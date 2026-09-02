import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import type { StatsResponse } from '../types';
import { useToast } from '../components/Toast';

const DEFAULT_THRESHOLD_DAYS = 30;

// Phase 3 (CLAUDE.md §7) stats + bulk lifecycle actions, split out of the
// single LifecyclePanel component so the sidebar redesign can render the
// stats (top bar) and the maintenance actions (sidebar) in two different
// places while sharing one fetch/mutation source of truth.
export function useLifecycleStats(onApplicationsChanged: () => void) {
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

  return {
    stats,
    error,
    thresholdDays,
    setThresholdDays,
    busy,
    handleMarkStale,
    handleDeleteRejected,
    refreshStats: loadStats,
  };
}
