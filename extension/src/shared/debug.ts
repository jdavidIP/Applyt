// All [Applyt]/[Applyt:bg] diagnostic logging is gated behind this flag,
// default OFF. The verbose trace logs (click detection, cached metadata,
// confirmation matching, etc.) were essential for debugging three real
// production bugs across Indeed/LinkedIn/Glassdoor this project — stripping
// them entirely would make re-debugging a future breakage (likely, given how
// fragile this markup has proven) start from scratch. Gating keeps them
// available without needing a rebuild.
//
// To enable: open any Applyt-matched page's console (or the service worker
// console via the "service worker" link on the chrome://extensions card) and run:
//   chrome.storage.local.set({ applytDebug: true })
// To disable: chrome.storage.local.set({ applytDebug: false })
const DEBUG_KEY = 'applytDebug';

let debugEnabled = false;

void chrome.storage.local.get(DEBUG_KEY).then((result) => {
  debugEnabled = Boolean(result[DEBUG_KEY]);
});

// Tracks live changes so toggling the flag takes effect immediately in any
// already-open tab/service worker, without needing a reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && DEBUG_KEY in changes) {
    debugEnabled = Boolean(changes[DEBUG_KEY].newValue);
  }
});

export function createLogger(prefix: string): (...args: unknown[]) => void {
  return (...args: unknown[]): void => {
    if (!debugEnabled) return;
    // console.info (not console.debug) — console.debug renders at DevTools'
    // "Verbose" level, which is hidden by default, so those lines would be
    // invisible even with the flag on.
    console.info(prefix, ...args);
  };
}
