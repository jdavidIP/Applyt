# Architecture

This document explains how Applyt's pieces fit together and why they're built the
way they are. For the product spec and phased roadmap, see [`CLAUDE.md`](./CLAUDE.md).
For "how do I run this," see [`SETUP.md`](./SETUP.md).

## The shape of the system

```
┌─────────────────────┐        ┌─────────────────────┐
│  Browser extension   │        │      Dashboard        │
│  (content scripts +  │        │  (React + Vite SPA)   │
│  background worker)  │        │                        │
└──────────┬───────────┘        └───────────┬────────────┘
           │ POST /applications              │ GET/PATCH/DELETE
           │ (auto-capture + manual mark)     │ /applications, /settings, ...
           └───────────────┬───────────────────┘
                            │
                   ┌────────▼─────────┐
                   │   Local backend   │
                   │  (Fastify + TS)   │
                   └────────┬──────────┘
                            │
                  ┌─────────┴──────────┐
                  │   SQLite (single    │
                  │   file on disk)     │
                  └──────────────────────┘
```

Everything runs on the user's own machine. The extension and the dashboard are two
different front ends for the **same backend on the same port** — there is
deliberately only one storage path (see CLAUDE.md §2). Nothing here talks to a
server we operate; the only outbound network call the backend ever makes is the
AI tailoring request to the user's own configured Anthropic/OpenAI account, using
a key that never leaves their machine.

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
  export, bulk lifecycle actions (mark-stale, bulk-delete-by-status), AI tailor
  request + cost estimate, resume-version download (PDF/DOCX/TXT).
- `src/routes/settings.ts` — AI provider/model/key/base-resume settings, backed
  by a local JSON file (`backend/data/settings.json`, gitignored) rather than the
  database, since it holds secrets and is conceptually per-machine config, not
  application data.
- `src/reportData.ts` — summary/report math (per-week counts, response rate,
  formula-injection sanitization) shared between the CSV and XLSX export paths
  so both report formats always agree on the same numbers.
- `src/ai.ts` — the one place that makes an outbound network call: direct
  `fetch` requests to the Anthropic or OpenAI Messages API using the user's own
  key, no SDK dependency.
- `src/resumeRender.ts` / `src/resumeSchema.ts` — turns a tailored resume
  (structured JSON: contact, summary, experience, projects, education, skills)
  into a single ATS-approved PDF/DOCX template. `src/tailoredResume.ts` parses
  the model's output and transparently falls back to older flat-text formats for
  `resume_versions` rows written before the structured format existed — no data
  migration needed.

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
