import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createDb } from '../src/storage/db.ts';
import { createSettingsStore } from '../src/storage/settings.ts';
import type { Application, ResumeVersion } from '../src/types/index.ts';
import { parseTailoredResume } from '../src/resume/tailoredResume.ts';

let app: FastifyInstance;
const db = createDb(':memory:');
const tmp = mkdtempSync(join(tmpdir(), 'applyt-mcp-endpoints-'));
const settings = createSettingsStore(join(tmp, 'settings.json'));

before(async () => {
  process.env.NODE_ENV = 'test';
  settings.update({ baseResume: 'Jane Doe\nSoftware Engineer' });
  app = await buildApp(db, settings);
  await app.ready();
});

after(async () => {
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM cover_letters; DELETE FROM resume_versions; DELETE FROM applications;');
});

async function createSample(overrides: Record<string, unknown> = {}): Promise<Application> {
  const res = await app.inject({
    method: 'POST',
    url: '/applications',
    payload: { company: 'Acme Corp', title: 'Engineer', ...overrides },
  });
  assert.equal(res.statusCode, 201);
  return res.json() as Application;
}

// Inserts a resume version + cover letter directly, the way /tailor would,
// so delete tests exercise the FK chain without needing an AI call.
function attachVersionAndCoverLetter(applicationId: number): void {
  const info = db
    .prepare(
      "INSERT INTO resume_versions (application_id, tailored_output, ai_provider, created_at) VALUES (?, '{}', 'anthropic', datetime('now'))",
    )
    .run(applicationId);
  db.prepare(
    "INSERT INTO cover_letters (application_id, resume_version_id, tailored_output, created_at) VALUES (?, ?, '{}', datetime('now'))",
  ).run(applicationId, info.lastInsertRowid);
}

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

// ---- status bulk delete regression ----

test('DELETE /applications?status= deletes rows that have resume versions and cover letters', async () => {
  const a = await createSample({ status: 'rejected' });
  attachVersionAndCoverLetter(a.id);
  await createSample({ status: 'applied' });

  const res = await app.inject({ method: 'DELETE', url: '/applications?status=rejected' });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { deleted: number }).deleted, 1);
  assert.equal(count('applications'), 1);
  assert.equal(count('resume_versions'), 0);
  assert.equal(count('cover_letters'), 0);
});

// ---- POST /applications/bulk-delete ----

test('bulk-delete removes the given applications and their versions/cover letters', async () => {
  const a = await createSample();
  const b = await createSample({ company: 'Beta' });
  const keep = await createSample({ company: 'Keep' });
  attachVersionAndCoverLetter(a.id);

  const res = await app.inject({
    method: 'POST',
    url: '/applications/bulk-delete',
    payload: { ids: [a.id, b.id] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { deleted: 2 });
  const remaining = db.prepare('SELECT id FROM applications').all() as { id: number }[];
  assert.deepEqual(remaining.map((r) => r.id), [keep.id]);
  assert.equal(count('resume_versions'), 0);
  assert.equal(count('cover_letters'), 0);
});

test('bulk-delete dedupes ids', async () => {
  const a = await createSample();
  const res = await app.inject({
    method: 'POST',
    url: '/applications/bulk-delete',
    payload: { ids: [a.id, a.id] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { deleted: 1 });
});

test('bulk-delete with any missing id deletes nothing and lists the missing ids', async () => {
  const a = await createSample();
  const res = await app.inject({
    method: 'POST',
    url: '/applications/bulk-delete',
    payload: { ids: [a.id, 999999] },
  });
  assert.equal(res.statusCode, 404);
  assert.deepEqual((res.json() as { missingIds: number[] }).missingIds, [999999]);
  assert.equal(count('applications'), 1);
});

// No ['1'] case: Fastify's Ajv coerces numeric strings to integers, so a
// string id that names a real row is (harmlessly) accepted.
test('bulk-delete rejects empty, non-integer, and oversized id lists', async () => {
  for (const ids of [[], [1.5], ['abc'], [0],Array.from({ length: 501 }, (_, i) => i + 1)]) {
    const res = await app.inject({ method: 'POST', url: '/applications/bulk-delete', payload: { ids } });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(ids).slice(0, 40)}`);
  }
  const missing = await app.inject({ method: 'POST', url: '/applications/bulk-delete', payload: {} });
  assert.equal(missing.statusCode, 400);
});

// ---- POST /applications/:id/resume-versions ----

const envelope = {
  resume: {
    contact: { name: 'Jane Doe', email: 'jane@example.com' },
    summary: 'Engineer.',
    experience: [
      { title: 'Engineer', company: 'Acme', startDate: 'Jan 2022', endDate: 'Present', bullets: ['Built things'] },
    ],
    education: [{ institution: 'State U', degree: 'BSc CS', dates: '2018 - 2022' }],
    skills: [{ label: 'Languages', items: ['TypeScript'] }],
  },
  matchRating: 4,
  matchJustification: ['Strong TypeScript'],
  suggestions: ['Mention AWS'],
};

const coverLetter = {
  contact: { name: 'Jane Doe' },
  date: 'Oct 19, 2026',
  header: { recipient: 'Hiring Team', company: 'Acme' },
  body: 'Para one.\n\nPara two.',
  footer: 'Sincerely, Jane Doe',
};

test('save resume version stores an mcp row the existing parser and downloads understand', async () => {
  const a = await createSample();
  const res = await app.inject({
    method: 'POST',
    url: `/applications/${a.id}/resume-versions`,
    payload: envelope,
  });
  assert.equal(res.statusCode, 201);
  const v = res.json() as ResumeVersion;
  assert.equal(v.application_id, a.id);
  assert.equal(v.ai_provider, 'mcp');
  assert.equal(v.model, null);
  assert.equal(v.cost, 0);
  assert.equal(v.base_resume_snapshot, 'Jane Doe\nSoftware Engineer');

  const parsed = parseTailoredResume(v.tailored_output as string);
  assert.equal(parsed.matchRating, 4);
  assert.equal(parsed.suggestions, '- Mention AWS'); // parser renders bullets as display text
  assert.equal(parsed.structured?.contact.name, 'Jane Doe');
  assert.equal(count('cover_letters'), 0);

  const pdf = await app.inject({
    method: 'GET',
    url: `/applications/${a.id}/resume-versions/${v.id}/download?format=pdf`,
  });
  assert.equal(pdf.statusCode, 200);

  const row = await app.inject({ method: 'GET', url: `/applications/${a.id}` });
  assert.equal((row.json() as Application).has_resume_version, true);
});

test('save resume version with a cover letter also writes a cover_letters row', async () => {
  const a = await createSample();
  const res = await app.inject({
    method: 'POST',
    url: `/applications/${a.id}/resume-versions`,
    payload: { ...envelope, coverLetter },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(count('cover_letters'), 1);
  assert.ok(parseTailoredResume((res.json() as ResumeVersion).tailored_output as string).coverLetter);
});

test('save resume version rejects a malformed nested field with its path', async () => {
  const a = await createSample();
  const bad = {
    ...envelope,
    resume: { ...envelope.resume, experience: [{ ...envelope.resume.experience[0], bullets: 'one\ntwo' }] },
  };
  const res = await app.inject({ method: 'POST', url: `/applications/${a.id}/resume-versions`, payload: bad });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /resume\.experience\[0\]\.bullets/);
  assert.equal(count('resume_versions'), 0);
});

test('save resume version 404s for an unknown application', async () => {
  const res = await app.inject({ method: 'POST', url: '/applications/999999/resume-versions', payload: envelope });
  assert.equal(res.statusCode, 404);
});
