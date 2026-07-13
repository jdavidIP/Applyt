import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import PDFDocument from 'pdfkit';
import { Document as DocxDocument, Packer, Paragraph } from 'docx';
import { buildApp } from '../src/app.ts';
import { createDb } from '../src/db.ts';
import { createSettingsStore } from '../src/settings.ts';
import { splitSuggestions } from '../src/resumeRender.ts';
import type { Application, ResumeVersion } from '../src/types.ts';

const db = createDb(':memory:');
const settingsPath = join(tmpdir(), `applyt-test-settings-${process.pid}-resume.json`);
const settings = createSettingsStore(settingsPath);
let app: FastifyInstance;

const originalFetch = global.fetch;

before(async () => {
  process.env.NODE_ENV = 'test';
  app = await buildApp(db, settings);
  await app.ready();
});

after(async () => {
  await app.close();
  db.close();
  global.fetch = originalFetch;
  rmSync(settingsPath, { force: true });
});

beforeEach(() => {
  db.exec('UPDATE applications SET resume_version_id = NULL');
  db.exec('DELETE FROM resume_versions');
  db.exec('DELETE FROM applications');
  rmSync(settingsPath, { force: true });
  global.fetch = originalFetch;
});

// Builds a raw multipart/form-data payload the same way a browser would,
// using Node's built-in FormData/Request rather than a new dependency — the
// Request object computes a correct boundary and serializes the body for us.
async function multipartPayload(
  filename: string,
  mimetype: string,
  data: Buffer,
): Promise<{ contentType: string; buffer: Buffer }> {
  const form = new FormData();
  form.append('file', new Blob([data], { type: mimetype }), filename);
  const req = new Request('http://localhost/', { method: 'POST', body: form });
  const contentType = req.headers.get('content-type')!;
  const buffer = Buffer.from(await req.arrayBuffer());
  return { contentType, buffer };
}

