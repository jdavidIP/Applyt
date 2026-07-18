import PDFDocument from 'pdfkit';
import { AlignmentType, BorderStyle, Document, Packer, Paragraph, TabStopType, TextRun } from 'docx';
import type { StructuredResume } from './resumeSchema.js';

// Turns a tailored resume into a downloadable PDF or DOCX. Only the resume
// section reaches here; the match rating and suggestions are shown in the
// dashboard, not written into the resume file.
//
// A `StructuredResume` (parseTailoredResume, tailoredResume.ts) renders into a
// proper single-page ATS template (renderStructuredPdf/renderStructuredDocx,
// below). A row from before the structured format existed only has flat text
// to work with — those fall back to the original dumb line-by-line renderer
// (renderPlainTextPdf/renderPlainTextDocx) unchanged, so old resume_versions
// rows keep downloading exactly as they always have.

interface ParsedLine {
  text: string;
  bullet: boolean;
}

const BULLET_PREFIX = /^[-*•]\s+/;

// Shared by both plain-text renderers so a bulleted line ("- Led a team of 5…")
// looks like a bullet in both PDF and DOCX output rather than a stray dash.
function parseLines(text: string): ParsedLine[] {
  return text.split('\n').map((line) => ({
    text: BULLET_PREFIX.test(line) ? line.replace(BULLET_PREFIX, '') : line,
    bullet: BULLET_PREFIX.test(line),
  }));
}

