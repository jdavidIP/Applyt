// Mirrors dashboard/src/download.ts — hand-copied per this codebase's existing
// convention for small cross-surface utilities (see resumeSchema.ts/tailoredResume.ts).
// Triggers a browser "Save As" for an in-memory Blob (e.g. a PDF/DOCX
// downloaded via the API) without navigating away from the popup.
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
