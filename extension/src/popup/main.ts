import {
  createPendingApplication,
  getSettings,
  tailorApplication,
  downloadResumeVersion,
  type ResumeDownloadFormat,
} from '../shared/backend';
import { triggerBlobDownload } from '../shared/download';
import { parseTailoredResume } from '../shared/tailoredResume';
import type { CurrentJobResponse, CurrentJobInfo, ResumeVersionResult } from '../shared/types';

// Default dashboard dev URL (dashboard/vite.config.ts). Not user-configurable
// yet — add a settings screen if/when the dashboard's own port becomes
// user-configurable beyond VITE dev defaults.
const DASHBOARD_URL = 'http://localhost:5173';

// ---- Element handles ----
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const statusEl = $('status');
const jobEl = $('job');
const jobTitleEl = $('job-title');
const jobCompanyEl = $('job-company');
const controlsEl = $('controls');
const controlsHintEl = $('controls-hint');
const optRating = $<HTMLInputElement>('opt-rating');
const optSuggestions = $<HTMLInputElement>('opt-suggestions');
const optOnePage = $<HTMLInputElement>('opt-one-page');
const tailorBtn = $<HTMLButtonElement>('tailor-btn');
const resultsEl = $('results');
const matchEl = $('match');
const matchStarsEl = $('match-stars');
const matchJustificationEl = $('match-justification');
const resumeEl = $<HTMLTextAreaElement>('resume');
const copyBtn = $<HTMLButtonElement>('copy-btn');
const downloadPdfBtn = $<HTMLButtonElement>('download-pdf-btn');
const downloadDocxBtn = $<HTMLButtonElement>('download-docx-btn');
const downloadTxtBtn = $<HTMLButtonElement>('download-txt-btn');
const suggestionsEl = $('suggestions');
const suggestionsBodyEl = $('suggestions-body');
const usageEl = $('usage');

$('open-dashboard').addEventListener('click', (e) => {
  e.preventDefault();
  void chrome.tabs.create({ url: DASHBOARD_URL });
});

// The job resolved from the active tab, and the pending application it was saved
// as (cached so "Generate new version" reuses the same row rather than risking a
// duplicate when a posting has no platform_job_id to upsert on).
let currentJob: CurrentJobInfo | null = null;
let pendingApplicationId: number | null = null;
// The version currently rendered in the results section — downloads act on
// this one (every version is downloadable in any format, not just whatever
// was chosen when it was generated, mirroring the dashboard's Tailor modal).
let currentVersion: ResumeVersionResult | null = null;

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.hidden = false;
  statusEl.classList.toggle('error', isError);
}

// Ask the active tab's content script for the job currently on screen. Targets
// the top frame so Indeed's smartapply iframe can't answer instead of the job
// page. Rejects/returns null on any page without a resolvable job posting.
async function fetchCurrentJob(): Promise<CurrentJobInfo | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    const res = (await chrome.tabs.sendMessage(
      tab.id,
      { type: 'GET_CURRENT_JOB' },
      { frameId: 0 },
    )) as CurrentJobResponse;
    return res ?? null;
  } catch {
    // No content script on this page (not a supported job site), or no frame
    // answered — treated the same as "no job here".
    return null;
  }
}

// Design system: amber-800 filled star / matcha-200 outline star (matches the
// dashboard TailorModal's MatchStars), plus an "N/5 Match Rating" label.
const STAR_FILLED =
  '<svg viewBox="0 0 24 24" fill="currentColor" class="w-[15px] h-[15px] text-amber-800"><path d="M8.243 7.34l-6.38 .925l-.113 .023a1 1 0 0 0 -.44 1.684l4.622 4.499l-1.09 6.355l-.013 .11a1 1 0 0 0 1.464 .944l5.706 -3l5.693 3l.1 .046a1 1 0 0 0 1.352 -1.1l-1.091 -6.355l4.624 -4.5l.078 -.085a1 1 0 0 0 -.633 -1.62l-6.38 -.926l-2.852 -5.78a1 1 0 0 0 -1.794 0l-2.853 5.78z"/></svg>';
const STAR_OUTLINE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-[15px] h-[15px] text-matcha-200"><path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873l-6.158 -3.245"/></svg>';

function renderStars(rating: number): void {
  const filled = Math.max(0, Math.min(5, rating));
  const stars = Array.from({ length: 5 }, (_, i) => (i < filled ? STAR_FILLED : STAR_OUTLINE)).join('');
  matchStarsEl.innerHTML = `<span class="flex items-center gap-0.5">${stars}</span><span class="text-[12px] font-medium text-amber-800">${filled}/5</span>`;
}

function formatCost(cost: number | null): string {
  if (cost === null || cost === undefined) return 'cost unknown';
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function usageSummary(v: ResumeVersionResult): string {
  const tokens =
    v.input_tokens != null && v.output_tokens != null
      ? `${v.input_tokens.toLocaleString()} in / ${v.output_tokens.toLocaleString()} out tokens`
      : null;
  return [v.model, tokens, formatCost(v.cost)].filter(Boolean).join(' · ');
}

// Strips characters that aren't filesystem-safe on Windows/macOS/Linux,
// collapsing runs of them to a single hyphen. Mirrors the dashboard's
// TailorModal.tsx sanitizeFilenamePart.
function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'resume';
}

