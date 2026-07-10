import type { DetectedApplication } from './types';

// Same default port as backend/src/index.ts. Overridable so a user who
// changed PORT/HOST in their backend .env can point the extension at it too.
const DEFAULT_BASE_URL = 'http://127.0.0.1:4317';

export async function getBackendBaseUrl(): Promise<string> {
  const { backendBaseUrl } = await chrome.storage.sync.get('backendBaseUrl');
  return (backendBaseUrl as string | undefined)?.trim() || DEFAULT_BASE_URL;
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
