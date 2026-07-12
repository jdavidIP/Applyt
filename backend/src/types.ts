// Shared domain types for the application tracker.
// The union values here MUST stay in sync with the CHECK-able sets enforced in
// validation.ts and with the SQLite schema (schema.ts / Section 5 of CLAUDE.md).

export const PLATFORMS = ['indeed', 'linkedin', 'glassdoor', 'manual'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const APPLY_METHODS = ['in_platform', 'external_redirect', 'manual'] as const;
export type ApplyMethod = (typeof APPLY_METHODS)[number];

export const STATUSES = [
  'applied',
  'pending_confirmation',
  'interviewing',
  'rejected',
  'offer',
  'ghosted',
  'stale',
] as const;
export type Status = (typeof STATUSES)[number];

export interface Application {
  id: number;
  platform: Platform;
  company: string;
  title: string;
  job_url: string | null;
  platform_job_id: string | null;
  apply_method: ApplyMethod;
  status: Status;
  date_applied: string;
  date_last_updated: string;
  notes: string | null;
  job_description: string | null;
  resume_version_id: number | null;
  created_at: string;
  updated_at: string;
}

// Fields a client (dashboard manual add, or the Phase 2 extension) may send on create.
// Keep this compatible with the extension's "capture at minimum" set (CLAUDE.md §6):
// company, title, job_url, platform_job_id, platform, apply_method.
export interface CreateApplicationBody {
  platform?: Platform;
  company: string;
  title: string;
  job_url?: string | null;
  platform_job_id?: string | null;
  apply_method?: ApplyMethod;
  status?: Status;
  date_applied?: string;
  notes?: string | null;
  job_description?: string | null;
}

export interface UpdateApplicationBody {
  platform?: Platform;
  company?: string;
  title?: string;
  job_url?: string | null;
  platform_job_id?: string | null;
  apply_method?: ApplyMethod;
  status?: Status;
  date_applied?: string;
  notes?: string | null;
  job_description?: string | null;
}

export interface ListApplicationsQuery {
  platform?: Platform;
  status?: Status;
  sort?: 'date_applied' | 'date_last_updated';
  order?: 'asc' | 'desc';
}

export interface MarkStaleBody {
  thresholdDays: number;
}

export interface BulkDeleteQuery {
  status: Status;
}

export interface WeeklyCount {
  weekStart: string; // ISO date (Monday) the week bucket starts on
  count: number;
}

export interface StatsResponse {
  totalApplications: number;
  perWeek: WeeklyCount[];
  responseRate: number | null; // null when there's no denominator (no non-pending applications yet)
}

// ---- Phase 4: AI resume tailoring ----

export const AI_PROVIDERS = ['anthropic', 'openai'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

// The full settings record as persisted to backend/data/settings.json. Holds
// the user's own secrets and never leaves the machine except as an outbound
// call to the chosen AI provider (CLAUDE.md §3/§4).
export interface Settings {
  provider: AiProvider;
  model: string;
  anthropicApiKey: string;
  openaiApiKey: string;
  baseResume: string;
}

// What a client may send to update settings — every field optional (partial
// update). API keys are write-only: absent means "leave unchanged", empty
// string means "clear it".
export interface UpdateSettingsBody {
  provider?: AiProvider;
  model?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  baseResume?: string;
}

// What GET /settings returns — secrets are never sent back to the client, only
// booleans indicating whether each key is configured (via file or env).
export interface PublicSettings {
  provider: AiProvider;
  model: string;
  baseResume: string;
  hasAnthropicKey: boolean;
  hasOpenaiKey: boolean;
}

export interface ResumeVersion {
  id: number;
  application_id: number | null;
  base_resume_snapshot: string | null;
  tailored_output: string | null;
  ai_provider: string | null;
  created_at: string;
}
