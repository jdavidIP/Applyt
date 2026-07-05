import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type Database from 'better-sqlite3';
import type {
  Application,
  CreateApplicationBody,
  UpdateApplicationBody,
  ListApplicationsQuery,
} from '../types.js';
import {
  createApplicationSchema,
  updateApplicationSchema,
  listApplicationsQuerySchema,
  idParamSchema,
} from '../validation.js';

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
  'resume_version_id',
  'created_at',
  'updated_at',
];

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
  const { db } = opts;

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

      const info = db
        .prepare(
          `INSERT INTO applications
             (platform, company, title, job_url, platform_job_id, apply_method,
              status, date_applied, date_last_updated, notes, created_at, updated_at)
           VALUES
             (@platform, @company, @title, @job_url, @platform_job_id, @apply_method,
              @status, @date_applied, @date_last_updated, @notes, @created_at, @updated_at)`,
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
}
