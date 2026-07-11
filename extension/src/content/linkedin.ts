import selectors from '../shared/selectors/linkedin.json';
import type { DetectedApplication, RuntimeMessage } from '../shared/types';

// Runs on linkedin.com/jobs/* (see manifest.config.ts).
//
// Detection strategy (per CLAUDE.md §6):
// - Easy Apply is a multi-step modal that opens on top of the job page and
//   ends in a confirmation state ("Your application was sent to <Company>")
//   before closing itself. The initial button click is NOT the signal — the
//   user can cancel partway through a multi-step form — so we watch the modal
//   via MutationObserver and only report once confirmation text appears.
// - Non-Easy-Apply "Apply" opens the employer's own site (new tab or same-tab
//   redirect); LinkedIn loses visibility the moment the user leaves, so the
//   click itself is the only signal we can act on (external_redirect /
//   pending_confirmation).
// - Distinguishing the two: LinkedIn's actual apply control is an <a> with
//   aria-label "Easy Apply to this job" (or similarly worded for external
//   apply). aria-label is used instead of visible text because the search
//   results list also contains "Filter by Easy Apply" filter-chip elements
//   whose visible text also contains "apply" — matching on text alone
//   misfires on those chips. aria-label disambiguates cleanly and is excluded
//   whenever it mentions "filter".
// - Title/company: LinkedIn's current build ships fully hashed, non-semantic
//   CSS class names (e.g. "aa26e2c6") with no <h1> present on the split-pane
//   view, so DOM selectors for these are unreliable. document.title reliably
//   follows "{Job Title} | {Company} | LinkedIn" and is used as the primary
//   source; selector-based lookup is only a last-resort fallback.

function firstMatch(sels: string[]): Element | null {
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function textOf(el: Element | null): string {
  return el?.textContent?.trim() ?? '';
}

function parseFromDocumentTitle(): { title?: string; company?: string } {
  const parts = document.title.split('|').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3 || parts[parts.length - 1].toLowerCase() !== 'linkedin') return {};
  const company = parts[parts.length - 2];
  // Rejoin in case the job title itself contains a '|' character.
  const title = parts.slice(0, parts.length - 2).join(' | ');
  return { title, company };
}

function resolveTitleAndCompany(): { title: string; company: string } {
  const fromTitle = parseFromDocumentTitle();
  return {
    title: fromTitle.title || textOf(firstMatch(selectors.jobTitleSelectors)),
    company: fromTitle.company || textOf(firstMatch(selectors.companySelectors)),
  };
}

function log(...args: unknown[]): void {
  // console.info (not console.debug) — console.debug renders at DevTools'
  // "Verbose" level, which is hidden by default, so those lines were invisible.
  console.info('[Applyt]', ...args);
}

function extractJobId(url: string): string | undefined {
  try {
    const u = new URL(url);
    // Standalone job page: /jobs/view/{jobId}/
    const pathMatch = u.pathname.match(/\/jobs\/view\/(\d+)/);
    if (pathMatch) return pathMatch[1];
    // Search-results split pane: /jobs/search/?currentJobId={jobId}
    return u.searchParams.get('currentJobId') ?? undefined;
  } catch {
    return undefined;
  }
}

function currentJobId(): string | undefined {
  return extractJobId(location.href);
}

// A clean, shareable link to the exact posting, built from the job id.
// Without this we'd save location.href, which on a search-results split-pane
// page is the whole search URL, not a link to the specific job.
function canonicalJobUrl(jobId: string | undefined, fallback: string): string {
  return jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : fallback;
}

interface JobMeta {
  company: string;
  title: string;
  job_url: string;
  jobId?: string;
}

const LAST_VIEWED_KEY = 'linkedinLastViewedJob';
const APPLY_IN_PROGRESS_KEY = 'linkedinApplyInProgress';

function cacheJobMeta(meta: JobMeta): void {
  void chrome.storage.local.set({ [LAST_VIEWED_KEY]: meta });
}

async function getLastViewedJob(): Promise<JobMeta | undefined> {
  const result = await chrome.storage.local.get(LAST_VIEWED_KEY);
  return result[LAST_VIEWED_KEY];
}

// The job the user is actively applying to, frozen at Easy-Apply-click time.
// The Easy Apply modal can take several steps to complete; freezing here means
// the eventual confirmation attributes correctly even if the split-pane detail
// view scrolls to a different job card while the modal is open.
async function setApplyInProgress(meta: JobMeta): Promise<void> {
  await chrome.storage.local.set({ [APPLY_IN_PROGRESS_KEY]: meta });
}

async function getApplyInProgress(): Promise<JobMeta | undefined> {
  const result = await chrome.storage.local.get(APPLY_IN_PROGRESS_KEY);
  return result[APPLY_IN_PROGRESS_KEY];
}

