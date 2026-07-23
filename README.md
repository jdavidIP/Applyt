# Applyt — Self-Hosted Job Application Tracker

A local-first, single-user job application tracker. You run it on your own machine;
nothing is sent to any server we operate. See [`CLAUDE.md`](./CLAUDE.md) for the full
product spec and roadmap, [`ARCHITECTURE.md`](./ARCHITECTURE.md) for how the pieces
fit together, and [`SETUP.md`](./SETUP.md) for detailed setup (Docker or manual).

> **Status: v1.0 — feature-complete.** All six phases of the original roadmap
> (CLAUDE.md §7) are done: manual tracking, auto-capture on Indeed/LinkedIn/
> Glassdoor, lifecycle management, AI resume tailoring with cost tracking, an
> ATS-friendly template for tailored resume downloads, and one-command Docker
> packaging all work today. Ongoing work from here is bug fixes and incremental
> enhancements filed as GitHub issues, not new phases.

<!--
  Screenshots/GIFs of the dashboard and extension popup go here. Not included yet —
  add a few PNGs/GIFs under e.g. `docs/screenshots/` and embed them with standard
  Markdown image syntax once captured.
-->

## Quick start

```bash
git clone https://github.com/jdavidIP/Applyt.git
cd Applyt
docker compose up --build
```

Open **http://localhost:5173**. That's the whole setup — see
[`SETUP.md`](./SETUP.md) for the no-Docker path, extension installation, AI key
configuration, and troubleshooting.

## Tech stack

