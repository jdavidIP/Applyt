import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type Database from 'better-sqlite3';
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
} from '../types.js';
import {
  createApplicationSchema,
  updateApplicationSchema,
  listApplicationsQuerySchema,
  idParamSchema,
  markStaleSchema,
  bulkDeleteQuerySchema,
} from '../validation.js';
import type { SettingsStore } from '../settings.js';
import { tailorResume } from '../ai.js';

// Confirmed-applied statuses that got some kind of outcome, for response-rate
// purposes (CLAUDE.md §7 Phase 3: "response rate"). 'pending_confirmation' is
// excluded from the denominator entirely — we don't yet know the application
// was actually completed, so it shouldn't count against the rate either way.
const RESPONSE_STATUSES = new Set(['interviewing', 'rejected', 'offer']);

// Monday 00:00:00 UTC of the ISO week containing `d`, used to bucket
// applications into "applications per week" (CLAUDE.md §7 Phase 3).
function mondayOf(d: Date): Date {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1) - day;
  date.setUTCDate(date.getUTCDate() + diff);
  return date;
}

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

// Columns exported to CSV, in order.
const CSV_COLUMNS: (keyof Application)[] = [
  'id',
  'platform',
  'company',
  'title',
  'job_url',
  'platform_job_id',
  'apply_method',
  'status',
  'date_applied',
  'date_last_updated',
  'notes',
  'job_description',
  'resume_version_id',
  'created_at',
  'updated_at',
];

// Statuses an automatic/manual re-detection of a job is allowed to set. A user's
// later lifecycle changes (interviewing/rejected/offer/ghosted/stale) must NOT be
// clobbered by a subsequent re-detect of the same posting.
const AUTO_STATUSES = new Set(['applied', 'pending_confirmation']);

// Resolve the status when an already-known job is reported again.
function mergeStatus(existing: string, incoming: string): string {
  // Preserve a user-advanced lifecycle status — never regress it.
  if (!AUTO_STATUSES.has(existing)) return existing;
  // Both are auto-ish: a confirmed 'applied' outranks 'pending_confirmation',
  // so promote (e.g. external redirect → user "Mark as applied") but never
  // downgrade a job already marked applied back to pending.
  if (existing === 'applied' || incoming === 'applied') return 'applied';
  return incoming;
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // Quote if the field contains a comma, quote, CR or LF; double up embedded quotes.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(rows: Application[]): string {
  const header = CSV_COLUMNS.join(',');
  const lines = rows.map((row) => CSV_COLUMNS.map((col) => csvEscape(row[col])).join(','));
  // CRLF line endings for maximum spreadsheet compatibility (RFC 4180).
  return [header, ...lines].join('\r\n') + '\r\n';
}

