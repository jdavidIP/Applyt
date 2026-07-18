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

// A resume built at the same scale as the actual reported PDF: enough
// experience/project content to push the Education section far enough down
// page 1 that the old renderer's mid-row page-break bug actually triggers
// (a shorter fixture renders in 1 clean page on both old and new code and
// wouldn't catch a regression — verified by running this fixture against
// the pre-fix renderer, which produces 3 pages; the fixed renderer collapses
// it to 2). Also reproduces the pathological "degree" the AI actually
// produced in the report: distinction/major text appended to degree instead
// of kept in `honors`.
const PATHOLOGICAL_RESUME: StructuredResume = {
  contact: {
    name: 'Jose David Ibanez',
    email: 'jdavidip2022@gmail.com',
    phone: '+1 (548) 390-4453',
    links: ['github.com/jdavidIP', 'linkedin.com/in/jose-david-ibanez-622314253'],
    location: 'Mississauga, ON',
  },
  summary:
    'Early-career full-stack software developer with a Computer Science degree (Cybersecurity major) and hands-on professional experience across React, Node.js, C#/ASP.NET, PHP, and SQL/relational databases. Comfortable working in Agile teams, writing and testing production code, resolving defects, and supporting deployments on cloud platforms (GCP, with AWS Cloud Practitioner study in progress). Strong foundation in OOP, software design, testing practices, and version control/CI-CD, with a demonstrated ability to quickly learn new stacks and contribute across the full software development lifecycle.',
  experience: [
    {
      title: 'Junior Software Developer, Contract, Full Time',
      company: 'Kraken Sense',
      location: 'Oakville, ON, Canada',
      startDate: 'May 2025',
      endDate: 'Present',
      bullets: [
        'Designed, developed, and maintained 3 internal full-stack applications using React, Node.js, FastAPI, and PostgreSQL to support operational workflows.',
        'Built and enhanced backend APIs implementing business logic, database interactions, and service integrations, collaborating closely with engineers in an Agile, iterative development cycle.',
        'Performed QA testing and debugged issues across frontend, backend, and database systems, identifying and resolving problems prior to release.',
        'Managed PostgreSQL databases and supported deployments on Google Cloud Platform (Cloud Run, Cloud SQL), contributing to CI/CD pipelines.',
        'Used AI-assisted tools (Claude, GitHub Copilot) to accelerate testing, debugging, and development workflows.',
      ],
    },
    {
      title: 'Junior Software Developer Intern',
      company: 'Agro-Costa SAS',
      location: 'Barranquilla, Colombia',
      startDate: 'May 2024',
      endDate: 'December 2024',
      bullets: [
        'Developed and maintained backend services using PHP, ASP.NET, and Node.js, implementing business logic, API integrations, and database-driven workflows in a production environment.',
        'Practiced test-driven development to validate business logic before implementation, improving code reliability and reducing production regressions.',
        'Implemented role-based access control (RBAC) to manage multiple user types, improving administrative workflows and increasing platform engagement by 30%.',
        'Identified, investigated, and resolved production issues across frontend, backend, and data systems, tracing bugs to their root cause across the stack.',
        'Designed and optimized SQL Server and MySQL queries, and tracked work using Azure DevOps throughout the development lifecycle.',
      ],
    },
  ],
  projects: [
    {
      name: 'Simple Rentals – Full Stack Web App',
      dateRange: 'January 2025 – August 2025',
      bullets: [
        'Built backend using Django REST Framework and PostgreSQL, with a responsive React frontend, as part of a small team.',
        'Built the testing and CI/CD infrastructure: unit and end-to-end tests with Cypress and Vitest, and automated pipelines with GitHub Actions on every push and pull request.',
        'Applied test-driven development and managed tasks via Azure DevOps, with containerized deployment using Docker.',
      ],
    },
    {
      name: 'Real-Time Object Detection & Tracking System',
      dateRange: '2023 – 2024',
      bullets: [
        'Built a Python computer vision application using OpenCV and YOLO, implementing the detection pipeline end-to-end and tuning parameters for accuracy and performance.',
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
  skills: [
    { label: 'Languages', items: ['Python', 'JavaScript', 'TypeScript', 'C#', 'C', 'C++', 'PHP', 'SQL', 'HTML5', 'CSS3'] },
    { label: 'Web & Backend', items: ['React', 'Node.js', 'FastAPI', 'Django', 'ASP.NET', 'PHP', 'REST API design & integration'] },
    { label: 'Databases', items: ['PostgreSQL', 'MySQL', 'Microsoft SQL Server', 'MongoDB', 'SQLite', 'Redis'] },
    { label: 'Testing & QA', items: ['Test-driven development (TDD)', 'Cypress', 'Vitest', 'manual QA testing', 'bug tracking', 'Postman'] },
    {
      label: 'Cloud & DevOps',
      items: [
        'Docker',
        'Google Cloud Platform (Cloud Run, Cloud SQL)',
        'Microsoft Azure (coursework)',
        'GitHub Actions',
        'Azure DevOps',
        'Git',
        'CI/CD',
        'AWS Certified Cloud Practitioner (in progress)',
      ],
    },
    {
      label: 'Practices & Security',
      items: [
        'Agile/iterative development',
        'SDLC',
        'OOP & software design principles',
        'RBAC & secure coding fundamentals',
        'code review',
        'AI-assisted development (Claude, GitHub Copilot)',
      ],
    },
  ],
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