async function clearApplyInProgress(): Promise<void> {
  await chrome.storage.local.remove(APPLY_IN_PROGRESS_KEY);
}

function report(payload: DetectedApplication): void {
  log('reporting detected application', payload);
  const message: RuntimeMessage = { type: 'APPLICATION_DETECTED', payload };
  chrome.runtime.sendMessage(message).catch((err) => {
    // Background service worker may be asleep on first dispatch; MV3 wakes it
    // to handle the message, so a transient send failure is not fatal here.
    log('sendMessage failed (will still likely be delivered on wake)', err);
  });
}

// ---- Step 1: cache metadata from the job detail view ----
// Works for both the standalone job page and the search-results split pane,
// which share the same "top card" component.
function captureJobPageMeta(): void {
  const jobId = currentJobId();
  const { title, company } = resolveTitleAndCompany();

  if (title && company) {
    log('captureJobPageMeta: cached', { jobId, title, company });
    cacheJobMeta({ company, title, job_url: canonicalJobUrl(jobId, location.href), jobId });
  } else {
    log('captureJobPageMeta: title/company not resolved', { jobId, title, company });
  }
}

// ---- Step 2: delegated click detection for both Easy Apply and external Apply ----
// Event delegation on the document (capture phase) is far more resilient to
// LinkedIn's markup churn than pinning specific class/testid selectors (per
// CLAUDE.md §6) — it matches on the button's visible text instead.
let lastClickAt = 0;

// aria-label is checked in preference to visible text: the search results
// list contains "Filter by Easy Apply" filter-chip elements whose visible
// text also contains "apply", which would otherwise misfire as an apply
// click. Any label mentioning "filter" is explicitly excluded.
function classifyApplyClick(el: Element): 'easy_apply' | 'external' | undefined {
  const label = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
  if (!label || label.includes('filter')) return undefined;
  if (selectors.easyApplyTextMatches.some((phrase) => label.includes(phrase))) return 'easy_apply';
  if (selectors.externalApplyTextMatches.some((phrase) => label.includes(phrase))) return 'external';
  // LinkedIn's external-apply control is literally just "Apply" — but that
  // substring also matches "Easy Apply", so only treat an exact "apply" (no
  // other words) as the external case, checked after the easy_apply branch.
  if (label === 'apply') return 'external';
  return undefined;
}

async function reportExternalApply(jobId: string | undefined): Promise<void> {
  let { title, company } = resolveTitleAndCompany();
  let jobUrl = canonicalJobUrl(jobId, location.href);
  let resolvedJobId = jobId;
  if (!title || !company) {
    const last = await getLastViewedJob();
    if (last) {
      title = title || last.title;
      company = company || last.company;
      resolvedJobId = resolvedJobId ?? last.jobId;
      jobUrl = last.job_url ?? jobUrl;
    }
  }
  if (!title || !company) {
    log('external apply click but no title/company resolved — dropping');
    return;
  }

  // No client-side dedupe cache here: the backend upserts on
  // platform+platform_job_id, so a repeat report merges into the existing
  // row instead of duplicating — and, crucially, still re-records correctly
  // if the user deleted that row from the dashboard and applied again.
  report({
    platform: 'linkedin',
    company,
    title,
    job_url: jobUrl,
    platform_job_id: resolvedJobId,
    apply_method: 'external_redirect',
    status: 'pending_confirmation',
  });
}

function attachApplyClickDelegation(): void {
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element | null;
      const el = target?.closest?.('a, button, [role="button"]');
      if (!el) return;
      const kind = classifyApplyClick(el);
      if (!kind) return;

      const now = Date.now();
      if (now - lastClickAt < 3000) return; // debounce accidental double-fire
      lastClickAt = now;

      const jobId = currentJobId();
      if (kind === 'easy_apply') {
        const { title, company } = resolveTitleAndCompany();
        if (!title || !company) {
          log('easy apply click but no title/company resolved — dropping');
          return;
        }
        void setApplyInProgress({
          company,
          title,
          job_url: canonicalJobUrl(jobId, location.href),
          jobId,
        });
        log('applyInProgress set', { jobId, title, company });
      } else {
        log('external apply click detected:', el.getAttribute('aria-label') || el.textContent);
        void reportExternalApply(jobId);
      }
    },
    true, // capture phase — fire before the page's own handler navigates away
  );
}

// ---- Step 3: Easy Apply modal confirmation detection ----
function looksLikeConfirmation(text: string): boolean {
  const lower = text.toLowerCase();
  return selectors.confirmationTextMatches.some((phrase) => lower.includes(phrase));
}

