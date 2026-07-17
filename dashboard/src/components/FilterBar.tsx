import { PLATFORMS, STATUSES, type Filters } from '../types';
import { PLATFORM_LABELS, STATUS_LABELS } from '../labels';

interface Props {
  filters: Filters;
  onChange: (next: Filters) => void;
}

const selectClass =
  'bg-white border border-matcha-200 rounded-lg px-2 h-[36px] text-[13px] outline-none focus:border-matcha-400';

// Drives the GET query params (platform/status filter, sort field + direction).
// Platform/status were pill filter chips in the first pass, but with 7+
// status values that read as visual clutter rather than a clean filter row
// (Issue #20) — plain dropdowns instead, matching Sort by / Order.
export function FilterBar({ filters, onChange }: Props) {
  return (
    <div className="card p-5 mb-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="flex flex-col gap-2">
          <span className="stat-label">Platform</span>
          <select
            value={filters.platform ?? ''}
            onChange={(e) => onChange({ ...filters, platform: e.target.value as Filters['platform'] })}
            className={selectClass}
          >
            <option value="">All</option>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABELS[p]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <span className="stat-label">Status</span>
          <select
            value={filters.status ?? ''}
            onChange={(e) => onChange({ ...filters, status: e.target.value as Filters['status'] })}
            className={selectClass}
          >
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <span className="stat-label">Sort by</span>
          <select
            value={filters.sort}
            onChange={(e) => onChange({ ...filters, sort: e.target.value as Filters['sort'] })}
            className={selectClass}
          >
            <option value="date_applied">Date applied</option>
            <option value="date_last_updated">Last updated</option>
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <span className="stat-label">Order</span>
          <select
            value={filters.order}
            onChange={(e) => onChange({ ...filters, order: e.target.value as Filters['order'] })}
            className={selectClass}
          >
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </div>
      </div>
    </div>
  );
}
