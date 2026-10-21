import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import PDFDocument from 'pdfkit';
import { Document as DocxDocument, Packer, Paragraph } from 'docx';
import { buildApp } from '../src/app.ts';
import { createDb } from '../src/storage/db.ts';
import { createSettingsStore } from '../src/storage/settings.ts';
import { detectFileFormat, MAX_ATTACHMENT_BYTES } from '../src/resume/fileFormat.ts';
import type { Application, ResumeVersionWithFiles } from '../src/types/index.ts';

const db = createDb(':memory:');
const settingsPath = join(tmpdir(), `applyt-test-settings-${process.pid}-attachments.json`);
const settings = createSettingsStore(settingsPath);
let app: FastifyInstance;

before(async () => {
  process.env.NODE_ENV = 'test';
  app = await buildApp(db, settings);
  await app.ready();
});

after(async () => {
  await app.close();
  db.close();
  rmSync(settingsPath, { force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM resume_version_files');
  db.exec('DELETE FROM cover_letters');
  db.exec('DELETE FROM resume_versions');
  db.exec('DELETE FROM applications');
});

type Part = { field: string; filename: string; data: Buffer };

// Builds a raw multipart/form-data payload with Node's own FormData/Request
// (no dependency), so the boundary and serialization match a real browser.
async function multipart(parts: Part[]): Promise<{ contentType: string; buffer: Buffer }> {
  const form = new FormData();
  for (const p of parts) form.append(p.field, new Blob([p.data]), p.filename);
  const req = new Request('http://localhost/', { method: 'POST', body: form });
  return {
    contentType: req.headers.get('content-type')!,
    buffer: Buffer.from(await req.arrayBuffer()),
  };
}

function makePdf(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.text(text);
    doc.end();
  });
}

async function makeDocx(text: string): Promise<Buffer> {
  return Packer.toBuffer(new DocxDocument({ sections: [{ children: [new Paragraph({ text })] }] }));
}

const padTo = (buf: Buffer, size: number) => Buffer.concat([buf, Buffer.alloc(size - buf.length, 0x20)]);

async function createApp(): Promise<Application> {
  const res = await app.inject({ method: 'POST', url: '/applications', payload: { company: 'Acme', title: 'Engineer' } });
  assert.equal(res.statusCode, 201);
  return res.json() as Application;
}

async function upload(appId: number, parts: Part[]) {
  const { contentType, buffer } = await multipart(parts);
  return app.inject({
    method: 'POST',
    url: `/applications/${appId}/resume-versions/files`,
    headers: { 'content-type': contentType },
    payload: buffer,
  });
}

const versionCount = () => (db.prepare('SELECT COUNT(*) AS n FROM resume_versions').get() as { n: number }).n;

// ---- detectFileFormat ----

test('detectFileFormat recognises PDF and DOCX by content', async () => {
  assert.equal(detectFileFormat(await makePdf('hello')), 'pdf');
  assert.equal(detectFileFormat(await makeDocx('hello')), 'docx');
});

test('detectFileFormat rejects plain text and a ZIP that is not a Word document', async () => {
  assert.equal(detectFileFormat(Buffer.from('just some text')), null);
  const docx = await makeDocx('hello');
  const notWord = Buffer.from(docx.toString('latin1').split('word/document.xml').join('word/documenX.xml'), 'latin1');
  assert.equal(detectFileFormat(notWord), null);
});

// ---- POST /applications/:id/resume-versions/files ----

test('upload round-trips a PDF and DOCX resume plus a PDF cover letter', async () => {
  const a = await createApp();
  const res = await upload(a.id, [
    { field: 'resume', filename: 'Jane_Resume.pdf', data: await makePdf('Jane Doe resume text') },
    { field: 'resume', filename: 'Jane_Resume.docx', data: await makeDocx('Jane Doe resume text') },
    { field: 'cover_letter', filename: 'Jane_Cover.pdf', data: await makePdf('Dear hiring team') },
  ]);
  assert.equal(res.statusCode, 201, res.body);
  const v = res.json() as ResumeVersionWithFiles;
  assert.equal(v.ai_provider, 'file');
  assert.equal(v.cost, null);
  assert.equal(v.model, null);
  assert.match(v.tailored_output ?? '', /Jane Doe resume text/);
  assert.deepEqual(
    v.files.map((f) => [f.kind, f.format, f.filename]).sort(),
    [
      ['cover_letter', 'pdf', 'Jane_Cover.pdf'],
      ['resume', 'docx', 'Jane_Resume.docx'],
      ['resume', 'pdf', 'Jane_Resume.pdf'],
    ],
  );
  assert.ok(v.files.every((f) => f.size > 0));
});

