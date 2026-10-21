import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import multipart from "@fastify/multipart";
import type Database from "better-sqlite3";
import type {
  Application,
  CreateApplicationBody,
  UpdateApplicationBody,
  ListApplicationsQuery,
  MarkStaleBody,
  BulkDeleteQuery,
  BulkDeleteIdsBody,
  StatsResponse,
  DailyStatsQuery,
  ResumeVersion,
  TailorEstimate,
  ResumeDownloadFormat,
  TailorRequestBody,
  AttachmentKind,
  AttachmentFormat,
  ResumeVersionFileSummary,
  ResumeVersionWithFiles,
} from "../types/index.js";
import { ATTACHMENT_KINDS } from "../types/index.js";
import {
  createApplicationSchema,
  updateApplicationSchema,
  listApplicationsQuerySchema,
  dailyStatsQuerySchema,
  idParamSchema,
  markStaleSchema,
  bulkDeleteQuerySchema,
  bulkDeleteIdsSchema,
  resumeVersionParamSchema,
  resumeDownloadQuerySchema,
} from "../validation.js";
import type { SettingsStore } from "../storage/settings.js";
import { tailorResume } from "../ai.js";
import { renderPdf, renderDocx } from "../resume/resumeRender.js";
import {
  parseTailoredResume,
  parseTailorRejection,
} from "../resume/tailoredResume.js";
import {
  computeReportSummary,
  resolveVersionByAppId,
  RESPONSE_STATUSES,
  computePerWeek,
  computePerDay,
  type AppVersionInfo,
} from "../export/reportData.js";
import {
  type CoverLetter,
  type TailorResponseEnvelope,
} from "../types/resumeSchema.js";
import { findEnvelopeError } from "../resume/envelopeValidation.js";
import { extractResumeText } from "../resume/resumeExtract.js";
import {
  detectFileFormat,
  FORMAT_MIME,
  MAX_ATTACHMENT_BYTES,
} from "../resume/fileFormat.js";
import { buildApplicationsWorkbook } from "../export/xlsxExport.js";
import { buildApplicationsReport } from "../export/csvExport.js";
import {
  normalizeForSearch,
  normalizeJobDescription,
  mergeStatus,
} from "../applicationHelpers.js";

// Attachment header for a user-supplied filename: an ASCII-only fallback
// (quotes, backslashes and non-ASCII replaced) plus the exact name as RFC 5987
// filename*, so names like `José "CV".pdf` survive without breaking the header.
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

interface RoutesOptions extends FastifyPluginOptions {
  db: Database.Database;
  settings: SettingsStore;
}

