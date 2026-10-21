# Architecture

This document explains how Applyt's pieces fit together and why they're built the
way they are. For the product spec and phased roadmap, see [`CLAUDE.md`](./CLAUDE.md).
For "how do I run this," see [`SETUP.md`](./SETUP.md).

## The shape of the system

```
┌────────────────────┐   ┌────────────────────┐   ┌───────────────────────┐
│ Browser extension  │   │ Dashboard          │   │ MCP server            │
│ (content scripts + │   │ (React + Vite SPA) │   │ (optional; spawned by │
│ background worker) │   │                    │   │ Claude Desktop/Code)  │
└──────────┬─────────┘   └──────────┬─────────┘   └───────────┬───────────┘
           │ POST /applications     │ GET/PATCH/DELETE        │ same HTTP API
           │ (auto-capture +        │ /applications,          │ (read, save tailored
           │  manual mark)          │ /settings, ...          │  resume, add/edit/delete)
           └────────────────────────┼─────────────────────────┘
                          ┌─────────▼─────────┐
                          │   Local backend   │
                          │  (Fastify + TS)   │
                          └─────────┬─────────┘
                                    │
                         ┌──────────┴─────────┐
                         │   SQLite (single   │
                         │   file on disk)    │
                         └────────────────────┘
```

Everything runs on the user's own machine. The extension, the dashboard, and the
optional MCP server are different front ends for the **same backend on the same port** — there is
deliberately only one storage path (see CLAUDE.md §2). Nothing here talks to a
server we operate; the only outbound network call the backend ever makes is the
AI tailoring request to the user's own configured provider — Anthropic, OpenAI (using
a key that never leaves their machine), or a local/LAN Ollama server (no key at all).
The MCP server makes no outbound calls of its own either; Claude is its client, so
whatever Claude reads through its tools travels to Anthropic as part of the user's
own conversation.

## Why self-hosted (and what that buys us)

This is a personal, cloneable tool, not a hosted SaaS product. That single
decision cascades into most of the technical choices below — see CLAUDE.md §3 for
the full reasoning:

- **SQLite, not a hosted database.** One file, no ops, trivially backed up by
  copying it.
- **No auth system, no accounts.** One instance = one user, so there's no
  multi-tenant key encryption, session management, or access-control surface to
  build or audit.
- **No telemetry, no privacy policy.** We don't operate infrastructure that
  collects anyone's data, so there's nothing to disclose.
- **Extension and dashboard share one backend.** A job application recorded via
  auto-capture and one added by hand both land in the exact same table through
  the exact same `POST /applications` endpoint — there's no reconciliation logic
  because there's nothing to reconcile.

Don't reintroduce multi-tenancy, hosted storage, or centralized key handling
without an explicit decision to do so; it undoes the reasoning above.

## Backend

