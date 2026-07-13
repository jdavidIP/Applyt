import type {
  Application,
  ApplicationInput,
  Filters,
  Status,
  StatsResponse,
  PublicSettings,
  SettingsInput,
  ResumeVersion,
  TailorEstimate,
  ModelsResponse,
  KnownPricingResponse,
  AiProvider,
} from './types';

// Base URL for the local backend. In dev, defaults to '/api' which Vite proxies
// to the backend (see vite.config.ts). Override with VITE_API_BASE if needed.
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON content-type when we're actually sending a body.
  // A bodyless request (GET/DELETE) that sets Content-Type: application/json
  // makes Fastify reject it with FST_ERR_CTP_EMPTY_JSON_BODY.
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      detail = body.error ?? body.message ?? detail;
    } catch {
      // non-JSON error body; keep statusText
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function buildQuery(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.platform) params.set('platform', filters.platform);
  if (filters.status) params.set('status', filters.status);
  params.set('sort', filters.sort);
  params.set('order', filters.order);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export const api = {
  list: (filters: Filters): Promise<Application[]> =>
    request<Application[]>(`/applications${buildQuery(filters)}`),

  create: (input: ApplicationInput): Promise<Application> =>
    request<Application>('/applications', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  update: (id: number, patch: Partial<ApplicationInput>): Promise<Application> =>
    request<Application>(`/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  remove: (id: number): Promise<void> =>
    request<void>(`/applications/${id}`, { method: 'DELETE' }),

  exportCsvUrl: (): string => `${API_BASE}/applications/export.csv`,

  stats: (): Promise<StatsResponse> => request<StatsResponse>('/applications/stats'),

  markStale: (thresholdDays: number): Promise<{ updated: number }> =>
    request<{ updated: number }>('/applications/mark-stale', {
      method: 'POST',
      body: JSON.stringify({ thresholdDays }),
    }),

  bulkDeleteByStatus: (status: Status): Promise<{ deleted: number }> =>
    request<{ deleted: number }>(`/applications?status=${encodeURIComponent(status)}`, {
      method: 'DELETE',
    }),

  getSettings: (): Promise<PublicSettings> => request<PublicSettings>('/settings'),

  getModels: (provider: AiProvider): Promise<ModelsResponse> =>
    request<ModelsResponse>(`/settings/models?provider=${provider}`),

  getKnownPricing: (): Promise<KnownPricingResponse> =>
    request<KnownPricingResponse>('/settings/known-pricing'),

  saveSettings: (input: SettingsInput): Promise<PublicSettings> =>
    request<PublicSettings>('/settings', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  tailor: (id: number): Promise<ResumeVersion> =>
    request<ResumeVersion>(`/applications/${id}/tailor`, { method: 'POST' }),

  estimateTailorCost: (id: number): Promise<TailorEstimate> =>
    request<TailorEstimate>(`/applications/${id}/tailor-estimate`),

  listResumeVersions: (id: number): Promise<ResumeVersion[]> =>
    request<ResumeVersion[]>(`/applications/${id}/resume-versions`),
};
