// Mirrors backend/src/types.ts. Kept in sync manually (Phase 1 has no shared package).

import type { StructuredResume } from './resumeSchema';

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
  job_description?: string | null;
}

export interface Filters {
  platform?: Platform | '';
  status?: Status | '';
  sort: 'date_applied' | 'date_last_updated';
  order: 'asc' | 'desc';
}

export interface WeeklyCount {
  weekStart: string;
  count: number;
}

export interface StatsResponse {
  totalApplications: number;
  perWeek: WeeklyCount[];
  responseRate: number | null;
}

// ---- Phase 4: AI resume tailoring ----

export const AI_PROVIDERS = ['anthropic', 'openai'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

// Per-model pricing (USD per million tokens), user-editable in Settings.
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}
export type ModelPricing = Record<string, ModelPrice>;

// Client-safe settings view from GET /settings — never includes raw API keys.
export interface PublicSettings {
  provider: AiProvider;
  model: string;
  baseResume: string;
  hasAnthropicKey: boolean;
  hasOpenaiKey: boolean;
  modelPricing: ModelPricing;
}

// Partial update sent to PUT /settings. API keys are write-only: omit to leave
// unchanged, send '' to clear. modelPricing, when sent, replaces the whole table.
export interface SettingsInput {
  provider?: AiProvider;
  model?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  baseResume?: string;
  modelPricing?: ModelPricing;
}

export interface ResumeVersion {
  id: number;
  application_id: number | null;
  base_resume_snapshot: string | null;
  tailored_output: string | null;
  ai_provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: number | null;
  input_char_length: number | null;
  created_at: string;
}

// Body for POST /:id/tailor — lets the user opt out of the match rating
// and/or suggestions sections (any combination). Omitted fields default to
// true on the backend. targetOnePage defaults to false on the backend: asks
// the model to prioritize/condense content relevant to the job posting to fit
// one page (advisory, not guaranteed).
export interface TailorOptions {
  includeMatchRating?: boolean;
  includeSuggestions?: boolean;
  targetOnePage?: boolean;
}

// Pre-generate cost estimate from GET /:id/tailor-estimate, shown before
// spending real money on a tailor run.
export interface TailorEstimate {
  estimatedCost: number | null;
  source: 'historical' | 'static' | 'unavailable';
  sampleSize?: number;
  model: string;
}

// The sections a tailor run produces, parsed from the raw tailored_output blob
// (see tailoredResume.ts). Mirrors backend/src/types.ts. `structured` is only
// populated for rows written in the new JSON format (see resumeSchema.ts);
// older rows get `structured: null` and the dashboard just shows the
// flattened `resume` text as before.
export interface TailoredSections {
  resume: string;
  structured: StructuredResume | null;
  matchRating: number | null; // integer 0–5; 5 = strongest match, 0 = out of scope
  matchJustification: string;
  suggestions: string;
}

// GET /settings/models response — model ids available from the user's own
// provider account, for populating the Settings model field.
export interface ModelsResponse {
  models: string[];
}

// GET /settings/known-pricing response — a curated, dated snapshot of
// published provider prices, used to "sync known prices" in Settings.
export interface KnownPricingResponse {
  asOf: string;
  pricing: ModelPricing;
}

// POST /settings/base-resume/extract response — plain text extracted from an
// uploaded PDF/DOCX resume, for review/editing before saving via the normal
// baseResume field. Never saved automatically.
export interface ExtractResumeTextResponse {
  text: string;
}

// GET /applications/:id/resume-versions/:versionId/download?format=
export const RESUME_DOWNLOAD_FORMATS = ['pdf', 'docx', 'txt'] as const;
export type ResumeDownloadFormat = (typeof RESUME_DOWNLOAD_FORMATS)[number];
