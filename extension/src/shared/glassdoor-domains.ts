// Glassdoor runs on separate per-country domains (not subdomains of one
// host), so a single '*://*.glassdoor.*/*' wildcard doesn't work — Chrome
// match/URL patterns can't wildcard the TLD portion of a hostname. Verified
// live (2026-07-11): glassdoor.ca does NOT get the content script without an
// explicit entry. This list is necessarily incomplete — if a user's country
// domain is missing, add it here; that's the whole fix. Shared between
// manifest.config.ts (content_scripts/host_permissions) and the background
// service worker (context menu documentUrlPatterns) so there's one list to
// keep in sync, not two.
export const GLASSDOOR_MATCHES = [
  '*://www.glassdoor.com/*',
  '*://www.glassdoor.ca/*',
  '*://www.glassdoor.co.uk/*',
  '*://www.glassdoor.ie/*',
  '*://www.glassdoor.com.au/*',
  '*://www.glassdoor.de/*',
  '*://www.glassdoor.fr/*',
  '*://www.glassdoor.es/*',
  '*://www.glassdoor.it/*',
  '*://www.glassdoor.nl/*',
  '*://www.glassdoor.ch/*',
  '*://www.glassdoor.at/*',
  '*://www.glassdoor.be/*',
  '*://www.glassdoor.in/*',
  '*://www.glassdoor.sg/*',
];
