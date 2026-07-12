import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createDb } from '../src/db.ts';
import { createSettingsStore } from '../src/settings.ts';
import type { Application, PublicSettings, ResumeVersion } from '../src/types.ts';

const db = createDb(':memory:');
const settingsPath = join(tmpdir(), `applyt-test-settings-${process.pid}.json`);
const settings = createSettingsStore(settingsPath);
let app: FastifyInstance;

// Provider key resolution prefers env vars; clear them so tests are deterministic
// regardless of the developer's/CI shell environment.
const savedEnv = {
  anthropic: process.env.ANTHROPIC_API_KEY,
  openai: process.env.OPENAI_API_KEY,
};
const originalFetch = global.fetch;

before(async () => {
  process.env.NODE_ENV = 'test';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  app = await buildApp(db, settings);
  await app.ready();
});

after(async () => {
  await app.close();
  db.close();
  global.fetch = originalFetch;
  process.env.ANTHROPIC_API_KEY = savedEnv.anthropic;
  process.env.OPENAI_API_KEY = savedEnv.openai;
  rmSync(settingsPath, { force: true });
});

beforeEach(() => {
  // applications.resume_version_id and resume_versions.application_id reference
  // each other, so clear the applications→version link first, then delete the
  // (now-unreferenced) versions, then the applications — keeping foreign_keys ON.
  db.exec('UPDATE applications SET resume_version_id = NULL');
  db.exec('DELETE FROM resume_versions');
  db.exec('DELETE FROM applications');
  rmSync(settingsPath, { force: true }); // reset settings to defaults each test
  global.fetch = originalFetch;
});

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

// Stub global.fetch (used by ai.ts) with a fixed response for one call.
function stubFetch(status: number, body: unknown): void {
  global.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

test('GET /settings returns defaults and masks keys', async () => {
  const res = await app.inject({ method: 'GET', url: '/settings' });
  assert.equal(res.statusCode, 200);
  const s = res.json() as PublicSettings;
  assert.equal(s.provider, 'anthropic');
  assert.equal(s.model, 'claude-sonnet-5');
  assert.equal(s.hasAnthropicKey, false);
  assert.equal(s.hasOpenaiKey, false);
  // Raw key fields must never appear in the public payload.
  assert.equal('anthropicApiKey' in (s as object), false);
  assert.equal('openaiApiKey' in (s as object), false);
});

test('PUT /settings saves values and reports key presence without leaking the key', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/settings',
    payload: {
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      anthropicApiKey: 'sk-ant-secret',
      baseResume: 'Jane Doe — Engineer',
    },
  });
  assert.equal(res.statusCode, 200);
  const s = res.json() as PublicSettings;
  assert.equal(s.model, 'claude-opus-4-8');
  assert.equal(s.baseResume, 'Jane Doe — Engineer');
  assert.equal(s.hasAnthropicKey, true);
  assert.equal(JSON.stringify(s).includes('sk-ant-secret'), false); // never echoed back
});

test('PUT /settings partial update leaves unspecified fields unchanged', async () => {
  await app.inject({
    method: 'PUT',
    url: '/settings',
    payload: { anthropicApiKey: 'sk-ant-secret', baseResume: 'RESUME' },
  });
  // Change only the model; key and resume must persist.
  await app.inject({ method: 'PUT', url: '/settings', payload: { model: 'gpt-4o' } });
  const s = (await app.inject({ method: 'GET', url: '/settings' })).json() as PublicSettings;
  assert.equal(s.model, 'gpt-4o');
  assert.equal(s.baseResume, 'RESUME');
  assert.equal(s.hasAnthropicKey, true);
});

test('job_description round-trips through POST and PATCH', async () => {
  const created = await createApp({ job_description: 'Build React apps.' });
  assert.equal(created.job_description, 'Build React apps.');

  const patched = await app.inject({
    method: 'PATCH',
    url: `/applications/${created.id}`,
    payload: { job_description: 'Now with TypeScript.' },
  });
  assert.equal((patched.json() as Application).job_description, 'Now with TypeScript.');
});

