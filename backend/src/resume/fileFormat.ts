// Content-based format detection for user-attached resume / cover-letter
// files. The extension and client-sent MIME type are never trusted: the
// leading bytes decide, so a renamed text file (or an .xlsx renamed to
// .docx — also a ZIP) is rejected instead of being stored as a "resume".

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export const FORMAT_MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;

const ZIP_LOCAL_HEADER = 0x04034b50;
const WORD_ENTRY = 'word/document.xml';

// Walks the ZIP's local file headers looking for word/document.xml — a few
// lines instead of a zip dependency. Entries written with a data descriptor
// (flag bit 3) record a 0 size up front, so the walk can't skip their data;
// fall back to a plain byte search in that case.
function zipHasWordDocument(buf: Buffer): boolean {
  let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === ZIP_LOCAL_HEADER) {
    const flags = buf.readUInt16LE(off + 6);
    const compressedSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    if (buf.toString('latin1', off + 30, off + 30 + nameLen) === WORD_ENTRY) return true;
    if (flags & 0x8) return buf.includes(WORD_ENTRY, off, 'latin1');
    off += 30 + nameLen + extraLen + compressedSize;
  }
  return false;
}

export function detectFileFormat(buf: Buffer): 'pdf' | 'docx' | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.length >= 4 && buf.readUInt32LE(0) === ZIP_LOCAL_HEADER && zipHasWordDocument(buf)) return 'docx';
  return null;
}
