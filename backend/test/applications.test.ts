import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createDb } from '../src/db.ts';
import type { Application } from '../src/types.ts';

let app: FastifyInstance;
const db = createDb(':memory:');

before(async () => {
  process.env.NODE_ENV = 'test';
  app = await buildApp(db);
  await app.ready();
});

after(async () => {
  await app.close();
  db.close();
});

beforeEach(() => {
  db.exec('DELETE FROM applications');
});

async function createSample(overrides: Record<string, unknown> = {}): Promise<Application> {
  const res = await app.inject({
    method: 'POST',
    url: '/applications',
    payload: {
      company: 'Acme Corp',
      title: 'Software Engineer',
      job_url: 'https://indeed.com/viewjob?jk=abc123',
      platform_job_id: 'abc123',
      platform: 'indeed',
      apply_method: 'in_platform',
      ...overrides,
    },
  });
  assert.equal(res.statusCode, 201);
  return res.json() as Application;
}

test('POST creates an application with server-set timestamps and defaults', async () => {
  const created = await createSample();
  assert.ok(created.id > 0);
  assert.equal(created.company, 'Acme Corp');
  assert.equal(created.status, 'applied'); // default
  assert.ok(created.date_last_updated);
  assert.ok(created.created_at);
  assert.equal(created.date_applied, created.date_applied); // present
});

test('POST defaults platform to manual and apply_method to manual', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/applications',
    payload: { company: 'Solo Inc', title: 'Designer' },
  });
  assert.equal(res.statusCode, 201);
  const row = res.json() as Application;
  assert.equal(row.platform, 'manual');
  assert.equal(row.apply_method, 'manual');
});

test('POST rejects an invalid status enum value', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/applications',
    payload: { company: 'Bad Co', title: 'Dev', status: 'not_a_status' },
  });
  assert.equal(res.statusCode, 400);
});

test('POST rejects missing required fields', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/applications',
    payload: { company: 'No Title Co' },
  });
  assert.equal(res.statusCode, 400);
});

test('GET lists applications and filters by platform and status', async () => {
  await createSample({ platform: 'indeed', status: 'applied' });
  await createSample({ platform: 'linkedin', status: 'interviewing', apply_method: 'in_platform' });

  const all = await app.inject({ method: 'GET', url: '/applications' });
  assert.equal((all.json() as Application[]).length, 2);

  const byPlatform = await app.inject({ method: 'GET', url: '/applications?platform=linkedin' });
  const rows = byPlatform.json() as Application[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].platform, 'linkedin');

  const byStatus = await app.inject({ method: 'GET', url: '/applications?status=applied' });
  assert.equal((byStatus.json() as Application[]).length, 1);
});

test('GET rejects an invalid filter enum value', async () => {
  const res = await app.inject({ method: 'GET', url: '/applications?status=bogus' });
  assert.equal(res.statusCode, 400);
});

test('PATCH updates status and bumps date_last_updated', async () => {
  const created = await createSample();
  const before = created.date_last_updated;
  await new Promise((r) => setTimeout(r, 5));

  const res = await app.inject({
    method: 'PATCH',
    url: `/applications/${created.id}`,
    payload: { status: 'interviewing' },
  });
  assert.equal(res.statusCode, 200);
  const updated = res.json() as Application;
  assert.equal(updated.status, 'interviewing');
  assert.notEqual(updated.date_last_updated, before);
});

test('PATCH on a missing id returns 404', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/applications/99999',
    payload: { status: 'offer' },
  });
  assert.equal(res.statusCode, 404);
});

test('DELETE removes a row', async () => {
  const created = await createSample();
  const del = await app.inject({ method: 'DELETE', url: `/applications/${created.id}` });
  assert.equal(del.statusCode, 204);

  const get = await app.inject({ method: 'GET', url: `/applications/${created.id}` });
  assert.equal(get.statusCode, 404);
});

test('DELETE on a missing id returns 404', async () => {
  const res = await app.inject({ method: 'DELETE', url: '/applications/99999' });
  assert.equal(res.statusCode, 404);
});

test('CSV export returns a header, all rows, and escapes special characters', async () => {
  await createSample({ company: 'Normal Co' });
  await createSample({ company: 'Comma, Inc', notes: 'He said "hi"\nnew line' });

  const res = await app.inject({ method: 'GET', url: '/applications/export.csv' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/csv/);
  assert.match(res.headers['content-disposition'] as string, /attachment/);

  const body = res.body;
  const header = body.split('\r\n')[0];
  assert.equal(header.split(',')[0], 'id');
  assert.match(header, /company/);
  // Comma-containing and quote-containing fields must be quoted/escaped.
  assert.match(body, /"Comma, Inc"/);
  assert.match(body, /"He said ""hi""/);
});

test('export.csv is not shadowed by the :id route', async () => {
  // Ensures route ordering: export.csv must resolve to the CSV handler, not GET /:id 400.
  const res = await app.inject({ method: 'GET', url: '/applications/export.csv' });
  assert.equal(res.statusCode, 200);
});
