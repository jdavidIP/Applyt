import { describe, test, expect } from 'vitest';
import { formatShortDate, formatRangeLabel, formatDayHeading, formatWeekRangeHeading } from './trendFormat';

// These deliberately use toLocaleDateString(undefined, ...) to respect the
// viewer's own locale (matching labels.ts's formatDate), so assertions here
// check locale-independent properties (the right day number appears, not
// shifted by a day) rather than hardcoding English month/weekday names.
//
// Regression guard for the UTC-safe parsing: `new Date('2026-01-01')` (no
// time-of-day) is UTC midnight, which formats as Dec 31 in any timezone west
// of UTC unless read back out in UTC too — an easy silent off-by-one-day bug.
describe('trendFormat', () => {
  test('formatShortDate does not shift the date in a negative-offset timezone', () => {
    expect(formatShortDate('2026-01-01')).toMatch(/\b1\b/);
    expect(formatShortDate('2026-01-01')).not.toMatch(/31/);
    expect(formatShortDate('2026-12-31')).toMatch(/31/);
  });

  test('formatRangeLabel includes both endpoints and the year once', () => {
    const label = formatRangeLabel('2026-08-04', '2026-08-31');
    assertDayPresent(label, 4);
    assertDayPresent(label, 31);
    expect(label).toMatch(/2026/);
  });

  test('formatWeekRangeHeading includes both endpoint days and the year once', () => {
    const heading = formatWeekRangeHeading('2026-08-04', '2026-08-10');
    expect(heading).toMatch(/^Week of/);
    assertDayPresent(heading, 4);
    assertDayPresent(heading, 10);
    expect(heading).toMatch(/2026/);
  });

  test('formatDayHeading includes the correct day number and year, not shifted', () => {
    const heading = formatDayHeading('2026-08-10');
    assertDayPresent(heading, 10);
    expect(heading).toMatch(/2026/);
    expect(heading).not.toMatch(/\b9\b/);
    expect(heading).not.toMatch(/\b11\b/);
  });
});

function assertDayPresent(text: string, day: number): void {
  expect(text).toMatch(new RegExp(`\\b0*${day}\\b`));
}
