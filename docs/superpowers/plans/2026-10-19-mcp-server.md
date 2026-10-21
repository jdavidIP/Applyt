# Applyt MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local stdio MCP server (`mcp/`) that lets Claude Desktop / Claude Code read, tailor-for, create, update, and (guardedly) delete Applyt applications through the existing backend.

**Architecture:** Two backend additions (save an externally written tailored resume; bulk delete by IDs, with a shared delete helper that also fixes the status bulk delete). A new `mcp/` npm workspace: a thin HTTP client over `localhost:4317`, an in-memory preview→confirm delete-token store, and nine tools registered on an `McpServer` over stdio. No business logic in `mcp/`.

**Tech Stack:** Node ≥ 20, TypeScript (ESM, NodeNext), Fastify + better-sqlite3 (backend, existing), `@modelcontextprotocol/server` ^2.3.1 + `zod` ^4.2.0 (new, `mcp/` only), `node:test` via `tsx`.

**Spec:** `docs/superpowers/specs/2026-10-19-mcp-server-design.md`

## Global Constraints

- Branch: `feat/mcp-server` (already created off up-to-date `main`). Never commit to `main`.
- **Commit only after the user explicitly confirms** each commit (user's standing rule). Every "Commit" step below = show the diff summary, ask, then commit. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run the `code-reviewer` subagent on the full branch before opening the PR; do not open/push the PR without asking.
- `mcp/` never opens the SQLite file; every read/write goes through the backend HTTP API (CLAUDE.md §2).
- No new dependencies outside `mcp/`. In `mcp/`: only `@modelcontextprotocol/server` and `zod`.
- Backend default URL: `APPLYT_URL` env var, default `http://localhost:4317`.
- MCP-saved resume versions: `ai_provider = 'mcp'`, `model = NULL`, `input_tokens = NULL`, `output_tokens = NULL`, `cost = 0`, `input_char_length = NULL`.
- Delete token TTL: 5 minutes; single use. Bulk delete max 500 IDs.
- Source imports use `.js` extensions; test files import sources with `.ts` extensions (existing repo convention, e.g. `backend/test/applications.test.ts`).
- Tests: `npm test --workspace backend`, `npm test --workspace mcp`, then root `npm test` and `npm run build`.

## Review Focus

1. **Backend not running when Claude calls a tool** → a clear "isn't reachable at … start it with …" tool error, never a stack trace or server crash. (Pinned in Task 3.)
2. **Status-based delete over 100 matching rows** (list route caps `pageSize` at 100) → preview must collect *all* IDs across pages, not silently delete only the first 100. (Pinned in Task 5.)
3. **Claude submits a resume with one malformed nested entry** (e.g. `bullets` a string) → 400 naming the exact path, not a silent drop of that entry. (Pinned in Task 2.)
4. **Bulk delete where one ID was already deleted (e.g. from the dashboard) between preview and confirm** → nothing deleted, 404 listing missing IDs; no partial delete. (Pinned in Task 1.)
5. **Dashboard "Delete all rejected" when a rejected application has a tailored resume** → succeeds (today it 500s on the FK). (Pinned in Task 1.)

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/routes/applications.ts` (modify) | `deleteApplicationsCascade()` + `insertResumeVersion()` inner helpers; new `POST /applications/bulk-delete` and `POST /applications/:id/resume-versions`; status bulk delete and single delete and `/tailor` switched to the helpers |
| `backend/src/validation.ts` (modify) | `bulkDeleteIdsSchema` |
| `backend/src/types/index.ts` (modify) | `BulkDeleteIdsBody` |
| `backend/src/resume/envelopeValidation.ts` (create) | strict `findEnvelopeError()` (done, moved out of resumeSchema.ts) |
| `backend/test/mcp-endpoints.test.ts` (create) | tests for both new endpoints + status-delete regression |
| `mcp/package.json`, `mcp/tsconfig.json` (create) | workspace setup |
| `mcp/src/client.ts` (create) | `createBackendClient()` — the only place that does `fetch`, error normalization |
| `mcp/src/deleteTokens.ts` (create) | pure preview→confirm token store |
| `mcp/src/tools.ts` (create) | `buildTools(client, tokens)` → array of tool definitions + handlers |
| `mcp/src/index.ts` (create) | entrypoint: `McpServer`, register tools, stdio transport |
| `mcp/test/*.test.ts` (create) | client, token store, tool tests |
| `package.json` (root, modify) | add `mcp` to workspaces/build/test |
| `SETUP.md`, `README.md`, `ARCHITECTURE.md`, `CLAUDE.md` (modify) | docs |

---

### Task 1: Shared delete helper, status-delete FK fix, and `POST /applications/bulk-delete`

**Files:**
- Modify: `backend/src/routes/applications.ts` (status bulk delete ~line 308, single delete ~line 465; add new route next to status bulk delete)
- Modify: `backend/src/validation.ts` (after `bulkDeleteQuerySchema`, ~line 129)
- Modify: `backend/src/types/index.ts` (next to `BulkDeleteQuery`)
- Create: `backend/test/mcp-endpoints.test.ts`

**Interfaces:**
- Produces: `POST /applications/bulk-delete` body `{ ids: number[] }` → `200 { deleted: number }` | `404 { error: string, missingIds: number[] }` | `400`.
- Produces (inner, in `applicationsRoutes`): `deleteApplicationsCascade(ids: number[]): number` — returns rows deleted from `applications`; runs in one transaction.

- [x] **Step 1: Write the failing tests**

Create `backend/test/mcp-endpoints.test.ts`:

```ts
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createDb } from '../src/storage/db.ts';
import { createSettingsStore } from '../src/storage/settings.ts';
import type { Application } from '../src/types/index.ts';

let app: FastifyInstance;
const db = createDb(':memory:');
const tmp = mkdtempSync(join(tmpdir(), 'applyt-mcp-endpoints-'));
const settings = createSettingsStore(join(tmp, 'settings.json'));

before(async () => {
  process.env.NODE_ENV = 'test';
  settings.update({ baseResume: 'Jane Doe\nSoftware Engineer' });
  app = await buildApp(db, settings);
  await app.ready();
});

after(async () => {
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM cover_letters; DELETE FROM resume_versions; DELETE FROM applications;');
});

async function createSample(overrides: Record<string, unknown> = {}): Promise<Application> {
  const res = await app.inject({
    method: 'POST',
    url: '/applications',
    payload: { company: 'Acme Corp', title: 'Engineer', ...overrides },
  });
  assert.equal(res.statusCode, 201);
  return res.json() as Application;
}

// Inserts a resume version + cover letter directly, the way /tailor would,
// so delete tests exercise the FK chain without needing an AI call.
function attachVersionAndCoverLetter(applicationId: number): void {
  const info = db
    .prepare(
      "INSERT INTO resume_versions (application_id, tailored_output, ai_provider, created_at) VALUES (?, '{}', 'anthropic', datetime('now'))",
    )
    .run(applicationId);
  db.prepare(
    "INSERT INTO cover_letters (application_id, resume_version_id, tailored_output, created_at) VALUES (?, ?, '{}', datetime('now'))",
  ).run(applicationId, info.lastInsertRowid);
}

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

// ---- status bulk delete regression ----

test('DELETE /applications?status= deletes rows that have resume versions and cover letters', async () => {
  const a = await createSample({ status: 'rejected' });
  attachVersionAndCoverLetter(a.id);
  await createSample({ status: 'applied' });

  const res = await app.inject({ method: 'DELETE', url: '/applications?status=rejected' });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { deleted: number }).deleted, 1);
  assert.equal(count('applications'), 1);
  assert.equal(count('resume_versions'), 0);
  assert.equal(count('cover_letters'), 0);
});

// ---- POST /applications/bulk-delete ----

test('bulk-delete removes the given applications and their versions/cover letters', async () => {
  const a = await createSample();
  const b = await createSample({ company: 'Beta' });
  const keep = await createSample({ company: 'Keep' });
  attachVersionAndCoverLetter(a.id);

  const res = await app.inject({
    method: 'POST',
    url: '/applications/bulk-delete',
    payload: { ids: [a.id, b.id] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { deleted: 2 });
  const remaining = db.prepare('SELECT id FROM applications').all() as { id: number }[];
  assert.deepEqual(remaining.map((r) => r.id), [keep.id]);
  assert.equal(count('resume_versions'), 0);
  assert.equal(count('cover_letters'), 0);
});

test('bulk-delete dedupes ids', async () => {
  const a = await createSample();
  const res = await app.inject({
    method: 'POST',
    url: '/applications/bulk-delete',
    payload: { ids: [a.id, a.id] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { deleted: 1 });
});

test('bulk-delete with any missing id deletes nothing and lists the missing ids', async () => {
  const a = await createSample();
  const res = await app.inject({
    method: 'POST',
    url: '/applications/bulk-delete',
    payload: { ids: [a.id, 999999] },
  });
  assert.equal(res.statusCode, 404);
  assert.deepEqual((res.json() as { missingIds: number[] }).missingIds, [999999]);
  assert.equal(count('applications'), 1);
});

test('bulk-delete rejects empty, non-integer, and oversized id lists', async () => {
  for (const ids of [[], [1.5], ['1'], [0], Array.from({ length: 501 }, (_, i) => i + 1)]) {
    const res = await app.inject({ method: 'POST', url: '/applications/bulk-delete', payload: { ids } });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(ids).slice(0, 40)}`);
  }
  const missing = await app.inject({ method: 'POST', url: '/applications/bulk-delete', payload: {} });
  assert.equal(missing.statusCode, 400);
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace backend -- --test-name-pattern="bulk-delete|status= deletes"`
(If the pattern flag doesn't pass through the workspace script, run `cd backend && npx tsx --test --test-name-pattern="bulk-delete|status= deletes" test/mcp-endpoints.test.ts`.)
Expected: FAIL — status delete returns 500 (`FOREIGN KEY constraint failed`); bulk-delete routes return 404 (route not found).

- [x] **Step 3: Add the body type and schema**

In `backend/src/types/index.ts`, next to `BulkDeleteQuery`:

```ts
export interface BulkDeleteIdsBody {
  ids: number[];
}
```

In `backend/src/validation.ts`, after `bulkDeleteQuerySchema`:

```ts
// POST /applications/bulk-delete — used by the MCP server's confirm_delete.
// POST (not DELETE) because DELETE request bodies are poorly supported.
export const bulkDeleteIdsSchema = {
  type: 'object',
  required: ['ids'],
  additionalProperties: false,
  properties: {
    ids: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      items: { type: 'integer', minimum: 1 },
    },
  },
} as const;
```

Note: Fastify's default Ajv config has `coerceTypes` on for querystrings; verify `['1']` is rejected for a JSON body (it should be — body coercion of array items applies only if `coerceTypes: 'array'` is configured). If the `['1']` case passes as 200/404, remove it from the test and add a comment that Ajv coerces it, rather than changing global Ajv config.

- [x] **Step 4: Add the shared helper and switch both existing delete routes to it**

In `backend/src/routes/applications.ts`, add imports `BulkDeleteIdsBody` (types) and `bulkDeleteIdsSchema` (validation). Directly after `getApplicationById`, add:

```ts
  // cover_letters references both applications(id) and resume_versions(id)
  // with no ON DELETE CASCADE (and db.ts enables foreign_keys), so its rows
  // must go first, then resume_versions, then the applications themselves.
  // Shared by every delete path so none of them can forget a table.
  const deleteApplicationsCascade = db.transaction((ids: number[]): number => {
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM cover_letters WHERE application_id IN (${placeholders})`,
    ).run(...ids);
    db.prepare(
      `DELETE FROM resume_versions WHERE application_id IN (${placeholders})`,
    ).run(...ids);
    return db
      .prepare(`DELETE FROM applications WHERE id IN (${placeholders})`)
      .run(...ids).changes;
  });
```

Replace the status bulk delete handler body with:

```ts
    async (request) => {
      const ids = (
        db
          .prepare("SELECT id FROM applications WHERE status = ?")
          .all(request.query.status) as { id: number }[]
      ).map((r) => r.id);
      const deleted = ids.length ? deleteApplicationsCascade(ids) : 0;
      return { deleted };
    },
```

Replace the single-delete handler body with:

```ts
    async (request, reply) => {
      const deleted = deleteApplicationsCascade([request.params.id]);
      if (deleted === 0)
        return reply.code(404).send({ error: "Application not found" });
      return reply.code(204).send();
    },
```

(Remove the old inline `deleteApplication` transaction and its comment — the comment now lives on the helper.)

- [x] **Step 5: Add the bulk-delete-by-ids route**

Directly after the status bulk delete route:

```ts
  // POST /applications/bulk-delete — delete an explicit set of ids, all or
  // nothing. The MCP server's confirm_delete is the caller: if any id has
  // vanished since its preview (e.g. deleted from the dashboard), refuse the
  // whole batch rather than delete a set the user never saw.
  fastify.post<{ Body: BulkDeleteIdsBody }>(
    "/applications/bulk-delete",
    { schema: { body: bulkDeleteIdsSchema } },
    async (request, reply) => {
      const ids = [...new Set(request.body.ids)];
      const placeholders = ids.map(() => "?").join(",");
      const existing = new Set(
        (
          db
            .prepare(`SELECT id FROM applications WHERE id IN (${placeholders})`)
            .all(...ids) as { id: number }[]
        ).map((r) => r.id),
      );
      const missingIds = ids.filter((id) => !existing.has(id));
      if (missingIds.length) {
        return reply.code(404).send({
          error: `Applications not found: ${missingIds.join(", ")}`,
          missingIds,
        });
      }
      return { deleted: deleteApplicationsCascade(ids) };
    },
  );
```

- [x] **Step 6: Run the whole backend suite**

Run: `npm test --workspace backend`
Expected: all PASS, including the pre-existing `DELETE /applications?status=X` and single-delete tests in `applications.test.ts`.

- [x] **Step 7: Commit (after user confirms)**

```bash
git add backend/src/routes/applications.ts backend/src/validation.ts backend/src/types/index.ts backend/test/mcp-endpoints.test.ts
git commit -m "Add bulk delete by ids; fix status bulk delete FK failure

Status bulk delete (dashboard 'Delete all rejected') only deleted from
applications, so with foreign_keys=ON it failed whenever a matching row
had a tailored resume or cover letter. All delete paths now share one
cascade helper.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Strict envelope validator and `POST /applications/:id/resume-versions`

**Files:**
- Modify: `backend/src/types/resumeSchema.ts` (append after `isStructuredResume`)
- Modify: `backend/src/routes/applications.ts` (`/tailor` persistence block ~lines 684–733; new route after `GET /applications/:id/resume-versions`)
- Modify: `backend/test/mcp-endpoints.test.ts`
- Modify: `backend/test/tailored-resume-parsing.test.ts` (add `findEnvelopeError` unit tests)

**Interfaces:**
- Consumes: `TailorResponseEnvelope`, `parseTailoredResume` (existing).
- Produces: `findEnvelopeError(x: unknown): string | null` exported from `backend/src/types/resumeSchema.ts`.
- Produces: `POST /applications/:id/resume-versions` body = `TailorResponseEnvelope` → `201 ResumeVersion` | `400 { error }` | `404 { error }`.
- Produces (inner): `insertResumeVersion(row: { applicationId: number; baseResume: string | null; output: string; provider: string; model: string | null; inputTokens: number | null; outputTokens: number | null; cost: number | null; inputCharLength: number | null; coverLetter: CoverLetter | null }): ResumeVersion`.

- [x] **Step 1: Write failing unit tests for `findEnvelopeError`**

Append to `backend/test/tailored-resume-parsing.test.ts` (add `findEnvelopeError` to its import from `../src/types/resumeSchema.ts`; if the file doesn't import from there yet, add `import { findEnvelopeError } from '../src/types/resumeSchema.ts';`):

```ts
const validResume = {
  contact: { name: 'Jane Doe', email: 'jane@example.com' },
  summary: 'Engineer.',
  experience: [
    { title: 'Engineer', company: 'Acme', startDate: 'Jan 2022', endDate: 'Present', bullets: ['Built things'] },
  ],
  education: [{ institution: 'State U', degree: 'BSc CS', dates: '2018 - 2022' }],
  skills: [{ label: 'Languages', items: ['TypeScript'] }],
};

test('findEnvelopeError accepts a valid envelope', () => {
  assert.equal(findEnvelopeError({ resume: validResume }), null);
  assert.equal(
    findEnvelopeError({
      resume: validResume,
      matchRating: 4,
      matchJustification: ['Strong TS'],
      suggestions: ['Mention AWS'],
      coverLetter: {
        contact: { name: 'Jane Doe' },
        date: 'Oct 19, 2026',
        header: { recipient: 'Hiring Team', company: 'Acme' },
        body: 'Para one.\n\nPara two.',
        footer: 'Sincerely, Jane Doe',
      },
    }),
    null,
  );
});

test('findEnvelopeError names the first offending path', () => {
  const cases: [unknown, string][] = [
    [null, 'body'],
    [{}, 'resume'],
    [{ resume: { ...validResume, contact: { name: '' } } }, 'resume.contact.name'],
    [{ resume: { ...validResume, experience: 'x' } }, 'resume.experience'],
    [
      { resume: { ...validResume, experience: [{ ...validResume.experience[0], bullets: 'one\ntwo' }] } },
      'resume.experience[0].bullets',
    ],
    [{ resume: { ...validResume, skills: [{ label: 'L', items: [1] }] } }, 'resume.skills[0].items'],
    [{ resume: validResume, matchRating: 6 }, 'matchRating'],
    [{ resume: validResume, matchRating: 2.5 }, 'matchRating'],
    [{ resume: validResume, suggestions: 'x' }, 'suggestions'],
    [{ resume: validResume, coverLetter: { contact: { name: 'J' } } }, 'coverLetter.header'],
  ];
  for (const [input, path] of cases) {
    const err = findEnvelopeError(input);
    assert.ok(err?.startsWith(path), `expected error starting with "${path}", got ${err}`);
  }
});
```

- [x] **Step 2: Run to verify failure**

Run: `cd backend && npx tsx --test test/tailored-resume-parsing.test.ts`
Expected: FAIL — `findEnvelopeError` is not exported.

- [x] **Step 3: Implement `findEnvelopeError`**

Append to `backend/src/types/resumeSchema.ts`:

```ts
// Strict counterpart to the lenient coerce* functions above, for input that
// arrives through POST /applications/:id/resume-versions (the MCP server).
// The coercers silently drop malformed nested entries — right for a model's
// raw output, wrong for an API caller who would never learn a bullet was
// dropped. Returns the first offending field path + reason, or null if valid.
export function findEnvelopeError(x: unknown): string | null {
  if (!isPlainObject(x)) return 'body must be a JSON object';
  const resumeErr = findResumeError(x.resume, 'resume');
  if (resumeErr) return resumeErr;
  if (x.coverLetter !== undefined) {
    const clErr = findCoverLetterError(x.coverLetter, 'coverLetter');
    if (clErr) return clErr;
  }
  if (
    x.matchRating !== undefined &&
    !(Number.isInteger(x.matchRating) && (x.matchRating as number) >= 0 && (x.matchRating as number) <= 5)
  ) {
    return 'matchRating must be an integer from 0 to 5';
  }
  for (const key of ['matchJustification', 'suggestions'] as const) {
    if (x[key] !== undefined && !isStringArray(x[key])) return `${key} must be an array of strings`;
  }
  return null;
}

const str = (v: unknown) => typeof v === 'string';
const optStr = (v: unknown) => v === undefined || typeof v === 'string';

function findContactError(c: unknown, path: string): string | null {
  if (!isPlainObject(c)) return `${path} must be an object`;
  if (!str(c.name) || !(c.name as string).trim()) return `${path}.name must be a non-empty string`;
  for (const k of ['email', 'phone', 'location'] as const) {
    if (!optStr(c[k])) return `${path}.${k} must be a string`;
  }
  if (c.links !== undefined && !isStringArray(c.links)) return `${path}.links must be an array of strings`;
  return null;
}

// fields: [key, required] pairs of string fields; arrays: string-array fields (always required).
function findEntryError(
  e: unknown,
  path: string,
  fields: [string, boolean][],
  arrays: string[],
): string | null {
  if (!isPlainObject(e)) return `${path} must be an object`;
  for (const [k, required] of fields) {
    if (required ? !str(e[k]) : !optStr(e[k])) return `${path}.${k} must be a string`;
  }
  for (const k of arrays) {
    if (!isStringArray(e[k])) return `${path}.${k} must be an array of strings`;
  }
  return null;
}

function findListError(
  list: unknown,
  path: string,
  required: boolean,
  check: (item: unknown, itemPath: string) => string | null,
): string | null {
  if (list === undefined && !required) return null;
  if (!Array.isArray(list)) return `${path} must be an array`;
  for (let i = 0; i < list.length; i++) {
    const err = check(list[i], `${path}[${i}]`);
    if (err) return err;
  }
  return null;
}

function findResumeError(r: unknown, path: string): string | null {
  if (!isPlainObject(r)) return `${path} is required and must be an object`;
  return (
    findContactError(r.contact, `${path}.contact`) ??
    (optStr(r.summary) ? null : `${path}.summary must be a string`) ??
    findListError(r.experience, `${path}.experience`, true, (e, p) =>
      findEntryError(e, p, [['title', true], ['company', true], ['location', false], ['startDate', true], ['endDate', true]], ['bullets']),
    ) ??
    findListError(r.projects, `${path}.projects`, false, (e, p) =>
      findEntryError(e, p, [['name', true], ['dateRange', false]], ['bullets']),
    ) ??
    findListError(r.education, `${path}.education`, true, (e, p) =>
      findEntryError(e, p, [['institution', true], ['degree', true], ['dates', true], ['honors', false], ['coursework', false]], []),
    ) ??
    findListError(r.skills, `${path}.skills`, true, (e, p) => findEntryError(e, p, [['label', true]], ['items']))
  );
}

function findCoverLetterError(c: unknown, path: string): string | null {
  if (!isPlainObject(c)) return `${path} must be an object`;
  const contactErr = findContactError(c.contact, `${path}.contact`);
  if (contactErr) return contactErr;
  if (!isPlainObject(c.header) || !str(c.header.recipient) || !str(c.header.company)) {
    return `${path}.header must be an object with string recipient and company`;
  }
  if (!str(c.body) || !(c.body as string).trim()) return `${path}.body must be a non-empty string`;
  if (!str(c.date)) return `${path}.date must be a string`;
  if (!str(c.footer)) return `${path}.footer must be a string`;
  return null;
}
```

Note the ordering in `findCoverLetterError` (header checked before date/footer) is what makes the `{ contact: { name: 'J' } }` test case report `coverLetter.header`.

- [x] **Step 4: Run unit tests to verify they pass**

Run: `cd backend && npx tsx --test test/tailored-resume-parsing.test.ts`
Expected: PASS.

- [x] **Step 5: Write failing endpoint tests**

Append to `backend/test/mcp-endpoints.test.ts` (add `import { parseTailoredResume } from '../src/resume/tailoredResume.ts';` and `import type { ResumeVersion } from '../src/types/index.ts';` at the top):

```ts
// ---- POST /applications/:id/resume-versions ----

const envelope = {
  resume: {
    contact: { name: 'Jane Doe', email: 'jane@example.com' },
    summary: 'Engineer.',
    experience: [
      { title: 'Engineer', company: 'Acme', startDate: 'Jan 2022', endDate: 'Present', bullets: ['Built things'] },
    ],
    education: [{ institution: 'State U', degree: 'BSc CS', dates: '2018 - 2022' }],
    skills: [{ label: 'Languages', items: ['TypeScript'] }],
  },
  matchRating: 4,
  matchJustification: ['Strong TypeScript'],
  suggestions: ['Mention AWS'],
};

const coverLetter = {
  contact: { name: 'Jane Doe' },
  date: 'Oct 19, 2026',
  header: { recipient: 'Hiring Team', company: 'Acme' },
  body: 'Para one.\n\nPara two.',
  footer: 'Sincerely, Jane Doe',
};

test('save resume version stores an mcp row the existing parser and downloads understand', async () => {
  const a = await createSample();
  const res = await app.inject({
    method: 'POST',
    url: `/applications/${a.id}/resume-versions`,
    payload: envelope,
  });
  assert.equal(res.statusCode, 201);
  const v = res.json() as ResumeVersion;
  assert.equal(v.application_id, a.id);
  assert.equal(v.ai_provider, 'mcp');
  assert.equal(v.model, null);
  assert.equal(v.cost, 0);
  assert.equal(v.base_resume_snapshot, 'Jane Doe\nSoftware Engineer');

  const parsed = parseTailoredResume(v.tailored_output as string);
  assert.equal(parsed.matchRating, 4);
  assert.deepEqual(parsed.suggestions, ['Mention AWS']);
  assert.equal(count('cover_letters'), 0);

  const pdf = await app.inject({
    method: 'GET',
    url: `/applications/${a.id}/resume-versions/${v.id}/download?format=pdf`,
  });
  assert.equal(pdf.statusCode, 200);

  const list = await app.inject({ method: 'GET', url: `/applications/${a.id}` });
  assert.equal((list.json() as Application).has_resume_version, true);
});

test('save resume version with a cover letter also writes a cover_letters row', async () => {
  const a = await createSample();
  const res = await app.inject({
    method: 'POST',
    url: `/applications/${a.id}/resume-versions`,
    payload: { ...envelope, coverLetter },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(count('cover_letters'), 1);
  assert.ok(parseTailoredResume((res.json() as ResumeVersion).tailored_output as string).coverLetter);
});

test('save resume version rejects a malformed nested field with its path', async () => {
  const a = await createSample();
  const bad = {
    ...envelope,
    resume: { ...envelope.resume, experience: [{ ...envelope.resume.experience[0], bullets: 'one\ntwo' }] },
  };
  const res = await app.inject({ method: 'POST', url: `/applications/${a.id}/resume-versions`, payload: bad });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /resume\.experience\[0\]\.bullets/);
  assert.equal(count('resume_versions'), 0);
});

test('save resume version 404s for an unknown application', async () => {
  const res = await app.inject({ method: 'POST', url: '/applications/999999/resume-versions', payload: envelope });
  assert.equal(res.statusCode, 404);
});
```

- [x] **Step 6: Run to verify failure**

Run: `cd backend && npx tsx --test test/mcp-endpoints.test.ts`
Expected: the four new tests FAIL (404 route not found); Task 1 tests still PASS.

- [x] **Step 7: Extract `insertResumeVersion` and use it in `/tailor`**

In `backend/src/routes/applications.ts`, import `CoverLetter` and `findEnvelopeError` from `"../types/resumeSchema.js"` and `TailorResponseEnvelope` from wherever it is exported (it's in `../types/resumeSchema.js`). Add after `deleteApplicationsCascade`:

```ts
  // The one place a resume_versions row (plus its optional cover_letters
  // row) gets written, shared by /tailor and the MCP save route so the two
  // persistence paths can't drift.
  function insertResumeVersion(row: {
    applicationId: number;
    baseResume: string | null;
    output: string;
    provider: string;
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cost: number | null;
    inputCharLength: number | null;
    coverLetter: CoverLetter | null;
  }): ResumeVersion {
    const now = new Date().toISOString();
    const insert = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO resume_versions
             (application_id, base_resume_snapshot, tailored_output, ai_provider,
              model, input_tokens, output_tokens, cost, input_char_length, created_at)
           VALUES (@application_id, @base_resume_snapshot, @tailored_output, @ai_provider,
              @model, @input_tokens, @output_tokens, @cost, @input_char_length, @created_at)`,
        )
        .run({
          application_id: row.applicationId,
          base_resume_snapshot: row.baseResume,
          tailored_output: row.output,
          ai_provider: row.provider,
          model: row.model,
          input_tokens: row.inputTokens,
          output_tokens: row.outputTokens,
          cost: row.cost,
          input_char_length: row.inputCharLength,
          created_at: now,
        });
      if (row.coverLetter) {
        db.prepare(
          `INSERT INTO cover_letters
             (application_id, resume_version_id, tailored_output, created_at)
           VALUES (@application_id, @resume_version_id, @tailored_output, @created_at)`,
        ).run({
          application_id: row.applicationId,
          resume_version_id: info.lastInsertRowid,
          tailored_output: JSON.stringify(row.coverLetter),
          created_at: now,
        });
      }
      db.prepare("UPDATE applications SET updated_at = @now WHERE id = @id").run({
        now,
        id: row.applicationId,
      });
      return info.lastInsertRowid;
    });
    const id = insert();
    return db.prepare("SELECT * FROM resume_versions WHERE id = ?").get(id) as ResumeVersion;
  }
```

Replace the `/tailor` block from `const now = new Date().toISOString();` through `return reply.code(201).send(created);` with:

```ts
      // Only persist a cover_letters row when one was actually requested AND
      // the model returned something coerceCoverLetter accepts — a run that
      // was asked for a cover letter but produced nothing parseable isn't
      // worth a broken/empty row.
      const created = insertResumeVersion({
        applicationId: app.id,
        baseResume,
        output,
        provider: cfg.provider,
        model: cfg.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cost,
        inputCharLength: baseResume.length + jobDescription.length,
        coverLetter: includeCoverLetter ? parseTailoredResume(output).coverLetter ?? null : null,
      });
      return reply.code(201).send(created);
```

(This also makes the /tailor writes transactional, which they weren't before — intended.)

- [x] **Step 8: Add the save route**

After `GET /applications/:id/resume-versions`:

```ts
  // POST /applications/:id/resume-versions — save a tailored resume written
  // elsewhere (the MCP server: Claude itself does the tailoring, so there is
  // no provider call, token usage, or cost). Stored in the same envelope
  // format /tailor writes, so TailorModal and every download format work
  // unchanged. Validated strictly (findEnvelopeError) so the caller learns
  // exactly which field to fix instead of having entries silently dropped.
  fastify.post<{ Params: { id: number }; Body: TailorResponseEnvelope }>(
    "/applications/:id/resume-versions",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const app = getApplicationById(request.params.id);
      if (!app) return reply.code(404).send({ error: "Application not found" });
      const error = findEnvelopeError(request.body);
      if (error) return reply.code(400).send({ error });

      const envelope = request.body;
      const created = insertResumeVersion({
        applicationId: app.id,
        baseResume: settings.read().baseResume.trim() || null,
        output: JSON.stringify(envelope),
        provider: "mcp",
        model: null,
        inputTokens: null,
        outputTokens: null,
        cost: 0,
        inputCharLength: null,
        coverLetter: envelope.coverLetter ?? null,
      });
      return reply.code(201).send(created);
    },
  );
```

- [x] **Step 9: Run full backend suite**

Run: `npm test --workspace backend`
Expected: all PASS — including the existing `/tailor` tests in `settings-and-tailor.test.ts` (cover-letter row, cost, provider) after the extraction.

- [x] **Step 10: Commit (after user confirms)**

```bash
git add backend/src/types/resumeSchema.ts backend/src/routes/applications.ts backend/test/mcp-endpoints.test.ts backend/test/tailored-resume-parsing.test.ts
git commit -m "Add endpoint to save an externally written tailored resume

POST /applications/:id/resume-versions stores a TailorResponseEnvelope as
an 'mcp' resume version (cost 0) in the same format /tailor writes, with
strict path-reporting validation. Persistence shared with /tailor.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `mcp/` workspace and backend HTTP client

**Files:**
- Create: `mcp/package.json`, `mcp/tsconfig.json`, `mcp/src/client.ts`, `mcp/test/client.test.ts`
- Modify: root `package.json`

**Interfaces:**
- Produces: `class BackendError extends Error {}` and
  `createBackendClient(baseUrl: string): BackendClient` where
  `interface BackendClient { baseUrl: string; request<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T>; }`.
  `request` throws `BackendError` with a user-facing message on network failure or non-2xx; returns `undefined` for 204.
- Produces: `resolveBaseUrl(env: NodeJS.ProcessEnv): string` — `APPLYT_URL` without trailing slash, default `http://localhost:4317`.

- [x] **Step 1: Create the workspace**

`mcp/package.json`:

```json
{
  "name": "@applyt/mcp",
  "version": "1.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "tsx --test test/**/*.test.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.3.1",
    "zod": "^4.2.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.5",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3"
  }
}
```

`mcp/tsconfig.json` (same as backend's, minus `resolveJsonModule`):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

Root `package.json`: add `"mcp"` to `workspaces`; change scripts to:

```json
    "build": "npm run build --workspace backend && npm run build --workspace dashboard && npm run build --workspace extension && npm run build --workspace mcp",
    "test": "npm test --workspace backend && npm test --workspace dashboard && npm test --workspace mcp"
