import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

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
      js: ['src/content/indeed.ts'],
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
  ],
  permissions: ['contextMenus', 'storage'],
  host_permissions: [
    '*://*.indeed.com/*',
    '*://smartapply.indeed.com/*',
    '*://www.linkedin.com/*',
    'http://127.0.0.1:4317/*',
    'http://localhost:4317/*',
  ],
});
