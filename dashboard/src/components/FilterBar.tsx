import { PLATFORMS, STATUSES, type Filters } from '../types';
import { PLATFORM_LABELS, STATUS_LABELS } from '../labels';

interface Props {
  filters: Filters;
  onChange: (next: Filters) => void;
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`filter-chip ${active ? 'filter-chip-active' : 'filter-chip-inactive'}`}
    >
      {children}
    </button>
  );
}

// Drives the GET query params (platform/status filter, sort field + direction).
// Platform/status are single-select chip groups (design system: pill filter
// chips); sort field/direction stay plain selects since they're a value pick,
// not a toggle set.
export function FilterBar({ filters, onChange }: Props) {
  return (
    <div className="card p-5 mb-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="flex flex-col gap-2">
          <span className="stat-label">Platform</span>
          <div className="flex flex-wrap gap-2">
            <Chip active={!filters.platform} onClick={() => onChange({ ...filters, platform: '' })}>
              All
            </Chip>
            {PLATFORMS.map((p) => (
              <Chip
                key={p}
                active={filters.platform === p}
                onClick={() => onChange({ ...filters, platform: p })}
              >
                {PLATFORM_LABELS[p]}
              </Chip>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="stat-label">Status</span>
          <div className="flex flex-wrap gap-2">
            <Chip active={!filters.status} onClick={() => onChange({ ...filters, status: '' })}>
              All
            </Chip>
            {STATUSES.map((s) => (
              <Chip key={s} active={filters.status === s} onClick={() => onChange({ ...filters, status: s })}>
                {STATUS_LABELS[s]}
              </Chip>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="stat-label">Sort by</span>
          <select
            value={filters.sort}
            onChange={(e) => onChange({ ...filters, sort: e.target.value as Filters['sort'] })}
            className="bg-white border border-matcha-200 rounded-lg px-2 h-[36px] text-[13px] outline-none focus:border-matcha-400"
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
            className="bg-white border border-matcha-200 rounded-lg px-2 h-[36px] text-[13px] outline-none focus:border-matcha-400"
          >
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </div>
      </div>
    </div>
  );
}