```

Run: `npm install`
Expected: installs; `package-lock.json` updated. (Windows gotcha from memory: if esbuild/tsx breaks after a repeat install, re-run `npm install` at the root.)

- [x] **Step 2: Write the failing client test**

`mcp/test/client.test.ts`:

```ts
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
```

- [x] **Step 3: Run to verify failure**

Run: `npm test --workspace mcp`
Expected: FAIL — cannot find `../src/client.ts`.

- [x] **Step 4: Implement the client**

`mcp/src/client.ts`:

```ts
// The only module in mcp/ that talks to the network. Every tool goes through
// request(), so "backend not running" and backend validation errors surface
// to Claude the same way everywhere. No business logic lives here — the
// backend owns validation and storage (CLAUDE.md §2: one storage path).

export class BackendError extends Error {}

export interface BackendClient {
  baseUrl: string;
  request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T>;
}

export function resolveBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env.APPLYT_URL || 'http://localhost:4317').replace(/\/+$/, '');
}

export function createBackendClient(baseUrl: string): BackendClient {
  async function request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
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
```

- [x] **Step 5: Run to verify pass**

Run: `npm test --workspace mcp`
Expected: PASS.

- [x] **Step 6: Commit (after user confirms)**

```bash
git add mcp/package.json mcp/tsconfig.json mcp/src/client.ts mcp/test/client.test.ts package.json package-lock.json
git commit -m "Scaffold mcp workspace with backend HTTP client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Delete-token store

**Files:**
- Create: `mcp/src/deleteTokens.ts`, `mcp/test/deleteTokens.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type DeleteTarget = { kind: 'ids' } | { kind: 'status'; status: string };
  interface PendingDelete { ids: number[]; target: DeleteTarget; createdAt: number }
  type TakeResult = { ok: true; pending: PendingDelete } | { ok: false; reason: string };
  interface DeleteTokenStore {
    issue(ids: number[], target: DeleteTarget): string;
    take(token: string, expectedCount: number): TakeResult;
  }
  createDeleteTokenStore(opts?: { now?: () => number; ttlMs?: number; newToken?: () => string }): DeleteTokenStore
  export const DELETE_TOKEN_TTL_MS = 5 * 60 * 1000;
  ```
  `issue` stores ids sorted ascending and deduplicated. `take` always consumes the token if it exists (single use, even on failure).

- [x] **Step 1: Write the failing tests**

`mcp/test/deleteTokens.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeleteTokenStore, DELETE_TOKEN_TTL_MS } from '../src/deleteTokens.ts';

function store(start = 0) {
  let t = start;
  let n = 0;
  const s = createDeleteTokenStore({ now: () => t, newToken: () => `tok${++n}` });
  return { s, advance: (ms: number) => (t += ms) };
}

test('issue then take with the right count succeeds, ids sorted and deduped', () => {
  const { s } = store();
  const token = s.issue([3, 1, 3, 2], { kind: 'ids' });
  const r = s.take(token, 3);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.pending.ids, [1, 2, 3]);
});

test('unknown token is refused', () => {
  const { s } = store();
  const r = s.take('nope', 1);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /unknown or already used/);
});

test('token is single use, even after a failed take', () => {
  const { s } = store();
  const token = s.issue([1, 2], { kind: 'ids' });
  assert.equal(s.take(token, 5).ok, false); // count mismatch consumes it
  const again = s.take(token, 2);
  assert.equal(again.ok, false);
  assert.match(!again.ok ? again.reason : '', /unknown or already used/);
});

test('count mismatch is refused with both numbers', () => {
  const { s } = store();
  const r = s.take(s.issue([1, 2], { kind: 'ids' }), 3);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /expected 3.*preview matched 2/);
});

test('expired token is refused', () => {
  const { s, advance } = store();
  const token = s.issue([1], { kind: 'ids' });
  advance(DELETE_TOKEN_TTL_MS + 1);
  const r = s.take(token, 1);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /expired/);
});

test('token just inside the TTL still works', () => {
  const { s, advance } = store();
  const token = s.issue([1], { kind: 'status', status: 'rejected' });
  advance(DELETE_TOKEN_TTL_MS);
  const r = s.take(token, 1);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.pending.target, { kind: 'status', status: 'rejected' });
});
```

- [x] **Step 2: Run to verify failure**

Run: `npm test --workspace mcp`
Expected: FAIL — cannot find `../src/deleteTokens.ts`.

- [x] **Step 3: Implement**

`mcp/src/deleteTokens.ts`:

```ts
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
        return { ok: false, reason: 'Confirmation token expired (5 minutes) — run preview_delete again.' };
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
```

- [x] **Step 4: Run to verify pass**

Run: `npm test --workspace mcp`
Expected: PASS.

- [x] **Step 5: Commit (after user confirms)**

```bash
git add mcp/src/deleteTokens.ts mcp/test/deleteTokens.test.ts
git commit -m "Add preview/confirm delete token store for the MCP server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Tools and stdio entrypoint

**Files:**
- Create: `mcp/src/tools.ts`, `mcp/src/index.ts`, `mcp/test/tools.test.ts`

**Interfaces:**
- Consumes: `BackendClient`, `BackendError`, `createBackendClient`, `resolveBaseUrl` (Task 3); `DeleteTokenStore`, `createDeleteTokenStore` (Task 4); backend routes from Tasks 1–2 plus existing `GET /applications` (`{ items, total, page, pageSize }`, `pageSize` max 100), `GET /applications/:id`, `GET /applications/:id/resume-versions`, `GET /applications/stats`, `GET /settings` (`{ baseResume, ... }`), `POST /applications`, `PATCH /applications/:id`.
- Produces:
  ```ts
  interface ToolResult { content: { type: 'text'; text: string }[]; isError?: boolean }
  interface ToolDef {
    name: string;
    title: string;
    description: string;
    inputSchema?: z.ZodObject;   // zod/v4
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
    handler(args: any): Promise<ToolResult>;
  }
  buildTools(client: BackendClient, tokens: DeleteTokenStore): ToolDef[]
  ```

- [x] **Step 1: Verify the SDK API against the installed package**

Run: `node -e "import('@modelcontextprotocol/server').then(m=>console.log(Object.keys(m).filter(k=>/Mcp|Server/.test(k))))"` from `mcp/`, and open `mcp/node_modules/@modelcontextprotocol/server/dist/index.d.mts` to confirm `McpServer#registerTool(name, { title, description, inputSchema, annotations }, handler)` and that `inputSchema` takes a `z.object(...)` from `zod/v4`. Expected: matches the v2 docs (`import { McpServer } from '@modelcontextprotocol/server'`, `import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'`). If it instead requires a raw shape (`{ field: z.string() }`), pass `schema.shape` in `index.ts` — `tools.ts` stays unchanged.

- [x] **Step 2: Write the failing tool tests**

`mcp/test/tools.test.ts`:

```ts
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
```

- [x] **Step 3: Run to verify failure**

Run: `npm test --workspace mcp`
Expected: FAIL — cannot find `../src/tools.ts`.

- [x] **Step 4: Implement `tools.ts`**

`mcp/src/tools.ts`:

```ts
import * as z from 'zod/v4';
import { BackendError, type BackendClient } from './client.js';
import type { DeleteTokenStore } from './deleteTokens.js';

// Tool definitions as plain data + handlers so they're testable without an
// MCP transport; index.ts registers them on the McpServer. Handlers never
// throw: every failure becomes { isError: true } text Claude can act on.

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema?: z.ZodObject;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler(args: any): Promise<ToolResult>;
}

// Mirrors backend/src/types/index.ts — kept as literals here rather than
// importing across workspaces; the backend still validates every value.
const PLATFORMS = ['indeed', 'linkedin', 'glassdoor', 'manual'] as const;
const STATUSES = ['applied', 'pending_confirmation', 'interviewing', 'rejected', 'offer', 'ghosted', 'stale'] as const;
const MODALITIES = ['on_site', 'hybrid', 'remote'] as const;
const LIST_PAGE_MAX = 100; // GET /applications caps pageSize at 100

interface AppRow {
  id: number;
  company: string;
  title: string;
  status: string;
  job_description?: string | null;
  [k: string]: unknown;
}
interface ListResponse {
  items: AppRow[];
  total: number;
  page: number;
  pageSize: number;
}

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});
const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BackendError) return fail(err.message);
    return fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function query(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

const summarize = ({ job_description: _jd, ...rest }: AppRow) => rest;

const editableFields = {
  company: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  job_url: z.string().nullable().optional(),
  status: z.enum(STATUSES).optional(),
  date_applied: z.string().optional().describe('YYYY-MM-DD'),
  notes: z.string().nullable().optional(),
  job_description: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  modality: z.enum(MODALITIES).nullable().optional(),
};

const RESUME_FORMAT = `Resume JSON shape (all strings unless noted; bullets/items are string arrays with no leading "-" or "•"):
{
  "resume": {
    "contact": { "name": (required), "email"?, "phone"?, "location"?, "links"?: string[] },
    "summary"?,
    "experience": [{ "title", "company", "location"?, "startDate", "endDate" ("Present" allowed), "bullets": [] }],
    "projects"?: [{ "name", "dateRange"?, "bullets": [] }],
    "education": [{ "institution", "degree", "dates", "honors"?, "coursework"? }],
    "skills": [{ "label", "items": [] }]
  },
  "coverLetter"?: { "contact": {same as above}, "date", "header": { "recipient", "company" }, "body" (3-4 paragraphs joined by "\\n\\n"), "footer" (sign-off) },
  "matchRating"?: integer 0-5,
  "matchJustification"?: string[],
  "suggestions"?: string[]
}`;

export function buildTools(client: BackendClient, tokens: DeleteTokenStore): ToolDef[] {
  async function idsForStatus(status: string): Promise<AppRow[]> {
    const rows: AppRow[] = [];
    for (let page = 1; ; page++) {
      const res = await client.request<ListResponse>(
        'GET',
        `/applications${query({ status, pageSize: LIST_PAGE_MAX, page })}`,
      );
      rows.push(...res.items);
      if (rows.length >= res.total || res.items.length === 0) return rows;
    }
  }

  return [
    {
      name: 'list_applications',
      title: 'List applications',
      description:
        'List saved job applications, newest first. Filter by search text (company/title), platform, or status. Rows omit the job description — use get_application for the full entry.',
      inputSchema: z.object({
        search: z.string().optional(),
        platform: z.enum(PLATFORMS).optional(),
        status: z.enum(STATUSES).optional(),
        sort: z.enum(['date_applied', 'date_last_updated']).optional(),
        order: z.enum(['asc', 'desc']).optional(),
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(LIST_PAGE_MAX).optional(),
      }),
      annotations: { readOnlyHint: true },
      handler: (args) =>
        guarded(async () => {
          const res = await client.request<ListResponse>('GET', `/applications${query(args)}`);
          return ok({ ...res, items: res.items.map(summarize) });
        }),
    },
    {
      name: 'get_application',
      title: 'Get application',
      description: 'Get one application including its full job description, plus a summary of resume versions already tailored for it.',
      inputSchema: z.object({ id: z.number().int().min(1) }),
      annotations: { readOnlyHint: true },
      handler: ({ id }) =>
        guarded(async () => {
          const application = await client.request<AppRow>('GET', `/applications/${id}`);
          const versions = await client.request<
            { id: number; created_at: string; ai_provider: string | null; model: string | null; tailored_output: string | null }[]
          >('GET', `/applications/${id}/resume-versions`);
          const resumeVersions = versions.map((v) => {
            let matchRating: number | null = null;
            try {
              const parsed = JSON.parse(v.tailored_output ?? '');
              if (typeof parsed?.matchRating === 'number') matchRating = parsed.matchRating;
            } catch {
              // legacy flat-text versions have no JSON rating
            }
            return { id: v.id, created_at: v.created_at, ai_provider: v.ai_provider, model: v.model, matchRating };
          });
          return ok({ application, resumeVersions });
        }),
    },
    {
      name: 'get_base_resume',
      title: 'Get base resume',
      description: "Get the user's base (master) resume as plain text — the source material for tailoring.",
      annotations: { readOnlyHint: true },
      handler: () =>
        guarded(async () => {
          const { baseResume } = await client.request<{ baseResume: string }>('GET', '/settings');
          if (!baseResume?.trim()) return fail('No base resume set — upload one in the Applyt dashboard Settings.');
          return ok(baseResume);
        }),
    },
    {
      name: 'get_stats',
      title: 'Get stats',
      description: 'Application totals, applications per week (last 8 weeks), and response rate.',
      annotations: { readOnlyHint: true },
      handler: () => guarded(async () => ok(await client.request('GET', '/applications/stats'))),
    },
    {
      name: 'create_application',
      title: 'Add application',
      description: 'Log a new application manually (e.g. one applied to on a company site). Platform and apply method are always "manual".',
      inputSchema: z.object({ ...editableFields, company: z.string().min(1), title: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: (args) =>
        guarded(async () => {
          // Strip any platform the model invents; manual entries are always manual.
          const { platform: _p, apply_method: _m, ...fields } = args;
          return ok(await client.request('POST', '/applications', { ...fields, platform: 'manual', apply_method: 'manual' }));
        }),
    },
    {
      name: 'update_application',
      title: 'Update application',
      description: 'Update fields on an existing application (status, notes, job description, location, modality, etc.). Only the fields you pass change.',
      inputSchema: z.object({ id: z.number().int().min(1), ...editableFields }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      handler: ({ id, ...fields }) => guarded(async () => ok(await client.request('PATCH', `/applications/${id}`, fields))),
    },
    {
      name: 'save_tailored_resume',
      title: 'Save tailored resume',
      description: `Save a resume you tailored for a saved application (read it first with get_application and get_base_resume). It becomes a resume version the user can download as PDF/Word from the dashboard. Write ATS-friendly content: concrete, quantified bullets; keep it to one page; never invent experience not in the base resume.\n\n${RESUME_FORMAT}`,
      inputSchema: z.object({
        applicationId: z.number().int().min(1),
        resume: z.record(z.string(), z.unknown()),
        coverLetter: z.record(z.string(), z.unknown()).optional(),
        matchRating: z.number().int().min(0).max(5).optional(),
        matchJustification: z.array(z.string()).optional(),
        suggestions: z.array(z.string()).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: ({ applicationId, ...envelope }) =>
        guarded(async () => {
          const v = await client.request<{ id: number }>('POST', `/applications/${applicationId}/resume-versions`, envelope);
          return ok(`Saved as resume version ${v.id}. The user can download it (PDF/Word/text) from this application in the Applyt dashboard.`);
        }),
    },
    {
      name: 'preview_delete',
      title: 'Preview delete',
      description:
        'Step 1 of deleting applications. Pass either ids or a status (not both). Deletes nothing: returns the matching applications and a confirmation token. Show the list to the user, then call confirm_delete with the token and the count.',
      inputSchema: z.object({
        ids: z.array(z.number().int().min(1)).min(1).max(500).optional(),
        status: z.enum(STATUSES).optional(),
      }),
      annotations: { readOnlyHint: true },
      handler: ({ ids, status }) =>
        guarded(async () => {
          if ((ids === undefined) === (status === undefined)) return fail('Pass exactly one of ids or status.');
          const rows = status
            ? await idsForStatus(status)
            : await Promise.all([...new Set<number>(ids)].map((id) => client.request<AppRow>('GET', `/applications/${id}`)));
          if (rows.length === 0) return ok('No matching applications — nothing to delete.');
          const token = tokens.issue(rows.map((r) => r.id), status ? { kind: 'status', status } : { kind: 'ids' });
          const applications = rows
            .map(({ id, company, title, status: s }) => ({ id, company, title, status: s }))
            .sort((a, b) => a.id - b.id);
          return ok({ count: applications.length, token, expiresInMinutes: 5, applications });
        }),
    },
    {
      name: 'confirm_delete',
      title: 'Confirm delete',
      description:
        'Step 2 of deleting applications: permanently deletes the applications from a preview_delete call, along with their tailored resumes and cover letters. Cannot be undone. expectedCount must equal the preview count.',
      inputSchema: z.object({ token: z.string(), expectedCount: z.number().int().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: true },
      handler: ({ token, expectedCount }) =>
        guarded(async () => {
          const taken = tokens.take(token, expectedCount);
          if (!taken.ok) return fail(taken.reason);
          const { ids, target } = taken.pending;
          if (target.kind === 'status') {
            const now = (await idsForStatus(target.status)).map((r) => r.id).sort((a, b) => a - b);
            if (now.length !== ids.length || now.some((id, i) => id !== ids[i])) {
              return fail('The matching applications changed since the preview — nothing was deleted. Run preview_delete again.');
            }
          }
          const { deleted } = await client.request<{ deleted: number }>('POST', '/applications/bulk-delete', { ids });
          return ok(`Deleted ${deleted} application${deleted === 1 ? '' : 's'}.`);
        }),
    },
  ];
}
```

Note: the `list_applications` test stubs `?search=acme&status=applied&pageSize=50` — `query()` preserves the args' insertion order, so the test's arg order must match the stub key (it does).

- [x] **Step 5: Implement the entrypoint**

`mcp/src/index.ts`:

```ts
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createBackendClient, resolveBaseUrl } from './client.js';
import { createDeleteTokenStore } from './deleteTokens.js';
import { buildTools } from './tools.js';

// Spawned by Claude Desktop / Claude Code over stdio. stdout is the protocol
// channel — never console.log here; diagnostics go to stderr.
const server = new McpServer({ name: 'applyt', version: '1.1.0' });
const client = createBackendClient(resolveBaseUrl(process.env));

for (const tool of buildTools(client, createDeleteTokenStore())) {
  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
    tool.handler,
  );
}

await server.connect(new StdioServerTransport());
console.error(`[applyt-mcp] ready, backend ${client.baseUrl}`);
```

If Step 1 found `registerTool` wants a raw shape, use `inputSchema: tool.inputSchema?.shape`. If TypeScript complains about the handler's return type vs. the SDK's `CallToolResult`, cast at this one call site (`tool.handler as never`) rather than loosening `ToolDef`.

- [x] **Step 6: Run tests and build**

Run: `npm test --workspace mcp && npm run build --workspace mcp`
Expected: all tests PASS; `mcp/dist/index.js` exists.

- [x] **Step 7: Smoke-test the protocol handshake**

Run (backend not required for listing tools):

```bash
cd mcp && printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node dist/index.js
```

Expected: two JSON-RPC responses on stdout; the second lists 9 tools, `confirm_delete` with `"destructiveHint": true`, and an `inputSchema` with `properties` for each tool that has inputs. (If the server rejects the protocol version, use the version from its initialize error/response.)

- [x] **Step 8: Commit (after user confirms)**

```bash
git add mcp/src/tools.ts mcp/src/index.ts mcp/test/tools.test.ts
git commit -m "Add Applyt MCP tools and stdio entrypoint

Nine tools over the local backend: list/get applications, base resume,
stats, create/update, save tailored resume, and a preview->confirm
delete pair (destructiveHint on confirm).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Docs and end-to-end verification

**Files:**
- Modify: `SETUP.md`, `README.md`, `ARCHITECTURE.md`, `CLAUDE.md` (§4)

- [x] **Step 1: SETUP.md — add a "Connect Claude (MCP)" section**

```markdown
## Connect Claude (MCP server, optional)

Lets Claude Desktop or Claude Code read your saved applications, tailor resumes for them (using your Claude plan — no API key), and add/update/delete entries.

1. Build it once: `npm install && npm run build --workspace mcp`
2. Keep the Applyt backend running (`npm run dev` or `docker compose up`).
3. Register it:
   - **Claude Code:** `claude mcp add applyt -- node /absolute/path/to/Applyt/mcp/dist/index.js`
   - **Claude Desktop:** Settings → Developer → Edit Config, then add to `claude_desktop_config.json`
     (Windows: `%APPDATA%\Claude\claude_desktop_config.json`, macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):
     ```json
     {
       "mcpServers": {
         "applyt": {
           "command": "node",
           "args": ["C:\\path\\to\\Applyt\\mcp\\dist\\index.js"]
         }
       }
     }
     ```
     Restart Claude Desktop.
4. Non-default backend port? Add `"env": { "APPLYT_URL": "http://localhost:<port>" }` (Desktop) or `-e APPLYT_URL=...` (Claude Code).

Docker users: same steps — the MCP server runs on your machine and reaches the backend container through the published port 4317.
```

- [x] **Step 2: README.md — short section + privacy and delete caveats**

Add after the AI tailoring section:

```markdown
### Use Applyt from Claude (MCP)

Applyt ships an optional local MCP server so Claude Desktop / Claude Code can browse your applications, answer questions about them, tailor a resume (saved as a normal resume version you download from the dashboard), and add, update, or delete entries. Setup: see [SETUP.md](SETUP.md#connect-claude-mcp-server-optional).

- **Privacy:** when Claude reads your applications or resume through these tools, that data is sent to Anthropic — the same as using the Anthropic tailoring provider. Nothing is sent unless you use the tools.
- **Deletes are two-step:** Claude must preview a delete (seeing exactly which applications match) and then confirm it with the matching count. This prevents deleting rows Claude never looked at, but the real safeguard is your client's per-tool approval prompt — don't set `confirm_delete` to "always allow". Deletes cannot be undone.
```

Also add the MCP server to the README's architecture/feature list if one enumerates components.

- [x] **Step 3: ARCHITECTURE.md and CLAUDE.md**

ARCHITECTURE.md: add an `mcp/` component entry (stdio server spawned by the Claude client → HTTP → backend; files `client.ts`, `deleteTokens.ts`, `tools.ts`, `index.ts`) and the two new backend routes in the routes list.

CLAUDE.md §4 Tech stack, add a bullet:

```markdown
- **MCP server (`mcp/`):** optional stdio MCP server for Claude Desktop/Claude Code (`@modelcontextprotocol/server`). Thin layer over the local backend's HTTP API — never touches SQLite directly. Claude does tailoring itself and saves results via `POST /applications/:id/resume-versions`; deletes go through a preview→confirm token.
```

- [x] **Step 4: Full verification**

Run: `npm test && npm run build`
Expected: backend, dashboard, and mcp suites PASS; all four workspaces build.

- [x] **Step 5: Manual end-to-end check (with the user)**

1. `npm run dev`; `claude mcp add applyt -- node <abs path>/mcp/dist/index.js`; restart the Claude Code session; `/mcp` shows `applyt` connected with 9 tools.
2. Ask Claude: "List my Applyt applications from the last month" → sensible table.
3. Ask Claude to tailor a resume for one real saved application → `save_tailored_resume` succeeds; in the dashboard, the version appears as `mcp · <date>` with `$0.00`, and PDF and Word download correctly.
4. Create a throwaway application via Claude, then "delete it" → `preview_delete` shows exactly that row; approve `confirm_delete`; row gone from dashboard.
5. Preview a delete, wait > 5 minutes (or call confirm with a wrong count) → refused, nothing deleted.
6. Stop the backend; ask Claude to list applications → "isn't reachable … start it with …" message.

- [x] **Step 6: Commit (after user confirms)**

```bash
git add SETUP.md README.md ARCHITECTURE.md CLAUDE.md docs/superpowers/specs/2026-10-19-mcp-server-design.md docs/superpowers/plans/2026-10-19-mcp-server.md
git commit -m "Document the Applyt MCP server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Pre-PR gate**

Run the `code-reviewer` subagent over `main..feat/mcp-server`; address findings; then ask the user before pushing and opening the PR.
