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

  // Default model claude-sonnet-5 is priced at 3/15 per million (input/output).
  stubFetch(200, {
    content: [{ type: 'text', text: 'TAILORED RESUME OUTPUT' }],
    usage: { input_tokens: 1000, output_tokens: 500 },
  });
  const res = await app.inject({ method: 'POST', url: `/applications/${created.id}/tailor` });
  assert.equal(res.statusCode, 201);
  const version = res.json() as ResumeVersion;
  assert.equal(version.application_id, created.id);
  assert.equal(version.tailored_output, 'TAILORED RESUME OUTPUT');
  assert.equal(version.base_resume_snapshot, 'BASE RESUME');
  assert.equal(version.ai_provider, 'anthropic');
  assert.equal(version.model, 'claude-sonnet-5');
  assert.equal(version.input_tokens, 1000);
  assert.equal(version.output_tokens, 500);
  // (1000/1e6)*3 + (500/1e6)*15 = 0.003 + 0.0075 = 0.0105
  assert.ok(Math.abs((version.cost ?? 0) - 0.0105) < 1e-9);

  // The application now points at its newest tailored version.
  const app2 = (await app.inject({ method: 'GET', url: `/applications/${created.id}` })).json() as Application;
  assert.equal(app2.resume_version_id, version.id);

  // …and it's listed under the application's resume-versions.
  const list = (await app.inject({ method: 'GET', url: `/applications/${created.id}/resume-versions` })).json() as ResumeVersion[];
  assert.equal(list.length, 1);
  assert.equal(list[0].id, version.id);
});

test('DELETE /applications/:id succeeds when the application has a tailored resume version', async () => {
  await app.inject({
    method: 'PUT',
    url: '/settings',
    payload: { provider: 'anthropic', anthropicApiKey: 'sk-ant-secret', baseResume: 'BASE RESUME' },
  });
  const created = await createApp({ job_description: 'Senior React role.' });

  stubFetch(200, {
    content: [{ type: 'text', text: 'TAILORED RESUME OUTPUT' }],
    usage: { input_tokens: 1000, output_tokens: 500 },
  });
  const tailorRes = await app.inject({ method: 'POST', url: `/applications/${created.id}/tailor` });
  assert.equal(tailorRes.statusCode, 201);

  // applications.resume_version_id and resume_versions.application_id reference
  // each other, so deletion must clear the app's pointer before dropping its
  // resume_versions rows, or the FK constraint on resume_version_id rejects it.
  const deleteRes = await app.inject({ method: 'DELETE', url: `/applications/${created.id}` });
  assert.equal(deleteRes.statusCode, 204);

  const getRes = await app.inject({ method: 'GET', url: `/applications/${created.id}` });
  assert.equal(getRes.statusCode, 404);
});

test('GET /:id/tailor-estimate 400s when there is no job description', async () => {
  await app.inject({ method: 'PUT', url: '/settings', payload: { baseResume: 'BASE' } });
  const created = await createApp();
  const res = await app.inject({ method: 'GET', url: `/applications/${created.id}/tailor-estimate` });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /job description/i);
});

test('GET /:id/tailor-estimate 400s when no base resume is configured', async () => {
  const created = await createApp({ job_description: 'Build things.' });
  const res = await app.inject({ method: 'GET', url: `/applications/${created.id}/tailor-estimate` });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /base resume/i);
});

test('GET /:id/tailor-estimate is unavailable for an unpriced model with no history', async () => {
  await app.inject({
    method: 'PUT',
    url: '/settings',
    payload: { model: 'some-unlisted-model', baseResume: 'BASE' },
  });
  const created = await createApp({ job_description: 'Some role.' });
  const res = await app.inject({ method: 'GET', url: `/applications/${created.id}/tailor-estimate` });
  assert.equal(res.statusCode, 200);
  const estimate = res.json() as { estimatedCost: number | null; source: string };
  assert.equal(estimate.source, 'unavailable');
  assert.equal(estimate.estimatedCost, null);
});

