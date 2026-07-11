import { postApplication } from '../shared/backend';
import type { DetectedApplication, RuntimeMessage } from '../shared/types';

function log(...args: unknown[]): void {
  console.info('[Applyt:bg]', ...args);
}

const MARK_APPLIED_MENU_ID = 'applyt-mark-as-applied';

log('service worker started');

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MARK_APPLIED_MENU_ID,
    title: 'Mark this job as applied (Applyt)',
    contexts: ['page'],
    documentUrlPatterns: [
      '*://*.indeed.com/*',
      '*://smartapply.indeed.com/*',
      '*://www.linkedin.com/jobs/*',
    ],
  });
});

// Manual fallback per CLAUDE.md §6: automatic detection will never be 100%
// reliable, so a right-click "mark as applied" must always be available.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MARK_APPLIED_MENU_ID || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_CURRENT_JOB' }).catch(() => {
    // Content script not present on this page (e.g. non-job page) — nothing to extract.
  });
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  log('received message', message?.type);
  if (message.type !== 'APPLICATION_DETECTED') return undefined;

  void handleDetectedApplication(message.payload).then(
    () => sendResponse({ ok: true }),
    (err: unknown) => sendResponse({ ok: false, error: String(err) }),
  );
  return true; // keep the message channel open for the async response
});

async function handleDetectedApplication(payload: DetectedApplication): Promise<void> {
  log('POSTing application to backend', payload);
  try {
    await postApplication(payload);
    log('POST succeeded');
  } catch (err) {
    log('POST FAILED — is the backend running on the configured port?', err);
    throw err;
  }
  await chrome.action.setBadgeText({ text: '✓' });
  await chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
  setTimeout(() => void chrome.action.setBadgeText({ text: '' }), 4000);
}
