// Triggers a browser "Save As" for an in-memory Blob (e.g. a PDF/DOCX
// downloaded via the API) without navigating away from the page.
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
