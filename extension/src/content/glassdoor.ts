import selectors from '../shared/selectors/glassdoor.json';
import { createLogger } from '../shared/debug';
import type { DetectedApplication, RuntimeMessage } from '../shared/types';

// Runs on glassdoor.com job pages AND smartapply.indeed.com (see
// manifest.config.ts) — Glassdoor is Indeed-owned, and per CLAUDE.md §6 its
// Easy Apply flow for synced profiles runs through Indeed's own smartapply
// form under the hood, so the actual confirmation may render in that iframe
// rather than on glassdoor.com itself. This script therefore mirrors two
// patterns already verified live on other platforms rather than one:
// - indeed.ts's smartapply-iframe bridge: cache job metadata on the
//   glassdoor.com job page (glassdoorLastViewedJob / glassdoorApplyInProgress
//   in chrome.storage.local), then resolve from that cache when confirmation
//   is observed in the smartapply.indeed.com frame, which has no Glassdoor
//   job DOM at all.
// - linkedin.ts's aria-label click classification and shadow-DOM-aware
//   confirmation watcher, in case Glassdoor instead shows its own native
//   in-page confirmation (unconfirmed which path synced-profile Easy Apply
//   actually takes without live testing).
//
// UNVERIFIED: none of this has been tested against a real Glassdoor posting
// yet (see shared/selectors/glassdoor.json). Expect a round of live-DOM-probe
// fixes here, same as LinkedIn needed.

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

function resolveTitleAndCompany(): { title: string; company: string } {
  return {
    title: textOf(firstMatch(selectors.jobTitleSelectors)),
    company: textOf(firstMatch(selectors.companySelectors)),
  };
}

const log = createLogger('[Applyt]');

function extractListingId(url: string): string | undefined {
  try {
    const params = new URL(url).searchParams;
    return params.get('jl') ?? params.get('jobListingId') ?? params.get('jl_id') ?? undefined;
  } catch {
    return undefined;
  }
}

// Verified live 2026-07-11: the jobs split-pane view's URL has NO job
// identifier at all (e.g. 'glassdoor.ca/Job/index.htm') — the open job lives
// purely in client-side state. The listing id is recoverable from the detail
// pane's title element, whose id follows 'jd-job-title-{listingId}'. This is
// deliberately NOT 'job-employer-{id}' (which exists only on the left-list
// cards and returns the FIRST card, not the open job — the wrong-job bug).
function extractListingIdFromDom(): string | undefined {
  const el = document.querySelector('[id^="jd-job-title-"]');
  return el?.id.match(/jd-job-title-(\d+)/)?.[1];
}

function currentListingId(): string | undefined {
  return extractListingId(location.href) ?? extractListingIdFromDom();
}

// The jobs split-pane recommendations view never changes location.href when
// a different card is opened, so location.href is useless as a job-specific
// link there — it just points back at the generic search page. As a
// best-effort substitute, reconstruct a link to the employer's own jobs tab
// from the detail pane's employer-profile anchor. Verified live 2026-07-11:
// the anchor's id IS the employer id ('E{id}' in Glassdoor's own jobs-tab
// URLs), and its href's slug ('Working-at-{slug}-EI_IE{id}...') matches the
// slug in a real jobs-tab URL the user confirmed working
// ('/Jobs/{slug}-Jobs-E{id}.htm'). Not guaranteed to generalize to every
// company name, but a broken link is a far smaller risk than the wrong-job
// data-correctness bugs already fixed elsewhere in this file — falls back to
// location.href if the anchor isn't found.
function extractCompanyJobsTabUrl(title: string): string | undefined {
  const link = document.querySelector<HTMLAnchorElement>(
    '[class*="JobDetails_employerAndJobTitle"] a[href*="/Overview/"]',
  );
  if (!link) return undefined;
  const employerId = link.id;
  const slugMatch = link.getAttribute('href')?.match(/Working-at-(.+)-EI_IE\d+/);
  if (!employerId || !slugMatch) return undefined;
  const base = `${location.origin}/Jobs/${slugMatch[1]}-Jobs-E${employerId}.htm`;
  if (!title) return base;
  // Filters the jobs tab to this exact title, verified live 2026-07-11
  // (URLSearchParams' form-encoding matches Glassdoor's own %2F/+/%26
  // pattern exactly). Best-effort only: the posting may have been filled or
  // removed by the time the user opens this link, in which case the filter
  // just returns an empty list — still better than an unfiltered jobs tab.
  const params = new URLSearchParams({ 'filter.jobTitleExact': title });
  return `${base}?${params.toString()}`;
}

