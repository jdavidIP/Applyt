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
}

export interface RuntimeMessage {
  type: 'APPLICATION_DETECTED';
  payload: DetectedApplication;
}
