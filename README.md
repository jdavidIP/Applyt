# Applyt — Self-Hosted Job Application Tracker

A local-first, single-user job application tracker. You run it on your own machine;
nothing is sent to any server we operate. See [`CLAUDE.md`](./CLAUDE.md) for the full
product spec and roadmap.

> **Status: Phases 1–4 complete.** Manual tracking, auto-capture on Indeed/LinkedIn/
> Glassdoor, lifecycle management, and AI resume tailoring with cost tracking all work
> today. Google Sheets sync (Phase 5) and Docker packaging (Phase 6) are next.

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

## Requirements

- [Node.js](https://nodejs.org/) 20+ (tested on 24)
- npm 10+
- Google Chrome (or a Chromium-based browser) if you want the extension

## Setup & run

```bash
# 1. Install all workspace dependencies (backend + dashboard + extension)
npm install

# 2. Start the backend (port 4317) and the dashboard (port 5173) together
npm run dev
```

Then open **http://localhost:5173**.

The dashboard proxies API calls to the backend, so you only need the one URL.

### Running the pieces separately

```bash
npm run dev:backend     # backend only, http://localhost:4317
npm run dev:dashboard   # dashboard only, http://localhost:5173
npm run dev:extension   # extension dev build, watches extension/dist
```

## Browser extension (auto-capture)

The extension watches job pages you're already browsing on Indeed, LinkedIn, and
Glassdoor, and reports applications to your local backend the moment it detects one.

```bash
npm run build --workspace extension   # produces extension/dist
```

Load it unpacked in Chrome:

1. Go to `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select `extension/dist`.
3. Make sure the backend is running (`npm run dev:backend` or `npm run dev`).

What it does today, per platform:

| Platform  | In-platform apply (reliable detection)                    | External redirect apply           |
| --------- | ----------------------------------------------------------- | ---------------------------------- |
| Indeed    | Indeed Apply / `smartapply.indeed.com` — logged `applied` on the confirmation screen | Logged `pending_confirmation` |
| LinkedIn  | Easy Apply — logged `applied` when the modal's confirmation state appears | Logged `pending_confirmation` |
| Glassdoor | Easy Apply (Synced Profile) — logged `applied` on success   | Logged `pending_confirmation`      |

All three also auto-capture the job description at detection time, so tailoring
against an auto-captured application doesn't require pasting the JD in by hand.

A manual fallback always exists: right-click a job page → **"Mark this job as
applied"**, or add/edit an entry directly in the dashboard.

Selectors and confirmation text are isolated per platform in
`extension/src/shared/selectors/*.json` — when a site changes its markup (it will),
fix the JSON, not the content script.

## AI resume tailoring

1. Open **Settings** in the dashboard, choose a provider (Anthropic or OpenAI), and
   paste in your own API key and base resume. Keys are stored locally in
   `backend/data/settings.json` (gitignored) and never leave your machine except in
   the outbound call to your chosen provider. Once a key is saved, the model field
   offers a live list of models from your own account (fetched from the provider
   using that key) — you can still type a custom model id if you prefer one that
   isn't listed.
2. On any application with a job description, click **Tailor for this job**. The
   dashboard shows an estimated cost first — extrapolated from your own tailoring
   history for that model once you have some, or a rough estimate otherwise — then
   the generated resume, real token usage, and actual cost once it completes.
3. Previous tailored versions for an application are kept and viewable.

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
backend/    Fastify + better-sqlite3 API (TypeScript)
dashboard/  React + Vite single-page app (TypeScript)
extension/  Chrome Manifest V3 extension — content scripts + background service worker
CLAUDE.md   Full product spec and phased roadmap
```

## License

MIT
