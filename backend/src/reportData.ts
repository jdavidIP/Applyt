import type { Application, ResumeVersion, Status, Platform, ApplyMethod, WeeklyCount } from "./types.js";
import { STATUSES, PLATFORMS } from "./types.js";
import { parseTailoredResume } from "./tailoredResume.js";

// Shared between the CSV (Issue #16) and XLSX (Issue #16 follow-up) exports so
// both report formats present identical numbers derived from the same rows.

export const STATUS_LABELS: Record<Status, string> = {
  applied: "Applied",
  pending_confirmation: "Pending Confirmation",
  interviewing: "Interviewing",
  rejected: "Rejected",
  offer: "Offer",
  ghosted: "Ghosted",
  stale: "Stale",
};

export const PLATFORM_LABELS: Record<Platform, string> = {
  indeed: "Indeed",
  linkedin: "LinkedIn",
  glassdoor: "Glassdoor",
  manual: "Manual",
};

export const APPLY_METHOD_LABELS: Record<ApplyMethod, string> = {
  in_platform: "In-Platform",
  external_redirect: "External Redirect",
  manual: "Manual",
};

// Confirmed-applied statuses that got some kind of outcome, for response-rate
// purposes (CLAUDE.md §7 Phase 3: "response rate"). 'pending_confirmation' is
// excluded from the denominator entirely.
const RESPONSE_STATUSES = new Set(["interviewing", "rejected", "offer"]);

// Monday 00:00:00 UTC of the ISO week containing `d`.
function mondayOf(d: Date): Date {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1) - day;
  date.setUTCDate(date.getUTCDate() + diff);
  return date;
}

// Bucketed across the actual span of the exported data (earliest to most
// recent date_applied), not a fixed rolling window like the dashboard's own
// 8-week stat widget — a downloaded report should reflect everything in it.
export function computePerWeekFullRange(dateApplied: string[]): WeeklyCount[] {
  if (dateApplied.length === 0) return [];
  const weekStartTimes = dateApplied.map((d) => mondayOf(new Date(d)).getTime());
  const counts = new Map<number, number>();
  for (const t of weekStartTimes) counts.set(t, (counts.get(t) ?? 0) + 1);

  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
  const min = Math.min(...weekStartTimes);
  const max = Math.max(...weekStartTimes);
  const buckets: WeeklyCount[] = [];
  for (let t = min; t <= max; t += MS_PER_WEEK) {
    buckets.push({ weekStart: new Date(t).toISOString().slice(0, 10), count: counts.get(t) ?? 0 });
  }
  return buckets;
}

// Tailoring info resolved per application (ai_provider/model straight from the
// linked resume_versions row; matchRating parsed out of its tailored_output).
// null fields mean "not tailored".
export interface AppVersionInfo {
  ai_provider: string | null;
  model: string | null;
  matchRating: number | null;
}

export function resolveVersionByAppId(
  versions: Pick<ResumeVersion, "id" | "application_id" | "ai_provider" | "model" | "tailored_output">[],
): Map<number, AppVersionInfo> {
  const versionByAppId = new Map<number, AppVersionInfo>();
  for (const v of versions) {
    if (v.application_id === null) continue;
    versionByAppId.set(v.application_id, {
      ai_provider: v.ai_provider,
      model: v.model,
      matchRating: v.tailored_output ? parseTailoredResume(v.tailored_output).matchRating : null,
    });
  }
  return versionByAppId;
}

export interface ReportSummary {
  totalApplications: number;
  byStatus: { status: Status; label: string; count: number }[];
  byPlatform: { platform: Platform; label: string; count: number }[];
  responseRate: number | null; // fraction 0-1, null when no eligible rows
  perWeek: WeeklyCount[];
  tailoredCount: number;
  avgMatchRating: number | null;
}

export function computeReportSummary(
  rows: Application[],
  versionByAppId: Map<number, AppVersionInfo>,
): ReportSummary {
  const byStatus = STATUSES.map((status) => ({
    status,
    label: STATUS_LABELS[status],
    count: rows.filter((r) => r.status === status).length,
  })).filter((s) => s.count > 0);

  const byPlatform = PLATFORMS.map((platform) => ({
    platform,
    label: PLATFORM_LABELS[platform],
    count: rows.filter((r) => r.platform === platform).length,
  })).filter((p) => p.count > 0);

  const responseEligible = rows.filter((r) => r.status !== "pending_confirmation");
  const responded = responseEligible.filter((r) => RESPONSE_STATUSES.has(r.status));
  const responseRate = responseEligible.length === 0 ? null : responded.length / responseEligible.length;

  const ratings = [...versionByAppId.values()]
    .map((v) => v.matchRating)
    .filter((r): r is number => r !== null);
  const avgMatchRating = ratings.length ? ratings.reduce((sum, r) => sum + r, 0) / ratings.length : null;

  return {
    totalApplications: rows.length,
    byStatus,
    byPlatform,
    responseRate,
    perWeek: computePerWeekFullRange(rows.map((r) => r.date_applied)),
    tailoredCount: versionByAppId.size,
    avgMatchRating,
  };
}
