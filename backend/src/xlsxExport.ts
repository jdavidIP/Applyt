import ExcelJS from "exceljs";
import type { Application, Status } from "./types.js";
import {
  STATUS_LABELS,
  PLATFORM_LABELS,
  APPLY_METHOD_LABELS,
  computeReportSummary,
  type AppVersionInfo,
} from "./reportData.js";

// Issue #16 follow-up: CSV covers the "zero-setup, machine-readable" export
// (CLAUDE.md §2); this covers "open it and it already looks professional" —
// a real .xlsx with a bordered/frozen-header table and an Insights sheet with
// summary tables plus in-cell data-bar charts (exceljs has no native chart
// object support, so data bars stand in for simple bar charts).

const ACCENT = "FF2F5496"; // dark blue
const HEADER_TEXT = "FFFFFFFF";
const BORDER: Partial<ExcelJS.Border> = { style: "thin", color: { argb: "FFB7B7B7" } };
const THIN_BORDERS: Partial<ExcelJS.Borders> = {
  top: BORDER,
  left: BORDER,
  bottom: BORDER,
  right: BORDER,
};

const STATUS_FILL: Record<Status, string> = {
  applied: "FFDDEBF7",
  pending_confirmation: "FFFFF2CC",
  interviewing: "FFD9EAD3",
  rejected: "FFF4CCCC",
  offer: "FFD9D2E9",
  ghosted: "FFEFEFEF",
  stale: "FFEFEFEF",
};

function styleHeaderRow(row: ExcelJS.Row): void {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_TEXT } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT } };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    cell.border = THIN_BORDERS;
  });
  row.height = 20;
}

function addDataBars(
  sheet: ExcelJS.Worksheet,
  ref: string,
  color = "FF638EC6",
): void {
  sheet.addConditionalFormatting({
    ref,
    rules: [
      {
        type: "dataBar",
        priority: 1,
        cfvo: [
          { type: "min" },
          { type: "max" },
        ],
        color: { argb: color },
        gradient: true,
        border: true,
      } as ExcelJS.ConditionalFormattingRule,
    ],
  });
}

function styleSectionTitle(cell: ExcelJS.Cell): void {
  cell.font = { bold: true, size: 12, color: { argb: ACCENT } };
}

