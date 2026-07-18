import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { renderPdf } from '../src/resumeRender.ts';
import type { StructuredResume } from '../src/resumeSchema.ts';

// Regression coverage for Issue #23: titleDateRow drew its left (title/company)
// and right (date) halves as two separate pdfkit .text() calls sharing one
// captured `y`. When the left call's text was long enough to trigger pdfkit's
// own implicit page break, that `y` (a bottom-of-old-page value) became stale
// on the new page, so the date landed far down the new page — sometimes
// triggering a further implicit page break of its own. In real output this
// showed up as a resume that should fit on ~1-2 pages spilling across 3, with
// large blank gaps in between. resumeRender.ts now reserves space for a row
// before drawing either half (ensureSpace), so a full page break happens
// before the row starts instead of in the middle of it.

// A resume built to reproduce the reported bug shape: a long combined
// experience location and, worse, an education "degree" so long it wraps —
// exactly what the AI produced in the reported case (distinction/major text
// appended to degree instead of kept in `honors`, per the pre-fix behavior).
const PATHOLOGICAL_RESUME: StructuredResume = {
  contact: { name: 'Jose David Ibanez', email: 'jdavidip2022@gmail.com', location: 'Mississauga, ON' },
  summary:
    'Early-career full-stack software developer with a Computer Science degree (Cybersecurity major) and hands-on professional experience across React, Node.js, C#/ASP.NET, PHP, and SQL/relational databases.',
  experience: [
    {
      title: 'Junior Software Developer, Contract, Full Time',
      company: 'Kraken Sense',
      location: 'Oakville, ON, Canada',
      startDate: 'May 2025',
      endDate: 'Present',
      bullets: [
        'Designed, developed, and maintained 3 internal full-stack applications using React, Node.js, FastAPI, and PostgreSQL to support operational workflows.',
        'Built and enhanced backend APIs implementing business logic, database interactions, and service integrations.',
      ],
    },
  ],
  education: [
    {
      institution: 'Conestoga College, Waterloo',
      degree: 'Bachelor of Computer Science – Honours (Co-op), With Distinction, Major in Cybersecurity',
      dates: '2021 – 2025',
      honors: 'With Distinction',
      coursework:
        'Relevant Coursework: Software Design Techniques, Data Structures and Algorithms, Software Development Life Cycle, Software Quality, Object Oriented Programming, Database Systems, Applied Cryptography, Network Security',
    },
  ],
  skills: [{ label: 'Languages', items: ['Python', 'JavaScript', 'TypeScript', 'C#'] }],
};

test('PDF: a resume with a long education title/date row does not spill the row across a huge blank gap or extra pages', async () => {
  const buffer = await renderPdf(PATHOLOGICAL_RESUME);
  const parser = new PDFParse({ data: buffer });
  const { pages } = await parser.getText();

  // Before the fix, this exact shape produced 3 pages: the education title
  // wrapped onto a near-empty page 2, then the date/institution/coursework
  // (using the stale pre-page-break `y`) landed on a near-empty page 3.
  assert.ok(pages.length <= 2, `expected at most 2 pages, got ${pages.length}`);

  const educationPage = pages.find((p) => p.text.includes('Conestoga College'));
  assert.ok(educationPage, 'education content should be present in the output');
  // The whole education entry — title row, institution, honors, and
  // coursework — must land together on one page, not split by a stale-y gap.
  assert.match(educationPage!.text, /2021.*2025/s);
  assert.match(educationPage!.text, /Conestoga College/);
  assert.match(educationPage!.text, /Relevant Coursework/);
});

test('PDF: experience location renders as a compact parenthetical rather than a comma-appended tail', async () => {
  const buffer = await renderPdf(PATHOLOGICAL_RESUME);
  const parser = new PDFParse({ data: buffer });
  const { text } = await parser.getText();
  const flat = text.replace(/\s+/g, ' ');
  assert.match(flat, /Kraken Sense \(Oakville, ON, Canada\)/);
});

test('PDF: education degree and institution render as separate lines, not one combined title', async () => {
  const buffer = await renderPdf(PATHOLOGICAL_RESUME);
  const parser = new PDFParse({ data: buffer });
  const { text } = await parser.getText();
  const flat = text.replace(/\s+/g, ' ');
  // The old template rendered "${institution} — ${degree}" as one bold
  // title; the new one puts institution on its own line below the degree.
  assert.doesNotMatch(flat, /Conestoga College, Waterloo — Bachelor/);
});
