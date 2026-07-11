import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';
import { GLASSDOOR_MATCHES } from './src/shared/glassdoor-domains';

// Manifest V3. Per CLAUDE.md: this extension only *observes* the user's own
// apply actions via content scripts reacting to DOM changes — no scripting
// permission, no host-wide access beyond the three job platforms, no
// background polling/alarms.
export default defineManifest({
  manifest_version: 3,
  name: 'Applyt — Job Application Tracker',
  description:
    'Automatically tracks job applications you submit on Indeed, LinkedIn, and Glassdoor into your local Applyt dashboard.',
  version: pkg.version,
  icons: {
    16: 'icons/icon16.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_icon: {
      16: 'icons/icon16.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['*://*.indeed.com/*', '*://smartapply.indeed.com/*'],
      // Both indeed.ts and glassdoor.ts run in this frame: Glassdoor's synced-
      // profile Easy Apply reportedly runs through Indeed's own smartapply
      // form under the hood (CLAUDE.md §6), so glassdoor.ts also needs to see
      // this iframe to resolve its own glassdoorApplyInProgress cache there.
      // Each script only acts on its own platform-scoped storage keys, so
      // running both is harmless if that turns out not to be the actual path.
      js: ['src/content/indeed.ts', 'src/content/glassdoor.ts'],
      run_at: 'document_idle',
      // Indeed Apply frequently renders as an in-page iframe pointing at
      // smartapply.indeed.com rather than a top-level navigation — without
      // all_frames, the confirmation screen inside that iframe is never seen.
      all_frames: true,
    },
    {
      matches: ['*://www.linkedin.com/jobs/*'],
      js: ['src/content/linkedin.ts'],
      run_at: 'document_idle',
    },
    {
      matches: GLASSDOOR_MATCHES,
      js: ['src/content/glassdoor.ts'],
      run_at: 'document_idle',
    },
  ],
  permissions: ['contextMenus', 'storage'],
  host_permissions: [
    '*://*.indeed.com/*',
    '*://smartapply.indeed.com/*',
    '*://www.linkedin.com/*',
    ...GLASSDOOR_MATCHES,
    'http://127.0.0.1:4317/*',
    'http://localhost:4317/*',
  ],
});
