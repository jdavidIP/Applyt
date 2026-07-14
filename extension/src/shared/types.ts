// Mirrors backend/src/types.ts's CreateApplicationBody shape. Kept as a
// hand-copied subset (not a cross-workspace import) since the extension is
// bundled separately from the backend and ships to the Chrome Web Store.
export type Platform = 'indeed' | 'linkedin' | 'glassdoor' | 'manual';
export type ApplyMethod = 'in_platform' | 'external_redirect' | 'manual';

export interface DetectedApplication {
  platform: Platform;
  company: string;
  title: string;
  job_url: string;
  platform_job_id?: string;
  apply_method: ApplyMethod;
  status?: 'applied' | 'pending_confirmation';
  // Captured from the job posting page so the user doesn't have to paste it in
  // manually before using AI resume tailoring (Phase 4, CLAUDE.md §7).
  job_description?: string;
}

// The subset of a job posting the popup needs to tailor against it — the same
// fields the content scripts already resolve when an Apply is detected, minus
// the apply_method/status (the popup decides those). Returned by a content
// script in response to a GET_CURRENT_JOB message from the popup.
export interface CurrentJobInfo {
  platform: Platform;
  company: string;
  title: string;
  job_url: string;
  platform_job_id?: string;
  job_description?: string;
}

// Messages the background/popup exchange with content scripts.
// - APPLICATION_DETECTED: a content script reports an observed apply (→ backend).
// - GET_CURRENT_JOB: the popup asks the active tab's content script to extract
//   the job currently on screen so it can be tailored (response: CurrentJobInfo
//   or null when title/company can't be resolved).
export type RuntimeMessage =
  | { type: 'APPLICATION_DETECTED'; payload: DetectedApplication }
  | { type: 'GET_CURRENT_JOB' };

// Response to GET_CURRENT_JOB. null when the active page isn't a resolvable job.
export type CurrentJobResponse = CurrentJobInfo | null;

// Minimal view of GET /settings the popup reads to decide whether tailoring is
// possible before it creates anything (avoids leaving an orphan pending row if
// the backend would 400 for a missing resume/key). Mirrors the relevant fields
// of backend PublicSettings.
export interface PublicSettingsView {
  provider: 'anthropic' | 'openai';
  baseResume: string;
  hasAnthropicKey: boolean;
  hasOpenaiKey: boolean;
}

// The application row returned by POST /applications (create/upsert). The popup
// only needs the id to tailor against, but the rest mirrors backend Application.
export interface ApplicationResult {
  id: number;
  status: string;
  [key: string]: unknown;
}

// The resume_versions row returned by POST /applications/:id/tailor. Only the
// fields the popup renders are typed; tailored_output is the raw marker-delimited
// text parsed by parseTailoredResume (shared/tailoredResume.ts).
export interface ResumeVersionResult {
  id: number;
  tailored_output: string | null;
  ai_provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: number | null;
  created_at: string;
}
