# Job Application Tracker — Project Context for Claude Code

## 1. What this project is

A **self-hosted, open-source job application tracker** with two pillars:

1. **Automatic application tracking** across Indeed, LinkedIn, and Glassdoor via a browser extension that observes the user's own apply actions in real time, stores them locally, and lets the user view/edit/delete entries in a local web dashboard.
2. **AI resume tailoring** — the user supplies their own Claude or OpenAI API key, and can generate a tailored resume/suggestions against a specific saved job entry.

This is **not** a hosted SaaS product. It is distributed as a public GitHub repo that each user clones and runs on their own machine. This is a deliberate architectural decision — see Section 3.

Job tracking is the primary feature. AI tailoring is a secondary feature built on top of tracked job entries, not a standalone tool.

## 2. Non-negotiable constraints

Read this section before writing any code. These are product decisions already made, not open questions.

- **No auto-apply, no automated form-filling, no bot-driven submission.** This tool observes and records; it never fills out or submits an application on the user's behalf. That behavior is a ToS violation on all three platforms and is explicitly out of scope.
- **No scraping of "My Applications" pages on a schedule, no background login/polling.** These platforms actively detect and rate-limit/ban this kind of automated access, especially LinkedIn. All detection happens passively, in the context of the user's own live browsing session, via content scripts reacting to DOM changes the user's own actions produce.
- **No API keys or credentials ever leave the user's machine.** Everything is self-hosted, single-user, local-first. No server we control, no database we control, no telemetry.
- **No accounts, no auth system.** One instance = one user. This eliminates an entire category of security work (encrypting other people's keys at rest, session management, etc.) that would be mandatory if this were multi-tenant.
- **CSV export is the default, zero-setup path to "somewhere I can see my data."** Google Sheets sync is an optional upgrade layered on top, using the user's own Google Cloud OAuth credentials (documented setup, not something we provide centrally).
- **Extension and local dashboard talk to the same local backend on the same default port.** Do not build two separate storage paths that need reconciling later.

## 3. Why self-hosted (context for design decisions)

This matters because it shapes almost every technical choice below. Running as a personal, cloneable tool rather than a hosted service means:
- SQLite instead of a hosted Postgres — single file, no ops.
- No encryption-at-rest requirement for API keys, since they live in the user's own `.env` or local storage, never transmitted to infrastructure we operate.
- No privacy policy / ToS document needed, since no user data is collected by us.
- Liability for how each user's extension interacts with LinkedIn/Indeed/Glassdoor rests with that user's own browser session, not with a service we run.

Don't reintroduce multi-tenancy, hosted storage, or centralized key handling without an explicit decision to do so — it would undo the reasoning above.

## 4. Tech stack

- **Extension:** Manifest V3, TypeScript, content scripts per platform (`indeed.ts`, `linkedin.ts`, `glassdoor.ts`), background service worker for message routing.
- **Local backend:** Node.js (Express or Fastify), TypeScript, SQLite (via `better-sqlite3` or `drizzle-orm`). Runs on `localhost` on a configurable default port (e.g. `4317`).
- **Dashboard:** React (Vite) or Next.js, talks to the local backend over `http://localhost:<port>`.
- **AI calls:** Backend proxies requests to Anthropic/OpenAI using the user's own key from `.env` or a local settings file — never hardcoded, never sent anywhere else.
- **Distribution:** public GitHub repo, optional `docker-compose.yml` for one-command setup, README with manual setup steps for non-Docker users.

## 5. Data model (SQLite)

```sql
CREATE TABLE applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,              -- 'indeed' | 'linkedin' | 'glassdoor' | 'manual'
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  job_url TEXT,
  platform_job_id TEXT,                -- jk (Indeed), jobId (LinkedIn), listingId (Glassdoor)
  apply_method TEXT NOT NULL,          -- 'in_platform' | 'external_redirect' | 'manual'
  status TEXT NOT NULL DEFAULT 'applied', -- applied | pending_confirmation | interviewing | rejected | offer | ghosted | stale
  date_applied TEXT NOT NULL,
  date_last_updated TEXT NOT NULL,
  notes TEXT,
  resume_version_id INTEGER REFERENCES resume_versions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE resume_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER REFERENCES applications(id),
  base_resume_snapshot TEXT,
  tailored_output TEXT,
  ai_provider TEXT,                    -- 'anthropic' | 'openai'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`apply_method = 'external_redirect'` and `status = 'pending_confirmation'` matter — see Section 6, this is how the extension handles applications it can only partially observe.

## 6. How each platform handles applications, and how to detect them

This is the hardest and most fragile part of the project. Read carefully — DOM structure on all three sites changes frequently and without notice, since none of them expose a public API for this. Build the selector logic so it's easy to patch later (isolate selectors into a small per-platform config object, not scattered inline).

**The universal split: in-platform apply vs. external redirect apply.**
All three platforms have two distinct apply paths, and this determines how reliably we can detect a completed application:

| Path | What happens | Detection reliability |
|---|---|---|
| In-platform apply (LinkedIn "Easy Apply", Indeed "Apply now" / Indeed Apply, Glassdoor "Easy Apply") | Application form is completed and submitted without leaving the platform's domain, ends in a confirmation screen/modal | High — we can watch for the confirmation state |
| External redirect apply (LinkedIn "Apply" to company site, Indeed "Apply on company site", Glassdoor "Apply Now" to company site) | User is sent to the employer's own careers page/ATS; the platform itself loses visibility into whether the application was actually completed | Low — we can only detect "user clicked apply and was redirected to X"; whether they finished the form on the external site is unknown |

For external redirects, log the entry with `status = 'pending_confirmation'` and surface it in the dashboard for the user to confirm or discard — don't silently mark it "applied," since a redirect click doesn't guarantee a completed submission. This distinction is important and should be visible in the UI, not just the schema.

### LinkedIn

- Job postings live at `linkedin.com/jobs/view/{jobId}`.
- **Easy Apply**: opens a multi-step modal in-page. It ends with a confirmation state (the modal shows a "done"/"application sent" screen and then closes). This is the moment to capture — not the initial button click, since the user can cancel partway through a multi-step modal.
- **Apply** (non-Easy Apply): opens the employer's site in a new tab — external redirect path.
- After a successful Easy Apply, the job card gets an "Applied" indicator, and the job appears under the user's **My Jobs → Applied** tab on LinkedIn itself — useful as a secondary verification surface if you want a periodic reconciliation feature later.
- Practical detection approach: content script uses `MutationObserver` on the job page / job card container to watch for the Easy Apply modal's confirmation state (e.g., a "Your application was sent to [Company]" message) rather than trying to hook the submit button directly, since the modal is multi-step and re-rendered dynamically. Job cards and modals are React-rendered with class names that change across LinkedIn releases, so selectors need to target semantic text content (e.g., "Application sent") as a fallback in addition to class-based selectors.

### Indeed

- Job postings live at `indeed.com/viewjob?jk={jobKey}`. The `jk` parameter is a stable identifier worth capturing.
- **Apply now / Indeed Apply**: the native flow is typically hosted under a subdomain (`smartapply.indeed.com`) and stays within Indeed's own apply flow, ending in a confirmation screen ("Application submitted" / "Your application has been submitted to [Company]"). Content script needs to run on both `indeed.com` and `smartapply.indeed.com`.
- **Apply on company site**: external redirect — Indeed has no visibility into whether the application actually completed, and neither does our extension beyond the redirect click.
- Indeed also sends a confirmation email titled **"Indeed Application: [job title]"** after every successful in-platform application — this is a reliable fallback signal. A Gmail API integration (read-only, user-consented) that searches for these subject lines can catch anything the extension missed, and is worth building as a secondary/backup detection path once the extension MVP works, not a blocker for v1.
- Applied jobs show an "Applied" label in Indeed's own search results and under **My Jobs → Applied**.

### Glassdoor

- Glassdoor is owned by Indeed and its "Easy Apply" flow for synced profiles actually runs through Indeed's Easy Apply form under the hood — worth knowing since the confirmation screen text and structure may closely resemble Indeed's.
- **Apply Now**: redirects to the employer's own career site — external redirect path, same caveats as above.
- **Easy Apply**: only available to users with a "Synced Profile"; submission happens without leaving Glassdoor and ends in a success confirmation ("Your application has been successfully submitted").
- Glassdoor only tracks applications made via Easy Apply on the user's own profile under **Profile → Job Activity → Applied Jobs**; anything via external redirect is invisible to Glassdoor itself too, which confirms our extension will have the same blind spot there and should treat it the same way (pending confirmation, not auto-applied).

### General implementation guidance for the content scripts

- Use `MutationObserver` scoped to the relevant container (job page/modal), not `document.body`, to avoid performance issues and excessive noise.
- Match on confirmation **text content**, not just CSS classes, as a resilience layer — class names churn far more often than the actual English confirmation copy ("application sent," "application submitted," etc.).
- Debounce/dedupe: a single application shouldn't be logged twice if the DOM mutates multiple times during the same confirmation event.
- Always capture at minimum: `company`, `title`, `job_url`, `platform_job_id` (if extractable from the URL), `platform`, and whether it was in-platform or external-redirect.
- Because selectors *will* break when these sites update their frontend, isolate all selectors/text-match strings into a single config file per platform (e.g. `extension/src/shared/selectors/linkedin.json`) so fixing a broken detector is a config change, not a code change, and document this expectation clearly in the README for contributors.
- Always provide a manual fallback: a right-click "Mark this job as applied" context menu item and a manual add form in the dashboard, since automatic detection will never be 100% reliable given how these sites work.

## 7. Phased build plan

**Status: all six phases complete — this is the v1.0 roadmap, not an in-progress plan.** Ongoing work past this point is tracked as individual GitHub issues (bug fixes, small enhancements), not new phases. See the README's "Known limitations / post-1.0 backlog" section for the current list.

**Phase 1 — Core tracking, manual entry (no browser automation yet)** — DONE
- SQLite schema (Section 5) and local backend CRUD routes (`/applications` GET/POST/PATCH/DELETE)
- Dashboard: table view, manual add/edit/delete, status dropdown, sort/filter by platform/status/date
- CSV export endpoint + download button
- Acceptance: usable as a fully manual tracker before any extension code exists

**Phase 2 — Browser extension, auto-capture** — DONE
- Indeed content script first (native Indeed Apply flow), then LinkedIn Easy Apply, then Glassdoor Easy Apply
- External-redirect handling on all three: log as `pending_confirmation`, surface for user review in dashboard
- Extension posts to the local backend on the shared default port
- Manual "mark as applied" fallback (context menu + dashboard button)
- Acceptance: applying to a real job in each in-platform flow produces a correct dashboard entry within a few seconds

**Phase 3 — Lifecycle management** — DONE
- Bulk actions: mark stale after N days of no status change (user-configurable threshold), bulk delete rejected
- Filtering/sorting improvements, basic stats (applications per week, response rate)

**Phase 4 — AI resume tailoring** — DONE
- Settings screen: enter Anthropic or OpenAI key, stored in local `.env`/settings file only
- Upload base resume (plain text first; PDF/docx parsing later)
- "Tailor for this job" action on a saved application entry → sends resume + job description to the chosen provider → stores result in `resume_versions` linked to that application

**Phase 5 — ATS-friendly resume template for tailored downloads** — DONE
- AI tailoring output (Phase 4) becomes structured JSON (contact, summary, experience, projects, education, skills) instead of a flat text blob, so a tailored resume has real sections to render into rather than being dumb-dumped into a default-font PDF/DOCX
- One default ATS-approved visual template (centered header, colored section headers with underline rules, right-aligned dates, hanging-indent bullets) applied to every tailored PDF/DOCX download — single column, no tables/images, ATS-parseable
- No attempt to clone the visual layout of the user's originally-uploaded resume — the upload flow still reduces PDFs/DOCX to plain text (Phase 4), so there's no formatting to clone from; a single polished template is used for everyone
- `resume_versions` rows written before this change (flat marker-text or older) keep downloading correctly forever via a legacy-format fallback in the parser — no data migration
- (Google Sheets sync was considered for this slot and dropped: a one-way/on-demand sync requiring the user's own Google Cloud OAuth setup added real engineering cost for little benefit over the existing CSV export + manual upload path.)

**Phase 6 — Polish for distribution** — DONE
- `docker-compose.yml`, clear README with screenshots/GIFs, `SETUP.md`, `ARCHITECTURE.md`
- Document the selector-fragility caveat prominently so contributors know to expect and fix breakage over time

## 8. Open questions from the original plan — resolved

- **Default port and configuration**: `4317` for the backend, `5173` for the dashboard; overridable via `PORT`/`HOST` (backend) and standard Vite config (dashboard). See README's Configuration table.
- **Gmail-based confirmation-email fallback for Indeed**: deferred indefinitely, not just to "a later phase." The extension's own DOM-based detection is the sole detection path; revisit only if a specific need arises.
- **PDF/docx resume parsing library**: `pdf-parse` for PDF text extraction, `mammoth` for `.docx`; tailored resume downloads are rendered via `pdfkit` (PDF) and `docx` (Word) against the structured ATS template from Phase 5.
