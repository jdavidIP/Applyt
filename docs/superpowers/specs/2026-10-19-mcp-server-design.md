# Applyt MCP Server — Design

**Date:** 2026-10-19
**Status:** Draft, awaiting review

## Goal

Let Claude Desktop and Claude Code read and manage the user's Applyt data through a local MCP server: browse/search saved applications, answer questions about them ("insights"), tailor resumes and cover letters for a saved job, and create/update/delete applications.

The key design point: **the MCP client is the LLM.** The MCP server does not call any AI provider. Claude reads the base resume and job description through tools, writes the tailored resume itself, and saves it back through a tool. Tailoring through MCP therefore uses the user's Claude plan, needs no API key, and supports iterative back-and-forth that the one-shot `TailorModal` cannot.

## Decisions already made

- **Clients:** Claude Desktop and Claude Code only. claude.ai web/mobile is out of scope — it would require exposing the local backend to the internet (tunnel + auth), reintroducing the auth work CLAUDE.md §2 avoids.
- **Write scope:** full — create, update, delete (single and bulk).
- **Delete guard:** preview-then-confirm token + MCP `destructiveHint` annotations. **No undo/trash/restore** (considered and explicitly removed).
- **Architecture:** a stdio MCP server in a new `mcp/` workspace that talks to the existing backend over HTTP. It never opens the SQLite file (CLAUDE.md §2: one storage path).

## Architecture

```
Claude Desktop / Claude Code
        │ spawns, stdio (JSON-RPC)
        ▼
mcp/dist/index.js  ── HTTP ──▶  backend (localhost:4317)  ──▶  SQLite
 (thin tool layer,                (all validation, storage,
  delete-token store)              business logic)
```

