// The only module in mcp/ that talks to the network. Every tool goes through
// request(), so "backend not running" and backend validation errors surface
// to Claude the same way everywhere. No business logic lives here — the
// backend owns validation and storage (CLAUDE.md §2: one storage path).

export class BackendError extends Error {}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface BackendClient {
  baseUrl: string;
  request<T = unknown>(method: Method, path: string, body?: unknown): Promise<T>;
}

export function resolveBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env.APPLYT_URL || 'http://localhost:4317').replace(/\/+$/, '');
}

export function createBackendClient(baseUrl: string): BackendClient {
  async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new BackendError(
        `Applyt backend isn't reachable at ${baseUrl} — start it with \`npm run dev\` or \`docker compose up\`.`,
      );
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const msg =
        data && typeof data === 'object' && 'error' in data
          ? String((data as { error: unknown }).error)
          : text || res.statusText;
      throw new BackendError(`${res.status}: ${msg}`);
    }
    return data as T;
  }
  return { baseUrl, request };
}
