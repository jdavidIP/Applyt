// Mirrors backend/src/types.ts. Kept in sync manually (Phase 1 has no shared package).

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

export interface ApplicationInput {
  platform: Platform;
  company: string;
  title: string;
  job_url?: string | null;
  platform_job_id?: string | null;
  apply_method: ApplyMethod;
  status: Status;
  date_applied?: string;
  notes?: string | null;
}

export interface Filters {
  platform?: Platform | '';
  status?: Status | '';
  sort: 'date_applied' | 'date_last_updated';
  order: 'asc' | 'desc';
}
