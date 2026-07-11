import selectors from '../shared/selectors/indeed.json';
import { createLogger } from '../shared/debug';
import type { DetectedApplication, RuntimeMessage } from '../shared/types';

// Runs on *.indeed.com and smartapply.indeed.com (see manifest.config.ts).
//
// Detection strategy (per CLAUDE.md §6):
// - On an indeed.com job page, cache the job's title/company/jk so that when
//   the user later lands on the confirmation screen (possibly on a different
//   subdomain/tab), we still have the metadata to report.
// - When the user clicks the in-platform "Apply now" button, freeze *that*
//   specific job as the application-in-progress. This is the reliable signal
//   of which job is being applied to — unlike "last viewed", it can't be
//   clobbered by Indeed navigating to recommended jobs after submission.
// - External "Apply on company site" links are logged immediately as
//   pending_confirmation on click — Indeed itself loses visibility the
//   moment the user leaves, so we can't do better than "they clicked".
// - In-platform submissions (Indeed Apply / smartapply.indeed.com) are only
//   logged once we observe the confirmation screen's text content, since the
//   flow is a multi-step form the user can abandon partway through.

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

const log = createLogger('[Applyt]');

function extractJobKey(url: string): string | undefined {
  try {
    const params = new URL(url).searchParams;
    // 'jk' on a direct /viewjob page; 'vjk' on the search-results split-pane view.
    return params.get('jk') ?? params.get('vjk') ?? undefined;
  } catch {
    return undefined;
  }
}

function currentJobKey(): string | undefined {
  return extractJobKey(location.href);
}

// A clean, shareable link to the exact posting, built from the job key. Without
// this we'd save location.href, which on a search-results page is the whole
// search URL (not a link to the specific job the user applied to).
function canonicalJobUrl(jk: string | undefined, fallback: string): string {
  return jk ? `https://www.indeed.com/viewjob?jk=${jk}` : fallback;
}

interface JobMeta {
  company: string;
  title: string;
  job_url: string;
  jk?: string;
}

const LAST_VIEWED_KEY = 'lastViewedJob';
const APPLY_IN_PROGRESS_KEY = 'applyInProgress';

function cacheJobMeta(meta: JobMeta): void {
  const entries: Record<string, JobMeta> = { [LAST_VIEWED_KEY]: meta };
  // Also keep a jk-keyed copy so a later confirmation that *does* know the jk
  // (e.g. re-applying from a job page) resolves the exact posting.
  if (meta.jk) entries[`jobMeta:${meta.jk}`] = meta;
  void chrome.storage.local.set(entries);
}

async function getCachedJobMeta(jk: string): Promise<JobMeta | undefined> {
  const key = `jobMeta:${jk}`;
  const result = await chrome.storage.local.get(key);
  return result[key];
}

// The apply form and confirmation live on smartapply.indeed.com, whose URL has
// no jk and whose DOM is not the Indeed job page. So the confirmation frame
// falls back to the most recently viewed job to recover company/title/jk.
async function getLastViewedJob(): Promise<JobMeta | undefined> {
  const result = await chrome.storage.local.get(LAST_VIEWED_KEY);
  return result[LAST_VIEWED_KEY];
}

// The job the user is actively applying to, frozen at Apply-button-click time.
// This is the primary source the confirmation frame trusts — it reflects the
// user's explicit intent and survives later same-company navigation.
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

