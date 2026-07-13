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

// Phase 4 AI tailoring (CLAUDE.md §7): settings + tailor + resume-versions.
describe('api Phase 4 tailoring functions', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('getSettings GETs /settings', async () => {
    const payload = {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      baseResume: '',
      hasAnthropicKey: false,
      hasOpenaiKey: false,
    };
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await api.getSettings();
    expect(result).toEqual(payload);
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/settings');
  });

  test('saveSettings PUTs the settings payload as JSON', async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ provider: 'openai' }), { status: 200 }),
    ) as unknown as typeof fetch;

    await api.saveSettings({ provider: 'openai', model: 'gpt-4o', openaiApiKey: 'sk-x' });
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/settings');
    expect((init as RequestInit).method).toBe('PUT');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      openaiApiKey: 'sk-x',
    });
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  test('saveSettings sends a modelPricing table when provided', async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ provider: 'anthropic' }), { status: 200 }),
    ) as unknown as typeof fetch;

    await api.saveSettings({
      model: 'claude-sonnet-5',
      modelPricing: { 'claude-sonnet-5': { inputPerMillion: 3, outputPerMillion: 15 } },
    });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string).modelPricing).toEqual({
      'claude-sonnet-5': { inputPerMillion: 3, outputPerMillion: 15 },
    });
  });

  test('tailor POSTs to /applications/:id/tailor with the include-section options', async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ id: 1, tailored_output: 'X' }), { status: 201 }),
    ) as unknown as typeof fetch;

    const result = await api.tailor(7, { includeMatchRating: false, includeSuggestions: true });
    expect(result).toEqual({ id: 1, tailored_output: 'X' });
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/applications/7/tailor');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      includeMatchRating: false,
      includeSuggestions: true,
    });
  });

  test('listResumeVersions GETs /applications/:id/resume-versions', async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify([]), { status: 200 }),
    ) as unknown as typeof fetch;

    await api.listResumeVersions(7);
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/applications/7/resume-versions');
  });

  test('estimateTailorCost GETs /applications/:id/tailor-estimate with no body', async () => {
    const payload = { estimatedCost: 0.0105, source: 'historical', sampleSize: 3, model: 'claude-sonnet-5' };
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await api.estimateTailorCost(7);
    expect(result).toEqual(payload);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/applications/7/tailor-estimate');
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.has('Content-Type')).toBe(false);
  });

  test('getModels GETs /settings/models with a provider query param and no body', async () => {
    const payload = { models: ['claude-sonnet-5', 'claude-opus-4-8'] };
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await api.getModels('anthropic');
    expect(result).toEqual(payload);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/settings/models?provider=anthropic');
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.has('Content-Type')).toBe(false);
  });

  test('getKnownPricing GETs /settings/known-pricing with no body', async () => {
    const payload = { asOf: '2026-07-13', pricing: { 'claude-sonnet-5': { inputPerMillion: 2, outputPerMillion: 10 } } };
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await api.getKnownPricing();
    expect(result).toEqual(payload);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/settings/known-pricing');
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.has('Content-Type')).toBe(false);
  });
});

// Resume file upload/download (CLAUDE.md §8: "PDF/docx parsing library
// choice"). Both functions deliberately bypass the shared request() helper:
// a multipart upload must let the browser set its own Content-Type boundary,
// and a file download is a Blob, not JSON.
describe('api resume file upload/download functions', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('extractResumeText POSTs a FormData body with no manually-set Content-Type', async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ text: 'Jane Doe — Engineer' }), { status: 200 }),
    ) as unknown as typeof fetch;

    const file = new File(['fake pdf bytes'], 'resume.pdf', { type: 'application/pdf' });
    const result = await api.extractResumeText(file);
    expect(result).toEqual({ text: 'Jane Doe — Engineer' });

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/settings/base-resume/extract');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
    // The browser sets its own multipart boundary — a manually-set
    // Content-Type here would break the upload (missing boundary).
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.has('Content-Type')).toBe(false);
  });

  test('extractResumeText surfaces the backend error message on failure', async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: 'Unsupported file type.' }), { status: 400 }),
    ) as unknown as typeof fetch;

    const file = new File(['x'], 'resume.txt', { type: 'text/plain' });
    await expect(api.extractResumeText(file)).rejects.toThrow('Unsupported file type.');
  });

  test('downloadResumeVersion GETs the download URL with a format query param and returns a Blob', async () => {
    const blob = new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' });
    global.fetch = vi.fn(
      async () => new Response(blob, { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await api.downloadResumeVersion(7, 3, 'pdf');
    expect(result).toBeInstanceOf(Blob);
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/applications/7/resume-versions/3/download?format=pdf');
  });

  test('downloadResumeVersion surfaces the backend error message on failure', async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: 'Resume version not found.' }), { status: 404 }),
    ) as unknown as typeof fetch;

    await expect(api.downloadResumeVersion(7, 999, 'txt')).rejects.toThrow('Resume version not found.');
  });
});