- `mcp/` is a 4th npm workspace (`@applyt/mcp`), TypeScript, ESM, built with `tsc` to `mcp/dist/`.
- Dependencies: `@modelcontextprotocol/server` (the v2 SDK, `^2.3.1`; Node >= 20) and `zod` (`^4.2.0`, the SDK's own dependency, imported as `zod/v4` for tool input schemas). No other new dependencies; HTTP via global `fetch`.
- Backend base URL from `APPLYT_URL` env var, default `http://localhost:4317`.
- The MCP server contains no business logic. It translates tool calls to HTTP requests, shapes responses for Claude, and owns only the in-memory delete-token store.
- Works unchanged for Docker users: `docker-compose.yml` already publishes `4317:4317` on the host, and the MCP server always runs on the host (spawned by the Claude client).

## Backend changes

### 1. `POST /applications/:id/resume-versions` — save an externally written tailored resume

Body:

```ts
{
  resume: StructuredResume;          // required, backend/src/types/resumeSchema.ts
  coverLetter?: CoverLetter;
  matchRating?: number;              // integer 0–5
  matchJustification?: string[];
  suggestions?: string[];
}
```

i.e. exactly the existing `TailorResponseEnvelope` shape.

- 404 if the application doesn't exist.
- Validation: `findEnvelopeError(body)` must return `null` — strict check of `resume` (required), `coverLetter` (optional), `matchRating` (integer 0–5), and the string-array fields. Failures return 400 with a message naming the offending field (e.g. `"resume.experience[2].bullets must be an array of strings"`), so Claude can self-correct and retry. The existing `coerceStructuredResume`/`isStructuredResume` are deliberately lenient (they silently drop malformed nested entries, which is right for parsing a model's raw output but wrong for an input endpoint — Claude would never learn a bullet was dropped). So add a separate strict `findEnvelopeError(x): string | null` in `resumeSchema.ts` that returns the first offending field path; leave the lenient coercers untouched.
- Storage: `tailored_output = JSON.stringify(envelope)` — the same format the `/tailor` route stores, so `parseTailoredResume`, the dashboard `TailorModal`, and PDF/DOCX/TXT downloads work with no changes. `ai_provider = 'mcp'`, `model = NULL`, `input_tokens/output_tokens = NULL`, `cost = 0`, `base_resume_snapshot` = current `settings.baseResume`, `input_char_length = NULL`.
- If `coverLetter` is present, insert a `cover_letters` row linked to the new version, as `/tailor` does.
- Bump the application's `updated_at`. Return 201 with the created `resume_versions` row.
- **Refactor:** extract the resume_versions + cover_letters insert + `updated_at` bump from the `/:id/tailor` route (`backend/src/routes/applications.ts` ~684–733) into a shared helper used by both routes, so the two persistence paths cannot drift.
- Dashboard: no change needed — verified `TailorModal` shows `ai_provider` verbatim ("mcp"), filters a null `model` out of the meta line, and formats `cost = 0` as "$0.00".

### 2. Bulk delete by IDs

`POST /applications/bulk-delete` with body `{ ids: number[] }` (POST because DELETE request bodies are poorly supported).

- Validation: non-empty array of positive integers, max 500, deduplicated.
- One transaction: delete `cover_letters`, then `resume_versions`, then `applications` for those IDs — same order and reason as the single-delete route (no `ON DELETE CASCADE`). Extract that three-statement sequence into a shared helper used by single delete, this route, and the existing status bulk delete.
- **Existing bug fixed along the way:** `DELETE /applications?status=` (the dashboard's "Delete all rejected") deletes only from `applications`. Because `db.ts` enables `foreign_keys = ON`, it fails with a FK constraint error whenever any matching application has a tailored resume or cover letter. Switching it to the shared helper fixes this.
- If any ID doesn't exist, return 404 listing the missing IDs and delete nothing.
- Returns `{ deleted: n }`.

No other backend changes. Existing routes used as-is: `GET /applications`, `GET /applications/:id`, `GET /applications/:id/resume-versions`, `GET /applications/stats`, `GET /settings`, `POST /applications`, `PATCH /applications/:id`.

## MCP tools

| Tool | Backend call(s) | Annotations | Notes |
|---|---|---|---|
| `list_applications` | `GET /applications` | readOnly | Inputs mirror the route's existing query params (search, platform, status, sort, order, page, pageSize). Returns compact rows — **no `job_description`** — to keep context small. |
| `get_application` | `GET /applications/:id` + `GET /applications/:id/resume-versions` | readOnly | Full row incl. job description, plus a summary of existing tailored versions (id, created_at, provider, match rating). |
| `get_base_resume` | `GET /settings` | readOnly | Returns only `baseResume` text. (`/settings` never returns raw keys, but the tool returns just the resume regardless.) Clear message if empty: "No base resume set — upload one in the dashboard Settings." |
| `get_stats` | `GET /applications/stats` | readOnly | Totals, per-week buckets, response rate. |
| `create_application` | `POST /applications` | — | `platform: 'manual'`, `apply_method: 'manual'` fixed by the tool; Claude supplies company, title, and optional fields. |
| `update_application` | `PATCH /applications/:id` | idempotent | Status, notes, job description, location, modality, title, company, job_url. |
| `save_tailored_resume` | `POST /applications/:id/resume-versions` | — | Tool description embeds the `StructuredResume`/`CoverLetter` shape and writing guidance (ATS-friendly, no bullet glyphs, single page target) so Claude produces valid input first try. Returns the version id and a pointer to download it from the dashboard. |
| `preview_delete` | `GET /applications` (by status) or `GET /applications/:id` (by ids) | readOnly | Input: `ids` **or** `status` (exactly one). Returns the matching rows (id, company, title, status) and a confirmation token. Deletes nothing. |
| `confirm_delete` | `POST /applications/bulk-delete` | destructive | Input: `token`, `expectedCount`. See guard below. |

Out of scope: a tool that triggers the built-in `/tailor` AI route (Claude does the tailoring itself), CSV/XLSX export (a file download — the dashboard covers it), settings editing, mark-stale.

### Delete guard

- `GET /applications` caps `pageSize` at 100, so a status-based preview pages through all results to collect every matching ID.
- `preview_delete` resolves the target set to a concrete, sorted list of IDs and stores `{ ids, createdAt }` under a random token (`crypto.randomUUID()`) in an in-memory `Map`.
- `confirm_delete(token, expectedCount)`:
  1. Token unknown or older than 5 minutes → refuse ("expired, preview again").
  2. Token is consumed (deleted from the map) on first use, success or failure — single use.
  3. `expectedCount !== ids.length` → refuse.
  4. Re-resolve: for a status-based preview, re-query the status and refuse if the ID set differs ("matching applications changed since the preview — preview again"); for an ID-based preview, the bulk endpoint's all-or-nothing 404 covers vanished rows.
  5. Call `POST /applications/bulk-delete` with the stored IDs.
- `expectedCount` exists so the client's tool-approval prompt shows the user a human-readable number ("confirm_delete … expectedCount: 14").
- Honest limit, documented in the README: nothing server-side can stop the model from confirming its own preview. The real human checkpoint is the client's per-tool approval prompt; the guard makes that prompt meaningful and prevents deleting rows the model never looked at. Users who set `confirm_delete` to "always allow" opt out of that checkpoint.
- The token store is pure functions over a `Map` with an injectable clock, for testability.

## Error handling

- **Backend unreachable** (fetch throws / ECONNREFUSED): tool returns `isError: true` with "Applyt backend isn't reachable at {APPLYT_URL} — start it with `npm run dev` or `docker compose up`." Never crashes the server.
- **Backend 4xx/5xx:** pass the backend's `{ error }` message through verbatim as a tool error, prefixed with the HTTP status.
- **Input validation:** shape only, via the tool's zod schema (the SDK rejects malformed calls before the handler runs). All semantic validation stays in the backend.
- All handlers go through one `callBackend()` wrapper so these rules are applied uniformly.

## Setup & docs

- Root `package.json`: add `mcp` to `workspaces`, `build`, and `test` scripts — CI (`npm ci && npm test && npm run build`) covers it automatically.
- **Claude Code:** `claude mcp add applyt -- node <repo>/mcp/dist/index.js`
- **Claude Desktop:** `mcpServers.applyt = { "command": "node", "args": ["<repo>/mcp/dist/index.js"] }` in `claude_desktop_config.json` (Windows/macOS paths documented).
- Optional `"env": { "APPLYT_URL": "..." }` for a non-default port.
- **SETUP.md:** full setup steps. **README:** short "Use Applyt from Claude" section, including the privacy line ("application data and your resume are sent to Anthropic when Claude reads them through these tools, like the existing Anthropic tailoring provider") and the delete-guard caveat. **ARCHITECTURE.md:** add the `mcp/` component.
- CLAUDE.md: add a line under §4 tech stack noting the MCP server.

## Testing

Backend (`node:test` via `tsx`, existing style with explicit `DB_PATH`/`SETTINGS_PATH`):
- `POST /:id/resume-versions`: valid envelope → 201, row stored with `ai_provider='mcp'`, `cost=0`, and `parseTailoredResume` round-trips it; cover letter creates a `cover_letters` row; invalid resume → 400 naming the field; unknown application → 404.
- `POST /bulk-delete`: deletes applications plus their resume_versions/cover_letters atomically; any missing ID → 404 and nothing deleted; validation errors (empty, non-integers, >500).
- Status bulk delete: applications with resume versions now delete cleanly (regression for the helper refactor).
- `/tailor` still passes its existing tests after the persistence-helper extraction.

MCP (`node:test` via `tsx`):
- Token store: issue → confirm succeeds; expired; reused; count mismatch; changed status set.
- Tool handlers against a stubbed `fetch` (same approach as `ai.ts` tests): correct URL/method/body per tool, unreachable-backend message, 4xx passthrough, `list_applications` strips `job_description`.

Manual (before PR): connect via Claude Code, tailor one real saved application end to end, download the PDF from the dashboard; preview + confirm a delete on a throwaway row; verify a stale token and a wrong count are refused.

## Non-goals

- claude.ai web/mobile (remote MCP), auth, tunnels.
- Undo/trash/restore for deletes.
- MCP resources/prompts — tools only for v1.
- Any interaction with LinkedIn/Indeed/Glassdoor (CLAUDE.md §2 unaffected).