// If the user navigates to a *different* posting than the one we were mid-apply
// on, that in-progress record is stale (the earlier apply was abandoned). Drop
// it so a later confirmation can't attribute the application to the wrong job.
async function clearStaleApplyInProgress(currentJk: string | undefined): Promise<void> {
  if (!currentJk) return;
  const inProgress = await getApplyInProgress();
  if (inProgress?.jk && inProgress.jk !== currentJk) {
    await chrome.storage.local.remove(APPLY_IN_PROGRESS_KEY);
    log('cleared stale applyInProgress', inProgress.jk, '→ now viewing', currentJk);
  }
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

// ---- Step 1: cache metadata from the job posting page ----
// Only meaningful on indeed.com job pages; the smartapply frame has no job
// DOM, so title/company simply won't be found there and we skip caching.
function captureJobPageMeta(): void {
  const jk = currentJobKey();
  const title = textOf(firstMatch(selectors.jobTitleSelectors));
  const company = textOf(firstMatch(selectors.companySelectors));

  if (title && company) {
    log('captureJobPageMeta: cached', { jk, title, company });
    cacheJobMeta({ company, title, job_url: canonicalJobUrl(jk, location.href), jk });
    void clearStaleApplyInProgress(jk);
  } else if (jk) {
    log('captureJobPageMeta: title/company selectors did not match', { jk, title, company });
  }
}

// ---- Step 2a: in-platform "Apply now" clicks ----
// Freeze which job the user is applying to at the moment they click Apply, so
// the confirmation (which fires later, in the smartapply iframe) attributes the
// application to the correct posting rather than whatever was viewed last.
function attachInPlatformApplyListener(): void {
  const jk = currentJobKey();
  let bound = 0;
  for (const sel of selectors.inPlatformApplyButtonSelectors) {
    document.querySelectorAll<HTMLElement>(sel).forEach((btn) => {
      if (btn.dataset.applytApplyBound) return;
      btn.dataset.applytApplyBound = 'true';
      bound += 1;
      btn.addEventListener('click', () => {
        const title = textOf(firstMatch(selectors.jobTitleSelectors));
        const company = textOf(firstMatch(selectors.companySelectors));
        if (!title || !company) return;
        void setApplyInProgress({
          company,
          title,
          job_url: canonicalJobUrl(jk, location.href),
          jk,
        });
        log('applyInProgress set', { jk, title, company });
      });
    });
  }
  if (bound > 0) log('attachInPlatformApplyListener: bound', bound, 'button(s)');
}

// ---- Step 2b: external "Apply on company site" clicks ----
// Unlike in-platform applies, an external redirect has NO confirmation we can
// observe — the user leaves Indeed for the employer's site — so the click is
// the only signal. Detect it by the button's *text* via delegation on the
// document, which is far more resilient to Indeed's markup churn than pinning
// specific class/testid selectors (per CLAUDE.md §6), and works whether the
// button is on the job page or inside an apply iframe (all_frames runs us in
// every frame).
let lastExternalClickAt = 0;

async function reportExternalApply(jk: string | undefined): Promise<void> {
  // Prefer the live job-page DOM; fall back to the last viewed job for the
  // iframe case, where the button has no job DOM and the URL has no jk.
  let title = textOf(firstMatch(selectors.jobTitleSelectors));
  let company = textOf(firstMatch(selectors.companySelectors));
  let jobUrl = canonicalJobUrl(jk, location.href);
  let resolvedJk = jk;
  if (!title || !company) {
    const last = await getLastViewedJob();
    if (last) {
      title = title || last.title;
      company = company || last.company;
      resolvedJk = resolvedJk ?? last.jk;
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
    platform: 'indeed',
    company,
    title,
    job_url: jobUrl,
    platform_job_id: resolvedJk,
    apply_method: 'external_redirect',
    status: 'pending_confirmation',
  });
}

function attachExternalApplyDelegation(): void {
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element | null;
      const el = target?.closest?.('a, button, [role="button"]');
      if (!el) return;
      const text = (el.textContent ?? '').trim().toLowerCase();
      if (!text) return;
      if (!selectors.externalApplyTextMatches.some((phrase) => text.includes(phrase))) return;

      const now = Date.now();
      if (now - lastExternalClickAt < 3000) return; // debounce accidental double-fire
      lastExternalClickAt = now;

      log('external apply click detected via text:', text);
      void reportExternalApply(currentJobKey());
    },
    true, // capture phase — fire before the page's own handler navigates away
  );
}

// ---- Step 3: in-platform confirmation detection (smartapply + in-page modal) ----
function looksLikeConfirmation(text: string): boolean {
  const lower = text.toLowerCase();
  return selectors.confirmationTextMatches.some((phrase) => lower.includes(phrase));
}

