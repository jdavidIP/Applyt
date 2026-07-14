import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph } from 'docx';

// Turns a tailored resume's plain text (already extracted from the full model
// output by parseTailoredResume — see tailoredResume.ts) into a downloadable
// PDF or DOCX. Only the resume section reaches here; the match rating and
// suggestions are shown in the dashboard, not written into the resume file.

interface ParsedLine {
  text: string;
  bullet: boolean;
}

const BULLET_PREFIX = /^[-*•]\s+/;

// Shared by both renderers so a bulleted line ("- Led a team of 5…") looks
// like a bullet in both PDF and DOCX output rather than a stray dash.
function parseLines(text: string): ParsedLine[] {
  return text.split('\n').map((line) => ({
    text: BULLET_PREFIX.test(line) ? line.replace(BULLET_PREFIX, '') : line,
    bullet: BULLET_PREFIX.test(line),
  }));
}

export function renderPdf(resumeText: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 54 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    for (const line of parseLines(resumeText)) {
      if (line.text.trim() === '') {
        doc.moveDown(0.5);
      } else if (line.bullet) {
        doc.text(`•  ${line.text}`, { indent: 18 });
      } else {
        doc.text(line.text);
      }
    }
    doc.end();
  });
}

export async function renderDocx(resumeText: string): Promise<Buffer> {
  const paragraphs = parseLines(resumeText).map((line) => {
    if (line.text.trim() === '') return new Paragraph({ text: '' });
    if (line.bullet) return new Paragraph({ text: line.text, bullet: { level: 0 } });
    return new Paragraph({ text: line.text });
  });
  const doc = new Document({ sections: [{ children: paragraphs }] });
  return Packer.toBuffer(doc);
}
