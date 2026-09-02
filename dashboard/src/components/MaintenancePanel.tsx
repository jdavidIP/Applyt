interface Props {
  thresholdDays: number;
  onThresholdChange: (days: number) => void;
  busy: boolean;
  onMarkStale: () => void;
  onDeleteRejected: () => void;
  error: string | null;
}

// Bulk lifecycle actions (Phase 3, CLAUDE.md §7), pinned to the bottom of the
// sidebar in the approved sidebar-redesign draft via mt-auto on the parent
// <aside> flex column (App.tsx). Only correct because the aside's height is
// zoom-compensated there — see the comment on `min-h-[calc(...)]` in App.tsx.
export function MaintenancePanel({
  thresholdDays,
  onThresholdChange,
  busy,
  onMarkStale,
  onDeleteRejected,
  error,
}: Props) {
  return (
    <div className="flex flex-col gap-4 mt-auto pt-6 border-t border-matcha-200">
      <div className="flex flex-col gap-2">
        <span className="stat-label uppercase tracking-wide">Maintenance</span>
        <label className="flex items-center gap-2 text-[12px] text-ink-soft">
          Stale at (days)
          <input
            type="number"
            min={1}
            value={thresholdDays}
            onChange={(e) => onThresholdChange(Number(e.target.value))}
            className="w-[50px] h-[28px] bg-white border border-matcha-200 rounded px-1.5 text-[12px] outline-none focus:border-matcha-400"
          />
        </label>
      </div>
      <button
        type="button"
        onClick={onMarkStale}
        disabled={busy || !(thresholdDays > 0)}
        className="btn-secondary py-2 text-[12px] w-full"
      >
        Mark stale
      </button>
      <button
        type="button"
        onClick={onDeleteRejected}
        disabled={busy}
        className="text-rose-800 font-medium text-[12px] hover:underline disabled:opacity-55 disabled:cursor-not-allowed text-left"
      >
        Delete all rejected
      </button>
      {error && (
        <div className="rounded-lg border-[0.5px] border-rose-100 bg-white px-3 py-2 text-[12px] text-rose-800">
          {error}
        </div>
      )}
    </div>
  );
}