function observeForConfirmation(): void {
  const container = firstMatch(selectors.confirmationContainerSelectors) ?? document.body;
  log('observeForConfirmation: watching container', container, 'in frame', location.href);

  // in-flight lock, NOT a one-shot "already handled this page" latch: it's
  // held only for the duration of processing a single match, then released —
  // so a later, genuinely different Apply click (fresh applyInProgress) on
  // the same long-lived page (e.g. a search-results listing) can still be
  // caught.
  let processing = false;
  const tryHandleConfirmation = (): void => {
    if (processing) return;
    if (!looksLikeConfirmation(container.textContent ?? '')) return;
    processing = true; // set synchronously, before any await, to close the race window

    void (async () => {
      try {
        // Requiring applyInProgress is deliberate and load-bearing: on a
        // long-lived listing page, confirmation-like text can linger or
        // reappear (a toast that faded but stayed in the DOM, an unrelated
        // re-render) long after the real apply completed. Falling back to
        // jk-cache/"last viewed job" here — merely having viewed a job, not
        // applied to it — caused a real Glassdoor application to be
        // misattributed to unrelated jobs viewed afterward; the same
        // architecture is used here, so the same fix applies. jk-keyed cache
        // is still used to fill in details applyInProgress might be missing
        // (e.g. a canonical jk when the click happened off the job page),
        // but is no longer a substitute for a genuine in-flight click. See
        // extension-detection-notes memory for the live incident this fixes.
        const applyState = await getApplyInProgress();
        if (!applyState) {
          log('confirmation-like text seen but no in-flight apply click — ignoring');
          return;
        }

        const jk = currentJobKey();
        const cachedByJk = jk ? await getCachedJobMeta(jk) : undefined;
        const title = applyState.title || cachedByJk?.title;
        const company = applyState.company || cachedByJk?.company;
        if (!title || !company) {
          log('confirmation matched but no title/company resolved — dropping', {
            jk,
            applyState,
            cachedByJk,
          });
          return;
        }

        const resolvedJk = jk ?? applyState.jk ?? cachedByJk?.jk;

        // No client-side dedupe cache: the backend upserts on
        // platform+platform_job_id, so a repeat report merges into the
        // existing row instead of duplicating, and still re-records correctly
        // if the user deleted that row from the dashboard and applied again.
        report({
          platform: 'indeed',
          company,
          title,
          job_url: applyState.job_url ?? canonicalJobUrl(resolvedJk, location.href),
          platform_job_id: resolvedJk,
          apply_method: 'in_platform',
          status: 'applied',
        });

        // The application is recorded — this apply flow is done. Clear the frozen
        // record so it can't leak into an unrelated confirmation later.
        await clearApplyInProgress();
      } finally {
        processing = false;
      }
    })();
  };

  const observer = new MutationObserver(() => tryHandleConfirmation());
  observer.observe(container, { childList: true, subtree: true, characterData: true });

  // Catch the case where the confirmation is already present on initial load.
  tryHandleConfirmation();
}

// Manual "mark as applied" fallback, triggered via the background script's
// context menu item (see background/service-worker.ts).
function attachManualMarkListener(): void {
  chrome.runtime.onMessage.addListener((message: { type: string }) => {
    if (message.type !== 'EXTRACT_CURRENT_JOB') return;

    const jk = currentJobKey();
    const title = textOf(firstMatch(selectors.jobTitleSelectors));
    const company = textOf(firstMatch(selectors.companySelectors));
    if (!title || !company) return;

    report({
      platform: 'indeed',
      company,
      title,
      job_url: canonicalJobUrl(jk, location.href),
      platform_job_id: jk,
      apply_method: 'manual',
      status: 'applied',
    });
  });
}

function init(): void {
  log('content script loaded in frame', location.href);
  captureJobPageMeta();
  attachInPlatformApplyListener();
  attachExternalApplyDelegation();
  attachManualMarkListener();
  observeForConfirmation();

  // Indeed's job page and search-results detail pane re-render via
  // client-side navigation without a full page load, so re-run capture on
  // history changes to keep the cached metadata and listeners current.
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      captureJobPageMeta();
      attachInPlatformApplyListener();
      // External-apply detection is a document-level delegated listener
      // attached once in init(); it survives SPA navigation, no rebind needed.
    }
  }).observe(document.body, { childList: true, subtree: true });
}

init();
