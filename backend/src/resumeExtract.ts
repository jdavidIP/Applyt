import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

// Phase 4 follow-up (CLAUDE.md §8: "PDF/docx parsing library choice"). Extracts
// plain text from an uploaded base-resume file so it can be dropped into the
// existing baseResume textarea for the user to review/edit before saving —
// extraction quality is inherently imperfect (column layouts, tables), so this
// never writes to settings directly.
const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const LEGACY_DOC_MIME = 'application/msword';

// Collapse the ragged spacing PDF/DOCX extraction tends to produce (runs of
// blank lines from column layouts, trailing whitespace per line) so the user
// isn't reviewing a mess before they've even started editing.
function normalizeWhitespace(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    // Join per-page text ourselves rather than using the library's own
    // concatenated `.text` field, which interleaves a "-- N of M --" page
    // separator marker that would otherwise pollute the resume text.
    const { pages } = await parser.getText();
    return pages.map((p) => p.text).join('\n\n');
  } finally {
    await parser.destroy();
  }
}

export async function extractResumeText(buffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType === PDF_MIME) {
    const text = await extractPdfText(buffer);
    return normalizeWhitespace(text);
  }
  if (mimeType === DOCX_MIME) {
    const { value } = await mammoth.extractRawText({ buffer });
    return normalizeWhitespace(value);
  }
  if (mimeType === LEGACY_DOC_MIME) {
    throw new Error('Legacy .doc files are not supported — please save as .docx or .pdf.');
  }
  throw new Error('Unsupported file type — upload a PDF or Word (.docx) file.');
}