test('POST /:id/tailor 404s for a missing application', async () => {
  const res = await app.inject({ method: 'POST', url: '/applications/99999/tailor' });
  assert.equal(res.statusCode, 404);
});

test('POST /:id/tailor 400s when the application has no job description', async () => {
  const created = await createApp();
  const res = await app.inject({ method: 'POST', url: `/applications/${created.id}/tailor` });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /job description/i);
});

test('POST /:id/tailor 400s when no base resume is configured', async () => {
  const created = await createApp({ job_description: 'Build things.' });
  const res = await app.inject({ method: 'POST', url: `/applications/${created.id}/tailor` });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /base resume/i);
});

test('POST /:id/tailor 400s when a base resume exists but no API key is set', async () => {
  await app.inject({ method: 'PUT', url: '/settings', payload: { baseResume: 'RESUME' } });
  const created = await createApp({ job_description: 'Build things.' });
  const res = await app.inject({ method: 'POST', url: `/applications/${created.id}/tailor` });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /api key/i);
});

test('POST /:id/tailor stores a resume version and links it to the application', async () => {
  await app.inject({
    method: 'PUT',
    url: '/settings',
    payload: { provider: 'anthropic', anthropicApiKey: 'sk-ant-secret', baseResume: 'BASE RESUME' },
  });
  const created = await createApp({ job_description: 'Senior React role.' });

  stubFetch(200, { content: [{ type: 'text', text: 'TAILORED RESUME OUTPUT' }] });
  const res = await app.inject({ method: 'POST', url: `/applications/${created.id}/tailor` });
  assert.equal(res.statusCode, 201);
  const version = res.json() as ResumeVersion;
  assert.equal(version.application_id, created.id);
  assert.equal(version.tailored_output, 'TAILORED RESUME OUTPUT');
  assert.equal(version.base_resume_snapshot, 'BASE RESUME');
  assert.equal(version.ai_provider, 'anthropic');

  // The application now points at its newest tailored version.
  const app2 = (await app.inject({ method: 'GET', url: `/applications/${created.id}` })).json() as Application;
  assert.equal(app2.resume_version_id, version.id);

  // …and it's listed under the application's resume-versions.
  const list = (await app.inject({ method: 'GET', url: `/applications/${created.id}/resume-versions` })).json() as ResumeVersion[];
  assert.equal(list.length, 1);
  assert.equal(list[0].id, version.id);
});

test('POST /:id/tailor uses the OpenAI response shape when provider is openai', async () => {
  await app.inject({
    method: 'PUT',
    url: '/settings',
    payload: { provider: 'openai', model: 'gpt-4o', openaiApiKey: 'sk-openai', baseResume: 'BASE' },
  });
  const created = await createApp({ job_description: 'Backend role.' });

  stubFetch(200, { choices: [{ message: { content: 'OPENAI TAILORED OUTPUT' } }] });
  const res = await app.inject({ method: 'POST', url: `/applications/${created.id}/tailor` });
  assert.equal(res.statusCode, 201);
  assert.equal((res.json() as ResumeVersion).tailored_output, 'OPENAI TAILORED OUTPUT');
});

test('POST /:id/tailor 502s and surfaces the provider error on an upstream failure', async () => {
  await app.inject({
    method: 'PUT',
    url: '/settings',
    payload: { anthropicApiKey: 'bad-key', baseResume: 'BASE' },
  });
  const created = await createApp({ job_description: 'Some role.' });

  stubFetch(401, { error: { message: 'invalid x-api-key' } });
  const res = await app.inject({ method: 'POST', url: `/applications/${created.id}/tailor` });
  assert.equal(res.statusCode, 502);
  assert.match((res.json() as { error: string }).error, /invalid x-api-key/);

  // A failed tailor must not create a stray resume_versions row.
  const list = (await app.inject({ method: 'GET', url: `/applications/${created.id}/resume-versions` })).json() as ResumeVersion[];
  assert.equal(list.length, 0);
});
