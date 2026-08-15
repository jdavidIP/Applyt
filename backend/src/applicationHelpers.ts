// Small pure helpers used when reading/writing an applications row — no
// Fastify or DB dependency, so they're easy to unit test in isolation from
// the route handlers in routes/applications.ts.

// Search bar: strips spaces/hyphens so "Full Stack", "Full-Stack", and
// "Fullstack" are treated as equivalent on both sides of the LIKE comparison,
// then escapes SQLite's own LIKE wildcards (%, _, and the escape char itself)
// so a literal % or _ in a company/title is matched literally rather than
// acting as a wildcard — paired with "ESCAPE '\'" on the LIKE clauses in the
// route that uses this.
export function normalizeForSearch(text: string): string {
  return text
    .trim()
    .replace(/[\s-]+/g, "")
    .replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Issue #12: job descriptions arrive as raw scraped textContent (extension) or
// pasted text (manual add/edit) with irregular interior whitespace from the
// source page's block elements. Normalized once here so every write path
// (extension capture and manual paste alike) stores/feeds the AI prompt with
// the same clean text, instead of patching each capture site separately.
export function normalizeJobDescription(
  text: string | null | undefined,
): string | null {
  if (text == null) return null;
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Statuses an automatic/manual re-detection of a job is allowed to set. A user's
// later lifecycle changes (interviewing/rejected/offer/ghosted/stale) must NOT be
// clobbered by a subsequent re-detect of the same posting.
const AUTO_STATUSES = new Set(["applied", "pending_confirmation"]);

// Resolve the status when an already-known job is reported again.
export function mergeStatus(existing: string, incoming: string): string {
  // Preserve a user-advanced lifecycle status — never regress it.
  if (!AUTO_STATUSES.has(existing)) return existing;
  // Both are auto-ish: a confirmed 'applied' outranks 'pending_confirmation',
  // so promote (e.g. external redirect → user "Mark as applied") but never
  // downgrade a job already marked applied back to pending.
  if (existing === "applied" || incoming === "applied") return "applied";
  return incoming;
}