function makeFixturePdf(text: string): Promise<Buffer> {
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

async function makeFixtureDocx(text: string): Promise<Buffer> {
  const doc = new DocxDocument({ sections: [{ children: [new Paragraph({ text })] }] });
  return Packer.toBuffer(doc);
}

function stubFetch(status: number, body: unknown): void {
  global.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

async function createApp(overrides: Record<string, unknown> = {}): Promise<Application> {
  const res = await app.inject({
    method: 'POST',
    url: '/applications',
    payload: {
      company: 'Acme Corp',
      title: 'Software Engineer',
      platform: 'indeed',
      apply_method: 'in_platform',
      ...overrides,
    },
  });
  assert.equal(res.statusCode, 201);
  return res.json() as Application;
}

// ---- splitSuggestions (pure function) ----
// PDF/DOCX output is a real zip/binary container, so asserting "the rendered
// bytes don't contain the literal Suggestions text" isn't reliable (both
// formats compress their content streams). Testing the split logic directly
// is the meaningful check; the HTTP tests below verify the pipeline runs and
// produces the right container format.
test('splitSuggestions separates the resume from a trailing Suggestions section', () => {
  const { resume, suggestions } = splitSuggestions(
    'John Doe\nSenior Engineer\n\nSuggestions:\nMention your Kubernetes experience.',
  );
  assert.equal(resume, 'John Doe\nSenior Engineer');
  assert.equal(suggestions, 'Suggestions:\nMention your Kubernetes experience.');
});

test('splitSuggestions returns the full text with null suggestions when there is no heading', () => {
  const { resume, suggestions } = splitSuggestions('Just a resume, no suggestions section.');
  assert.equal(resume, 'Just a resume, no suggestions section.');
  assert.equal(suggestions, null);
});

// ---- POST /settings/base-resume/extract ----

test('POST /settings/base-resume/extract extracts text from an uploaded PDF', async () => {
  const pdf = await makeFixturePdf('Jane Smith — Backend Engineer with 8 years of experience.');
  const { contentType, buffer } = await multipartPayload('resume.pdf', 'application/pdf', pdf);
  const res = await app.inject({
    method: 'POST',
    url: '/settings/base-resume/extract',
    headers: { 'content-type': contentType },
    payload: buffer,
  });
  assert.equal(res.statusCode, 200);
  assert.match((res.json() as { text: string }).text, /Jane Smith/);
});

test('POST /settings/base-resume/extract extracts text from an uploaded DOCX', async () => {
  const docx = await makeFixtureDocx('Alex Rivera — Full-stack developer.');
  const { contentType, buffer } = await multipartPayload(
    'resume.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    docx,
  );
  const res = await app.inject({
    method: 'POST',
    url: '/settings/base-resume/extract',
    headers: { 'content-type': contentType },
    payload: buffer,
  });
  assert.equal(res.statusCode, 200);
  assert.match((res.json() as { text: string }).text, /Alex Rivera/);
});

test('POST /settings/base-resume/extract rejects an unsupported file type', async () => {
  const { contentType, buffer } = await multipartPayload(
    'resume.txt',
    'text/plain',
    Buffer.from('plain text resume'),
  );
  const res = await app.inject({
    method: 'POST',
    url: '/settings/base-resume/extract',
    headers: { 'content-type': contentType },
    payload: buffer,
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /PDF|DOCX/i);
});

test('POST /settings/base-resume/extract rejects legacy .doc files by name', async () => {
  const { contentType, buffer } = await multipartPayload(
    'resume.doc',
    'application/msword',
    Buffer.from('legacy binary word doc'),
  );
  const res = await app.inject({
    method: 'POST',
    url: '/settings/base-resume/extract',
    headers: { 'content-type': contentType },
    payload: buffer,
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /\.docx|pdf/i);
});

test('POST /settings/base-resume/extract 400s on a corrupt PDF rather than 500ing', async () => {
  const { contentType, buffer } = await multipartPayload(
    'resume.pdf',
    'application/pdf',
    Buffer.from('this is not actually a pdf'),
  );
  const res = await app.inject({
    method: 'POST',
    url: '/settings/base-resume/extract',
    headers: { 'content-type': contentType },
    payload: buffer,
  });
  assert.equal(res.statusCode, 400);
});

test('POST /settings/base-resume/extract 413s on an oversized file', async () => {
  // One byte past the route's hardcoded 10MB limit (settings.ts MAX_UPLOAD_BYTES).
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41);
  const { contentType, buffer } = await multipartPayload('resume.pdf', 'application/pdf', oversized);
  const res = await app.inject({
    method: 'POST',
    url: '/settings/base-resume/extract',
    headers: { 'content-type': contentType },
    payload: buffer,
  });
  assert.equal(res.statusCode, 413);
});

// ---- GET /applications/:id/resume-versions/:versionId/download ----

async function createTailoredVersion(): Promise<{ applicationId: number; versionId: number }> {
  await app.inject({
    method: 'PUT',
    url: '/settings',
    payload: { provider: 'anthropic', anthropicApiKey: 'sk-ant-secret', baseResume: 'BASE RESUME' },
  });
  const created = await createApp({ job_description: 'Senior React role.' });
  stubFetch(200, {
    content: [
      {
        type: 'text',
        text: 'Jane Smith\nSenior Engineer\n- Led a team of 5 engineers\n\nSuggestions:\nMention leadership.',
      },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  });
  const tailorRes = await app.inject({ method: 'POST', url: `/applications/${created.id}/tailor` });
  assert.equal(tailorRes.statusCode, 201);
  const version = tailorRes.json() as ResumeVersion;
  return { applicationId: created.id, versionId: version.id };
}

test('GET .../download?format=txt returns the full tailored_output including suggestions', async () => {
  const { applicationId, versionId } = await createTailoredVersion();
  const res = await app.inject({
    method: 'GET',
    url: `/applications/${applicationId}/resume-versions/${versionId}/download?format=txt`,
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/plain/);
  assert.match(res.body, /Suggestions:/);
  assert.match(res.body, /Jane Smith/);
});

test('GET .../download?format=pdf returns a valid PDF containing only the resume portion', async () => {
  const { applicationId, versionId } = await createTailoredVersion();
  const res = await app.inject({
    method: 'GET',
    url: `/applications/${applicationId}/resume-versions/${versionId}/download?format=pdf`,
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /application\/pdf/);
  assert.equal(res.rawPayload.subarray(0, 4).toString('latin1'), '%PDF');
});

test('GET .../download?format=docx returns a valid DOCX (zip) container', async () => {
  const { applicationId, versionId } = await createTailoredVersion();
  const res = await app.inject({
    method: 'GET',
    url: `/applications/${applicationId}/resume-versions/${versionId}/download?format=docx`,
  });
  assert.equal(res.statusCode, 200);
  assert.match(
    res.headers['content-type'] as string,
    /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/,
  );
  assert.equal(res.rawPayload.subarray(0, 2).toString('latin1'), 'PK');
});

test('GET .../download 404s when the version does not belong to the given application', async () => {
  const { versionId } = await createTailoredVersion();
  const otherApp = await createApp({ company: 'Other Co' });
  const res = await app.inject({
    method: 'GET',
    url: `/applications/${otherApp.id}/resume-versions/${versionId}/download?format=txt`,
  });
  assert.equal(res.statusCode, 404);
});

test('GET .../download 400s on an invalid format value', async () => {
  const { applicationId, versionId } = await createTailoredVersion();
  const res = await app.inject({
    method: 'GET',
    url: `/applications/${applicationId}/resume-versions/${versionId}/download?format=exe`,
  });
  assert.equal(res.statusCode, 400);
});