`backend/` — Node.js + [Fastify](https://fastify.dev/) + TypeScript,
[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) for storage.

- `src/app.ts` — builds the Fastify instance, registers routes, CORS scoped to
  the dashboard's own localhost origin (not `*`, since this is still a real HTTP
  server even though it's local-only).
- `src/routes/applications.ts` — CRUD + list/filter/sort/paginate, CSV/XLSX
  export, bulk lifecycle actions (mark-stale, bulk-delete by status or by an
  explicit id set), AI tailor request + cost estimate, saving a tailored resume
  written elsewhere (the MCP path), attaching the user's own resume/cover-letter
  files, resume-version download (PDF/DOCX/TXT). All deletes go through one
  cascade helper (attached files → cover letters → resume versions →
  applications), since the schema has no `ON DELETE CASCADE`.
- **File versions** (`ai_provider = 'file'`) — a resume version whose PDF/DOCX
  downloads are files the user attached, served byte-for-byte under their
  original names. The bytes live in their own table, `resume_version_files`,
  which only the download route reads, so listing versions stays cheap. Format
  is decided by content (`src/resume/fileFormat.ts`: `%PDF-`, or a ZIP containing
  `word/document.xml`), never by filename; the version's `tailored_output` holds
  the extracted text so every preview works with the unchanged parsers.
- `src/routes/settings.ts` — AI provider/model/key/base-resume settings, backed
  by a local JSON file (`backend/data/settings.json`, gitignored) rather than the
  database, since it holds secrets and is conceptually per-machine config, not
  application data.
- `src/export/reportData.ts` — summary/report math (per-week counts, response
  rate, formula-injection sanitization) shared between `src/export/csvExport.ts`
  and `src/export/xlsxExport.ts` so both report formats always agree on the
  same numbers.
- `src/ai.ts` — the one place that makes an outbound network call: direct
  `fetch` requests to the Anthropic or OpenAI Messages API using the user's own
  key, or to a local/LAN Ollama server's native API (no key) — no SDK dependency
  for any of the three.
- `src/resume/resumeRender.ts` / `src/types/resumeSchema.ts` — turns a tailored
  resume (structured JSON: contact, summary, experience, projects, education,
  skills) into a single ATS-approved PDF/DOCX template. `src/resume/tailoredResume.ts`
  parses the model's output and transparently falls back to older flat-text
  formats for `resume_versions` rows written before the structured format
  existed — no data migration needed. `src/resume/envelopeValidation.ts` is the
  strict counterpart for resumes arriving over the API (the MCP path): it
  rejects a malformed entry with the exact field path instead of dropping it.
- `src/storage/` — `db.ts` (SQLite connection + migrations) and `schema.ts`
  (the DDL) for the database; `settings.ts` for the JSON-file-backed AI
  provider/key/base-resume config described above. `src/types/` holds the
  domain types (`index.ts`) and the resume/cover-letter schema
  (`resumeSchema.ts`) shared across the backend.

### Data model

See [`CLAUDE.md` §5](./CLAUDE.md#5-data-model-sqlite) for the full schema. The
two columns worth calling out here: `apply_method = 'external_redirect'` and
`status = 'pending_confirmation'`. Together they encode the central limitation
of this whole system — see "The detection ceiling" below.

## Dashboard

`dashboard/` — React + [Vite](https://vite.dev/) SPA, TypeScript, styled with
Tailwind CSS against a shared design-token file (`shared/tailwind-tokens.cjs`)
so the dashboard and the extension popup render as one consistent product
instead of two independently-styled UIs.

Talks to the backend over `/api`, proxied by Vite in dev
(`dashboard/vite.config.ts`) and by nginx in the Docker image
(`dashboard/nginx.conf`) — the dashboard's own code never hardcodes a backend
host, so the same build works in both environments.

## Extension

`extension/` — Chrome Manifest V3, TypeScript, per-platform content scripts
(`indeed.ts`, `linkedin.ts`, `glassdoor.ts`) plus a background service worker
for message routing and the right-click "Mark this job as applied" context
menu.

### The detection ceiling (read this before touching content scripts)

Indeed, LinkedIn, and Glassdoor all split "apply" into two paths, and the split
determines how reliably this tool can know an application actually happened:

| Path | What happens | Detection |
| --- | --- | --- |
| In-platform apply (Easy Apply / Indeed Apply) | Form is completed without leaving the platform's own domain, ends in a confirmation state | Reliable — a `MutationObserver` watches for the confirmation screen/modal |
| External redirect apply | User is sent to the employer's own site | Unreliable — we only know the user *clicked* apply and was redirected; whether they finished the form is invisible to the platform itself, and therefore to us |

External redirects are logged as `pending_confirmation`, never silently marked
`applied`, and surfaced in the dashboard for the user to confirm or discard.
This isn't a workaround to be "fixed" later — it's the honest ceiling of what a
passive, ToS-respecting observer can know. See CLAUDE.md §6 for the full
per-platform breakdown (URLs, DOM structure notes, confirmation-text
heuristics, Indeed's confirmation-email fallback).

### Why selectors are config, not code

Every platform's frontend is React/JS-rendered, unversioned from our
perspective, and changes without notice. Content scripts do not hardcode CSS
selectors or button text inline — everything lives in
`extension/src/shared/selectors/{indeed,linkedin,glassdoor}.json`, matched
against confirmation **text content** as a resilience layer, since English
copy ("application sent," "application submitted") churns far less often than
class names.

**When a detector breaks — and it will, because these sites change their
markup with no warning — the fix is almost always editing the relevant JSON
file, not the content script itself.** If you're contributing and a detector
stops firing, start there before touching `.ts` files.

A manual fallback always exists precisely because automatic detection can
never be 100% reliable given how these sites work: the right-click context
menu item and the dashboard's manual add form both go through the same
`POST /applications` endpoint as auto-capture.

## MCP server

`mcp/` — optional stdio [MCP](https://modelcontextprotocol.io/) server for Claude
Desktop and Claude Code, built on `@modelcontextprotocol/server`. The Claude app
spawns `node mcp/dist/index.js` as a child process and talks JSON-RPC over its
stdin/stdout — no port is opened. Every tool call becomes an HTTP request to the
backend (`APPLYT_URL`, default `http://localhost:4317`); `mcp/` never opens the
SQLite file and holds no business logic, so validation and storage stay in one
place.

- `src/client.ts` — the only module that does network I/O. Turns "backend not
  running" and backend 4xx/5xx responses into readable errors Claude can act on.
- `src/tools.ts` — the ten tools (list/get applications, base resume, stats,
  create, update, save tailored resume, attach files, preview/confirm delete), as plain data +
  handlers so they're testable without a transport. Handlers never throw.
- `src/deleteTokens.ts` — the delete guard. `preview_delete` resolves its target
  to concrete ids and issues a single-use, 5-minute token; `confirm_delete` needs
  that token plus the matching count, and a status-based delete is refused if the
  matching set changed since the preview. It can't stop Claude confirming its
  own preview — the client's per-tool approval prompt is the human checkpoint —
  but nothing is deleted that wasn't shown first.
- `src/attachFiles.ts` — the guard for `attach_files`. The model supplies the
  path, so only absolute paths to regular `.pdf`/`.docx` files of ≤ 5 MB are
  read (size checked before reading), and their leading bytes must match the
  extension — a confused or prompt-injected Claude can't pull other files
  (keys, `.env`) into Applyt.
- `src/index.ts` — creates the `McpServer`, registers the tools, connects stdio.

Tailoring through MCP is different from the dashboard's **Tailor** button: Claude
itself writes the resume (no provider call, no key, `cost = 0`) and saves it with
`POST /applications/:id/resume-versions` in the same stored format, so it shows
up and downloads exactly like any other version (`ai_provider = 'mcp'`).

## Distribution (Phase 6, v1.0)

- `docker-compose.yml` + `backend/Dockerfile` + `dashboard/Dockerfile` — a
  two-service stack (backend on `4317`, dashboard served by nginx on `5173`,
  proxying `/api` to the backend container). A named volume
  (`applyt-data`) persists the SQLite file across container restarts. See
  [`SETUP.md`](./SETUP.md) for the one-command version.
- No CD, deliberately. CI (`.github/workflows/`) runs tests + build on every
  push/PR; there is nothing to deploy anywhere, since every user runs their own
  instance. Don't add a publish/deploy step without revisiting why (see
  CLAUDE.md §3 — there's no infrastructure we operate to deploy to).

## What's *not* here, on purpose

- No auto-apply / automated form submission anywhere in the extension. It
  observes and records; it never fills out or submits a form. This is a ToS
  violation on all three platforms and explicitly out of scope (CLAUDE.md §2).
- No scheduled/background scraping or polling of "My Applications" pages. All
  detection happens passively, reacting to DOM mutations produced by the user's
  own live browsing session.
- No accounts, no multi-tenant anything, no encryption-at-rest scheme for API
  keys beyond "it's a local file on the user's own machine, same as their
  browser's saved passwords."