function renderPlainTextPdf(resumeText: string): Promise<Buffer> {
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

async function renderPlainTextDocx(resumeText: string): Promise<Buffer> {
  const paragraphs = parseLines(resumeText).map((line) => {
    if (line.text.trim() === '') return new Paragraph({ text: '' });
    if (line.bullet) return new Paragraph({ text: line.text, bullet: { level: 0 } });
    return new Paragraph({ text: line.text });
  });
  const doc = new Document({ sections: [{ children: paragraphs }] });
  return Packer.toBuffer(doc);
}

// ---- ATS template (StructuredResume) rendering ----

const ACCENT_COLOR = '#1a56c4'; // hex, no leading # for docx APIs — stripped where needed

function accentHex(): string {
  return ACCENT_COLOR.replace('#', '');
}

function contactLineParts(resume: StructuredResume): string[] {
  const { contact } = resume;
  return [contact.email, contact.phone, ...(contact.links ?? []), contact.location].filter(
    (v): v is string => Boolean(v),
  );
}

function experienceDateRange(startDate: string, endDate: string): string {
  return [startDate, endDate].filter(Boolean).join(' – ');
}

// ---- PDF ----
// pdfkit has no auto-reflow/shrink-to-fit, so this renders at a fixed compact
// scale rather than measuring and retrying — a resume long enough to overflow
// one page will spill to a second page. Documented, accepted limitation
// rather than building a measure+shrink retry loop (DOCX has no such risk,
// since Word reflows on open).

const PDF_MARGIN = 48;

function renderStructuredPdf(resume: StructuredResume): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PDF_MARGIN, size: 'LETTER' });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const contentWidth = doc.page.width - PDF_MARGIN * 2;

    // pdfkit auto-paginates mid-`text()` call when the given position doesn't
    // fit the remaining page height. titleDateRow draws its left and right
    // halves as two separate .text() calls sharing one captured `y` — if the
    // first call triggers an implicit page break, that `y` (a bottom-of-old-
    // page value) is stale on the new page, so the second call lands far down
    // the new page instead of alongside the first, producing a huge blank gap
    // (and sometimes a further implicit page break of its own). Forcing the
    // page break ourselves, before either call, keeps both halves on one page.
    function ensureSpace(minHeight: number) {
      const bottom = doc.page.height - doc.page.margins.bottom;
      if (doc.y + minHeight > bottom) {
        doc.addPage();
        doc.x = PDF_MARGIN;
      }
    }

    // Header: centered name + contact line.
    doc.font('Helvetica-Bold').fontSize(18).fillColor(ACCENT_COLOR).text(resume.contact.name, { align: 'center' });
    const contactLine = contactLineParts(resume).join('  |  ');
    if (contactLine) {
      doc.moveDown(0.15);
      doc.font('Helvetica').fontSize(9).fillColor('black').text(contactLine, { align: 'center' });
    }
    doc.moveDown(0.6);

    // titleDateRow explicitly repositions doc.x to the date column when it
    // draws the date; every subsequent left-margin block must reset doc.x
    // back to PDF_MARGIN itself rather than trust the cursor left behind by
    // whatever ran before it (see titleDateRow).
    function sectionHeader(label: string) {
      // Reserve room for the header rule plus at least the start of its first
      // row, so a header never ends up alone at the bottom of a page.
      ensureSpace(50);
      doc.x = PDF_MARGIN;
      doc.font('Helvetica-Bold').fontSize(11).fillColor(ACCENT_COLOR).text(label.toUpperCase());
      const y = doc.y + 1;
      doc
        .moveTo(PDF_MARGIN, y)
        .lineTo(PDF_MARGIN + contentWidth, y)
        .strokeColor(ACCENT_COLOR)
        .lineWidth(0.75)
        .stroke();
      doc.moveDown(0.4);
      doc.fillColor('black');
    }

    // Enough width at 9.5pt oblique for the longest realistic date range
    // ("January 2025 – August 2025"); reserving this keeps the left text from
    // wrapping into the date column instead of wrapping earlier and cleanly.
    const DATE_COLUMN_WIDTH = 140;
    const DATE_COLUMN_GUTTER = 8;

    // Left title/company + right-aligned date on the same line: pin both
    // calls to the same starting y, since pdfkit has no native two-column
    // same-line layout primitive. The left text's own width is narrowed to
    // leave room for the date column, and — since a long title/institution
    // can legitimately wrap to two lines — the row's final doc.y is set to
    // whichever call (the possibly-multi-line left text, or the single-line
    // date) actually ends lower, so content drawn after this row never lands
    // on top of a wrapped second line.
    function titleDateRow(leftBold: string, leftAccent: string, date: string) {
      const leftWidth = date ? contentWidth - DATE_COLUMN_WIDTH - DATE_COLUMN_GUTTER : contentWidth;
      // Reserve space for the row (both halves share one `y` below) before
      // drawing anything — see the ensureSpace comment above for why.
      doc.font('Helvetica-Bold').fontSize(10.5);
      const estimatedHeight = doc.heightOfString(leftBold + leftAccent, { width: leftWidth });
      ensureSpace(Math.max(estimatedHeight, 14));

      const y = doc.y;
      doc
        .font('Helvetica-Bold')
        .fontSize(10.5)
        .fillColor('black')
        .text(leftBold, PDF_MARGIN, y, { continued: leftAccent.length > 0, width: leftWidth });
      if (leftAccent) {
        doc.font('Helvetica').fillColor(ACCENT_COLOR).text(leftAccent);
      }
      const afterLeftY = doc.y;

      if (date) {
        doc
          .font('Helvetica-Oblique')
          .fontSize(9.5)
          .fillColor('black')
          .text(date, PDF_MARGIN + contentWidth - DATE_COLUMN_WIDTH, y, {
            width: DATE_COLUMN_WIDTH,
            align: 'right',
          });
      }
      doc.y = Math.max(doc.y, afterLeftY);
      doc.fillColor('black');
    }

    function bulletList(bullets: string[]) {
      const bulletIndent = 12;
      for (const bullet of bullets) {
        ensureSpace(14);
        const y = doc.y;
        doc.font('Helvetica').fontSize(9.5).fillColor('black').text('•', PDF_MARGIN, y, { width: bulletIndent });
        doc.text(bullet, PDF_MARGIN + bulletIndent, y, { width: contentWidth - bulletIndent });
      }
    }

    if (resume.summary) {
      sectionHeader('Professional Summary');
      doc.x = PDF_MARGIN;
      doc.font('Helvetica').fontSize(9.5).fillColor('black').text(resume.summary, { width: contentWidth });
      doc.moveDown(0.5);
    }

    if (resume.experience.length) {
      sectionHeader('Professional Experience');
      for (const e of resume.experience) {
        // Parenthetical location ("Company (City, ST)") stays compact and
        // keeps the whole title/company/location on one line far more often
        // than a comma-appended location, which tends to wrap mid-location.
        titleDateRow(e.title, ` — ${e.company}${e.location ? ` (${e.location})` : ''}`, experienceDateRange(e.startDate, e.endDate));
        doc.moveDown(0.15);
        bulletList(e.bullets);
        doc.moveDown(0.4);
      }
    }

    if (resume.projects?.length) {
      sectionHeader('Projects');
      for (const p of resume.projects) {
        titleDateRow(p.name, '', p.dateRange ?? '');
        doc.moveDown(0.15);
        bulletList(p.bullets);
        doc.moveDown(0.4);
      }
    }

    if (resume.skills.length) {
      sectionHeader('Technical Skills');
      for (const s of resume.skills) {
        doc.x = PDF_MARGIN;
        doc
          .font('Helvetica-Bold')
          .fontSize(9.5)
          .fillColor('black')
          .text(`${s.label}: `, { continued: true, width: contentWidth })
          .font('Helvetica')
          .text(s.items.join(', '));
      }
      doc.moveDown(0.5);
    }

    if (resume.education.length) {
      sectionHeader('Education');
      for (const e of resume.education) {
        // Degree gets its own bold line with the date; institution goes on a
        // separate italic line below rather than crammed into one combined
        // title — "institution — degree" easily overflows the left column
        // and wraps awkwardly (see resumeRender.ts history / Issue #23).
        titleDateRow(e.degree, '', e.dates);
        doc.moveDown(0.1);
        doc.x = PDF_MARGIN;
        doc.font('Helvetica-Oblique').fontSize(9.5).fillColor('black').text(e.institution, { width: contentWidth });
        if (e.honors) {
          doc.moveDown(0.1);
          doc.x = PDF_MARGIN;
          doc.font('Helvetica-Oblique').fontSize(9).fillColor('black').text(e.honors, { width: contentWidth });
        }
        if (e.coursework) {
          doc.moveDown(0.1);
          doc.x = PDF_MARGIN;
          doc.font('Helvetica').fontSize(9).fillColor('black').text(e.coursework, { width: contentWidth });
        }
        doc.moveDown(0.3);
      }
    }

    doc.end();
  });
}

