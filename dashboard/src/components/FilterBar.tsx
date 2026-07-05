import { PLATFORMS, STATUSES, type Filters } from '../types';
import { PLATFORM_LABELS, STATUS_LABELS } from '../labels';

interface Props {
  filters: Filters;
  onChange: (next: Filters) => void;
}

// Drives the GET query params (platform/status filter, sort field + direction).
export function FilterBar({ filters, onChange }: Props) {
  return (
    <div className="filter-bar">
      <label>
        Platform
        <select
          value={filters.platform ?? ''}
          onChange={(e) => onChange({ ...filters, platform: e.target.value as Filters['platform'] })}
        >
          <option value="">All</option>
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {PLATFORM_LABELS[p]}
            </option>
          ))}
        </select>
      </label>

      <label>
        Status
        <select
          value={filters.status ?? ''}
          onChange={(e) => onChange({ ...filters, status: e.target.value as Filters['status'] })}
        >
          <option value="">All</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <label>
        Sort by
        <select
          value={filters.sort}
          onChange={(e) => onChange({ ...filters, sort: e.target.value as Filters['sort'] })}
        >
          <option value="date_applied">Date applied</option>
          <option value="date_last_updated">Last updated</option>
        </select>
      </label>

      <label>
        Order
        <select
          value={filters.order}
          onChange={(e) => onChange({ ...filters, order: e.target.value as Filters['order'] })}
        >
          <option value="desc">Newest first</option>
          <option value="asc">Oldest first</option>
        </select>
      </label>
    </div>
  );
}
