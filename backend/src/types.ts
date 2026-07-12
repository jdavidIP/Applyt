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
