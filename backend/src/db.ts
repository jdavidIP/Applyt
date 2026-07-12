import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_SQL } from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default DB location: backend/data/applications.db (gitignored).
// Overridable via DB_PATH env var (e.g. ':memory:' for tests).
function resolveDbPath(): string {
  const envPath = process.env.DB_PATH;
  if (envPath && envPath.trim() !== '') return envPath;
  // src/ -> ../data  (in dev) ; dist/ -> ../data (in build). Both land at backend/data.
  return resolve(__dirname, '..', 'data', 'applications.db');
}

export function createDb(dbPath: string = resolveDbPath()): Database.Database {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  migrate(db);
  return db;
}

// Additive, idempotent migrations for databases created before a column existed.
// SCHEMA_SQL uses CREATE TABLE IF NOT EXISTS, so a pre-existing table is never
// recreated — new columns must be added with ALTER TABLE here. Each step checks
// the live column set first so re-running is a harmless no-op.
function migrate(db: Database.Database): void {
  const hasColumn = (table: string, column: string): boolean =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
      (c) => c.name === column,
    );

  // Phase 4: job_description holds the JD text used as the AI tailoring input.
  if (!hasColumn('applications', 'job_description')) {
    db.exec('ALTER TABLE applications ADD COLUMN job_description TEXT');
  }

  // Phase 4 cost tracking: record what each tailor run consumed and cost.
  if (!hasColumn('resume_versions', 'model')) {
    db.exec('ALTER TABLE resume_versions ADD COLUMN model TEXT');
  }
  if (!hasColumn('resume_versions', 'input_tokens')) {
    db.exec('ALTER TABLE resume_versions ADD COLUMN input_tokens INTEGER');
  }
  if (!hasColumn('resume_versions', 'output_tokens')) {
    db.exec('ALTER TABLE resume_versions ADD COLUMN output_tokens INTEGER');
  }
  if (!hasColumn('resume_versions', 'cost')) {
    db.exec('ALTER TABLE resume_versions ADD COLUMN cost REAL');
  }
}
