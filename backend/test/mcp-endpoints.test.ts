import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createDb } from '../src/storage/db.ts';
import { createSettingsStore } from '../src/storage/settings.ts';
import type { Application } from '../src/types/index.ts';

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