test('GET /:id/tailor-estimate falls back to a static per-token estimate with no history', async () => {
  await app.inject({
    method: 'PUT',
    url: '/settings',
    payload: { provider: 'anthropic', model: 'claude-sonnet-5', baseResume: 'x'.repeat(400) },
  });
  const created = await createApp({ job_description: 'y'.repeat(400) });
  const res = await app.inject({ method: 'GET', url: `/applications/${created.id}/tailor-estimate` });
  assert.equal(res.statusCode, 200);
  const estimate = res.json() as { estimatedCost: number; source: string };
  assert.equal(estimate.source, 'static');
  // 800 chars / 4 = 200 tokens in, 200 tokens out (same-length heuristic).
  // (200/1e6)*3 + (200/1e6)*15 = 0.0006 + 0.003 = 0.0036
  assert.ok(Math.abs(estimate.estimatedCost - 0.0036) < 1e-9);
});

test('GET /:id/tailor-estimate extrapolates from historical cost-per-char once a run exists', async () => {
  await app.inject({
    method: 'PUT',
    url: '/settings',
    payload: { provider: 'anthropic', anthropicApiKey: 'sk-ant', model: 'claude-sonnet-5', baseResume: 'BASE' },
  });
  const first = await createApp({ job_description: 'Role one.' });
  stubFetch(200, {
    content: [{ type: 'text', text: 'OUT' }],
    usage: { input_tokens: 1000, output_tokens: 500 },
  });
  const tailorRes = await app.inject({ method: 'POST', url: `/applications/${first.id}/tailor` });
  assert.equal(tailorRes.statusCode, 201);
  const version = tailorRes.json() as ResumeVersion;
  assert.ok(version.cost !== null && version.input_char_length !== null);
  const knownCostPerChar = (version.cost as number) / (version.input_char_length as number);

  const second = await createApp({ job_description: 'Role two.' });
  const res = await app.inject({ method: 'GET', url: `/applications/${second.id}/tailor-estimate` });
  assert.equal(res.statusCode, 200);
  const estimate = res.json() as { estimatedCost: number; source: string; sampleSize: number };
  assert.equal(estimate.source, 'historical');
  assert.equal(estimate.sampleSize, 1);
  const expectedChars = 'BASE'.length + 'Role two.'.length;
  assert.ok(Math.abs(estimate.estimatedCost - knownCostPerChar * expectedChars) < 1e-9);
});

test('POST /:id/tailor uses the OpenAI response shape and its usage fields', async () => {
  await app.inject({
    method: 'PUT',
    url: '/settings',
    payload: { provider: 'openai', model: 'gpt-4o', openaiApiKey: 'sk-openai', baseResume: 'BASE' },
  });
  const created = await createApp({ job_description: 'Backend role.' });

  // gpt-4o is priced at 2.5/10 per million.
  stubFetch(200, {
    choices: [{ message: { content: 'OPENAI TAILORED OUTPUT' } }],
    usage: { prompt_tokens: 2000, completion_tokens: 1000 },
  });
  const res = await app.inject({ method: 'POST', url: `/applications/${created.id}/tailor` });
  assert.equal(res.statusCode, 201);
  const version = res.json() as ResumeVersion;
  assert.equal(version.tailored_output, 'OPENAI TAILORED OUTPUT');
  assert.equal(version.input_tokens, 2000);
  assert.equal(version.output_tokens, 1000);
  // (2000/1e6)*2.5 + (1000/1e6)*10 = 0.005 + 0.01 = 0.015
  assert.ok(Math.abs((version.cost ?? 0) - 0.015) < 1e-9);
});

