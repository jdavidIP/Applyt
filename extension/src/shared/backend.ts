import type {
  ApplicationResult,
  CurrentJobInfo,
  DetectedApplication,
  PublicSettingsView,
  ResumeVersionResult,
} from './types';

// Same default port as backend/src/index.ts. Overridable so a user who
// changed PORT/HOST in their backend .env can point the extension at it too.
const DEFAULT_BASE_URL = 'http://127.0.0.1:4317';

export async function getBackendBaseUrl(): Promise<string> {
  const { backendBaseUrl } = await chrome.storage.sync.get('backendBaseUrl');
  return (backendBaseUrl as string | undefined)?.trim() || DEFAULT_BASE_URL;
}

// Pull the backend's own error message out of a non-2xx JSON body when present
// ({ error }), so the popup can show a useful reason (no base resume, bad key,
// provider failure) rather than a bare status line.
async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    return body.error ?? body.message ?? `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

export async function postApplication(app: DetectedApplication): Promise<void> {
  const base = await getBackendBaseUrl();
  const res = await fetch(`${base}/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(app),
  });
  if (!res.ok) {
    throw new Error(`Applyt backend rejected application: ${res.status} ${await res.text()}`);
  }
}

// ---- Popup tailoring (Phase 4): tailor a job before it's been applied to ----

export async function getSettings(): Promise<PublicSettingsView> {
  const base = await getBackendBaseUrl();
  const res = await fetch(`${base}/settings`);
  if (!res.ok) throw new Error(await errorDetail(res));
  return (await res.json()) as PublicSettingsView;
}

// Create (or upsert on platform+platform_job_id) a pending_confirmation row for
// the job the user is tailoring against, mirroring the external-redirect flow:
// the application is tracked as "not yet confirmed" and the existing detection
// machinery promotes it to 'applied' if the user completes an Easy Apply.
export async function createPendingApplication(job: CurrentJobInfo): Promise<ApplicationResult> {
  const base = await getBackendBaseUrl();
  const payload: DetectedApplication = {
    platform: job.platform,
    company: job.company,
    title: job.title,
    job_url: job.job_url,
    platform_job_id: job.platform_job_id,
    apply_method: 'external_redirect',
    status: 'pending_confirmation',
    job_description: job.job_description,
  };
  const res = await fetch(`${base}/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await errorDetail(res));
  return (await res.json()) as ApplicationResult;
}

export interface TailorOptions {
  includeMatchRating: boolean;
  includeSuggestions: boolean;
  targetOnePage: boolean;
}

export async function tailorApplication(
  applicationId: number,
  options: TailorOptions,
): Promise<ResumeVersionResult> {
  const base = await getBackendBaseUrl();
  const res = await fetch(`${base}/applications/${applicationId}/tailor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!res.ok) throw new Error(await errorDetail(res));
  return (await res.json()) as ResumeVersionResult;
}

export type ResumeDownloadFormat = 'pdf' | 'docx' | 'txt';

// Mirrors dashboard/src/api.ts's downloadResumeVersion — same server-side
// render endpoint, so the popup can offer the same PDF/Word/txt downloads
// right after generating, without needing to open the dashboard.
export async function downloadResumeVersion(
  applicationId: number,
  versionId: number,
  format: ResumeDownloadFormat,
): Promise<Blob> {
  const base = await getBackendBaseUrl();
  const res = await fetch(
    `${base}/applications/${applicationId}/resume-versions/${versionId}/download?format=${format}`,
  );
  if (!res.ok) throw new Error(await errorDetail(res));
  return res.blob();
}
