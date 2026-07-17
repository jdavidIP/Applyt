import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { StatsResponse } from '../types';
import { useToast } from './Toast';

interface Props {
  // Bulk actions mutate rows behind the parent's back, so it must reload its
  // own applications list after either one completes.
  onApplicationsChanged: () => void;
}

const DEFAULT_THRESHOLD_DAYS = 30;

// Phase 3 (CLAUDE.md §7): bulk lifecycle actions (mark stale, bulk-delete
// rejected) plus basic stats (applications/week, response rate). Three stat
// cards in a row, then a slim actions bar beneath — matches the approved
// SuperDesign draft (response rate uses terracotta-800 to make it "pop").
export function LifecyclePanel({ onApplicationsChanged }: Props) {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thresholdDays, setThresholdDays] = useState(DEFAULT_THRESHOLD_DAYS);
  const [busy, setBusy] = useState(false);
  const { showToast } = useToast();

  const loadStats = useCallback(async () => {
    try {
      setStats(await api.stats());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stats.');
    }
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  async function handleMarkStale() {
    setBusy(true);
    setError(null);
    try {
      const { updated } = await api.markStale(thresholdDays);
      showToast({
        tone: 'success',
        message: `Marked ${updated} application${updated === 1 ? '' : 's'} as stale.`,
      });
      onApplicationsChanged();
      await loadStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark stale.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteRejected() {
    if (!window.confirm('Delete all applications with status "Rejected"? This cannot be undone.')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { deleted } = await api.bulkDeleteByStatus('rejected');
      showToast({
        tone: 'success',
        message: `Deleted ${deleted} rejected application${deleted === 1 ? '' : 's'}.`,
      });
      onApplicationsChanged();
      await loadStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to bulk-delete.');
    } finally {
      setBusy(false);
    }
  }

  const maxWeekCount = stats ? Math.max(1, ...stats.perWeek.map((w) => w.count)) : 1;

  // perWeek is ordered oldest -> newest (see backend/src/routes/applications.ts
  // computePerWeek), so the last entry is the current week and the one before
  // it is the prior week — used for the week-over-week trend below the title.
  const weeks = stats?.perWeek ?? [];
  const currentWeek = weeks[weeks.length - 1];
  const previousWeek = weeks[weeks.length - 2];
  let trend: { text: string; className: string } | null = null;
  if (currentWeek && previousWeek) {
    if (previousWeek.count === 0) {
      trend =
        currentWeek.count === 0
          ? { text: 'No change', className: 'text-ink-soft' }
          : { text: 'New this week', className: 'text-matcha-800' };
    } else {
      const pct = Math.round(((currentWeek.count - previousWeek.count) / previousWeek.count) * 100);
      trend =
        pct === 0
          ? { text: 'No change', className: 'text-ink-soft' }
          : { text: `${pct > 0 ? '+' : ''}${pct}% vs last week`, className: pct > 0 ? 'text-matcha-800' : 'text-rose-800' };
    }
  }

  return (
    <div className="mb-6 flex flex-col gap-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="card p-5 flex flex-col">
          <span className="stat-label mb-1">Total applications</span>
          <span className="stat-number">{stats ? stats.totalApplications : '—'}</span>
        </div>

        <div className="card p-5 flex flex-col">
          <span className="stat-label mb-1">Response rate</span>
          <span className="stat-number text-terracotta-800">
            {!stats || stats.responseRate === null ? '—' : `${Math.round(stats.responseRate * 100)}%`}
          </span>
        </div>

        <div className="card p-5 flex flex-col justify-between">
          <div>
            <span className="stat-label block">Applications per week</span>
            {trend && <span className={`text-[11px] font-medium ${trend.className}`}>{trend.text}</span>}
          </div>
          {stats && (
            <div className="flex items-end justify-end gap-1.5 h-10 mt-2">
              {stats.perWeek.map((w) => (
                <div
                  key={w.weekStart}
                  className="flex flex-col-reverse items-center gap-0.5 w-[10px] h-full"
                  title={`${w.weekStart}: ${w.count}`}
                >
                  <div
                    className="week-bar w-full min-h-[2px]"
                    style={{ height: `${(w.count / maxWeekCount) * 100}%` }}
                  />
                  <span className="text-[9px] leading-none text-ink-soft">{w.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card p-4 flex items-center justify-between bg-matcha-50/30">
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 stat-label text-[11px] uppercase tracking-wide">
            Stale threshold (days)
            <input
              type="number"
              min={1}
              value={thresholdDays}
              onChange={(e) => setThresholdDays(Number(e.target.value))}
              className="w-[60px] h-[32px] bg-white border border-matcha-200 rounded px-2 text-[13px] outline-none focus:border-matcha-400"
            />
          </label>
          <button
            type="button"
            onClick={() => void handleMarkStale()}
            disabled={busy || !(thresholdDays > 0)}
            className="btn-secondary h-[32px] px-3 text-[12px]"
          >
            Mark stale
          </button>
        </div>
        <button
          type="button"
          onClick={() => void handleDeleteRejected()}
          disabled={busy}
          className="text-rose-800 font-medium text-[12px] hover:underline disabled:opacity-55 disabled:cursor-not-allowed"
        >
          Delete all rejected
        </button>
      </div>

      {error && (
        <div className="rounded-xl border-[0.5px] border-rose-100 bg-white px-3.5 py-2.5 text-[13px] text-rose-800">
          {error}
        </div>
      )}
    </div>
  );
}