// A direct link to the exact posting's Glassdoor detail view. Verified live
// 2026-07-11: the minimal '/job-listing/j?jl={listingId}' form resolves to
// the correct posting on its own — the slug, 'IC{locationId}', and 'KO,KE'
// character offsets that appear in Glassdoor's own canonical URLs are SEO
// decoration and are NOT required. Built from location.origin (NOT the
// '/job-listing/' anchors in the DOM, which point at locale subdomains like
// fr.glassdoor.ca and are the left-list cards, not the open job).
function soloJobListingUrl(listingId: string | undefined): string | undefined {
  if (!listingId) return undefined;
  return `${location.origin}/job-listing/j?jl=${listingId}`;
}

// Fallback link (company's Glassdoor jobs tab, filtered to this title) used
// only when a listing id can't be resolved, so a direct posting link can't
// be built. Kept as a degradation path for exactJobUrl below.
function companyJobsTabUrl(): string {
  const { title } = resolveTitleAndCompany();
  return extractCompanyJobsTabUrl(title) ?? location.href;
}

// The exact-posting link, used for every apply method (Easy Apply, external
// redirect, and manual). The '/job-listing/j?jl={id}' detail view resolves
// for any job with a listing id; degrades to the company jobs tab, then the
// raw page URL, if the listing id or employer anchor can't be resolved.
function exactJobUrl(listingId: string | undefined): string {
  return soloJobListingUrl(listingId) ?? companyJobsTabUrl();
}

interface JobMeta {
  company: string;
  title: string;
  job_url: string;
  listingId?: string;
  job_description?: string;
}

// Job description text, captured so the user doesn't have to paste it in
// manually before using AI resume tailoring (Phase 4, CLAUDE.md §7).
function currentJobDescription(): string | undefined {
  return textOf(firstMatch(selectors.jobDescriptionSelectors)) || undefined;
}

const LAST_VIEWED_KEY = 'glassdoorLastViewedJob';
const APPLY_IN_PROGRESS_KEY = 'glassdoorApplyInProgress';

function cacheJobMeta(meta: JobMeta): void {
  void chrome.storage.local.set({ [LAST_VIEWED_KEY]: meta });
}

async function getLastViewedJob(): Promise<JobMeta | undefined> {
  const result = await chrome.storage.local.get(LAST_VIEWED_KEY);
  return result[LAST_VIEWED_KEY];
}

// The job the user is actively applying to, frozen at Easy-Apply-click time —
// the reliable signal of intent, immune to later navigation (per the Indeed
// "wrong posting saved" fix; see extension-detection-notes memory).
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

// ---- Step 1: cache metadata from the job page ----
// Only meaningful on glassdoor.com; the smartapply.indeed.com frame has no
// Glassdoor job DOM, so these selectors simply won't match there and nothing
// gets cached from that frame (harmless no-op).
function captureJobPageMeta(): void {
  const listingId = currentListingId();
  const { title, company } = resolveTitleAndCompany();

  if (title && company) {
    const job_description = currentJobDescription();
    log('captureJobPageMeta: cached', {
      listingId,
      title,
      company,
      hasDescription: Boolean(job_description),
    });
    // This cache is consumed only as a title/company/listingId fallback by the
    // external-redirect path; its job_url isn't used there (that path rebuilds
    // the URL from the resolved listing id), so exactJobUrl is fine here too.
    cacheJobMeta({ company, title, job_url: exactJobUrl(listingId), listingId, job_description });
  } else {
    log('captureJobPageMeta: title/company not resolved', { listingId, title, company });
  }
}