function renderResult(version: ResumeVersionResult): void {
  currentVersion = version;
  const sections = parseTailoredResume(version.tailored_output ?? '');

  if (sections.matchRating !== null || sections.matchJustification) {
    matchEl.hidden = false;
    matchStarsEl.innerHTML = '';
    if (sections.matchRating !== null) renderStars(sections.matchRating);
    matchJustificationEl.textContent = sections.matchJustification;
  } else {
    matchEl.hidden = true;
  }

  resumeEl.value = sections.resume;

  if (sections.suggestions) {
    suggestionsEl.hidden = false;
    suggestionsBodyEl.textContent = sections.suggestions;
  } else {
    suggestionsEl.hidden = true;
  }

  usageEl.textContent = usageSummary(version);
  resultsEl.hidden = false;
}

async function handleTailor(): Promise<void> {
  if (!currentJob) return;
  tailorBtn.disabled = true;
  tailorBtn.textContent = 'Generating…';
  setStatus('Tailoring your resume — this can take a few seconds…');
  try {
    // Create (or reuse) the pending application this tailored resume attaches
    // to, mirroring the external-redirect flow: it's tracked as not-yet-applied
    // and the existing detection machinery promotes it to 'applied' if the user
    // completes an Easy Apply.
    if (pendingApplicationId === null) {
      const app = await createPendingApplication(currentJob);
      pendingApplicationId = app.id;
    }
    const version = await tailorApplication(pendingApplicationId, {
      includeMatchRating: optRating.checked,
      includeSuggestions: optSuggestions.checked,
      targetOnePage: optOnePage.checked,
    });
    renderResult(version);
    setStatus('Saved as a pending application — confirm it in the dashboard after you apply.');
  } catch (err) {
    setStatus(err instanceof Error ? err.message : 'Failed to tailor resume.', true);
  } finally {
    tailorBtn.disabled = false;
    tailorBtn.textContent = 'Generate new version';
  }
}

copyBtn.addEventListener('click', () => {
  void navigator.clipboard.writeText(resumeEl.value).then(
    () => {
      copyBtn.textContent = 'Copied';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
    },
    () => {
      // Clipboard may be blocked; the textarea is selectable as a fallback.
    },
  );
});

// Renders the currently-selected version on demand into the requested format
// (server side, resumeRender.ts) — mirrors the dashboard's TailorModal so the
// popup doesn't need the dashboard open just to grab a file.
async function handleDownload(format: ResumeDownloadFormat, btn: HTMLButtonElement): Promise<void> {
  if (!currentVersion || pendingApplicationId === null || !currentJob) return;
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const blob = await downloadResumeVersion(pendingApplicationId, currentVersion.id, format);
    const filename = `${sanitizeFilenamePart(currentJob.company)}-${sanitizeFilenamePart(currentJob.title)}-resume.${format}`;
    triggerBlobDownload(blob, filename);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : `Failed to download the ${format.toUpperCase()}.`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

downloadPdfBtn.addEventListener('click', () => void handleDownload('pdf', downloadPdfBtn));
downloadDocxBtn.addEventListener('click', () => void handleDownload('docx', downloadDocxBtn));
downloadTxtBtn.addEventListener('click', () => void handleDownload('txt', downloadTxtBtn));

tailorBtn.addEventListener('click', () => void handleTailor());

async function init(): Promise<void> {
  const job = await fetchCurrentJob();
  if (!job) {
    setStatus('Open a job posting on Indeed, LinkedIn, or Glassdoor to tailor your resume here.');
    return;
  }
  currentJob = job;
  jobTitleEl.textContent = job.title;
  jobCompanyEl.textContent = job.company;
  jobEl.hidden = false;

  if (!job.job_description?.trim()) {
    setStatus(
      "No job description found on this page, which tailoring needs. Open the posting's full description and reopen this popup.",
    );
    return;
  }

  // Readiness pre-check: don't create a pending application we can't tailor.
  let ready = false;
  try {
    const settings = await getSettings();
    const hasKey = settings.provider === 'openai' ? settings.hasOpenaiKey : settings.hasAnthropicKey;
    ready = Boolean(settings.baseResume.trim()) && hasKey;
    if (!ready) {
      controlsHintEl.textContent =
        'Add a base resume and an API key in the dashboard Settings before tailoring.';
      controlsHintEl.hidden = false;
      tailorBtn.disabled = true;
    }
  } catch {
    controlsHintEl.textContent =
      'Could not reach the Applyt backend. Start it (npm run dev) and reopen this popup.';
    controlsHintEl.hidden = false;
    tailorBtn.disabled = true;
  }

  statusEl.hidden = true;
  controlsEl.hidden = false;
}

void init();
