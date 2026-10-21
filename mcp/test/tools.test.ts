import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTools, type ToolDef } from '../src/tools.ts';
import { createBackendClient } from '../src/client.ts';
import { createDeleteTokenStore } from '../src/deleteTokens.ts';

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

type Call = { method: string; url: string; body?: unknown };

// Routes a stubbed fetch by "METHOD path" (path includes query string).
function stubFetch(routes: Record<string, (body: unknown) => { status?: number; json?: unknown }>): Call[] {
  const calls: Call[] = [];
  global.fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const key = `${init?.method ?? 'GET'} ${u.pathname}${u.search}`;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method: init?.method ?? 'GET', url: `${u.pathname}${u.search}`, body });
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ error: `no stub for ${key}` }), { status: 599 });
    const { status = 200, json } = handler(body);
    return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
  return calls;
}

function setup() {
  let n = 0;
  const tools = buildTools(
    createBackendClient('http://localhost:4317'),
    createDeleteTokenStore({ newToken: () => `tok${++n}` }),
  );
  const get = (name: string): ToolDef => {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `tool ${name} missing`);
    return t;
  };
  return { tools, get };
}

const text = (r: { content: { text: string }[] }) => r.content[0].text;
const app = (id: number, extra: Record<string, unknown> = {}) => ({
  id, company: `Co${id}`, title: 'Eng', status: 'rejected', platform: 'manual', job_description: 'long JD', ...extra,
});

test('registers the nine tools with the right annotations', () => {
  const { tools, get } = setup();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'confirm_delete', 'create_application', 'get_application', 'get_base_resume', 'get_stats',
    'list_applications', 'preview_delete', 'save_tailored_resume', 'update_application',
  ]);
  for (const name of ['list_applications', 'get_application', 'get_base_resume', 'get_stats', 'preview_delete']) {
    assert.equal(get(name).annotations.readOnlyHint, true, name);
  }
  assert.equal(get('confirm_delete').annotations.destructiveHint, true);
  assert.equal(get('create_application').annotations.destructiveHint, false);
  assert.equal(get('update_application').annotations.idempotentHint, true);
});

test('list_applications forwards filters and strips job_description', async () => {
  const calls = stubFetch({
    'GET /applications?search=acme&status=applied&pageSize=50': () => ({
      json: { items: [app(1)], total: 1, page: 1, pageSize: 50 },
    }),
  });
  const r = await setup().get('list_applications').handler({ search: 'acme', status: 'applied', pageSize: 50 });
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 1);
  const out = JSON.parse(text(r));
  assert.equal(out.total, 1);
  assert.equal('job_description' in out.items[0], false);
});

test('get_application combines the row and a version summary', async () => {
  stubFetch({
    'GET /applications/7': () => ({ json: app(7) }),
    'GET /applications/7/resume-versions': () => ({
      json: [{ id: 3, created_at: '2026-10-19', ai_provider: 'mcp', model: null, tailored_output: '{"resume":{},"matchRating":4}' }],
    }),
  });
  const out = JSON.parse(text(await setup().get('get_application').handler({ id: 7 })));
  assert.equal(out.application.job_description, 'long JD');
  assert.deepEqual(out.resumeVersions, [{ id: 3, created_at: '2026-10-19', ai_provider: 'mcp', model: null, matchRating: 4 }]);
});

test('get_base_resume returns only the resume text, with a hint when empty', async () => {
  stubFetch({ 'GET /settings': () => ({ json: { baseResume: 'Jane Doe', hasAnthropicKey: true } }) });
  assert.equal(text(await setup().get('get_base_resume').handler({})), 'Jane Doe');
  stubFetch({ 'GET /settings': () => ({ json: { baseResume: '  ' } }) });
  const empty = await setup().get('get_base_resume').handler({});
  assert.equal(empty.isError, true);
  assert.match(text(empty), /No base resume set/);
});

test('create_application forces manual platform and apply method', async () => {
  const calls = stubFetch({ 'POST /applications': (b) => ({ status: 201, json: { id: 1, ...(b as object) } }) });
  await setup().get('create_application').handler({ company: 'A', title: 'B', platform: 'linkedin' });
  assert.equal((calls[0].body as { platform: string }).platform, 'manual');
  assert.equal((calls[0].body as { apply_method: string }).apply_method, 'manual');
});