// ---- Step 2: delegated click detection for both Easy Apply and external Apply ----
// aria-label preferred over visible text (per the LinkedIn fix — a lesson
// worth applying here proactively rather than waiting to hit the same trap):
// job-list filter/save controls can contain "apply"-adjacent visible text.
let lastClickAt = 0;

function classifyApplyClick(el: Element): 'easy_apply' | 'external' | undefined {
  // Prefer the stable data-test hook Glassdoor puts on the detail-pane Easy
  // Apply button (verified live) — more robust than button text/label, which
  // is why it's checked first.
  if (el.closest('[data-test="easyApply"]')) return 'easy_apply';
  const label = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
  if (!label || label.includes('filter')) return undefined;
  if (selectors.easyApplyTextMatches.some((phrase) => label.includes(phrase))) return 'easy_apply';
  if (selectors.externalApplyTextMatches.some((phrase) => label.includes(phrase))) return 'external';
  return undefined;
}

async function reportExternalApply(listingId: string | undefined): Promise<void> {
  let { title, company } = resolveTitleAndCompany();
  let jobDescription = currentJobDescription();
  let resolvedListingId = listingId;
  if (!title || !company) {
    const last = await getLastViewedJob();
    if (last) {
      title = title || last.title;
      company = company || last.company;
      resolvedListingId = resolvedListingId ?? last.listingId;
      jobDescription = jobDescription || last.job_description;
    }
  }
  if (!title || !company) {
    log('external apply click but no title/company resolved — dropping');
    return;
  }

  // External-redirect jobs get a link to their exact Glassdoor posting too:
  // viewing the '/job-listing/j?jl={id}' detail page shows Glassdoor's own
  // posting (the off-site bounce only happens on apply-click, not on view),
  // so it's more precise than the company jobs tab. Degrades to the company
  // jobs tab, then location.href, if no listing id is resolvable.
  const jobUrl = exactJobUrl(resolvedListingId);

  // No client-side dedupe cache: the backend upserts on
  // platform+platform_job_id, so a repeat report merges into the existing
  // row instead of duplicating, and still re-records correctly if the user
  // deleted that row from the dashboard and applied again.
  report({
    platform: 'glassdoor',
    company,
    title,
    job_url: jobUrl,
    platform_job_id: resolvedListingId,
    apply_method: 'external_redirect',
    status: 'pending_confirmation',
    job_description: jobDescription,
  });
}

function attachApplyClickDelegation(): void {
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element | null;
      const el = target?.closest?.('a, button, [role="button"]');
      if (!el) return;

      // Diagnostic: log every apply-adjacent click regardless of outcome, so
      // it's visible in the console whether a click was even seen and how it
      // was classified — this is the exact gap that made LinkedIn's silent
      // classification failure hard to debug (see extension-detection-notes
      // memory). Narrowed to elements whose label mentions "apply" so this
      // doesn't spam every unrelated click on the page.
      const rawLabel = (el.getAttribute('aria-label') || el.textContent || '').trim();
      const kind = classifyApplyClick(el);
      if (/apply/i.test(rawLabel)) {
        log('apply-adjacent click seen', { rawLabel, classifiedAs: kind ?? '(none — ignored)' });
      }
      if (!kind) return;

      const now = Date.now();
      if (now - lastClickAt < 3000) {
        log('apply click debounced (fired again within 3s), skipping', kind);
        return;
      }
      lastClickAt = now;

      const listingId = currentListingId();
      if (kind === 'easy_apply') {
        const { title, company } = resolveTitleAndCompany();
        if (!title || !company) {
          log('easy apply click but no title/company resolved — dropping');
          return;
        }
        void setApplyInProgress({
          company,
          title,
          job_url: exactJobUrl(listingId),
          listingId,
          job_description: currentJobDescription(),
        });
        log('applyInProgress set', { listingId, title, company });
      } else {
        log('external apply click detected:', el.getAttribute('aria-label') || el.textContent);
        void reportExternalApply(listingId);
      }
    },
    true, // capture phase — fire before the page's own handler navigates away
  );
}