| Layer         | Stack                                                                 |
| ------------- | ---------------------------------------------------------------------|
| Backend       | Node.js + [Fastify](https://fastify.dev/) + [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (SQLite), TypeScript |
| Dashboard     | React + [Vite](https://vite.dev/), TypeScript                        |
| Extension     | Chrome Manifest V3, [@crxjs/vite-plugin](https://crxjs.dev/vite-plugin), TypeScript content scripts (per-platform: Indeed, LinkedIn, Glassdoor) |
| AI tailoring  | Direct `fetch` calls to the Anthropic or OpenAI REST API (no SDK dependency) using your own API key |
| Storage       | A single SQLite file (`backend/data/applications.db`) — no external database, no hosted backend |
| Tests         | `node:test` (backend), [Vitest](https://vitest.dev/) (dashboard)     |
| Monorepo      | npm workspaces (`backend`, `dashboard`, `extension`)                 |

Everything runs locally on your machine — see [`CLAUDE.md`](./CLAUDE.md) §2–3 for why
this is deliberately self-hosted rather than a hosted service.

## What works today

- **Manual tracking** — add / edit / delete job applications by hand in a local web
  dashboard; filter by platform and status; sort by date applied or last updated;
  change status inline (applied → interviewing → offer, etc.).
- **Auto-capture** — a browser extension detects applications you submit on Indeed,
  LinkedIn, and Glassdoor as you apply, and logs them automatically. It never fills
  out or submits anything on your behalf (see `CLAUDE.md` §2/§6). External-redirect
  applies (sent to the employer's own site) are logged as `pending_confirmation` for
  you to confirm, since neither the platform nor the extension can see whether you
  actually finished the form there.
- **CSV export** — the permanent, zero-setup export path, one click.
- **Lifecycle management** — bulk-mark stale applications after N days of inactivity,
  bulk-delete by status, and basic stats (applications per week, response rate).
- **AI resume tailoring** — bring your own Anthropic or OpenAI API key, tailor your
  base resume against a specific job's description, and see real per-run token usage
  and cost. A pre-generate cost estimate (extrapolated from your own tailoring
  history, or a rough static estimate before any history exists) is shown before you
  spend money running it.
- **ATS-friendly resume downloads** — every tailored resume downloads as a PDF or
  DOCX in a single, polished ATS-approved template (centered header, colored section
  headers, right-aligned dates, hanging-indent bullets) instead of unstyled text in
  a default font.

## Requirements

- **Docker** (with Compose v2), for the one-command path above, **or**
- [Node.js](https://nodejs.org/) 20+ (tested on 24) and npm 10+, for running the
  pieces directly — see [`SETUP.md`](./SETUP.md)
- Google Chrome (or a Chromium-based browser) if you want the extension, either way

## Browser extension (auto-capture)

The extension watches job pages you're already browsing on Indeed, LinkedIn, and
Glassdoor, and reports applications to your local backend the moment it detects one.

> **Contributor note: selectors *will* break.** None of these three sites expose a
> public API for this, and their DOM structure changes without notice. Detection
> logic is deliberately isolated into
> `extension/src/shared/selectors/{indeed,linkedin,glassdoor}.json` — when a
> detector stops firing after a site redesign, the fix is almost always editing
> that JSON, not the `.ts` content script. See
> [`ARCHITECTURE.md`](./ARCHITECTURE.md#why-selectors-are-config-not-code) before
> touching a content script.

```bash
npm run build --workspace extension   # produces extension/dist
```

Load it unpacked in Chrome:

1. Go to `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select `extension/dist`.
3. Make sure the backend is running — `npm run dev:backend`/`npm run dev`, or
   `docker compose up backend`. See [`SETUP.md`](./SETUP.md).

What it does today, per platform:

| Platform  | In-platform apply (reliable detection)                    | External redirect apply           |
| --------- | ----------------------------------------------------------- | ---------------------------------- |
| Indeed    | Indeed Apply / `smartapply.indeed.com` — logged `applied` on the confirmation screen | Logged `pending_confirmation` |
| LinkedIn  | Easy Apply — logged `applied` when the modal's confirmation state appears | Logged `pending_confirmation` |
| Glassdoor | Easy Apply (Synced Profile) — logged `applied` on success   | Logged `pending_confirmation`      |

All three also auto-capture the job description at detection time, so tailoring
against an auto-captured application doesn't require pasting the JD in by hand.

**Tailor before you apply, from the popup.** For Easy Apply jobs the posting
isn't tracked until *after* you submit — too late to tailor against it. So the
extension popup reads the job you're currently viewing and lets you **tailor a
resume and see the match rating + suggestions right there**, without opening the
dashboard. Doing so saves the job as a `pending_confirmation` application with
the tailored resume attached; if you then complete an Easy Apply it's promoted
to `applied` automatically, and if you don't it waits in the dashboard for you to
confirm or discard. (Requires a base resume and API key configured in the
dashboard first.)

A manual fallback always exists: right-click a job page → **"Mark this job as
applied"**, or add/edit an entry directly in the dashboard.

## AI resume tailoring

1. Open **Settings** in the dashboard, choose a provider (Anthropic or OpenAI), and
   paste in your own API key and base resume. Keys are stored locally in
   `backend/data/settings.json` (gitignored) and never leave your machine except in
   the outbound call to your chosen provider. Once a key is saved, the model field
   offers a live list of models from your own account (fetched from the provider
   using that key) — you can still type a custom model id if you prefer one that
   isn't listed.
2. On any application with a job description, click **Tailor for this job**. Two
   checkboxes let you choose whether to also receive a **match rating** (0–5
   stars, with a short justification of which requirements you meet, partially
   meet, or are missing) and **interview & cover-letter suggestions** — any
   combination of both, one, or neither; the tailored resume itself is always
   produced. Sections you opt out of are never requested from the model, so
   you're not billed for output you don't want. The dashboard shows an
   estimated cost first — extrapolated from your own tailoring history for
   that model once you have some, or a rough estimate otherwise. Real token
   usage and actual cost are shown once it completes.
3. Your base resume can be pasted as plain text or uploaded as a PDF/Word (.docx)
   file — an upload extracts the text for you to review and edit before saving.
4. Download any tailored resume as **PDF, Word (.docx), or plain text**; the match
   rating and suggestions stay in the dashboard and are never written into the
   downloadable resume file.
5. Previous tailored versions for an application are kept and viewable.

API keys can also be supplied via `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` environment
variables, which take precedence over the stored settings file — useful if you'd
rather not have the key on disk at all.

Per-model pricing (USD per million tokens) is editable in Settings; a model with no
configured price simply shows cost as "unknown" rather than a guess.

## Configuration

| Variable            | Where    | Default                        | Purpose                                          |
| -------------------- | -------- | ------------------------------- | ------------------------------------------------- |
| `PORT`               | backend  | `4317`                          | Backend HTTP port                                  |
| `HOST`               | backend  | `127.0.0.1`                     | Backend bind address                               |
| `DB_PATH`            | backend  | `backend/data/applications.db`  | SQLite file location (`:memory:` for ephemeral)    |
| `SETTINGS_PATH`      | backend  | `backend/data/settings.json`    | Where AI provider settings/keys are stored         |
| `CORS_ORIGIN`        | backend  | `http://localhost:5173`         | Comma-separated allowed dashboard origins          |
| `ANTHROPIC_API_KEY`  | backend  | —                                | Overrides the stored Anthropic key, if set         |
| `OPENAI_API_KEY`     | backend  | —                                | Overrides the stored OpenAI key, if set            |
| `VITE_API_BASE`      | dashboard| `/api` (proxied)                | Backend base URL the dashboard calls               |

Your data lives in a single SQLite file at `backend/data/applications.db` (gitignored).
Back it up by copying that file.

## API

All routes are under the backend origin (`http://localhost:4317`):

| Method   | Path                                    | Description                                               |
| -------- | ---------------------------------------- | ----------------------------------------------------------- |
| `GET`    | `/applications`                          | List; optional `?platform=&status=&sort=&order=`            |
| `GET`    | `/applications/:id`                      | Fetch one                                                    |
| `POST`   | `/applications`                          | Create (upserts on `platform`+`platform_job_id` if it already exists) |
| `PATCH`  | `/applications/:id`                      | Partial update; bumps `date_last_updated`                    |
| `DELETE` | `/applications/:id`                      | Delete one (and any tailored resume versions for it)         |
| `DELETE` | `/applications?status=`                  | Bulk-delete all applications with a given status             |
| `GET`    | `/applications/export.csv`               | Download all rows as CSV                                     |
| `GET`    | `/applications/stats`                    | Applications-per-week (last 8 weeks) + response rate         |
| `POST`   | `/applications/mark-stale`               | Bulk-mark old `applied` rows as `stale` (`{ thresholdDays }`) |
| `POST`   | `/applications/:id/tailor`               | Generate a tailored resume for this application              |
| `GET`    | `/applications/:id/tailor-estimate`      | Pre-generate cost estimate for a tailor run                  |
| `GET`    | `/applications/:id/resume-versions`      | List tailored resume versions for this application           |
| `GET`    | `/settings`                              | Client-safe AI settings (never returns raw API keys)         |
| `PUT`    | `/settings`                              | Update AI provider, model, keys, base resume, or pricing     |
| `GET`    | `/settings/models?provider=`             | Live model list from the provider, using your stored/env key |
| `GET`    | `/settings/known-pricing`                | Curated, dated snapshot of published provider prices          |
| `GET`    | `/health`                                | Liveness check                                                |

The `POST /applications` body shape is intentionally compatible with what the browser
extension sends, so the extension and the manual dashboard form both go through this
same endpoint — there is only one storage path.

## Tests

```bash
npm test        # backend (node:test) + dashboard (Vitest)
```

The extension has no automated test suite — all three content scripts are verified
via live manual testing against real job postings, since their DOM-selector logic is
inherently tied to each site's actual (and frequently changing) markup.

## Project layout

```
backend/         Fastify + better-sqlite3 API (TypeScript)
dashboard/       React + Vite single-page app (TypeScript)
extension/       Chrome Manifest V3 extension — content scripts + background service worker
shared/          Design tokens shared by the dashboard and extension popup UIs
docker-compose.yml, backend/Dockerfile, dashboard/Dockerfile   One-command Docker packaging
CLAUDE.md        Full product spec and phased roadmap
ARCHITECTURE.md  How the pieces fit together and why
SETUP.md         Detailed setup (Docker or manual), configuration reference, troubleshooting
```

## Known limitations / post-1.0 backlog

- **Job description formatting** ([#12](https://github.com/jdavidIP/Applyt/issues/12)) —
  captured job descriptions are read correctly but rendered with inconsistent
  whitespace/layout, which is harder to read and may affect AI tailoring quality.
- **Cover letter generation** ([#15](https://github.com/jdavidIP/Applyt/issues/15)) —
  not yet supported; tailoring currently produces a resume (plus optional match
  rating and interview suggestions) only.
- **Gmail confirmation-email fallback for Indeed** (CLAUDE.md §6/§8) — deferred
  indefinitely; the extension's own DOM-based detection is the only detection path.
- The extension has no automated tests (see [Tests](#tests) above); Glassdoor's
  external-redirect/manual-fallback paths and LinkedIn's external "Apply" were
  only lightly exercised in live testing compared to each platform's Easy Apply
  flow.

None of these block using Applyt as a daily driver — they're refinements, tracked
as GitHub issues rather than roadmap phases.

## License

MIT
