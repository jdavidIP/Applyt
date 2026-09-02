// Date-label formatting for TrendModal, split out so the UTC-safe parsing
// (backend/src/reportData.ts computePerDay hands back bare YYYY-MM-DD dates)
// is unit-testable without rendering the modal.

export function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function formatRangeLabel(rangeStart: string, rangeEnd: string): string {
  const start = new Date(`${rangeStart}T00:00:00Z`);
  const end = new Date(`${rangeEnd}T00:00:00Z`);
  const startLabel = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const endLabel = end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `${startLabel} – ${endLabel}`;
}

// Heading for a selected week in TrendModal's weekly view, e.g.
// "Week of Aug 4 – Aug 10, 2026".
export function formatWeekRangeHeading(weekStart: string, weekEnd: string): string {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(`${weekEnd}T00:00:00Z`);
  const startLabel = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const endLabel = end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `Week of ${startLabel} – ${endLabel}`;
}

export function formatDayHeading(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