export function buildApplicationsWorkbook(
  rows: Application[],
  versionByAppId: Map<number, AppVersionInfo>,
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Applyt";
  workbook.created = new Date();

  // ---- Sheet 1: Applications table ----
  const sheet = workbook.addWorksheet("Applications", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "Date Applied", key: "dateApplied", width: 13 },
    { header: "Company", key: "company", width: 22 },
    { header: "Job Title", key: "title", width: 28 },
    { header: "Platform", key: "platform", width: 12 },
    { header: "Application Method", key: "applyMethod", width: 16 },
    { header: "Status", key: "status", width: 16 },
    { header: "Last Updated", key: "lastUpdated", width: 13 },
    { header: "Resume Tailored", key: "tailored", width: 14 },
    { header: "Match Rating", key: "matchRating", width: 12 },
    { header: "AI Provider", key: "aiProvider", width: 12 },
    { header: "AI Model", key: "aiModel", width: 16 },
    { header: "Job URL", key: "jobUrl", width: 30 },
    { header: "Notes", key: "notes", width: 30 },
    { header: "Job Description", key: "jobDescription", width: 40 },
  ];
  styleHeaderRow(sheet.getRow(1));

  for (const a of rows) {
    const v = versionByAppId.get(a.id);
    const row = sheet.addRow({
      dateApplied: a.date_applied.slice(0, 10),
      company: a.company,
      title: a.title,
      platform: PLATFORM_LABELS[a.platform],
      applyMethod: APPLY_METHOD_LABELS[a.apply_method],
      status: STATUS_LABELS[a.status],
      lastUpdated: a.date_last_updated.slice(0, 10),
      tailored: v ? "Yes" : "No",
      matchRating: v?.matchRating != null ? `${v.matchRating}/5` : "",
      aiProvider: v?.ai_provider ?? "",
      aiModel: v?.model ?? "",
      jobUrl: a.job_url ?? "",
      notes: a.notes ?? "",
      jobDescription: a.job_description ?? "",
    });
    row.eachCell((cell) => {
      cell.border = THIN_BORDERS;
      cell.alignment = { vertical: "top", wrapText: false };
    });
    const statusCell = row.getCell("status");
    statusCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: STATUS_FILL[a.status] },
    };
  }

  if (rows.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
  }

  // ---- Sheet 2: Insights ----
  const insights = workbook.addWorksheet("Insights", {
    views: [{ showGridLines: false }],
  });
  insights.getColumn(1).width = 28;
  insights.getColumn(2).width = 14;
  insights.getColumn(3).width = 3;
  insights.getColumn(4).width = 28;
  insights.getColumn(5).width = 14;

  const summary = computeReportSummary(rows, versionByAppId);
  let r = 1;

  const titleCell = insights.getCell(r, 1);
  titleCell.value = "Applyt — Application Insights";
  titleCell.font = { bold: true, size: 16, color: { argb: ACCENT } };
  r += 2;

  insights.getCell(r, 1).value = "Total Applications";
  insights.getCell(r, 1).font = { bold: true };
  insights.getCell(r, 2).value = summary.totalApplications;
  r += 1;
  insights.getCell(r, 1).value = "Response Rate";
  insights.getCell(r, 1).font = { bold: true };
  insights.getCell(r, 2).value =
    summary.responseRate !== null ? `${(summary.responseRate * 100).toFixed(1)}%` : "N/A";
  r += 1;
  insights.getCell(r, 1).value = "Applications with Tailored Resume";
  insights.getCell(r, 1).font = { bold: true };
  insights.getCell(r, 2).value = summary.tailoredCount;
  r += 1;
  insights.getCell(r, 1).value = "Average Match Rating";
  insights.getCell(r, 1).font = { bold: true };
  insights.getCell(r, 2).value =
    summary.avgMatchRating !== null ? `${summary.avgMatchRating.toFixed(1)}/5` : "N/A";
  r += 2;

  // Side-by-side: "By Status" (cols A-B) and "By Platform" (cols D-E).
  const sideStartRow = r;
  styleSectionTitle(insights.getCell(r, 1));
  insights.getCell(r, 1).value = "Applications by Status";
  styleSectionTitle(insights.getCell(r, 4));
  insights.getCell(r, 4).value = "Applications by Platform";
  r += 1;
  const statusHeaderRow = r;
  insights.getCell(r, 1).value = "Status";
  insights.getCell(r, 2).value = "Count";
  insights.getCell(r, 4).value = "Platform";
  insights.getCell(r, 5).value = "Count";
  [1, 2, 4, 5].forEach((c) => (insights.getCell(r, c).font = { bold: true }));
  r += 1;
  const statusFirstDataRow = r;
  for (const s of summary.byStatus) {
    insights.getCell(r, 1).value = s.label;
    insights.getCell(r, 2).value = s.count;
    r += 1;
  }
  const statusLastDataRow = r - 1;
  const platformFirstDataRow = statusFirstDataRow;
  let pr = platformFirstDataRow;
  for (const p of summary.byPlatform) {
    insights.getCell(pr, 4).value = p.label;
    insights.getCell(pr, 5).value = p.count;
    pr += 1;
  }
  const platformLastDataRow = pr - 1;
  r = Math.max(statusLastDataRow, platformLastDataRow, statusHeaderRow) + 1;

  if (statusLastDataRow >= statusFirstDataRow) {
    addDataBars(insights, `B${statusFirstDataRow}:B${statusLastDataRow}`);
  }
  if (platformLastDataRow >= platformFirstDataRow) {
    addDataBars(insights, `E${platformFirstDataRow}:E${platformLastDataRow}`, "FF93C47D");
  }
  void sideStartRow;

  r += 1;
  styleSectionTitle(insights.getCell(r, 1));
  insights.getCell(r, 1).value = "Applications per Week";
  r += 1;
  insights.getCell(r, 1).value = "Week Starting";
  insights.getCell(r, 2).value = "Count";
  insights.getCell(r, 1).font = { bold: true };
  insights.getCell(r, 2).font = { bold: true };
  r += 1;
  const weekFirstDataRow = r;
  for (const w of summary.perWeek) {
    insights.getCell(r, 1).value = w.weekStart;
    insights.getCell(r, 2).value = w.count;
    r += 1;
  }
  const weekLastDataRow = r - 1;
  if (weekLastDataRow >= weekFirstDataRow) {
    addDataBars(insights, `B${weekFirstDataRow}:B${weekLastDataRow}`, "FFE69138");
  }

  return workbook;
}
