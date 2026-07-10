import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api';

// Regression coverage for the DELETE 400 bug: request() used to set
// Content-Type: application/json on every call, including bodyless
// DELETE/GET requests. Fastify rejects a bodyless request that declares a
// JSON content-type (FST_ERR_CTP_EMPTY_JSON_BODY), so deleting an entry
// from the dashboard failed. These tests pin the fetch() call shape directly,
// since backend tests alone can't catch this — app.inject() in the backend
// suite never sends a Content-Type header on a bodyless request, so it never
// exercised the request shape the real dashboard was sending.
describe('api request()', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('DELETE sends no Content-Type header (no body)', async () => {
    await api.remove(1);
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.has('Content-Type')).toBe(false);
  });

  test('POST with a body sends Content-Type: application/json', async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ id: 1 }), { status: 201 }),
    ) as unknown as typeof fetch;

    await api.create({ company: 'Acme', title: 'Engineer' } as never);
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  test('PATCH with a body sends Content-Type: application/json', async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ id: 1 }), { status: 200 }),
    ) as unknown as typeof fetch;

    await api.update(1, { status: 'interviewing' });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('Content-Type')).toBe('application/json');
  });
});
