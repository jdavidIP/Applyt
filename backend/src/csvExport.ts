import type { Application } from "./types.js";
import {
  STATUS_LABELS,
  PLATFORM_LABELS,
  APPLY_METHOD_LABELS,
  computeReportSummary,
  neutralizeFormulaPrefix,
  type AppVersionInfo,
} from "./reportData.js";

// Issue #16: CSV export. The previous export dumped every raw DB column
// (internal id, resume_version_id FK, created_at/updated_at bookkeeping) with
// no structure — "correctly generated" but of little use to a human. This
// produces a two-section report instead: a clean, human-readable detail table
// (one row per application, with tailoring info resolved from resume_versions
// rather than exposing the raw FK), followed by a summary/insights block
// below a blank separator row. Any tool that just reads until a shorter row
// still gets a clean table from the top section — the summary is additive,
// not a format change to the detail rows a spreadsheet import would rely on.

const CSV_DETAIL_HEADERS = [
  "Date Applied",
  "Company",
  "Job Title",
  "Platform",
  "Application Method",
  "Status",
  "Last Updated",
  "Resume Tailored",
  "Match Rating",
  "AI Provider",
  "AI Model",
  "Job URL",
  "Notes",
  "Job Description",
];

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = neutralizeFormulaPrefix(String(value));
  // Quote if the field contains a comma, quote, CR or LF; double up embedded quotes.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(values: (string | number | null | undefined)[]): string {
  return values.map(csvEscape).join(",");
}

// date_last_updated is stored as a full ISO timestamp (unlike date_applied,
// a plain date) — trim it to just the date for a report column, matching the
// Date Applied column's format instead of showing a raw timestamp.
function csvDate(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

export function buildApplicationsReport(
  rows: Application[],
  versionByAppId: Map<number, AppVersionInfo>,
): string {
  const lines: string[] = [csvRow(CSV_DETAIL_HEADERS)];

  for (const a of rows) {
    const v = versionByAppId.get(a.id);
    lines.push(
      csvRow([
        csvDate(a.date_applied),
        a.company,
        a.title,
        PLATFORM_LABELS[a.platform],
        APPLY_METHOD_LABELS[a.apply_method],
        STATUS_LABELS[a.status],
        csvDate(a.date_last_updated),
        v ? "Yes" : "No",
        v?.matchRating != null ? `${v.matchRating}/5` : "",
        v?.ai_provider ?? "",
        v?.model ?? "",
        a.job_url,
        a.notes,
        a.job_description,
      ]),
    );
  }

  const summary = computeReportSummary(rows, versionByAppId);

  // ---- Summary / insights, below a blank separator row ----
  lines.push("");
  lines.push(csvRow(["SUMMARY"]));
  lines.push(csvRow(["Total Applications", summary.totalApplications]));

  lines.push("");
  lines.push(csvRow(["Applications by Status"]));
  for (const s of summary.byStatus) lines.push(csvRow([s.label, s.count]));

  lines.push("");
  lines.push(csvRow(["Applications by Platform"]));
  for (const p of summary.byPlatform) lines.push(csvRow([p.label, p.count]));

  lines.push("");
  lines.push(
    csvRow([
      "Response Rate",
      summary.responseRate !== null
        ? `${(summary.responseRate * 100).toFixed(1)}%`
        : "N/A",
    ]),
  );

  lines.push("");
  lines.push(csvRow(["Applications per Week"]));
  lines.push(csvRow(["Week Starting", "Count"]));
  for (const w of summary.perWeek) lines.push(csvRow([w.weekStart, w.count]));

  lines.push("");
  lines.push(csvRow(["Tailoring Insights"]));
  lines.push(
    csvRow(["Applications with Tailored Resume", summary.tailoredCount]),
  );
  lines.push(
    csvRow([
      "Average Match Rating",
      summary.avgMatchRating !== null
        ? `${summary.avgMatchRating.toFixed(1)}/5`
        : "N/A",
    ]),
  );

  // CRLF line endings for maximum spreadsheet compatibility (RFC 4180).
  return lines.join("\r\n") + "\r\n";
}
