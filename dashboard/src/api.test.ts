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

// Phase 3 lifecycle actions (CLAUDE.md §7): mark-stale, bulk-delete-by-status,
// and stats. Pinning the request shape (method, URL, body) the same way the
// pre-existing suite above does for create/update/remove.
describe('api Phase 3 lifecycle functions', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('markStale POSTs thresholdDays as JSON', async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ updated: 3 }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await api.markStale(30);
    expect(result).toEqual({ updated: 3 });

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/applications/mark-stale');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ thresholdDays: 30 });
  });

  test('bulkDeleteByStatus DELETEs with a status query param and no body', async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ deleted: 2 }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await api.bulkDeleteByStatus('rejected');
    expect(result).toEqual({ deleted: 2 });

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/applications?status=rejected');
    expect((init as RequestInit).method).toBe('DELETE');
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.has('Content-Type')).toBe(false); // bodyless — the DELETE-400 regression this suite already guards
  });

  test('stats GETs /applications/stats and returns the parsed response', async () => {
    const payload = { totalApplications: 5, perWeek: [{ weekStart: '2026-07-06', count: 5 }], responseRate: 0.4 };
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await api.stats();
    expect(result).toEqual(payload);
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/applications/stats');
  });
});
