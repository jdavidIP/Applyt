import { useEffect, useState } from 'react';
import { IconChevronLeft, IconChevronRight, IconChartBar } from '@tabler/icons-react';
import { api } from '../api';
import { STATUS_LABELS } from '../labels';
import { DAILY_STATS_WEEK_OPTIONS } from '../types';
import type { Application, DailyStatsResponse, DailyStatsWeeks } from '../types';
import { formatShortDate, formatRangeLabel, formatDayHeading, formatWeekRangeHeading } from '../trendFormat';
import { Modal } from './Modal';

interface Props {
  onClose: () => void;
}

type ViewMode = 'daily' | 'weekly';

// A day-drilldown or a week-drilldown, mutually exclusive — only one panel
// selection is ever active, matching whichever viewMode produced it.
type Selection = { kind: 'day'; date: string } | { kind: 'week'; start: string; end: string };

const CHART_HEIGHT = 160;
// Sized so the default 4-week daily view (28 bars) fits the chart pane
// (~60% of the xwide modal) without a horizontal scrollbar; 8/12 weeks (or
// the weekly view's wider per-bar width) still need it.
const DAY_SLOT_WIDTH = 20;
const WEEK_SLOT_WIDTH = 64;

// Trend-detail modal (approved SuperDesign "Split" draft, extended with a
// Daily/Weekly toggle): a breakdown of the dashboard's Trend stat, with a
// persistent side panel showing whichever day/week is selected. Weeks/offset
// page through the data; the chart doesn't share state with StatsBar's own
// 8-week mini sparkline — this is a separate, independently-navigable view.
export function TrendModal({ onClose }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('daily');
  const [weeks, setWeeks] = useState<DailyStatsWeeks>(4);
  const [offset, setOffset] = useState(0);
  const [daily, setDaily] = useState<DailyStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [apps, setApps] = useState<Application[] | null>(null);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appsError, setAppsError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSelection(null);
    setApps(null);
    setError(null);
    void (async () => {
      try {
        const res = await api.dailyStats(weeks, offset);
        if (active) setDaily(res);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load trend data.');
      }
    })();
    return () => {
      active = false;
    };
  }, [weeks, offset]);

  // Switching Daily/Weekly invalidates whatever was selected under the other mode.
  useEffect(() => {
    setSelection(null);
    setApps(null);
  }, [viewMode]);

  useEffect(() => {
    if (!selection) return;
    let active = true;
    setAppsLoading(true);
    setAppsError(null);
    void (async () => {
      try {
        const result =
          selection.kind === 'day'
            ? await api.listByDate(selection.date)
            : await api.listByDateRange(selection.start, selection.end);
        if (active) setApps(result);
      } catch (err) {
        if (active) setAppsError(err instanceof Error ? err.message : 'Failed to load applications.');
      } finally {
        if (active) setAppsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [selection]);

  const days = daily?.days ?? [];
  const dayGroups: (typeof days)[] = [];
  for (let i = 0; i < days.length; i += 7) dayGroups.push(days.slice(i, i + 7));
  const weekBuckets = dayGroups
    .filter((group) => group.length > 0)
    .map((group) => ({
      start: group[0].date,
      end: group[group.length - 1].date,
      count: group.reduce((sum, d) => sum + d.count, 0),
    }));

  const maxDayCount = Math.max(1, ...days.map((d) => d.count));
  const maxWeekCount = Math.max(1, ...weekBuckets.map((w) => w.count));

  const panelHeading =
    selection?.kind === 'day'
      ? formatDayHeading(selection.date)
      : selection?.kind === 'week'
        ? formatWeekRangeHeading(selection.start, selection.end)
        : null;

  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <IconChartBar size={20} className="text-matcha-600" stroke={1.75} />
          Application Trends
        </span>
      }
      xwide
      onClose={onClose}
      footer={
        <button type="button" className="btn-ghost px-6 py-2 text-sm" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-ghost p-1.5 flex items-center"
            onClick={() => setOffset((o) => o + 1)}
            aria-label="Earlier"
          >
            <IconChevronLeft size={18} stroke={1.75} />
          </button>
          <span className="text-[13px] font-medium text-ink px-1 min-w-[180px] text-center">
            {daily ? formatRangeLabel(daily.rangeStart, daily.rangeEnd) : ' '}
          </span>
          <button
            type="button"
            className="btn-ghost p-1.5 flex items-center disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => setOffset((o) => Math.max(0, o - 1))}
            disabled={offset === 0}
            aria-label="Later"
          >
            <IconChevronRight size={18} stroke={1.75} />
          </button>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center bg-matcha-100 rounded-lg p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('daily')}
              className={`px-3 py-1 text-[11px] font-medium rounded-md transition-colors ${
                viewMode === 'daily' ? 'bg-white text-matcha-800 shadow-sm' : 'text-ink-soft'
              }`}
            >
              Daily
            </button>
            <button
              type="button"
              onClick={() => setViewMode('weekly')}
              className={`px-3 py-1 text-[11px] font-medium rounded-md transition-colors ${
                viewMode === 'weekly' ? 'bg-white text-matcha-800 shadow-sm' : 'text-ink-soft'
              }`}
            >
              Weekly
            </button>
          </div>
          <select
            value={weeks}
            onChange={(e) => {
              setWeeks(Number(e.target.value) as DailyStatsWeeks);
              setOffset(0);
            }}
            className="input-field w-auto h-[34px]"
          >
            {DAILY_STATS_WEEK_OPTIONS.map((w) => (
              <option key={w} value={w}>
                {w} weeks
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <p className="text-rose-800 text-[13px] mb-4">{error}</p>}

      <div className="flex flex-col lg:flex-row gap-6">
        <div className="lg:w-[60%] overflow-x-auto">
          {viewMode === 'daily' ? (
            <div
              className="flex items-end gap-3"
              style={{ height: CHART_HEIGHT + 40, minWidth: days.length * DAY_SLOT_WIDTH }}
            >
              {dayGroups.map((week, wi) => (
                <div
                  key={week[0]?.date ?? wi}
                  className={`flex items-end gap-1 h-full ${wi < dayGroups.length - 1 ? 'pr-3 border-r border-matcha-200' : ''}`}
                >
                  {week.map((day) => {
                    const isSelected = selection?.kind === 'day' && selection.date === day.date;
                    return (
                      <button
                        type="button"
                        key={day.date}
                        onClick={() => setSelection({ kind: 'day', date: day.date })}
                        className="flex flex-col items-center justify-end gap-1 h-full group"
                        style={{ width: DAY_SLOT_WIDTH - 6 }}
                        title={`${day.date}: ${day.count}`}
                      >
                        <span className="text-[10px] font-medium text-ink-soft">{day.count}</span>
                        <div
                          className={`w-full rounded-t-sm transition-colors ${
                            isSelected ? 'bg-matcha-800' : 'bg-matcha-400 group-hover:bg-matcha-600'
                          }`}
                          style={{ height: Math.max(2, (day.count / maxDayCount) * CHART_HEIGHT) }}
                        />
                        <span className="text-[9px] text-ink-soft whitespace-nowrap -rotate-45 origin-top mt-1">
                          {formatShortDate(day.date)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : (
            <div
              className="flex items-end gap-4"
              style={{ height: CHART_HEIGHT + 40, minWidth: weekBuckets.length * WEEK_SLOT_WIDTH }}
            >
              {weekBuckets.map((week) => {
                const isSelected = selection?.kind === 'week' && selection.start === week.start;
                return (
                  <button
                    type="button"
                    key={week.start}
                    onClick={() => setSelection({ kind: 'week', start: week.start, end: week.end })}
                    className="flex flex-col items-center justify-end gap-1 h-full group"
                    style={{ width: WEEK_SLOT_WIDTH - 16 }}
                    title={`${week.start} – ${week.end}: ${week.count}`}
                  >
                    <span className="text-[11px] font-medium text-ink-soft">{week.count}</span>
                    <div
                      className={`w-full rounded-t-sm transition-colors ${
                        isSelected ? 'bg-matcha-800' : 'bg-matcha-400 group-hover:bg-matcha-600'
                      }`}
                      style={{ height: Math.max(2, (week.count / maxWeekCount) * CHART_HEIGHT) }}
                    />
                    <span className="text-[10px] text-ink-soft whitespace-nowrap">{formatShortDate(week.start)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="lg:w-[40%] lg:border-l lg:border-matcha-200 lg:pl-6 flex flex-col gap-3 min-h-[220px]">
          {!selection && (
            <p className="text-ink-soft text-[13px] italic m-auto text-center">
              {viewMode === 'daily'
                ? "Click a bar to see that day's applications."
                : "Click a bar to see that week's applications."}
            </p>
          )}

          {selection && (
            <>
              <div className="flex items-center justify-between">
                <h3 className="text-[13px] font-medium text-ink m-0">{panelHeading}</h3>
                {apps && (
                  <span className="text-[11px] text-ink-soft">
                    {apps.length} application{apps.length === 1 ? '' : 's'}
                  </span>
                )}
              </div>

              {appsLoading && <p className="text-ink-soft text-[13px]">Loading…</p>}
              {appsError && <p className="text-rose-800 text-[13px]">{appsError}</p>}

              {apps && apps.length === 0 && (
                <p className="text-ink-soft text-[13px]">
                  No applications logged {selection.kind === 'day' ? 'this day' : 'this week'}.
                </p>
              )}

              {apps && apps.length > 0 && (
                <div className="flex flex-col gap-2 overflow-y-auto max-h-[320px]">
                  {apps.map((app) => (
                    <div key={app.id} className="card p-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-matcha-600 m-0 truncate">{app.company}</p>
                        <p className="text-[12px] text-ink-soft m-0 truncate">{app.title}</p>
                      </div>
                      <span className={`badge status-${app.status} shrink-0`}>{STATUS_LABELS[app.status]}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
