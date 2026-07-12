// SQLite DDL — mirrors CLAUDE.md Section 5 exactly.
// Kept as a TS string constant (rather than a .sql file read at runtime) so it
// resolves identically under `tsx` dev and compiled `dist/` builds with no copy step.
// Uses CREATE TABLE IF NOT EXISTS so startup is idempotent.

export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,                       -- 'indeed' | 'linkedin' | 'glassdoor' | 'manual'
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  job_url TEXT,
  platform_job_id TEXT,                         -- jk (Indeed), jobId (LinkedIn), listingId (Glassdoor)
  apply_method TEXT NOT NULL,                   -- 'in_platform' | 'external_redirect' | 'manual'
  status TEXT NOT NULL DEFAULT 'applied',       -- applied | pending_confirmation | interviewing | rejected | offer | ghosted | stale
  date_applied TEXT NOT NULL,
  date_last_updated TEXT NOT NULL,
  notes TEXT,
  job_description TEXT,                          -- pasted/edited JD text; the tailoring input (Phase 4)
  resume_version_id INTEGER REFERENCES resume_versions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Created now for schema completeness; unused until Phase 4 (AI resume tailoring).
CREATE TABLE IF NOT EXISTS resume_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER REFERENCES applications(id),
  base_resume_snapshot TEXT,
  tailored_output TEXT,
  ai_provider TEXT,                             -- 'anthropic' | 'openai'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_platform ON applications(platform);
`;