test('update_application sends only the provided fields', async () => {
  const calls = stubFetch({ 'PATCH /applications/4': (b) => ({ json: { id: 4, ...(b as object) } }) });
  await setup().get('update_application').handler({ id: 4, status: 'interviewing' });
  assert.deepEqual(calls[0].body, { status: 'interviewing' });
});

test('save_tailored_resume posts the envelope and surfaces validation errors', async () => {
  const calls = stubFetch({
    'POST /applications/2/resume-versions': () => ({ status: 201, json: { id: 11, application_id: 2 } }),
  });
  const ok = await setup().get('save_tailored_resume').handler({ applicationId: 2, resume: { contact: { name: 'J' } } });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(calls[0].body, { resume: { contact: { name: 'J' } } });
  assert.match(text(ok), /version 11/);

  stubFetch({
    'POST /applications/2/resume-versions': () => ({ status: 400, json: { error: 'resume.experience must be an array' } }),
  });
  const bad = await setup().get('save_tailored_resume').handler({ applicationId: 2, resume: {} });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /400: resume\.experience must be an array/);
});

test('unreachable backend becomes a tool error, not a throw', async () => {
  global.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const r = await setup().get('get_stats').handler({});
  assert.equal(r.isError, true);
  assert.match(text(r), /isn't reachable/);
});

test('preview_delete by ids lists rows and issues a token; confirm deletes them', async () => {
  const calls = stubFetch({
    'GET /applications/1': () => ({ json: app(1) }),
    'GET /applications/2': () => ({ json: app(2) }),
    'POST /applications/bulk-delete': () => ({ json: { deleted: 2 } }),
  });
  const { get } = setup();
  const preview = JSON.parse(text(await get('preview_delete').handler({ ids: [2, 1] })));
  assert.equal(preview.count, 2);
  assert.equal(preview.token, 'tok1');
  assert.deepEqual(preview.applications.map((a: { id: number }) => a.id), [1, 2]);
  assert.equal(calls.some((c) => c.url.includes('bulk-delete')), false); // preview deletes nothing

  const done = await get('confirm_delete').handler({ token: 'tok1', expectedCount: 2 });
  assert.equal(done.isError, undefined);
  assert.deepEqual(calls.at(-1)?.body, { ids: [1, 2] });
  assert.match(text(done), /Deleted 2/);
});

test('preview_delete requires exactly one of ids or status', async () => {
  const { get } = setup();
  assert.equal((await get('preview_delete').handler({})).isError, true);
  assert.equal((await get('preview_delete').handler({ ids: [1], status: 'rejected' })).isError, true);
});

test('preview_delete by status pages through more than 100 matches', async () => {
  const page = (p: number, ids: number[]) => ({ json: { items: ids.map((id) => app(id)), total: 150, page: p, pageSize: 100 } });
  stubFetch({
    'GET /applications?status=rejected&pageSize=100&page=1': () => page(1, Array.from({ length: 100 }, (_, i) => i + 1)),
    'GET /applications?status=rejected&pageSize=100&page=2': () => page(2, Array.from({ length: 50 }, (_, i) => i + 101)),
  });
  const preview = JSON.parse(text(await setup().get('preview_delete').handler({ status: 'rejected' })));
  assert.equal(preview.count, 150);
});

test('confirm_delete refuses when the status set changed since preview', async () => {
  let ids = [1, 2];
  const calls = stubFetch({
    'GET /applications?status=rejected&pageSize=100&page=1': () => ({
      json: { items: ids.map((id) => app(id)), total: ids.length, page: 1, pageSize: 100 },
    }),
    'POST /applications/bulk-delete': () => ({ json: { deleted: 2 } }),
  });
  const { get } = setup();
  await get('preview_delete').handler({ status: 'rejected' });
  ids = [1, 2, 3]; // extension logged another rejection
  const r = await get('confirm_delete').handler({ token: 'tok1', expectedCount: 2 });
  assert.equal(r.isError, true);
  assert.match(text(r), /changed since the preview/);
  assert.equal(calls.some((c) => c.url.includes('bulk-delete')), false);
});

test('confirm_delete refuses a wrong count or reused token', async () => {
  stubFetch({ 'GET /applications/1': () => ({ json: app(1) }) });
  const { get } = setup();
  await get('preview_delete').handler({ ids: [1] });
  const wrong = await get('confirm_delete').handler({ token: 'tok1', expectedCount: 5 });
  assert.equal(wrong.isError, true);
  const reused = await get('confirm_delete').handler({ token: 'tok1', expectedCount: 1 });
  assert.match(text(reused), /unknown or already used/);
});