// LinkedIn renders at least part of its current UI (confirmed via a live
// probe: a 'theme--light' shadow host) inside open shadow roots, whose
// content a plain document.querySelectorAll/.textContent from the top-level
// document cannot see, and which MutationObserver does not traverse into
// automatically. Recursively collect every open shadow root reachable from a
// given root so their text/mutations can be checked too. (Closed shadow
// roots are invisible to content scripts entirely — nothing further to do
// if LinkedIn ever switches to those.)
function collectShadowRoots(root: ParentNode, acc: ShadowRoot[] = []): ShadowRoot[] {
  root.querySelectorAll('*').forEach((el) => {
    const sr = (el as HTMLElement).shadowRoot;
    if (sr && !acc.includes(sr)) {
      acc.push(sr);
      collectShadowRoots(sr, acc);
    }
  });
  return acc;
}

function allReachableText(): string {
  let text = document.body.textContent ?? '';
  for (const sr of collectShadowRoots(document)) {
    text += ' ' + (sr.textContent ?? '');
  }
  return text;
}

function observeForConfirmation(): void {
  log('observeForConfirmation: watching document body + shadow roots');

  let handled = false;
  const observedShadowRoots = new Set<ShadowRoot>();

  const tryHandleConfirmation = (): void => {
    if (handled) return;
    if (!looksLikeConfirmation(allReachableText())) return;
    handled = true;
    log('observeForConfirmation: confirmation text matched');

    const jobId = currentJobId();
    void (async () => {
      // Resolve which job this confirmation belongs to, most-trusted first:
      //   1. applyInProgress — frozen when the user clicked Easy Apply; the
      //      reliable signal of intent, immune to split-pane re-scroll.
      //   2. lastViewedJob — best-effort fallback if the click was missed.
      //   3. live DOM scrape — works if the top card is still on screen.
      const cached = (await getApplyInProgress()) ?? (await getLastViewedJob());
      const live = resolveTitleAndCompany();
      const title = cached?.title || live.title;
      const company = cached?.company || live.company;
      if (!title || !company) {
        log('confirmation matched but no title/company resolved — dropping', { jobId, cached });
        // Reset so a later, resolvable confirmation in the same session isn't
        // permanently blocked by this one unresolved attempt.
        handled = false;
        return;
      }

      const resolvedJobId = jobId ?? cached?.jobId;

      // No client-side dedupe cache: the backend upserts on
      // platform+platform_job_id, so a repeat report merges into the
      // existing row instead of duplicating, and still re-records correctly
      // if the user deleted that row from the dashboard and applied again.
      report({
        platform: 'linkedin',
        company,
        title,
        job_url: cached?.job_url ?? canonicalJobUrl(resolvedJobId, location.href),
        platform_job_id: resolvedJobId,
        apply_method: 'in_platform',
        status: 'applied',
      });

      // The application is recorded — this apply flow is done. Clear the
      // frozen record so it can't leak into an unrelated confirmation later.
      await clearApplyInProgress();
    })();
  };

  const mutationOpts: MutationObserverInit = { childList: true, subtree: true, characterData: true };

  const attachShadowObservers = (): void => {
    for (const sr of collectShadowRoots(document)) {
      if (observedShadowRoots.has(sr)) continue;
      observedShadowRoots.add(sr);
      log('observeForConfirmation: attaching to newly discovered shadow root', sr.host.tagName);
      new MutationObserver(() => tryHandleConfirmation()).observe(sr, mutationOpts);
    }
  };

  attachShadowObservers();
  new MutationObserver(() => {
    tryHandleConfirmation();
    // The modal (or its confirmation state) may attach a fresh shadow host
    // dynamically, so re-scan for new shadow roots on every body mutation.
    attachShadowObservers();
  }).observe(document.body, mutationOpts);

  // Catch the case where the confirmation is already present on initial load.
  tryHandleConfirmation();
}

// Manual "mark as applied" fallback, triggered via the background script's
// context menu item (see background/service-worker.ts).
function attachManualMarkListener(): void {
  chrome.runtime.onMessage.addListener((message: { type: string }) => {
    if (message.type !== 'EXTRACT_CURRENT_JOB') return;

    const jobId = currentJobId();
    const { title, company } = resolveTitleAndCompany();
    if (!title || !company) return;

    report({
      platform: 'linkedin',
      company,
      title,
      job_url: canonicalJobUrl(jobId, location.href),
      platform_job_id: jobId,
      apply_method: 'manual',
      status: 'applied',
    });
  });
}

function init(): void {
  log('content script loaded', location.href);
  captureJobPageMeta();
  attachApplyClickDelegation();
  attachManualMarkListener();
  observeForConfirmation();

  // LinkedIn is a heavy client-side-routed SPA — job views change without a
  // full page load, so re-run capture on history changes to keep the cached
  // metadata current. The click delegation and modal observer are already
  // document-level and survive this navigation without rebinding.
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      captureJobPageMeta();
    }
  }).observe(document.body, { childList: true, subtree: true });
}

init();
