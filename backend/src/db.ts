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
  return db;
}