export default async function applicationsRoutes(
  fastify: FastifyInstance,
  opts: RoutesOptions,
): Promise<void> {
  const { db, settings } = opts;

  // GET /applications — list with optional platform/status filter and sort.
  fastify.get<{ Querystring: ListApplicationsQuery }>(
    '/applications',
    { schema: { querystring: listApplicationsQuerySchema } },
    async (request) => {
      const { platform, status, sort, order } = request.query;
      const where: string[] = [];
      const params: Record<string, string> = {};
      if (platform) {
        where.push('platform = @platform');
        params.platform = platform;
      }
      if (status) {
        where.push('status = @status');
        params.status = status;
      }
      const sortCol = sort === 'date_last_updated' ? 'date_last_updated' : 'date_applied';
      const sortDir = order === 'asc' ? 'ASC' : 'DESC';
      const sql =
        `SELECT * FROM applications` +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ` ORDER BY ${sortCol} ${sortDir}, id ${sortDir}`;
      return db.prepare(sql).all(params) as Application[];
    },
  );

  // GET /applications/export.csv — full table as a CSV download.
  // Declared before the ':id' route so 'export.csv' is never parsed as an id.
  fastify.get('/applications/export.csv', async (_request, reply) => {
    const rows = db
      .prepare('SELECT * FROM applications ORDER BY date_applied DESC, id DESC')
      .all() as Application[];
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="applications.csv"')
      .send(toCsv(rows));
  });

  // GET /applications/stats — applications-per-week (last 8 weeks) + response rate.
  // Declared before ':id' so 'stats' is never parsed as an id.
  fastify.get('/applications/stats', async () => {
    const rows = db
      .prepare('SELECT status, date_applied FROM applications')
      .all() as Pick<Application, 'status' | 'date_applied'>[];

    const total = rows.length;
    const responseEligible = rows.filter((r) => r.status !== 'pending_confirmation');
    const responded = responseEligible.filter((r) => RESPONSE_STATUSES.has(r.status));
    const responseRate =
      responseEligible.length === 0 ? null : responded.length / responseEligible.length;

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
    '/applications/mark-stale',
    { schema: { body: markStaleSchema } },
    async (request) => {
      const { thresholdDays } = request.body;
      const cutoff = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000).toISOString();
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
    '/applications',
    { schema: { querystring: bulkDeleteQuerySchema } },
    async (request) => {
      const info = db
        .prepare('DELETE FROM applications WHERE status = ?')
        .run(request.query.status);
      return { deleted: info.changes };
    },
  );

  // GET /applications/:id — single row.
  fastify.get<{ Params: { id: number } }>(
    '/applications/:id',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const row = db
        .prepare('SELECT * FROM applications WHERE id = ?')
        .get(request.params.id) as Application | undefined;
      if (!row) return reply.code(404).send({ error: 'Application not found' });
      return row;
    },
  );

  // POST /applications — create. Server owns timestamps and defaults.
  fastify.post<{ Body: CreateApplicationBody }>(
    '/applications',
    { schema: { body: createApplicationSchema } },
    async (request, reply) => {
      const b = request.body;
      const now = new Date().toISOString();
      const platform = b.platform ?? 'manual';
      const apply_method = b.apply_method ?? (platform === 'manual' ? 'manual' : 'in_platform');
      const status = b.status ?? 'applied';
      const date_applied = b.date_applied ?? now;

      // De-duplicate on job identity. A single posting can legitimately be
      // reported more than once — e.g. an external redirect logged as
      // pending_confirmation, then the user right-clicks "Mark as applied", or
      // the extension re-fires on the same jk. When a row already exists for the
      // same platform + platform_job_id, update it in place instead of inserting
      // a copy. (No platform_job_id — e.g. a manual dashboard add — always inserts.)
      if (b.platform_job_id) {
        const existing = db
          .prepare('SELECT * FROM applications WHERE platform = ? AND platform_job_id = ?')
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
            .prepare('SELECT * FROM applications WHERE id = ?')
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
        .prepare('SELECT * FROM applications WHERE id = ?')
        .get(info.lastInsertRowid) as Application;
      return reply.code(201).send(created);
    },
  );

  // PATCH /applications/:id — partial update; bumps date_last_updated + updated_at.
  fastify.patch<{ Params: { id: number }; Body: UpdateApplicationBody }>(
    '/applications/:id',
    { schema: { params: idParamSchema, body: updateApplicationSchema } },
    async (request, reply) => {
      const id = request.params.id;
      const existing = db.prepare('SELECT * FROM applications WHERE id = ?').get(id) as
        | Application
        | undefined;
      if (!existing) return reply.code(404).send({ error: 'Application not found' });

      const b = request.body;
      const now = new Date().toISOString();
      const fields: string[] = [];
      const params: Record<string, unknown> = { id };
      const settable: (keyof UpdateApplicationBody)[] = [
        'platform',
        'company',
        'title',
        'job_url',
        'platform_job_id',
        'apply_method',
        'status',
        'date_applied',
        'notes',
        'job_description',
      ];
      for (const key of settable) {
        if (Object.prototype.hasOwnProperty.call(b, key)) {
          fields.push(`${key} = @${key}`);
          params[key] = b[key] ?? null;
        }
      }
      // Always bump these on any update.
      fields.push('date_last_updated = @date_last_updated', 'updated_at = @updated_at');
      params.date_last_updated = now;
      params.updated_at = now;

      db.prepare(`UPDATE applications SET ${fields.join(', ')} WHERE id = @id`).run(params);
      return db.prepare('SELECT * FROM applications WHERE id = ?').get(id) as Application;
    },
  );

  // DELETE /applications/:id
  fastify.delete<{ Params: { id: number } }>(
    '/applications/:id',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const info = db.prepare('DELETE FROM applications WHERE id = ?').run(request.params.id);
      if (info.changes === 0) return reply.code(404).send({ error: 'Application not found' });
      return reply.code(204).send();
    },
  );

  // POST /applications/:id/tailor — AI resume tailoring (CLAUDE.md §7 Phase 4).
  // Sends the base resume + this job's description to the user's chosen provider,
  // stores the result in resume_versions, and links it to the application. This
  // is the only route that makes an outbound network call (see ai.ts).
  fastify.post<{ Params: { id: number } }>(
    '/applications/:id/tailor',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(request.params.id) as
        | Application
        | undefined;
      if (!app) return reply.code(404).send({ error: 'Application not found' });

      const jobDescription = (app.job_description ?? '').trim();
      if (!jobDescription) {
        return reply
          .code(400)
          .send({ error: 'This application has no job description to tailor against. Add one first.' });
      }

      const cfg = settings.read();
      const baseResume = cfg.baseResume.trim();
      if (!baseResume) {
        return reply
          .code(400)
          .send({ error: 'No base resume is configured. Add one in Settings first.' });
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
        });
        output = result.output;
        usage = result.usage;
      } catch (err) {
        // Upstream provider failure (bad key, rate limit, bad model, network) —
        // 502, surfacing the provider's own message for the dashboard to show.
        request.log.error(err);
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message : 'AI provider request failed.' });
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
              model, input_tokens, output_tokens, cost, created_at)
           VALUES (@application_id, @base_resume_snapshot, @tailored_output, @ai_provider,
              @model, @input_tokens, @output_tokens, @cost, @created_at)`,
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
          created_at: now,
        });

      // Point the application at its newest tailored version.
      db.prepare(
        'UPDATE applications SET resume_version_id = @rvid, updated_at = @now WHERE id = @id',
      ).run({ rvid: info.lastInsertRowid, now, id: app.id });

      const created = db
        .prepare('SELECT * FROM resume_versions WHERE id = ?')
        .get(info.lastInsertRowid) as ResumeVersion;
      return reply.code(201).send(created);
    },
  );

  // GET /applications/:id/resume-versions — all tailored versions for a job,
  // newest first.
  fastify.get<{ Params: { id: number } }>(
    '/applications/:id/resume-versions',
    { schema: { params: idParamSchema } },
    async (request) => {
      return db
        .prepare(
          'SELECT * FROM resume_versions WHERE application_id = ? ORDER BY created_at DESC, id DESC',
        )
        .all(request.params.id) as ResumeVersion[];
    },
  );
}
