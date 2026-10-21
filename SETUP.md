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

### Local AI tailoring with Ollama (no API key, opt-in)

Prefer to run tailoring entirely on your own hardware instead of a hosted
provider? An `ollama` server plus a one-shot puller for the two recommended
default models (`llama3.2:latest`, `llama3.2:1b`) are defined in
`docker-compose.yml`, but **not** started by a plain `docker compose up` —
they're behind an opt-in Compose profile so existing users who only use their
own Anthropic/OpenAI key don't get a surprise multi-GB download on their next
rebuild. Start it with:

```bash
docker compose --profile ollama up --build
```

The first run pulls the `ollama/ollama` image and both models (several GB
total) — expect it to take a while. `ollama pull` hash-checks what's already
present, so every run after the first is fast, not a re-download. Once it's
up, select **Ollama (local)** as the provider in the dashboard's Settings
screen; the backend is already wired to reach it via `OLLAMA_BASE_URL:
http://ollama:11434` in `docker-compose.yml`, so no extra configuration is
needed. Model weights persist in the `ollama-data` volume across restarts.

If you're running the backend outside Docker (Option B below) with a local
`ollama serve` instead, the default `OLLAMA_BASE_URL` of
`http://localhost:11434` already points at it — nothing extra to set.

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
npm test        # backend + mcp (node:test) + dashboard (Vitest)
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

## Connect Claude (MCP server, optional)

Lets Claude Desktop or Claude Code read your saved applications, answer questions
about them, tailor resumes for them (using your Claude plan — no API key), and
add, update, or delete entries. The MCP server is a small local process the
Claude app starts on demand; it talks to the same backend as the dashboard and
never touches the database file directly.

1. Build it once: `npm install && npm run build --workspace mcp`
2. Keep the Applyt backend running (`npm run dev` or `docker compose up`).
3. Register it:
   - **Claude Code:** `claude mcp add applyt -- node /absolute/path/to/Applyt/mcp/dist/index.js`
   - **Claude Desktop:** Settings → Developer → **Edit Config** (this opens the
     right file for your install), then add the block below to
     `claude_desktop_config.json`. The file normally lives at
     `%APPDATA%\Claude\` (Windows) or `~/Library/Application Support/Claude/`
     (macOS); the Microsoft Store build keeps it elsewhere (e.g.
     `%LOCALAPPDATA%\Claude-Data\claude_<id>\`), which is why Edit Config is the
     safe way to find it. Desktop also stores its own preferences in this file —
     add the `mcpServers` key alongside them rather than replacing the file.
     If Claude reports the server failed to start, replace `"node"` with the full
     path to your Node binary (`where node` / `which node`) — desktop apps don't
     always inherit your terminal's `PATH`.
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
4. Backend on a non-default port? Add `"env": { "APPLYT_URL": "http://localhost:<port>" }`
   to the Desktop entry, or pass `-e APPLYT_URL=http://localhost:<port>` to
   `claude mcp add` (before the `--`).

Docker users: same steps — the MCP server runs on your machine and reaches the
backend container through the published port 4317.

Deletes are two-step: Claude has to preview a delete (seeing exactly which
applications match) and then confirm it with the matching count. Keep your
Claude app's approval prompt on for `confirm_delete` — that prompt is the real
safeguard, and deletes cannot be undone.

To keep a resume or cover letter in your own layout, have Claude attach the file
with `attach_files` (give it the full path; in Claude Desktop, download the file
Claude made first). The tool only reads absolute paths to `.pdf`/`.docx` files of
up to 5 MB whose contents match the extension.

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
| `OLLAMA_BASE_URL`    | backend   | `http://localhost:11434`         | Overrides the stored Ollama server URL, if set     |
| `APPLYT_URL`         | mcp       | `http://localhost:4317`          | Backend URL the MCP server calls                   |
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
- **Claude says the Applyt backend "isn't reachable".** The MCP server started
  fine but can't reach the backend — start it (`npm run dev` or
  `docker compose up`), or set `APPLYT_URL` if it isn't on port 4317.
- **`applyt` doesn't show up in Claude at all.** Check the path in your
  `claude mcp add` / Desktop config points at `mcp/dist/index.js` (absolute
  path) and that you ran `npm run build --workspace mcp`. In Claude Code,
  `/mcp` shows each server's connection status.
