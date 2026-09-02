import type { StatsResponse } from '../types';

interface Props {
  stats: StatsResponse | null;
}

// Approved sidebar-redesign draft: the 3 lifecycle stats render inline in a
// single top-bar row (Total / Response / Trend) instead of 3 separate cards,
// sharing one card with the header action buttons — see App.tsx.
export function StatsBar({ stats }: Props) {
  const maxWeekCount = stats ? Math.max(1, ...stats.perWeek.map((w) => w.count)) : 1;

  // perWeek is ordered oldest -> newest (see backend/src/routes/applications.ts
  // computePerWeek), so the last entry is the current week and the one before
  // it is the prior week.
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
    <div className="flex items-center gap-8">
      <div className="flex items-baseline gap-2">
        <span className="stat-label">Total:</span>
        <span className="text-lg font-medium text-ink">{stats ? stats.totalApplications : '—'}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="stat-label">Response:</span>
        <span className="text-lg font-medium text-terracotta-800">
          {!stats || stats.responseRate === null ? '—' : `${Math.round(stats.responseRate * 100)}%`}
        </span>
      </div>
      {stats && (
        <div className="flex items-center gap-3">
          <span className="stat-label">Trend:</span>
          <div className="flex items-end gap-1 h-6">
            {stats.perWeek.map((w) => (
              <div
                key={w.weekStart}
                className="week-bar w-[6px] min-h-[2px]"
                style={{ height: `${(w.count / maxWeekCount) * 100}%` }}
                title={`${w.weekStart}: ${w.count}`}
              />
            ))}
          </div>
          {trend && <span className={`text-[11px] font-medium ${trend.className}`}>{trend.text}</span>}
        </div>
      )}
    </div>
  );
}