test('list returns files without blob data, and generated versions have files: []', async () => {
  const a = await createApp();
  await upload(a.id, [{ field: 'resume', filename: 'r.pdf', data: await makePdf('x') }]);
  const gen = await app.inject({
    method: 'POST',
    url: `/applications/${a.id}/resume-versions`,
    payload: { resume: { contact: { name: 'Jane' }, experience: [], education: [], skills: [] } },
  });
  assert.equal(gen.statusCode, 201);
  const list = (await app.inject({ method: 'GET', url: `/applications/${a.id}/resume-versions` })).json() as ResumeVersionWithFiles[];
  assert.equal(list.length, 2);
  assert.equal(JSON.stringify(list).includes('"data"'), false);
  assert.deepEqual(list.find((v) => v.ai_provider === 'mcp')?.files, []);
  assert.equal(list.find((v) => v.ai_provider === 'file')?.files.length, 1);
});

test('cover-letter-only upload is accepted', async () => {
  const a = await createApp();
  const res = await upload(a.id, [{ field: 'cover_letter', filename: 'c.pdf', data: await makePdf('Dear team') }]);
  assert.equal(res.statusCode, 201, res.body);
  assert.match((res.json() as ResumeVersionWithFiles).tailored_output ?? '', /Dear team/);
});

test('invalid uploads are rejected and write nothing', async () => {
  const a = await createApp();
  const pdf = await makePdf('x');
  const cases: [string, Part[], number, RegExp][] = [
    ['no files', [], 400, /no files/i],
    ['unknown field', [{ field: 'photo', filename: 'p.pdf', data: pdf }], 400, /photo/],
    ['text named .pdf', [{ field: 'resume', filename: 'x.pdf', data: Buffer.from('not a pdf') }], 400, /unsupported/i],
    [
      'duplicate kind+format',
      [
        { field: 'resume', filename: 'a.pdf', data: pdf },
        { field: 'resume', filename: 'b.pdf', data: pdf },
      ],
      400,
      /more than one/i,
    ],
    ['empty file', [{ field: 'resume', filename: 'e.pdf', data: Buffer.alloc(0) }], 400, /empty/i],
    ['too large', [{ field: 'resume', filename: 'big.pdf', data: padTo(pdf, MAX_ATTACHMENT_BYTES + 1) }], 413, /too large/i],
  ];
  for (const [name, parts, status, msg] of cases) {
    const res = await upload(a.id, parts);
    assert.equal(res.statusCode, status, `${name}: ${res.body}`);
    assert.match((res.json() as { error: string }).error, msg, name);
  }
  assert.equal(versionCount(), 0);
});

test('unknown application → 404', async () => {
  const res = await upload(99999, [{ field: 'resume', filename: 'r.pdf', data: await makePdf('x') }]);
  assert.equal(res.statusCode, 404);
  assert.equal(versionCount(), 0);
});

test('four files of 5 MB each are accepted', async () => {
  const a = await createApp();
  const pdf = padTo(await makePdf('big resume'), MAX_ATTACHMENT_BYTES);
  const docx = padTo(await makeDocx('big resume'), MAX_ATTACHMENT_BYTES);
  const res = await upload(a.id, [
    { field: 'resume', filename: 'r.pdf', data: pdf },
    { field: 'resume', filename: 'r.docx', data: docx },
    { field: 'cover_letter', filename: 'c.pdf', data: pdf },
    { field: 'cover_letter', filename: 'c.docx', data: docx },
  ]);
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((res.json() as ResumeVersionWithFiles).files.length, 4);
});

test('extraction failure still saves with a placeholder', async () => {
  const a = await createApp();
  const res = await upload(a.id, [
    { field: 'resume', filename: 'broken.pdf', data: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 0x41)]) },
  ]);
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((res.json() as ResumeVersionWithFiles).tailored_output, '(Text could not be extracted from this file.)');
});

test('deleting an application with a file version succeeds', async () => {
  const a = await createApp();
  await upload(a.id, [{ field: 'resume', filename: 'r.pdf', data: await makePdf('x') }]);
  const res = await app.inject({ method: 'DELETE', url: `/applications/${a.id}` });
  assert.equal(res.statusCode, 204);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM resume_version_files').get() as { n: number }).n, 0);
});
