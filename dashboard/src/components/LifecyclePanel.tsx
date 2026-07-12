import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { StatsResponse } from '../types';

interface Props {
  // Bulk actions mutate rows behind the parent's back, so it must reload its
  // own applications list after either one completes.
  onApplicationsChanged: () => void;
}

const DEFAULT_THRESHOLD_DAYS = 30;

// Phase 3 (CLAUDE.md §7): bulk lifecycle actions (mark stale, bulk-delete
// rejected) plus basic stats (applications/week, response rate).
export function LifecyclePanel({ onApplicationsChanged }: Props) {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thresholdDays, setThresholdDays] = useState(DEFAULT_THRESHOLD_DAYS);
  const [busy, setBusy] = useState(false);

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
      window.alert(`Marked ${updated} application${updated === 1 ? '' : 's'} as stale.`);
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
      window.alert(`Deleted ${deleted} rejected application${deleted === 1 ? '' : 's'}.`);
      onApplicationsChanged();
      await loadStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to bulk-delete.');
    } finally {
      setBusy(false);
    }
  }

  const maxWeekCount = stats ? Math.max(1, ...stats.perWeek.map((w) => w.count)) : 1;

  return (
    <div className="lifecycle-panel">
      <div className="lifecycle-actions">
        <label>
          Stale threshold (days)
          <input
            type="number"
            min={1}
            value={thresholdDays}
            onChange={(e) => setThresholdDays(Number(e.target.value))}
          />
        </label>
        <button
          className="btn btn-secondary"
          onClick={() => void handleMarkStale()}
          disabled={busy || !(thresholdDays > 0)}
        >
          Mark stale
        </button>
        <button className="btn btn-danger" onClick={() => void handleDeleteRejected()} disabled={busy}>
          Delete all rejected
        </button>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      {stats && (
        <div className="stats">
          <div className="stat">
            <span className="stat-label">Total applications</span>
            <span className="stat-value">{stats.totalApplications}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Response rate</span>
            <span className="stat-value">
              {stats.responseRate === null ? '—' : `${Math.round(stats.responseRate * 100)}%`}
            </span>
          </div>
          <div className="stat stat-chart">
            <span className="stat-label">Applications per week</span>
            <div className="week-chart">
              {stats.perWeek.map((w) => (
                <div key={w.weekStart} className="week-bar-wrap" title={`${w.weekStart}: ${w.count}`}>
                  <div className="week-bar" style={{ height: `${(w.count / maxWeekCount) * 100}%` }} />
                  <span className="week-count">{w.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
