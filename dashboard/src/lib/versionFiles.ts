import type { AttachmentKind, ResumeDownloadFormat, ResumeVersion } from '../types';

// Generated versions render any format on demand. File versions (the user's own
// attached files) only offer the formats actually attached; their txt is the
// extracted text of what was attached, so it needs a file of that kind too —
// otherwise a cover-letter-only version would hand out cover-letter text as
// "…-resume.txt".
export function canDownload(
  version: ResumeVersion,
  kind: AttachmentKind,
  format: ResumeDownloadFormat,
): boolean {
  if (version.ai_provider !== 'file') return true;
  return version.files.some((f) => f.kind === kind && (format === 'txt' || f.format === format));
}
