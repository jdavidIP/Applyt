import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import type Database from "better-sqlite3";
import type {
  Application,
  CreateApplicationBody,
  UpdateApplicationBody,
  ListApplicationsQuery,
  MarkStaleBody,
  BulkDeleteQuery,
  StatsResponse,
  WeeklyCount,
  ResumeVersion,
  TailorEstimate,
  ResumeDownloadFormat,
  TailorRequestBody,
} from "../types.js";
import {
  createApplicationSchema,
  updateApplicationSchema,
  listApplicationsQuerySchema,
  idParamSchema,
  markStaleSchema,
  bulkDeleteQuerySchema,
  resumeVersionParamSchema,
  resumeDownloadQuerySchema,
} from "../validation.js";
import type { SettingsStore } from "../settings.js";
import { tailorResume } from "../ai.js";
import { renderPdf, renderDocx } from "../resumeRender.js";
import { parseTailoredResume, parseTailorRejection } from "../tailoredResume.js";
import {
  STATUS_LABELS,
  PLATFORM_LABELS,
  APPLY_METHOD_LABELS,
  computeReportSummary,
  resolveVersionByAppId,
  RESPONSE_STATUSES,
  mondayOf,
  neutralizeFormulaPrefix,
  type AppVersionInfo,
} from "../reportData.js";
import { buildApplicationsWorkbook } from "../xlsxExport.js";

const WEEKS_IN_STATS = 8;

function computePerWeek(dateApplied: string[]): WeeklyCount[] {
  const now = new Date();
  const currentWeekStart = mondayOf(now);
  const buckets: WeeklyCount[] = [];
  for (let i = WEEKS_IN_STATS - 1; i >= 0; i--) {
    const weekStart = new Date(currentWeekStart);
    weekStart.setUTCDate(weekStart.getUTCDate() - i * 7);
    buckets.push({ weekStart: weekStart.toISOString().slice(0, 10), count: 0 });
  }
  const indexByWeekStart = new Map(buckets.map((b, i) => [b.weekStart, i]));
  for (const iso of dateApplied) {
    const weekStart = mondayOf(new Date(iso)).toISOString().slice(0, 10);
    const idx = indexByWeekStart.get(weekStart);
    if (idx !== undefined) buckets[idx].count += 1;
  }
  return buckets;
}

interface RoutesOptions extends FastifyPluginOptions {
  db: Database.Database;
}

// ---- CSV export (Issue #16) ----
// The previous export dumped every raw DB column (internal id, resume_version_id
// FK, created_at/updated_at bookkeeping) with no structure — "correctly
// generated" but of little use to a human. This produces a two-section report
// instead: a clean, human-readable detail table (one row per application, with
// tailoring info resolved from resume_versions rather than exposing the raw
// FK), followed by a summary/insights block below a blank separator row.
// Any tool that just reads until a shorter row still gets a clean table from
// the top section — the summary is additive, not a format change to the detail
// rows a spreadsheet import would rely on.

const CSV_DETAIL_HEADERS = [
  "Date Applied",
  "Company",
  "Job Title",
  "Platform",
  "Application Method",
  "Status",
  "Last Updated",
  "Resume Tailored",
  "Match Rating",
  "AI Provider",
  "AI Model",
  "Job URL",
  "Notes",
  "Job Description",
];

// Statuses an automatic/manual re-detection of a job is allowed to set. A user's
// later lifecycle changes (interviewing/rejected/offer/ghosted/stale) must NOT be
// clobbered by a subsequent re-detect of the same posting.
const AUTO_STATUSES = new Set(["applied", "pending_confirmation"]);

// Resolve the status when an already-known job is reported again.
function mergeStatus(existing: string, incoming: string): string {
  // Preserve a user-advanced lifecycle status — never regress it.
  if (!AUTO_STATUSES.has(existing)) return existing;
  // Both are auto-ish: a confirmed 'applied' outranks 'pending_confirmation',
  // so promote (e.g. external redirect → user "Mark as applied") but never
  // downgrade a job already marked applied back to pending.
  if (existing === "applied" || incoming === "applied") return "applied";
  return incoming;
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = neutralizeFormulaPrefix(String(value));
  // Quote if the field contains a comma, quote, CR or LF; double up embedded quotes.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(values: (string | number | null | undefined)[]): string {
  return values.map(csvEscape).join(",");
}

