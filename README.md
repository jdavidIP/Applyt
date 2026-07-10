# Applyt — Self-Hosted Job Application Tracker

A local-first, single-user job application tracker. You run it on your own machine;
nothing is sent to any server we operate. See [`CLAUDE.md`](./CLAUDE.md) for the full
product spec and roadmap.

> **Status: Phase 2 in progress — auto-capture.** Backend + dashboard + CSV export
> (Phase 1) are working. The browser extension now auto-detects Indeed applications;
> LinkedIn, Glassdoor, and AI resume tailoring come in later phases.

## What works today

- Add / edit / delete job applications by hand in a local web dashboard.
- Filter by platform and status; sort by date applied or last updated.
- Change an application's status inline (applied → interviewing → offer, etc.).
- Export everything to CSV with one click (the permanent, zero-setup export path).

## Requirements

- [Node.js](https://nodejs.org/) 20+ (tested on 24)
- npm 10+

## Setup & run

```bash
# 1. Install all workspace dependencies (backend + dashboard)
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
```

## Browser extension (auto-capture)

The extension watches Indeed job pages you're already browsing and reports
applications to your local backend the moment it detects one — it never fills
out or submits anything on your behalf (see `CLAUDE.md` §2/§6).

```bash
npm run build --workspace extension   # produces extension/dist
```

Load it unpacked in Chrome:

1. Go to `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select `extension/dist`.
3. Make sure the backend is running (`npm run dev:backend` or `npm run dev`).

What it does today:

- **Indeed Apply / smartapply.indeed.com** (in-platform): logged as `applied` once
  the confirmation screen appears.
- **Apply on company site** (external redirect): logged immediately as
  `pending_confirmation` — Indeed itself can't see whether the user actually
  finished the form on the employer's site, so neither can we.
- **Manual fallback**: right-click a job page → "Mark this job as applied".

Selectors and confirmation text are isolated in
`extension/src/shared/selectors/indeed.json` — when Indeed changes its markup
(it will), fix the JSON, not the content script.

## Configuration

| Variable      | Where            | Default                      | Purpose                                  |
| ------------- | ---------------- | ---------------------------- | ---------------------------------------- |
| `PORT`        | backend          | `4317`                       | Backend HTTP port                        |
| `HOST`        | backend          | `127.0.0.1`                  | Backend bind address                     |
| `DB_PATH`     | backend          | `backend/data/applications.db` | SQLite file location (`:memory:` for ephemeral) |
| `CORS_ORIGIN` | backend          | `http://localhost:5173`      | Comma-separated allowed dashboard origins |
| `VITE_API_BASE` | dashboard      | `/api` (proxied)             | Backend base URL the dashboard calls     |

Your data lives in a single SQLite file at `backend/data/applications.db` (gitignored).
Back it up by copying that file.

## API

All routes are under the backend origin (`http://localhost:4317`):

| Method   | Path                        | Description                                    |
| -------- | --------------------------- | ---------------------------------------------- |
| `GET`    | `/applications`             | List; optional `?platform=&status=&sort=&order=` |
| `GET`    | `/applications/:id`         | Fetch one                                      |
| `POST`   | `/applications`             | Create (defaults: platform `manual`, status `applied`) |
| `PATCH`  | `/applications/:id`         | Partial update; bumps `date_last_updated`      |
| `DELETE` | `/applications/:id`         | Delete one                                     |
| `GET`    | `/applications/export.csv`  | Download all rows as CSV                        |
| `GET`    | `/health`                   | Liveness check                                 |

The `POST /applications` body shape is intentionally compatible with what the
Phase 2 browser extension will send, so the extension reuses this same endpoint —
there is only one storage path.

## Tests

```bash
npm test        # backend CRUD + CSV + validation tests
```

## Project layout

```
backend/    Fastify + better-sqlite3 API (TypeScript)
dashboard/  React + Vite single-page app (TypeScript)
CLAUDE.md   Full product spec and phased roadmap
```

## License

MIT