// ---- Step 3: confirmation detection (glassdoor.com native OR smartapply.indeed.com) ----
function looksLikeConfirmation(text: string): boolean {
  const lower = text.toLowerCase();
  return selectors.confirmationTextMatches.some((phrase) => lower.includes(phrase));
}

// Same shadow-DOM-aware approach that fixed LinkedIn's confirmation
// detection — applied proactively here since Glassdoor's actual markup is
// unverified and could have the same trap.
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
  log('observeForConfirmation: watching document body + shadow roots in', location.hostname);

  // in-flight lock, NOT a one-shot "already handled this page" latch: it's
  // held only for the duration of processing a single match, then released —
  // so a later, genuinely different Easy Apply click (fresh applyInProgress)
  // on the same long-lived page can still be caught.
  let processing = false;
  const observedShadowRoots = new Set<ShadowRoot>();

  const tryHandleConfirmation = (): void => {
    if (processing) return;
    if (!looksLikeConfirmation(allReachableText())) return;
    processing = true; // set synchronously, before any await, to close the race window

    void (async () => {
      try {
        // Requiring applyInProgress is deliberate and load-bearing: on a
        // long-lived recommendations/search page, confirmation-like text can
        // linger or reappear (a toast that faded but stayed in the DOM, an
        // unrelated re-render) long after the real apply completed. Falling
        // back to "last viewed job" here — merely browsing, not applying —
        // caused real applications to be misattributed to whatever job the
        // user happened to be looking at when the stray match fired. See
        // extension-detection-notes memory for the live incident this fixes.
        const applyState = await getApplyInProgress();
        if (!applyState) {
          log('confirmation-like text seen but no in-flight apply click — ignoring');
          return;
        }

        const listingId = currentListingId() ?? applyState.listingId;

        // No client-side dedupe cache: the backend upserts on
        // platform+platform_job_id, so a repeat report merges into the
        // existing row instead of duplicating, and still re-records
        // correctly if the user deleted that row from the dashboard and
        // applied again.
        report({
          platform: 'glassdoor',
          company: applyState.company,
          title: applyState.title,
          job_url: applyState.job_url,
          platform_job_id: listingId,
          apply_method: 'in_platform',
          status: 'applied',
          job_description: applyState.job_description,
        });

        // The application is recorded — this apply flow is done. Clear the
        // frozen record so it can't leak into an unrelated confirmation later.
        await clearApplyInProgress();
      } finally {
        processing = false;
      }
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
// context menu item (see background/service-worker.ts). Only meaningful on
// glassdoor.com — the smartapply iframe has no job DOM to extract from and
// isn't a page the user would right-click on directly.
function attachManualMarkListener(): void {
  chrome.runtime.onMessage.addListener((message: { type: string }) => {
    if (message.type !== 'EXTRACT_CURRENT_JOB') return;

    const listingId = currentListingId();
    const { title, company } = resolveTitleAndCompany();
    if (!title || !company) return;

    report({
      platform: 'glassdoor',
      company,
      title,
      job_url: exactJobUrl(listingId),
      platform_job_id: listingId,
      apply_method: 'manual',
      status: 'applied',
      job_description: currentJobDescription(),
    });
  });
}

function init(): void {
  log('content script loaded', location.href);
  captureJobPageMeta();
  attachApplyClickDelegation();
  attachManualMarkListener();
  observeForConfirmation();

  // Glassdoor's job page is client-side-routed — job views change without a
  // full page load, so re-run capture on history changes to keep the cached
  // metadata current. The click delegation and confirmation observer are
  // already document-level and survive this navigation without rebinding.
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      captureJobPageMeta();
    }
  }).observe(document.body, { childList: true, subtree: true });
}

init();
