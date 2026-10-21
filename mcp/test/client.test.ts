import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createBackendClient, BackendError, resolveBaseUrl } from '../src/client.ts';

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

test('resolveBaseUrl defaults and strips trailing slash', () => {
  assert.equal(resolveBaseUrl({}), 'http://localhost:4317');
  assert.equal(resolveBaseUrl({ APPLYT_URL: 'http://127.0.0.1:9000/' }), 'http://127.0.0.1:9000');
});

test('request sends JSON and parses JSON', async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  global.fetch = (async (url: string, init?: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const client = createBackendClient('http://localhost:4317');
  const out = await client.request('POST', '/applications', { company: 'A' });
  assert.deepEqual(out, { ok: 1 });
  assert.equal(seen?.url, 'http://localhost:4317/applications');
  assert.equal(seen?.init?.method, 'POST');
  assert.equal(seen?.init?.body, JSON.stringify({ company: 'A' }));
  assert.equal((seen?.init?.headers as Record<string, string>)['content-type'], 'application/json');
});

test('request returns undefined for 204', async () => {
  global.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  assert.equal(await createBackendClient('http://x').request('DELETE', '/applications/1'), undefined);
});

test('unreachable backend throws a BackendError telling the user how to start it', async () => {
  global.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  await assert.rejects(createBackendClient('http://localhost:4317').request('GET', '/applications'), (err: unknown) => {
    assert.ok(err instanceof BackendError);
    assert.match(err.message, /isn't reachable at http:\/\/localhost:4317/);
    assert.match(err.message, /npm run dev/);
    assert.match(err.message, /docker compose up/);
    return true;
  });
});

test('non-2xx passes the backend error message through with the status', async () => {
  global.fetch = (async () =>
    new Response(JSON.stringify({ error: 'Application not found' }), { status: 404 })) as typeof fetch;
  await assert.rejects(createBackendClient('http://x').request('GET', '/applications/9'), /404: Application not found/);
});

test('non-2xx without a JSON body still produces a message', async () => {
  global.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
  await assert.rejects(createBackendClient('http://x').request('GET', '/x'), /500/);
});

test('request sends FormData as-is, without a JSON content-type', async () => {
  let seen: RequestInit | undefined;
  global.fetch = (async (_url: string, init?: RequestInit) => {
    seen = init;
    return new Response(JSON.stringify({ id: 1 }), { status: 201 });
  }) as typeof fetch;
  const form = new FormData();
  form.append('resume', new Blob(['%PDF-']), 'r.pdf');
  await createBackendClient('http://x').request('POST', '/applications/1/resume-versions/files', form);
  assert.ok(seen?.body instanceof FormData);
  assert.equal((seen?.headers as Record<string, string>)['content-type'], undefined);
});