test('POST /:id/tailor records tokens but a null cost for an unpriced model', async () => {
  await app.inject({
    method: 'PUT',
    url: '/settings',
    payload: {
      provider: 'anthropic',
      model: 'some-unlisted-model',
      anthropicApiKey: 'sk-ant',
      baseResume: 'BASE',
    },
  });
  const created = await createApp({ job_description: 'Role.' });

  stubFetch(200, {
    content: [{ type: 'text', text: 'OUT' }],
    usage: { input_tokens: 100, output_tokens: 50 },
  });
  const res = await app.inject({ method: 'POST', url: `/applications/${created.id}/tailor` });
  assert.equal(res.statusCode, 201);
  const version = res.json() as ResumeVersion;
  assert.equal(version.input_tokens, 100);
  assert.equal(version.output_tokens, 50);
  assert.equal(version.cost, null); // no pricing for this model → unknown, not fabricated
});

test('GET /settings exposes a default model pricing table', async () => {
  const s = (await app.inject({ method: 'GET', url: '/settings' })).json() as PublicSettings;
  assert.ok(s.modelPricing);
  assert.deepEqual(s.modelPricing['claude-sonnet-5'], { inputPerMillion: 3, outputPerMillion: 15 });
});

test('PUT /settings replaces the model pricing table and round-trips it', async () => {
  await app.inject({
    method: 'PUT',
    url: '/settings',
    payload: { modelPricing: { 'my-model': { inputPerMillion: 1, outputPerMillion: 2 } } },
  });
  const s = (await app.inject({ method: 'GET', url: '/settings' })).json() as PublicSettings;
  assert.deepEqual(s.modelPricing['my-model'], { inputPerMillion: 1, outputPerMillion: 2 });
});

test('PUT /settings rejects a malformed pricing entry', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/settings',
    payload: { modelPricing: { bad: { inputPerMillion: -1, outputPerMillion: 2 } } },
  });
  assert.equal(res.statusCode, 400); // negative price violates minimum: 0
});

test('GET /settings/models 400s without a valid provider', async () => {
  const res = await app.inject({ method: 'GET', url: '/settings/models' });
  assert.equal(res.statusCode, 400);
});

test('GET /settings/models 400s when no API key is configured for that provider', async () => {
  const res = await app.inject({ method: 'GET', url: '/settings/models?provider=anthropic' });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /no api key/i);
});

test('GET /settings/models returns the Anthropic model list, filtered to ids only', async () => {
  await app.inject({
    method: 'PUT',
    url: '/settings',
    payload: { anthropicApiKey: 'sk-ant-secret' },
  });
  stubFetch(200, {
    data: [
      { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
      { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
    ],
  });
  const res = await app.inject({ method: 'GET', url: '/settings/models?provider=anthropic' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { models: string[] }).models, [
    'claude-sonnet-5',
    'claude-opus-4-8',
  ]);
});

test('GET /settings/models returns the OpenAI model list, filtered to chat-capable ids', async () => {
  await app.inject({
    method: 'PUT',
    url: '/settings',
    payload: { openaiApiKey: 'sk-openai-secret' },
  });
  stubFetch(200, {
    data: [
      { id: 'gpt-4o' },
      { id: 'gpt-4o-mini' },
      { id: 'text-embedding-3-small' },
      { id: 'whisper-1' },
      { id: 'o1' },
    ],
  });
  const res = await app.inject({ method: 'GET', url: '/settings/models?provider=openai' });
  assert.equal(res.statusCode, 200);
  const models = (res.json() as { models: string[] }).models;
  assert.deepEqual([...models].sort(), ['gpt-4o', 'gpt-4o-mini', 'o1']);
});

test('GET /settings/models 502s and surfaces the provider error on an upstream failure', async () => {
  await app.inject({
    method: 'PUT',
    url: '/settings',
    payload: { anthropicApiKey: 'bad-key' },
  });
  stubFetch(401, { error: { message: 'invalid x-api-key' } });
  const res = await app.inject({ method: 'GET', url: '/settings/models?provider=anthropic' });
  assert.equal(res.statusCode, 502);
  assert.match((res.json() as { error: string }).error, /invalid x-api-key/);
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