export default async function applicationsRoutes(
  fastify: FastifyInstance,
  opts: RoutesOptions,
): Promise<void> {
  const { db, settings } = opts;

  // Scoped to this plugin (Fastify encapsulation): attachment uploads get their
  // own limits without touching the settings route's 10MB / 1-file setup.
  await fastify.register(multipart, {
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 4 },
    throwFileSizeLimit: true,
  });

  // applications.resume_version_id was removed (redundant with
  // resume_versions.application_id, and created a circular FK between the two
  // tables). Client-facing Application rows instead carry a computed
  // has_resume_version flag so the dashboard can still show "already
  // tailored" without a stored pointer to go stale.
  function getApplicationById(id: number): Application | undefined {
    const row = db
      .prepare(
        `SELECT applications.*,
                EXISTS(SELECT 1 FROM resume_versions WHERE resume_versions.application_id = applications.id) AS has_resume_version
           FROM applications WHERE id = ?`,
      )
      .get(id) as
      | (Omit<Application, "has_resume_version"> & {
          has_resume_version: number;
        })
      | undefined;
    return row
      ? { ...row, has_resume_version: !!row.has_resume_version }
      : undefined;
  }

  // cover_letters references both applications(id) and resume_versions(id)
  // with no ON DELETE CASCADE (and db.ts enables foreign_keys), so its rows
  // must go first, then resume_versions, then the applications themselves.
  // Shared by every delete path so none of them can forget a table.
  const deleteApplicationsCascade = db.transaction((ids: number[]): number => {
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM resume_version_files WHERE resume_version_id IN
         (SELECT id FROM resume_versions WHERE application_id IN (${placeholders}))`,
    ).run(...ids);
    db.prepare(
      `DELETE FROM cover_letters WHERE application_id IN (${placeholders})`,
    ).run(...ids);
    db.prepare(
      `DELETE FROM resume_versions WHERE application_id IN (${placeholders})`,
    ).run(...ids);
    return db
      .prepare(`DELETE FROM applications WHERE id IN (${placeholders})`)
      .run(...ids).changes;
  });

  // Attaches each version's file summaries (never the blob data) — empty for
  // generated versions.
  function withFiles(versions: ResumeVersion[]): ResumeVersionWithFiles[] {
    if (versions.length === 0) return [];
    const rows = db
      .prepare(
        `SELECT resume_version_id, kind, format, filename, size FROM resume_version_files
         WHERE resume_version_id IN (${versions.map(() => "?").join(",")}) ORDER BY id`,
      )
      .all(...versions.map((v) => v.id)) as (ResumeVersionFileSummary & {
      resume_version_id: number;
    })[];
    return versions.map((v) => ({
      ...v,
      files: rows
        .filter((r) => r.resume_version_id === v.id)
        .map(({ kind, format, filename, size }) => ({ kind, format, filename, size })),
    }));
  }

  // The one place a resume_versions row (plus its optional cover_letters
  // row) gets written, shared by /tailor and the MCP save route so the two
  // persistence paths can't drift.
  function insertResumeVersion(row: {
    applicationId: number;
    baseResume: string | null;
    output: string;
    provider: string;
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cost: number | null;
    inputCharLength: number | null;
    coverLetter: CoverLetter | null;
  }): ResumeVersion {
    const now = new Date().toISOString();
    const insert = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO resume_versions
             (application_id, base_resume_snapshot, tailored_output, ai_provider,
              model, input_tokens, output_tokens, cost, input_char_length, created_at)
           VALUES (@application_id, @base_resume_snapshot, @tailored_output, @ai_provider,
              @model, @input_tokens, @output_tokens, @cost, @input_char_length, @created_at)`,
        )
        .run({
          application_id: row.applicationId,
          base_resume_snapshot: row.baseResume,
          tailored_output: row.output,
          ai_provider: row.provider,
          model: row.model,
          input_tokens: row.inputTokens,
          output_tokens: row.outputTokens,
          cost: row.cost,
          input_char_length: row.inputCharLength,
          created_at: now,
        });
      if (row.coverLetter) {
        db.prepare(
          `INSERT INTO cover_letters
             (application_id, resume_version_id, tailored_output, created_at)
           VALUES (@application_id, @resume_version_id, @tailored_output, @created_at)`,
        ).run({
          application_id: row.applicationId,
          resume_version_id: info.lastInsertRowid,
          tailored_output: JSON.stringify(row.coverLetter),
          created_at: now,
        });
      }
      db.prepare(
        "UPDATE applications SET updated_at = @now WHERE id = @id",
      ).run({ now, id: row.applicationId });
      return info.lastInsertRowid;
    });
    const id = insert();
    return db
      .prepare("SELECT * FROM resume_versions WHERE id = ?")
      .get(id) as ResumeVersion;
  }

  // GET /applications — list with optional platform/status filter, sort, and
  // pagination (page/pageSize; defaults 1/25, pageSize capped at 100).
  fastify.get<{ Querystring: ListApplicationsQuery }>(
    "/applications",
    { schema: { querystring: listApplicationsQuerySchema } },
    async (request) => {
      const {
        platform,
        status,
        search,
        date,
        dateFrom,
        dateTo,
        sort,
        order,
        page = 1,
        pageSize = 25,
      } = request.query;
      const where: string[] = [];
      const params: Record<string, string> = {};
      if (platform) {
        where.push("platform = @platform");
        params.platform = platform;
      }
      if (status) {
        where.push("status = @status");
        params.status = status;
      }
      if (date) {
        // date_applied is stored as either a bare date (YYYY-MM-DD, when the
        // client supplied one) or a full ISO timestamp (server default when
        // it didn't) — substr matches both against the bare date the
        // trend-detail modal's day-drilldown sends.
        where.push("substr(date_applied, 1, 10) = @date");
        params.date = date;
      }
      if (dateFrom && dateTo) {
        // Inclusive calendar-day range — the trend-detail modal's weekly view
        // drilldown (a week's worth of days at once). Same substr rationale
        // as `date` above.
        where.push("substr(date_applied, 1, 10) BETWEEN @dateFrom AND @dateTo");
        params.dateFrom = dateFrom;
        params.dateTo = dateTo;
      }
      if (search?.trim()) {
        // Strip spaces/hyphens from both sides so "Full Stack", "Full-Stack",
        // and "Fullstack" all match each other — still an exact substring
        // match post-normalization, not fuzzy/typo-tolerant, so it doesn't
        // trade away precision.
        where.push(
          "(REPLACE(REPLACE(company, ' ', ''), '-', '') LIKE @search ESCAPE '\\' OR REPLACE(REPLACE(title, ' ', ''), '-', '') LIKE @search ESCAPE '\\')",
        );
        params.search = `%${normalizeForSearch(search)}%`;
      }
      const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
      const sortCol =
        sort === "date_last_updated" ? "date_last_updated" : "date_applied";
      const sortDir = order === "asc" ? "ASC" : "DESC";

      const total = (
        db
          .prepare(`SELECT COUNT(*) AS count FROM applications${whereSql}`)
          .get(params) as {
          count: number;
        }
      ).count;

      // Clamp to the last valid page so a page number left over from before a
      // delete/bulk-action shrank the result set doesn't return an empty page.
      const maxPage = Math.max(1, Math.ceil(total / pageSize));
      const clampedPage = Math.min(page, maxPage);

      const offset = (clampedPage - 1) * pageSize;
      const sql =
        `SELECT applications.*,
                EXISTS(SELECT 1 FROM resume_versions WHERE resume_versions.application_id = applications.id) AS has_resume_version
           FROM applications${whereSql}` +
        ` ORDER BY ${sortCol} ${sortDir}, id ${sortDir}` +
        ` LIMIT @pageSize OFFSET @offset`;
      const rows = db
        .prepare(sql)
        .all({ ...params, pageSize, offset }) as (Omit<
        Application,
        "has_resume_version"
      > & { has_resume_version: number })[];
      const items = rows.map((r) => ({
        ...r,
        has_resume_version: !!r.has_resume_version,
      }));

      return { items, total, page: clampedPage, pageSize };
    },
  );

  // Shared by both export routes: every application row plus tailoring info
  // (ai_provider/model/matchRating) resolved from its linked resume_versions row.
  function loadReportData(): {
    rows: Application[];
    versionByAppId: Map<number, AppVersionInfo>;
  } {
    const rows = db
      .prepare("SELECT * FROM applications ORDER BY date_applied DESC, id DESC")
      .all() as Application[];

    // Newest-per-application wins: resolveVersionByAppId does a plain
    // Map.set() per row in iteration order, so ordering ascending by id
    // means the last (newest) row for a given application overwrites any
    // earlier one.
    const versions = db
      .prepare(
        `SELECT id, application_id, ai_provider, model, tailored_output
         FROM resume_versions ORDER BY id ASC`,
      )
      .all() as Pick<
      ResumeVersion,
      "id" | "application_id" | "ai_provider" | "model" | "tailored_output"
    >[];
    return { rows, versionByAppId: resolveVersionByAppId(versions) };
  }

  // GET /applications/export.csv — a structured, human-readable CSV report
  // (Issue #16), not a raw table dump. Declared before the ':id' route so
  // 'export.csv' is never parsed as an id.
  fastify.get("/applications/export.csv", async (_request, reply) => {
    const { rows, versionByAppId } = loadReportData();
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="applications.csv"')
      .send(buildApplicationsReport(rows, versionByAppId));
  });

  // GET /applications/export.xlsx — a styled Excel workbook: a formatted,
  // bordered table with a frozen header/autofilter on one sheet, plus a
  // second "Insights" sheet with summary tables and in-cell data-bar charts.
  // CSV stays the zero-setup default (CLAUDE.md §2); this is the "open it and
  // it already looks professional" alternative some users asked for (Issue #16).
  fastify.get("/applications/export.xlsx", async (_request, reply) => {
    const { rows, versionByAppId } = loadReportData();
    const workbook = buildApplicationsWorkbook(rows, versionByAppId);
    const buffer = await workbook.xlsx.writeBuffer();
    reply
      .header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      )
      .header("Content-Disposition", 'attachment; filename="applications.xlsx"')
      .send(Buffer.from(buffer));
  });

  // GET /applications/stats — applications-per-week (last 8 weeks) + response rate.
  // Declared before ':id' so 'stats' is never parsed as an id.
  fastify.get("/applications/stats", async () => {
    const rows = db
      .prepare("SELECT status, date_applied FROM applications")
      .all() as Pick<Application, "status" | "date_applied">[];

    const total = rows.length;
    const responseEligible = rows.filter(
      (r) => r.status !== "pending_confirmation",
    );
    const responded = responseEligible.filter((r) =>
      RESPONSE_STATUSES.has(r.status),
    );
    const responseRate =
      responseEligible.length === 0
        ? null
        : responded.length / responseEligible.length;

    const stats: StatsResponse = {
      totalApplications: total,
      perWeek: computePerWeek(rows.map((r) => r.date_applied)),
      responseRate,
    };
    return stats;
  });

  // GET /applications/stats/daily — day-by-day breakdown for the trend-detail
  // modal's chart. weeks selects the window size (4/8/12), offset pages back
  // in units of that window. Declared before ':id' for the same reason as
  // 'stats' above.
  fastify.get<{ Querystring: DailyStatsQuery }>(
    "/applications/stats/daily",
    { schema: { querystring: dailyStatsQuerySchema } },
    async (request) => {
      const { weeks = 4, offset = 0 } = request.query;
      const rows = db
        .prepare("SELECT date_applied FROM applications")
        .all() as Pick<Application, "date_applied">[];
      return computePerDay(
        rows.map((r) => r.date_applied),
        weeks,
        offset,
      );
    },
  );

  // POST /applications/mark-stale — bulk-transition long-untouched 'applied'
  // rows to 'stale' (CLAUDE.md §7 Phase 3: user-configurable threshold).
  // Only 'applied' rows are eligible: any other status is either already a
  // deliberate lifecycle state or not yet confirmed, so leave it alone.
  fastify.post<{ Body: MarkStaleBody }>(
    "/applications/mark-stale",
    { schema: { body: markStaleSchema } },
    async (request) => {
      const { thresholdDays } = request.body;
      const cutoff = new Date(
        Date.now() - thresholdDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      const now = new Date().toISOString();
      const info = db
        .prepare(
          `UPDATE applications
              SET status = 'stale', date_last_updated = @now, updated_at = @now
            WHERE status = 'applied' AND date_last_updated < @cutoff`,
        )
        .run({ now, cutoff });
      return { updated: info.changes };
    },
  );

  // DELETE /applications?status=rejected — bulk-delete every row with the
  // given status (CLAUDE.md §7 Phase 3: "bulk delete rejected"). Generalized
  // to any status rather than hardcoding 'rejected', since the same query
  // shape is useful for clearing out 'stale'/'ghosted' rows too.
  fastify.delete<{ Querystring: BulkDeleteQuery }>(
    "/applications",
    { schema: { querystring: bulkDeleteQuerySchema } },
    async (request) => {
      const ids = (
        db
          .prepare("SELECT id FROM applications WHERE status = ?")
          .all(request.query.status) as { id: number }[]
      ).map((r) => r.id);
      const deleted = ids.length ? deleteApplicationsCascade(ids) : 0;
      return { deleted };
    },
  );

  // POST /applications/bulk-delete — delete an explicit set of ids, all or
  // nothing. A separate POST route rather than a body on DELETE
  // /applications, which already exists for delete-by-status and requires
  // ?status=. The MCP server's confirm_delete is the caller: if any id has
  // vanished since its preview (e.g. deleted from the dashboard), refuse the
  // whole batch rather than delete a set the user never saw.
  fastify.post<{ Body: BulkDeleteIdsBody }>(
    "/applications/bulk-delete",
    { schema: { body: bulkDeleteIdsSchema } },
    async (request, reply) => {
      const ids = [...new Set(request.body.ids)];
      const placeholders = ids.map(() => "?").join(",");
      const existing = new Set(
        (
          db
            .prepare(`SELECT id FROM applications WHERE id IN (${placeholders})`)
            .all(...ids) as { id: number }[]
        ).map((r) => r.id),
      );
      const missingIds = ids.filter((id) => !existing.has(id));
      if (missingIds.length) {
        return reply.code(404).send({
          error: `Applications not found: ${missingIds.join(", ")}`,
          missingIds,
        });
      }
      return { deleted: deleteApplicationsCascade(ids) };
    },
  );

  // GET /applications/:id — single row.
  fastify.get<{ Params: { id: number } }>(
    "/applications/:id",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const row = getApplicationById(request.params.id);
      if (!row) return reply.code(404).send({ error: "Application not found" });
      return row;
    },
  );

  // POST /applications — create. Server owns timestamps and defaults.
  fastify.post<{ Body: CreateApplicationBody }>(
    "/applications",
    { schema: { body: createApplicationSchema } },
    async (request, reply) => {
      const b = request.body;
      const now = new Date().toISOString();
      const platform = b.platform ?? "manual";
      const apply_method =
        b.apply_method ?? (platform === "manual" ? "manual" : "in_platform");
      const status = b.status ?? "applied";
      const date_applied = b.date_applied ?? now;

      // De-duplicate on job identity. A single posting can legitimately be
      // reported more than once — e.g. an external redirect logged as
      // pending_confirmation, then the user right-clicks "Mark as applied", or
      // the extension re-fires on the same jk. When a row already exists for the
      // same platform + platform_job_id, update it in place instead of inserting
      // a copy. (No platform_job_id — e.g. a manual dashboard add — always inserts.)
      if (b.platform_job_id) {
        const existing = db
          .prepare(
            "SELECT * FROM applications WHERE platform = ? AND platform_job_id = ?",
          )
          .get(platform, b.platform_job_id) as Application | undefined;
        if (existing) {
          db.prepare(
            `UPDATE applications
                SET status = @status,
                    job_url = COALESCE(job_url, @job_url),
                    apply_method = COALESCE(apply_method, @apply_method),
                    date_last_updated = @now,
                    updated_at = @now
              WHERE id = @id`,
          ).run({
            status: mergeStatus(existing.status, status),
            job_url: b.job_url ?? null,
            apply_method,
            now,
            id: existing.id,
          });
          const updated = getApplicationById(existing.id);
          return reply.code(200).send(updated);
        }
      }

      const info = db
        .prepare(
          `INSERT INTO applications
             (platform, company, title, job_url, platform_job_id, apply_method,
              status, date_applied, date_last_updated, notes, job_description,
              location, modality, created_at, updated_at)
           VALUES
             (@platform, @company, @title, @job_url, @platform_job_id, @apply_method,
              @status, @date_applied, @date_last_updated, @notes, @job_description,
              @location, @modality, @created_at, @updated_at)`,
        )
        .run({
          platform,
          company: b.company,
          title: b.title,
          job_url: b.job_url ?? null,
          platform_job_id: b.platform_job_id ?? null,
          apply_method,
          status,
          date_applied,
          date_last_updated: now,
          notes: b.notes ?? null,
          job_description: normalizeJobDescription(b.job_description),
          location: b.location ?? null,
          modality: b.modality ?? null,
          created_at: now,
          updated_at: now,
        });

      const created = getApplicationById(info.lastInsertRowid as number);
      return reply.code(201).send(created);
    },
  );

  // PATCH /applications/:id — partial update; bumps date_last_updated + updated_at.
  fastify.patch<{ Params: { id: number }; Body: UpdateApplicationBody }>(
    "/applications/:id",
    { schema: { params: idParamSchema, body: updateApplicationSchema } },
    async (request, reply) => {
      const id = request.params.id;
      const existing = db
        .prepare("SELECT * FROM applications WHERE id = ?")
        .get(id) as Application | undefined;
      if (!existing)
        return reply.code(404).send({ error: "Application not found" });

      const b = request.body;
      const now = new Date().toISOString();
      const fields: string[] = [];
      const params: Record<string, unknown> = { id };
      const settable: (keyof UpdateApplicationBody)[] = [
        "platform",
        "company",
        "title",
        "job_url",
        "platform_job_id",
        "apply_method",
        "status",
        "date_applied",
        "notes",
        "job_description",
        "location",
        "modality",
      ];
      for (const key of settable) {
        if (Object.prototype.hasOwnProperty.call(b, key)) {
          fields.push(`${key} = @${key}`);
          params[key] =
            key === "job_description"
              ? normalizeJobDescription(b[key] as string | null | undefined)
              : (b[key] ?? null);
        }
      }
      // Always bump these on any update.
      fields.push(
        "date_last_updated = @date_last_updated",
        "updated_at = @updated_at",
      );
      params.date_last_updated = now;
      params.updated_at = now;

      db.prepare(
        `UPDATE applications SET ${fields.join(", ")} WHERE id = @id`,
      ).run(params);
      return getApplicationById(id);
    },
  );

  // DELETE /applications/:id
  fastify.delete<{ Params: { id: number } }>(
    "/applications/:id",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const deleted = deleteApplicationsCascade([request.params.id]);
      if (deleted === 0)
        return reply.code(404).send({ error: "Application not found" });
      return reply.code(204).send();
    },
  );

  // GET /applications/:id/tailor-estimate — predicted cost of a tailor run,
  // shown before the user spends real money on POST /:id/tailor. Prefers a
  // historical extrapolation (this model's actual $-per-char of input, from
  // past runs) and falls back to a static per-token estimate off the
  // configured pricing table when the model has no history yet.
  fastify.get<{ Params: { id: number } }>(
    "/applications/:id/tailor-estimate",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const app = db
        .prepare("SELECT * FROM applications WHERE id = ?")
        .get(request.params.id) as Application | undefined;
      if (!app) return reply.code(404).send({ error: "Application not found" });

      const jobDescription = (app.job_description ?? "").trim();
      if (!jobDescription) {
        return reply.code(400).send({
          error:
            "This application has no job description to tailor against. Add one first.",
        });
      }

      const cfg = settings.read();
      const baseResume = cfg.baseResume.trim();
      if (!baseResume) {
        return reply.code(400).send({
          error: "No base resume is configured. Add one in Settings first.",
        });
      }

      const inputCharLength = baseResume.length + jobDescription.length;

      const history = db
        .prepare(
          `SELECT cost, input_char_length FROM resume_versions
           WHERE model = ? AND cost IS NOT NULL AND input_char_length IS NOT NULL
             AND input_char_length > 0`,
        )
        .all(cfg.model) as { cost: number; input_char_length: number }[];

      if (history.length > 0) {
        // Weighted average $-per-char across all historical runs of this model
        // (sum of costs over sum of chars), extrapolated to this input's length.
        const totalCost = history.reduce((sum, h) => sum + h.cost, 0);
        const totalChars = history.reduce(
          (sum, h) => sum + h.input_char_length,
          0,
        );
        const costPerChar = totalCost / totalChars;
        const estimate: TailorEstimate = {
          estimatedCost: costPerChar * inputCharLength,
          source: "historical",
          sampleSize: history.length,
          model: cfg.model,
        };
        return estimate;
      }

      const price = cfg.modelPricing[cfg.model];
      if (!price) {
        const estimate: TailorEstimate = {
          estimatedCost: null,
          source: "unavailable",
          model: cfg.model,
        };
        return estimate;
      }

      // No history yet: rough estimate from chars/4 ≈ tokens, assuming the
      // tailored output is roughly as long as the input resume.
      const estimatedInputTokens = Math.ceil(inputCharLength / 4);
      const estimatedOutputTokens = estimatedInputTokens;
      const estimate: TailorEstimate = {
        estimatedCost:
          (estimatedInputTokens / 1_000_000) * price.inputPerMillion +
          (estimatedOutputTokens / 1_000_000) * price.outputPerMillion,
        source: "static",
        model: cfg.model,
      };
      return estimate;
    },
  );

  // POST /applications/:id/tailor — AI resume tailoring (CLAUDE.md §7 Phase 4).
  // Sends the base resume + this job's description to the user's chosen provider,
  // stores the result in resume_versions, and links it to the application. This
  // is the only route that makes an outbound network call (see ai.ts).
  fastify.post<{ Params: { id: number }; Body: TailorRequestBody }>(
    "/applications/:id/tailor",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const app = db
        .prepare("SELECT * FROM applications WHERE id = ?")
        .get(request.params.id) as Application | undefined;
      if (!app) return reply.code(404).send({ error: "Application not found" });

      const body = request.body ?? {};
      if (
        (body.includeMatchRating !== undefined &&
          typeof body.includeMatchRating !== "boolean") ||
        (body.includeSuggestions !== undefined &&
          typeof body.includeSuggestions !== "boolean") ||
        (body.targetOnePage !== undefined &&
          typeof body.targetOnePage !== "boolean") ||
        (body.includeCoverLetter !== undefined &&
          typeof body.includeCoverLetter !== "boolean")
      ) {
        return reply.code(400).send({
          error:
            "includeMatchRating, includeSuggestions, targetOnePage and includeCoverLetter must be booleans if provided.",
        });
      }
      const includeMatchRating = body.includeMatchRating ?? true;
      const includeSuggestions = body.includeSuggestions ?? true;
      const targetOnePage = body.targetOnePage ?? false;
      const includeCoverLetter = body.includeCoverLetter ?? false;

      const jobDescription = (app.job_description ?? "").trim();
      if (!jobDescription) {
        return reply.code(400).send({
          error:
            "This application has no job description to tailor against. Add one first.",
        });
      }

      const cfg = settings.read();
      const baseResume = cfg.baseResume.trim();
      if (!baseResume) {
        return reply.code(400).send({
          error: "No base resume is configured. Add one in Settings first.",
        });
      }

      // Ollama runs locally with no auth, so it's exempt from the key gate —
      // an unreachable server surfaces later as a 502 from ai.ts instead.
      const apiKey = settings.resolveApiKey(cfg.provider);
      if (cfg.provider !== "ollama" && !apiKey) {
        return reply.code(400).send({
          error: `No API key configured for ${cfg.provider}. Add one in Settings first.`,
        });
      }

      let output: string;
      let usage: { inputTokens: number; outputTokens: number };
      try {
        const result = await tailorResume({
          provider: cfg.provider,
          apiKey: apiKey ?? "",
          ollamaBaseUrl: settings.resolveOllamaBaseUrl(),
          model: cfg.model,
          baseResume,
          jobDescription,
          company: app.company,
          title: app.title,
          includeMatchRating,
          includeSuggestions,
          targetOnePage,
          includeCoverLetter,
        });
        output = result.output;
        usage = result.usage;
      } catch (err) {
        // Upstream provider failure (bad key, rate limit, bad model, network) —
        // 502, surfacing the provider's own message for the dashboard to show.
        request.log.error(err);
        return reply.code(502).send({
          error:
            err instanceof Error ? err.message : "AI provider request failed.",
        });
      }

      // The model is prompted (ai.ts) to refuse instead of tailoring when the
      // configured base resume clearly isn't a real resume (Issue #14). This
      // call already happened and was billed, but there's nothing useful to
      // persist as a resume_versions row, and storing one would pollute the
      // historical cost-per-char estimate with a run that has a very
      // different token profile than an actual successful tailoring.
      const rejection = parseTailorRejection(output);
      if (rejection) {
        return reply.code(422).send({ error: rejection.message });
      }

      // Actual cost = tokens × the configured price for this model. NULL when the
      // model has no pricing entry — we show "unknown", never a fabricated number.
      // Ollama runs on the user's own hardware, so it's a real, known 0 rather
      // than an unpriced unknown — don't send it through the pricing table.
      const price = cfg.modelPricing[cfg.model];
      const cost =
        cfg.provider === "ollama"
          ? 0
          : price
            ? (usage.inputTokens / 1_000_000) * price.inputPerMillion +
              (usage.outputTokens / 1_000_000) * price.outputPerMillion
            : null;

      // Only persist a cover_letters row when one was actually requested AND
      // the model returned something coerceCoverLetter accepts — a run that
      // was asked for a cover letter but produced nothing parseable isn't
      // worth a broken/empty row.
      const created = insertResumeVersion({
        applicationId: app.id,
        baseResume,
        output,
        provider: cfg.provider,
        model: cfg.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cost,
        inputCharLength: baseResume.length + jobDescription.length,
        coverLetter: includeCoverLetter
          ? (parseTailoredResume(output).coverLetter ?? null)
          : null,
      });
      return reply.code(201).send(created);
    },
  );

  // GET /applications/:id/resume-versions — all tailored versions for a job,
  // newest first.
  fastify.get<{ Params: { id: number } }>(
    "/applications/:id/resume-versions",
    { schema: { params: idParamSchema } },
    async (request) => {
      const versions = db
        .prepare(
          "SELECT * FROM resume_versions WHERE application_id = ? ORDER BY created_at DESC, id DESC",
        )
        .all(request.params.id) as ResumeVersion[];
      return withFiles(versions);
    },
  );

  // POST /applications/:id/resume-versions/files — attach the user's own
  // resume and/or cover letter (PDF/DOCX, at most one per kind+format) as a
  // new 'file' resume version. Bytes are stored untouched and the format comes
  // from the content, never the filename. Every part is read and validated
  // before anything is written, so a bad upload leaves no partial version.
  fastify.post<{ Params: { id: number } }>(
    "/applications/:id/resume-versions/files",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const app = getApplicationById(request.params.id);
      if (!app) return reply.code(404).send({ error: "Application not found" });

      const parts: { field: string; filename: string; data: Buffer }[] = [];
      try {
        for await (const part of request.files()) {
          parts.push({
            field: part.fieldname,
            // Browsers and Node's FormData escape `"` and CR/LF in multipart
            // filenames (WHATWG spec); busboy doesn't undo it.
            filename: part.filename
              .replace(/%22/g, '"')
              .replace(/%0D|%0A/gi, ""),
            data: await part.toBuffer(),
          });
        }
      } catch (err) {
        if (err instanceof fastify.multipartErrors.RequestFileTooLargeError) {
          return reply.code(413).send({
            error: `File is too large (max ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB).`,
          });
        }
        if (err instanceof fastify.multipartErrors.FilesLimitError) {
          return reply
            .code(400)
            .send({ error: "At most 4 files can be attached at once." });
        }
        throw err;
      }

      if (parts.length === 0) {
        return reply.code(400).send({ error: "No files uploaded." });
      }
      const files: {
        kind: AttachmentKind;
        format: AttachmentFormat;
        filename: string;
        data: Buffer;
      }[] = [];
      for (const p of parts) {
        if (!(ATTACHMENT_KINDS as readonly string[]).includes(p.field)) {
          return reply.code(400).send({
            error: `Unknown file field "${p.field}" — use "resume" or "cover_letter".`,
          });
        }
        const kind = p.field as AttachmentKind;
        if (p.data.length === 0) {
          return reply
            .code(400)
            .send({ error: `The ${kind} file "${p.filename}" is empty.` });
        }
        const format = detectFileFormat(p.data);
        if (!format) {
          return reply.code(400).send({
            error: `"${p.filename}" is an unsupported type — attach a PDF or Word (.docx) file.`,
          });
        }
        if (files.some((f) => f.kind === kind && f.format === format)) {
          return reply.code(400).send({
            error: `More than one ${kind} ${format} file — attach at most one of each.`,
          });
        }
        files.push({ kind, format, filename: p.filename, data: p.data });
      }

      // Preview text only (dashboard/popup/MCP); the files themselves are what
      // matter, so an unreadable file (e.g. a scanned PDF) still saves.
      const source = [
        ["resume", "pdf"],
        ["resume", "docx"],
        ["cover_letter", "pdf"],
        ["cover_letter", "docx"],
      ]
        .map(([k, f]) => files.find((x) => x.kind === k && x.format === f))
        .find(Boolean)!;
      let text = "";
      try {
        text = await extractResumeText(source.data, FORMAT_MIME[source.format]);
      } catch {
        // fall through to the placeholder
      }
      if (!text.trim()) text = "(Text could not be extracted from this file.)";

      const now = new Date().toISOString();
      const versionId = db.transaction(() => {
        const { lastInsertRowid } = db
          .prepare(
            `INSERT INTO resume_versions (application_id, tailored_output, ai_provider, created_at)
             VALUES (?, ?, 'file', ?)`,
          )
          .run(app.id, text, now);
        const insertFile = db.prepare(
          `INSERT INTO resume_version_files
             (resume_version_id, kind, format, filename, size, data, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const f of files) {
          insertFile.run(lastInsertRowid, f.kind, f.format, f.filename, f.data.length, f.data, now);
        }
        db.prepare("UPDATE applications SET updated_at = ? WHERE id = ?").run(now, app.id);
        return lastInsertRowid;
      })();

      const version = db
        .prepare("SELECT * FROM resume_versions WHERE id = ?")
        .get(versionId) as ResumeVersion;
      return reply.code(201).send(withFiles([version])[0]);
    },
  );

  // POST /applications/:id/resume-versions — save a tailored resume written
  // elsewhere (the MCP server: Claude itself does the tailoring, so there is
  // no provider call, token usage, or cost). Stored in the same envelope
  // format /tailor writes, so TailorModal and every download format work
  // unchanged. Validated strictly (findEnvelopeError) so the caller learns
  // exactly which field to fix instead of having entries silently dropped.
  fastify.post<{ Params: { id: number }; Body: TailorResponseEnvelope }>(
    "/applications/:id/resume-versions",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const app = getApplicationById(request.params.id);
      if (!app) return reply.code(404).send({ error: "Application not found" });
      const error = findEnvelopeError(request.body);
      if (error) return reply.code(400).send({ error });

      const envelope = request.body;
      const created = insertResumeVersion({
        applicationId: app.id,
        baseResume: settings.read().baseResume.trim() || null,
        output: JSON.stringify(envelope),
        provider: "mcp",
        model: null,
        inputTokens: null,
        outputTokens: null,
        cost: 0,
        inputCharLength: null,
        coverLetter: envelope.coverLetter ?? null,
      });
      return reply.code(201).send(created);
    },
  );

  // GET /applications/:id/resume-versions/:versionId/download?format=pdf|docx|txt[&kind=resume|cover_letter]
  // Renders the stored tailored_output on demand rather than storing multiple
  // binary formats per version — any past or present version becomes
  // downloadable in any format, with no schema changes and no re-running the
  // AI call. Every format contains only the tailored resume itself: the match
  // rating and suggestions live in the dashboard, not in a submittable resume
  // file. parseTailoredResume also transparently handles rows saved before the
  // structured format existed.
  fastify.get<{
    Params: { id: number; versionId: number };
    Querystring: { format: ResumeDownloadFormat; kind: AttachmentKind };
  }>(
    "/applications/:id/resume-versions/:versionId/download",
    {
      schema: {
        params: resumeVersionParamSchema,
        querystring: resumeDownloadQuerySchema,
      },
    },
    async (request, reply) => {
      const { id, versionId } = request.params;
      const version = db
        .prepare(
          "SELECT * FROM resume_versions WHERE id = ? AND application_id = ?",
        )
        .get(versionId, id) as ResumeVersion | undefined;
      if (!version) {
        return reply.code(404).send({ error: "Resume version not found." });
      }

      const { format, kind } = request.query;

      // File versions serve the user's own attached files byte-for-byte —
      // never re-rendered through the template.
      if (version.ai_provider === "file" && format !== "txt") {
        const file = db
          .prepare(
            "SELECT filename, data FROM resume_version_files WHERE resume_version_id = ? AND kind = ? AND format = ?",
          )
          .get(version.id, kind, format) as
          | { filename: string; data: Buffer }
          | undefined;
        if (!file) {
          const what = `${format === "pdf" ? "PDF" : "Word"} ${kind === "resume" ? "resume" : "cover letter"}`;
          return reply
            .code(404)
            .send({ error: `This version has no ${what}.` });
        }
        reply.header("Content-Disposition", contentDisposition(file.filename));
        return reply.type(FORMAT_MIME[format]).send(file.data);
      }
      // Generated cover letters deliberately have no download.
      if (kind === "cover_letter" && version.ai_provider !== "file") {
        return reply
          .code(404)
          .send({ error: "This version has no cover letter file." });
      }
      if (!version.tailored_output) {
        return reply.code(404).send({ error: "Resume version not found." });
      }
      const filenameBase = `resume-${id}-${versionId}`;
      const { resume, structured } = parseTailoredResume(
        version.tailored_output,
      );

      if (format === "txt") {
        reply.header(
          "Content-Disposition",
          `attachment; filename="${filenameBase}.txt"`,
        );
        return reply.type("text/plain").send(resume);
      }
      if (format === "pdf") {
        const buffer = await renderPdf(structured ?? resume);
        reply.header(
          "Content-Disposition",
          `attachment; filename="${filenameBase}.pdf"`,
        );
        return reply.type("application/pdf").send(buffer);
      }

      const buffer = await renderDocx(structured ?? resume);
      reply.header(
        "Content-Disposition",
        `attachment; filename="${filenameBase}.docx"`,
      );
      return reply
        .type(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
        .send(buffer);
    },
  );
}