// date_last_updated is stored as a full ISO timestamp (unlike date_applied,
// a plain date) — trim it to just the date for a report column, matching the
// Date Applied column's format instead of showing a raw timestamp.
function csvDate(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

function buildApplicationsReport(
  rows: Application[],
  versionByAppId: Map<number, AppVersionInfo>,
): string {
  const lines: string[] = [csvRow(CSV_DETAIL_HEADERS)];

  for (const a of rows) {
    const v = versionByAppId.get(a.id);
    lines.push(
      csvRow([
        csvDate(a.date_applied),
        a.company,
        a.title,
        PLATFORM_LABELS[a.platform],
        APPLY_METHOD_LABELS[a.apply_method],
        STATUS_LABELS[a.status],
        csvDate(a.date_last_updated),
        v ? "Yes" : "No",
        v?.matchRating != null ? `${v.matchRating}/5` : "",
        v?.ai_provider ?? "",
        v?.model ?? "",
        a.job_url,
        a.notes,
        a.job_description,
      ]),
    );
  }

  const summary = computeReportSummary(rows, versionByAppId);

  // ---- Summary / insights, below a blank separator row ----
  lines.push("");
  lines.push(csvRow(["SUMMARY"]));
  lines.push(csvRow(["Total Applications", summary.totalApplications]));

  lines.push("");
  lines.push(csvRow(["Applications by Status"]));
  for (const s of summary.byStatus) lines.push(csvRow([s.label, s.count]));

  lines.push("");
  lines.push(csvRow(["Applications by Platform"]));
  for (const p of summary.byPlatform) lines.push(csvRow([p.label, p.count]));

  lines.push("");
  lines.push(
    csvRow([
      "Response Rate",
      summary.responseRate !== null ? `${(summary.responseRate * 100).toFixed(1)}%` : "N/A",
    ]),
  );

  lines.push("");
  lines.push(csvRow(["Applications per Week"]));
  lines.push(csvRow(["Week Starting", "Count"]));
  for (const w of summary.perWeek) lines.push(csvRow([w.weekStart, w.count]));

  lines.push("");
  lines.push(csvRow(["Tailoring Insights"]));
  lines.push(csvRow(["Applications with Tailored Resume", summary.tailoredCount]));
  lines.push(
    csvRow([
      "Average Match Rating",
      summary.avgMatchRating !== null ? `${summary.avgMatchRating.toFixed(1)}/5` : "N/A",
    ]),
  );

  // CRLF line endings for maximum spreadsheet compatibility (RFC 4180).
  return lines.join("\r\n") + "\r\n";
}

export default async function applicationsRoutes(
  fastify: FastifyInstance,
  opts: RoutesOptions,
): Promise<void> {
  const { db, settings } = opts;

  // GET /applications — list with optional platform/status filter, sort, and
  // pagination (page/pageSize; defaults 1/25, pageSize capped at 100).
  fastify.get<{ Querystring: ListApplicationsQuery }>(
    "/applications",
    { schema: { querystring: listApplicationsQuerySchema } },
    async (request) => {
      const { platform, status, sort, order, page = 1, pageSize = 25 } = request.query;
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
      const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
      const sortCol =
        sort === "date_last_updated" ? "date_last_updated" : "date_applied";
      const sortDir = order === "asc" ? "ASC" : "DESC";

      const total = (
        db.prepare(`SELECT COUNT(*) AS count FROM applications${whereSql}`).get(params) as {
          count: number;
        }
      ).count;

      // Clamp to the last valid page so a page number left over from before a
      // delete/bulk-action shrank the result set doesn't return an empty page.
      const maxPage = Math.max(1, Math.ceil(total / pageSize));
      const clampedPage = Math.min(page, maxPage);

      const offset = (clampedPage - 1) * pageSize;
      const sql =
        `SELECT * FROM applications${whereSql}` +
        ` ORDER BY ${sortCol} ${sortDir}, id ${sortDir}` +
        ` LIMIT @pageSize OFFSET @offset`;
      const items = db.prepare(sql).all({ ...params, pageSize, offset }) as Application[];

      return { items, total, page: clampedPage, pageSize };
    },
  );

  // Shared by both export routes: every application row plus tailoring info
  // (ai_provider/model/matchRating) resolved from its linked resume_versions row.
  function loadReportData(): { rows: Application[]; versionByAppId: Map<number, AppVersionInfo> } {
    const rows = db
      .prepare("SELECT * FROM applications ORDER BY date_applied DESC, id DESC")
      .all() as Application[];

    const versionIds = rows
      .map((r) => r.resume_version_id)
      .filter((id): id is number => id !== null);
    const versions = versionIds.length
      ? (db
          .prepare(
            `SELECT id, application_id, ai_provider, model, tailored_output
             FROM resume_versions WHERE id IN (${versionIds.map(() => "?").join(",")})`,
          )
          .all(...versionIds) as Pick<
          ResumeVersion,
          "id" | "application_id" | "ai_provider" | "model" | "tailored_output"
        >[])
      : [];
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
      const info = db
        .prepare("DELETE FROM applications WHERE status = ?")
        .run(request.query.status);
      return { deleted: info.changes };
    },
  );

  // GET /applications/:id — single row.
  fastify.get<{ Params: { id: number } }>(
    "/applications/:id",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const row = db
        .prepare("SELECT * FROM applications WHERE id = ?")
        .get(request.params.id) as Application | undefined;
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
          const updated = db
            .prepare("SELECT * FROM applications WHERE id = ?")
            .get(existing.id) as Application;
          return reply.code(200).send(updated);
        }
      }

      const info = db
        .prepare(
          `INSERT INTO applications
             (platform, company, title, job_url, platform_job_id, apply_method,
              status, date_applied, date_last_updated, notes, job_description,
              created_at, updated_at)
           VALUES
             (@platform, @company, @title, @job_url, @platform_job_id, @apply_method,
              @status, @date_applied, @date_last_updated, @notes, @job_description,
              @created_at, @updated_at)`,
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
          job_description: b.job_description ?? null,
          created_at: now,
          updated_at: now,
        });

      const created = db
        .prepare("SELECT * FROM applications WHERE id = ?")
        .get(info.lastInsertRowid) as Application;
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
      ];
      for (const key of settable) {
        if (Object.prototype.hasOwnProperty.call(b, key)) {
          fields.push(`${key} = @${key}`);
          params[key] = b[key] ?? null;
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
      return db
        .prepare("SELECT * FROM applications WHERE id = ?")
        .get(id) as Application;
    },
  );

  // DELETE /applications/:id
  fastify.delete<{ Params: { id: number } }>(
    "/applications/:id",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const id = request.params.id;
      // applications.resume_version_id and resume_versions.application_id
      // reference each other, so the app's pointer must be cleared before its
      // resume_versions rows can be deleted, or the FK constraint on
      // resume_version_id rejects the delete.
      const deleteApplication = db.transaction(() => {
        db.prepare(
          "UPDATE applications SET resume_version_id = NULL WHERE id = ?",
        ).run(id);
        db.prepare("DELETE FROM resume_versions WHERE application_id = ?").run(
          id,
        );
        return db.prepare("DELETE FROM applications WHERE id = ?").run(id);
      });
      const info = deleteApplication();
      if (info.changes === 0)
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
        const totalChars = history.reduce((sum, h) => sum + h.input_char_length, 0);
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
        (body.includeMatchRating !== undefined && typeof body.includeMatchRating !== "boolean") ||
        (body.includeSuggestions !== undefined && typeof body.includeSuggestions !== "boolean") ||
        (body.targetOnePage !== undefined && typeof body.targetOnePage !== "boolean")
      ) {
        return reply.code(400).send({
          error: "includeMatchRating, includeSuggestions, and targetOnePage must be booleans if provided.",
        });
      }
      const includeMatchRating = body.includeMatchRating ?? true;
      const includeSuggestions = body.includeSuggestions ?? true;
      const targetOnePage = body.targetOnePage ?? false;

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

      const apiKey = settings.resolveApiKey(cfg.provider);
      if (!apiKey) {
        return reply.code(400).send({
          error: `No API key configured for ${cfg.provider}. Add one in Settings first.`,
        });
      }

      let output: string;
      let usage: { inputTokens: number; outputTokens: number };
      try {
        const result = await tailorResume({
          provider: cfg.provider,
          apiKey,
          model: cfg.model,
          baseResume,
          jobDescription,
          company: app.company,
          title: app.title,
          includeMatchRating,
          includeSuggestions,
          targetOnePage,
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
      const price = cfg.modelPricing[cfg.model];
      const cost = price
        ? (usage.inputTokens / 1_000_000) * price.inputPerMillion +
          (usage.outputTokens / 1_000_000) * price.outputPerMillion
        : null;

      const now = new Date().toISOString();
      const info = db
        .prepare(
          `INSERT INTO resume_versions
             (application_id, base_resume_snapshot, tailored_output, ai_provider,
              model, input_tokens, output_tokens, cost, input_char_length, created_at)
           VALUES (@application_id, @base_resume_snapshot, @tailored_output, @ai_provider,
              @model, @input_tokens, @output_tokens, @cost, @input_char_length, @created_at)`,
        )
        .run({
          application_id: app.id,
          base_resume_snapshot: baseResume,
          tailored_output: output,
          ai_provider: cfg.provider,
          model: cfg.model,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cost,
          input_char_length: baseResume.length + jobDescription.length,
          created_at: now,
        });

      // Point the application at its newest tailored version.
      db.prepare(
        "UPDATE applications SET resume_version_id = @rvid, updated_at = @now WHERE id = @id",
      ).run({ rvid: info.lastInsertRowid, now, id: app.id });

      const created = db
        .prepare("SELECT * FROM resume_versions WHERE id = ?")
        .get(info.lastInsertRowid) as ResumeVersion;
      return reply.code(201).send(created);
    },
  );

  // GET /applications/:id/resume-versions — all tailored versions for a job,
  // newest first.
  fastify.get<{ Params: { id: number } }>(
    "/applications/:id/resume-versions",
    { schema: { params: idParamSchema } },
    async (request) => {
      return db
        .prepare(
          "SELECT * FROM resume_versions WHERE application_id = ? ORDER BY created_at DESC, id DESC",
        )
        .all(request.params.id) as ResumeVersion[];
    },
  );

  // GET /applications/:id/resume-versions/:versionId/download?format=pdf|docx|txt
  // Renders the stored tailored_output on demand rather than storing multiple
  // binary formats per version — any past or present version becomes
  // downloadable in any format, with no schema changes and no re-running the
  // AI call. Every format contains only the tailored resume itself: the match
  // rating and suggestions live in the dashboard, not in a submittable resume
  // file. parseTailoredResume also transparently handles rows saved before the
  // structured format existed.
  fastify.get<{
    Params: { id: number; versionId: number };
    Querystring: { format: ResumeDownloadFormat };
  }>(
    "/applications/:id/resume-versions/:versionId/download",
    { schema: { params: resumeVersionParamSchema, querystring: resumeDownloadQuerySchema } },
    async (request, reply) => {
      const { id, versionId } = request.params;
      const version = db
        .prepare("SELECT * FROM resume_versions WHERE id = ? AND application_id = ?")
        .get(versionId, id) as ResumeVersion | undefined;
      if (!version || !version.tailored_output) {
        return reply.code(404).send({ error: "Resume version not found." });
      }

      const { format } = request.query;
      const filenameBase = `resume-${id}-${versionId}`;
      const { resume, structured } = parseTailoredResume(version.tailored_output);

      if (format === "txt") {
        reply.header("Content-Disposition", `attachment; filename="${filenameBase}.txt"`);
        return reply.type("text/plain").send(resume);
      }
      if (format === "pdf") {
        const buffer = await renderPdf(structured ?? resume);
        reply.header("Content-Disposition", `attachment; filename="${filenameBase}.pdf"`);
        return reply.type("application/pdf").send(buffer);
      }

      const buffer = await renderDocx(structured ?? resume);
      reply.header("Content-Disposition", `attachment; filename="${filenameBase}.docx"`);
      return reply
        .type("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        .send(buffer);
    },
  );
}
