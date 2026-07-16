import {
  createPendingApplication,
  getSettings,
  tailorApplication,
} from '../shared/backend';
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

function renderStars(rating: number): void {
  const filled = Math.max(0, Math.min(5, rating));
  matchStarsEl.textContent = '★'.repeat(filled) + '☆'.repeat(5 - filled);
  const count = document.createElement('span');
  count.className = 'stars-count';
  count.textContent = `${filled}/5`;
  matchStarsEl.appendChild(count);
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

function renderResult(version: ResumeVersionResult): void {
  const sections = parseTailoredResume(version.tailored_output ?? '');

  if (sections.matchRating !== null || sections.matchJustification) {
    matchEl.hidden = false;
    matchStarsEl.textContent = '';
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
