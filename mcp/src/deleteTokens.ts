import { randomUUID } from 'node:crypto';

// Preview -> confirm guard for deletes. preview_delete resolves its target to
// a concrete id set and issues a token for it; confirm_delete must present
// that token plus the count it expects to delete. This can't stop the model
// from confirming its own preview — the client's per-tool approval prompt is
// the real human checkpoint — but it guarantees nothing is deleted that the
// model (and that prompt) never saw. In-memory only: a server restart simply
// invalidates outstanding tokens, which is the safe direction.

export const DELETE_TOKEN_TTL_MS = 5 * 60 * 1000;

export type DeleteTarget = { kind: 'ids' } | { kind: 'status'; status: string };

export interface PendingDelete {
  ids: number[];
  target: DeleteTarget;
  createdAt: number;
}

export type TakeResult = { ok: true; pending: PendingDelete } | { ok: false; reason: string };

export interface DeleteTokenStore {
  issue(ids: number[], target: DeleteTarget): string;
  take(token: string, expectedCount: number): TakeResult;
}

// ponytail: never-confirmed tokens stay in the map until the process exits —
// a few bytes each, and the process lives only as long as one Claude session.
export function createDeleteTokenStore(
  opts: { now?: () => number; ttlMs?: number; newToken?: () => string } = {},
): DeleteTokenStore {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DELETE_TOKEN_TTL_MS;
  const newToken = opts.newToken ?? randomUUID;
  const pending = new Map<string, PendingDelete>();

  return {
    issue(ids, target) {
      const token = newToken();
      pending.set(token, { ids: [...new Set(ids)].sort((a, b) => a - b), target, createdAt: now() });
      return token;
    },
    take(token, expectedCount) {
      const p = pending.get(token);
      pending.delete(token); // single use, success or failure
      if (!p) return { ok: false, reason: 'Confirmation token is unknown or already used — run preview_delete again.' };
      if (now() - p.createdAt > ttlMs) {
        return {
          ok: false,
          reason: `Confirmation token expired (${Math.round(ttlMs / 60000)} minutes) — run preview_delete again.`,
        };
      }
      if (expectedCount !== p.ids.length) {
        return {
          ok: false,
          reason: `Count mismatch: expected ${expectedCount} but the preview matched ${p.ids.length} — run preview_delete again.`,
        };
      }
      return { ok: true, pending: p };
    },
  };
}
