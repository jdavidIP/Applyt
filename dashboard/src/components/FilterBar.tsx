import { useEffect, useRef, useState } from 'react';
import { PLATFORMS, STATUSES, type Filters } from '../types';
import { PLATFORM_LABELS, STATUS_LABELS } from '../lib/labels';

interface Props {
  filters: Filters;
  onChange: (next: Filters) => void;
}

const selectClass = 'input-field h-[36px]';

const SEARCH_DEBOUNCE_MS = 300;

// Drives the GET query params (platform/status filter, search, sort field +
// direction). Platform/status were pill filter chips in the first pass, but
// with 7+ status values that read as visual clutter rather than a clean
// filter row (Issue #20) — plain dropdowns instead, matching Sort by / Order.
// Stacked vertically (not a card/grid) since this now lives in the sidebar
// (approved sidebar-redesign draft) rather than its own horizontal card.
export function FilterBar({ filters, onChange }: Props) {
  // Local, debounced copy of the search text: the dropdowns below fire
  // onChange immediately (a request per selection is fine), but a text input
  // would otherwise fire a request per keystroke.
  const [searchText, setSearchText] = useState(filters.search ?? '');

  // The debounce timer's callback fires after this render is long gone, so it
  // must read the LATEST filters (via this ref) rather than close over the
  // `filters` value from when the timer was scheduled — otherwise a dropdown
  // change made during the debounce window gets silently overwritten back to
  // its pre-change value when the stale timer finally fires.
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  useEffect(() => {
    setSearchText(filters.search ?? '');
  }, [filters.search]);

  useEffect(() => {
    const trimmed = searchText.trim();
    if (trimmed === (filters.search ?? '')) return;
    const timer = setTimeout(
      () => onChange({ ...filtersRef.current, search: trimmed }),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-[11px] uppercase tracking-wider text-ink-soft font-medium m-0">Filters</h2>

      <label className="flex flex-col gap-2">
        <span className="stat-label">Search</span>
        <input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Company, title…"
          className={selectClass}
        />
      </label>

      <div className="flex flex-col gap-2">
        <span className="stat-label">Platform</span>
        <select
          value={filters.platform ?? ''}
          onChange={(e) => onChange({ ...filters, platform: e.target.value as Filters['platform'] })}
          className={selectClass}
        >
          <option value="">All Platforms</option>
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
          <option value="">All Statuses</option>
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
  );
}
