# Setup

Two ways to run Applyt: **Docker** (one command, no local Node install needed) or
**manual** (Node.js directly, better if you're actively developing). Both give you
the same dashboard at `http://localhost:5173`, talking to the same backend at
`http://localhost:4317`.

The browser extension is not part of either path above — it's a separate, optional
step at the end of this doc, since it runs inside Chrome rather than as a server
process.

---

## Option A: Docker (recommended for just running it)

### Requirements

- [Docker](https://docs.docker.com/get-docker/) with Compose v2 (`docker compose`,
  not the old standalone `docker-compose`)

### Run it

```bash
git clone https://github.com/jdavidIP/Applyt.git
cd Applyt
docker compose up --build
```

- Dashboard → **http://localhost:5173**
- Backend → **http://localhost:4317** (exposed so the browser extension, running
  outside Docker in your actual browser, can reach it)

Your data persists in a named Docker volume (`applyt-data`) mounted at
`/app/backend/data` inside the backend container, so `docker compose down` and a
later `docker compose up` keep your applications. `docker compose down -v` deletes
the volume — only do that if you actually want to wipe your data.

Stop it with `Ctrl+C`, or `docker compose down` to also remove the containers
(the volume survives either way unless you pass `-v`).

### Configuring AI tailoring under Docker

Add API keys as environment variables on the `backend` service in
`docker-compose.yml` (or an `.env` file Compose picks up automatically):

```yaml
services:
  backend:
    environment:
      ANTHROPIC_API_KEY: sk-ant-...
      # or
      OPENAI_API_KEY: sk-...
```

Alternatively, skip this and set the key from the dashboard's Settings screen
after startup — it's saved into `backend/data/settings.json` inside the persisted
volume either way.

### Rebuilding after pulling changes

```bash
git pull
docker compose up --build
```

`--build` forces Docker to rebuild the images if `backend/`, `dashboard/`, or
their Dockerfiles changed; Docker's layer cache keeps this fast when only
application code (not dependencies) changed.

---

## Option B: Manual (Node.js directly)

### Requirements

- [Node.js](https://nodejs.org/) 20+ (tested on 24)
- npm 10+
- Google Chrome (or a Chromium-based browser), only if you want the extension

### Run it

```bash
git clone https://github.com/jdavidIP/Applyt.git
cd Applyt
npm install
npm run dev
```

This installs all three workspaces (`backend`, `dashboard`, `extension`) and
starts the backend (port `4317`) and dashboard (port `5173`) together. Open
**http://localhost:5173**.

Run the pieces separately if you want independent logs/restarts:

```bash
npm run dev:backend     # backend only, http://localhost:4317
npm run dev:dashboard   # dashboard only, http://localhost:5173
```

### Configuring AI tailoring manually

Either:

- Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in your shell / a `backend/.env`
  file before starting the backend, **or**
- Open **Settings** in the dashboard once it's running and paste your key in —
  it's written to `backend/data/settings.json` (gitignored, never committed).

Environment variables always take precedence over the stored settings file.

### Building for production (without Docker)

```bash
npm run build   # compiles backend + builds dashboard + builds extension
```

Compiled backend output lands in `backend/dist`; the dashboard's static bundle
lands in `dashboard/dist`. You'd need to serve `dashboard/dist` yourself (any
static file server, with `/api` proxied to the backend) — this is exactly what
`dashboard/Dockerfile` + `dashboard/nginx.conf` do, so read those if you want to
replicate it outside Docker.

### Running tests

```bash
npm test        # backend (node:test) + dashboard (Vitest)
```

The extension has no automated test suite — its content scripts are verified via
live manual testing against real job postings, since their DOM-selector logic is
inherently tied to each site's actual, frequently-changing markup. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md#why-selectors-are-config-not-code) before
touching a content script.

---

## Browser extension (auto-capture)

Optional, and separate from both setup paths above — it runs inside your browser,
not as a server process, and talks to whichever backend you started (Docker or
manual, same port either way).

```bash
npm run build --workspace extension   # produces extension/dist
```

1. Make sure the backend is running (either setup path above).
2. Go to `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select `extension/dist`.

For active extension development, `npm run dev:extension` watches and rebuilds
`extension/dist` on save — reload the extension from `chrome://extensions` to
pick up changes.

---

## Configuration reference

| Variable            | Where     | Default                         | Purpose                                          |
| -------------------- | --------- | -------------------------------- | ------------------------------------------------- |
| `PORT`               | backend   | `4317`                           | Backend HTTP port                                  |
| `HOST`               | backend   | `127.0.0.1` (`0.0.0.0` in Docker) | Backend bind address                               |
| `DB_PATH`            | backend   | `backend/data/applications.db`   | SQLite file location (`:memory:` for ephemeral)    |
| `SETTINGS_PATH`      | backend   | `backend/data/settings.json`     | Where AI provider settings/keys are stored         |
| `CORS_ORIGIN`        | backend   | `http://localhost:5173`          | Comma-separated allowed dashboard origins          |
| `ANTHROPIC_API_KEY`  | backend   | —                                 | Overrides the stored Anthropic key, if set         |
| `OPENAI_API_KEY`     | backend   | —                                 | Overrides the stored OpenAI key, if set            |
| `VITE_API_BASE`      | dashboard | `/api` (proxied)                 | Backend base URL the dashboard calls               |

Your data lives in a single SQLite file (`backend/data/applications.db`, or the
`applyt-data` Docker volume) — back it up by copying that file (or the volume).

## Troubleshooting

- **Dashboard loads but shows no data / network errors.** Confirm the backend is
  actually up: `curl http://localhost:4317/health` should return `{"status":"ok"}`.
  Under Docker, check `docker compose ps` — the dashboard container's healthcheck
  dependency means it won't start serving until the backend passes its own
  healthcheck.
- **`npm install` fails to build `better-sqlite3`.** It ships prebuilt binaries
  for common platforms; if none matches yours, you need a C++ build toolchain
  (Python, make, a C compiler) available. This is exactly what
  `backend/Dockerfile`'s build stage installs, so Docker sidesteps this entirely.
- **Extension shows nothing / doesn't detect applications.** Confirm the backend
  is running and reachable at `http://localhost:4317`, then check the browser
  console on the job page for errors. If a specific detector has stopped firing
  after a site redesign, see
  [`ARCHITECTURE.md`](./ARCHITECTURE.md#why-selectors-are-config-not-code) — the
  fix is almost always a selectors JSON update, not a code change.
- **Port already in use.** Set `PORT` (backend) or change the dashboard's Vite
  dev port in `dashboard/vite.config.ts` (manual setup), or edit the `ports:`
  mappings in `docker-compose.yml` (Docker setup).