// ---- DOCX ----
// docx exposes real primitives for the layout tricks pdfkit has to hand-roll
// (paragraph border for the section-header rule, tabStops for left/right rows,
// native hanging indent for bullets) — lower risk, and no page-fit concern
// since Word reflows content on open.

const DOCX_MARGIN_TWIPS = 720; // 0.5"
const DOCX_PAGE_WIDTH_TWIPS = 12240; // US Letter, 8.5" * 1440
const DOCX_CONTENT_WIDTH_TWIPS = DOCX_PAGE_WIDTH_TWIPS - DOCX_MARGIN_TWIPS * 2;

function docxSectionHeader(label: string): Paragraph {
  return new Paragraph({
    spacing: { before: 200, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: accentHex(), space: 1 } },
    children: [new TextRun({ text: label.toUpperCase(), bold: true, color: accentHex(), size: 20 })],
  });
}

function docxTitleDateRow(leftBold: string, leftAccent: string, date: string): Paragraph {
  const children = [new TextRun({ text: leftBold, bold: true, size: 21 })];
  if (leftAccent) children.push(new TextRun({ text: leftAccent, color: accentHex(), size: 21 }));
  if (date) children.push(new TextRun({ text: `\t${date}`, italics: true, size: 19 }));
  return new Paragraph({
    tabStops: [{ type: TabStopType.RIGHT, position: DOCX_CONTENT_WIDTH_TWIPS }],
    children,
  });
}

function docxBullets(bullets: string[]): Paragraph[] {
  return bullets.map(
    (bullet) =>
      new Paragraph({
        text: bullet,
        bullet: { level: 0 },
        indent: { left: 360, hanging: 360 },
      }),
  );
}

async function renderStructuredDocx(resume: StructuredResume): Promise<Buffer> {
  const children: Paragraph[] = [];

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: resume.contact.name, bold: true, color: accentHex(), size: 36 })],
    }),
  );
  const contactLine = contactLineParts(resume).join('  |  ');
  if (contactLine) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: contactLine, size: 18 })],
      }),
    );
  }

  if (resume.summary) {
    children.push(docxSectionHeader('Professional Summary'));
    children.push(new Paragraph({ text: resume.summary }));
  }

  if (resume.experience.length) {
    children.push(docxSectionHeader('Professional Experience'));
    for (const e of resume.experience) {
      children.push(
        docxTitleDateRow(e.title, ` — ${e.company}${e.location ? ` (${e.location})` : ''}`, experienceDateRange(e.startDate, e.endDate)),
      );
      children.push(...docxBullets(e.bullets));
    }
  }

  if (resume.projects?.length) {
    children.push(docxSectionHeader('Projects'));
    for (const p of resume.projects) {
      children.push(docxTitleDateRow(p.name, '', p.dateRange ?? ''));
      children.push(...docxBullets(p.bullets));
    }
  }

  if (resume.skills.length) {
    children.push(docxSectionHeader('Technical Skills'));
    for (const s of resume.skills) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${s.label}: `, bold: true }),
            new TextRun({ text: s.items.join(', ') }),
          ],
        }),
      );
    }
  }

  if (resume.education.length) {
    children.push(docxSectionHeader('Education'));
    for (const e of resume.education) {
      children.push(docxTitleDateRow(e.degree, '', e.dates));
      children.push(new Paragraph({ children: [new TextRun({ text: e.institution, italics: true, size: 19 })] }));
      if (e.honors) children.push(new Paragraph({ children: [new TextRun({ text: e.honors, italics: true, size: 18 })] }));
      if (e.coursework) children.push(new Paragraph({ children: [new TextRun({ text: e.coursework, size: 18 })] }));
    }
  }

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: { top: DOCX_MARGIN_TWIPS, bottom: DOCX_MARGIN_TWIPS, left: DOCX_MARGIN_TWIPS, right: DOCX_MARGIN_TWIPS },
          },
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

export function renderPdf(resume: StructuredResume | string): Promise<Buffer> {
  return typeof resume === 'string' ? renderPlainTextPdf(resume) : renderStructuredPdf(resume);
}

export async function renderDocx(resume: StructuredResume | string): Promise<Buffer> {
  return typeof resume === 'string' ? renderPlainTextDocx(resume) : renderStructuredDocx(resume);
}
