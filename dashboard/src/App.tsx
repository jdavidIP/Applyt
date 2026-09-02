import { useCallback, useEffect, useState } from 'react';
import { IconCircleCheck, IconSettings, IconPlus } from '@tabler/icons-react';
import { api } from './api';
import type { Application, ApplicationInput, Filters, Status } from './types';
import { ApplicationsTable } from './components/ApplicationsTable';
import { AddEditForm } from './components/AddEditForm';
import { FilterBar } from './components/FilterBar';
import { ExportButton } from './components/ExportButton';
import { StatsBar } from './components/StatsBar';
import { MaintenancePanel } from './components/MaintenancePanel';
import { Pagination } from './components/Pagination';
import { SettingsModal } from './components/SettingsModal';
import { TailorModal } from './components/TailorModal';
import { TrendModal } from './components/TrendModal';
import { useToast } from './components/Toast';
import { useLifecycleStats } from './hooks/useLifecycleStats';

// Issue #20 page-wide zoom (see the comment above the layout below) — kept as
// one constant since the sidebar's height compensates for this exact value;
// changing one without the other would silently reintroduce the 12% overshoot.
const PAGE_ZOOM = 1.12;

const DEFAULT_FILTERS: Filters = {
  platform: '',
  status: '',
  sort: 'date_applied',
  order: 'desc',
  page: 1,
};

export default function App() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Application | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tailoring, setTailoring] = useState<Application | null>(null);
  const [trendsOpen, setTrendsOpen] = useState(false);
  const { showToast } = useToast();

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await api.list(filters);
      setApplications(res.items);
      setTotal(res.total);
      setPageSize(res.pageSize);
      // The backend clamps to the last valid page (e.g. after a delete shrinks
      // the result set past the requested page); mirror that back into filters
      // so Pagination and the next fetch stay in sync instead of re-requesting
      // the now-empty page.
      if (res.page !== filters.page) {
        setFilters((f) => ({ ...f, page: res.page }));
      }
    } catch (err) {
      // A background poll failing silently (e.g. a momentary network hiccup)
      // shouldn't surface an error banner over an already-loaded table.
      if (!silent) setError(err instanceof Error ? err.message : 'Failed to load applications.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const {
    stats,
    error: lifecycleError,
    thresholdDays,
    setThresholdDays,
    busy: lifecycleBusy,
    handleMarkStale,
    handleDeleteRejected,
    refreshStats,
  } = useLifecycleStats(() => void load());

  // Extension-detected applications land straight in the DB behind our back
  // (no dashboard-initiated fetch triggers a reload), so poll in the
  // background to pick them up without the user having to refresh. No modal
  // open only, so an in-progress edit/tailor form isn't reset from under the
  // user by a background reload.
  useEffect(() => {
    const modalOpen = formOpen || tailoring !== null || settingsOpen || trendsOpen;
    if (modalOpen) return;
    const id = setInterval(() => {
      void load(true);
      void refreshStats();
    }, 5000);
    return () => clearInterval(id);
  }, [load, refreshStats, formOpen, tailoring, settingsOpen, trendsOpen]);

  async function handleSubmit(input: ApplicationInput) {
    if (editing) {
      await api.update(editing.id, input);
    } else {
      await api.create(input);
    }
    setFormOpen(false);
    setEditing(null);
    await load();
  }

  async function handleStatusChange(app: Application, next: Status) {
    setBusyId(app.id);
    try {
      await api.update(app.id, { status: next });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(app: Application) {
    if (!window.confirm(`Delete the application for ${app.title} at ${app.company}?`)) return;
    setBusyId(app.id);
    try {
      await api.remove(app.id);
      showToast({ tone: 'success', message: `Deleted ${app.title} at ${app.company}.` });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete.');
    } finally {
      setBusyId(null);
    }
  }

  // Issue #20: page felt too small/sparse at 100% — a mild zoom (not a
  // font-size rescale, since most sizing here is literal px matching the
  // approved mockups) makes the whole page read bigger without touching
  // every component's spacing individually.
  //
  // Sidebar redesign (approved SuperDesign draft): filters + brand mark +
  // maintenance actions live in a matcha-tinted sidebar; the main content
  // area gets a top bar combining the lifecycle stats with the header
  // action buttons, then the table/pagination below.
  //
  // The sidebar is `sticky top-0` with a `min-h` floor rather than
  // `h-screen`/`h-full` (an exact box), so its content lays out normally
  // instead of being force-fit with a scrollbar. The floor itself is
  // `100vh / 1.12`, not plain `100vh`: `vh` resolves against the real
  // viewport regardless of the ancestor `zoom` above, but `zoom` then paints
  // that whole box 1.12x larger — so a plain `min-h-screen` box visually
  // overshoots the viewport by 12%, and anything pinned to its bottom via
  // mt-auto (MaintenancePanel) lands 12% below the visible fold with no way
  // to scroll to it. Dividing out the zoom factor makes the box's *painted*
  // height match the real viewport exactly, so mt-auto lands right at the
  // visible bottom edge.
  return (
    <div className="min-h-screen bg-cream flex" style={{ zoom: PAGE_ZOOM }}>
      <aside
        className="w-[280px] shrink-0 self-start sticky top-0 bg-matcha-50 border-r-[0.5px] border-matcha-200 flex flex-col p-6"
        style={{ minHeight: `calc(100vh / ${PAGE_ZOOM})` }}
      >
        <div className="flex items-center gap-2 mb-10">
          <IconCircleCheck className="text-matcha-400" size={28} stroke={1.75} />
          <div>
            <h1 className="text-2xl font-medium tracking-tight text-ink m-0">Applyt</h1>
            <p className="text-ink-soft text-[11px] m-0">Local Job Tracking</p>
          </div>
        </div>

        <FilterBar filters={filters} onChange={(next) => setFilters({ ...next, page: 1 })} />

        <MaintenancePanel
          thresholdDays={thresholdDays}
          onThresholdChange={setThresholdDays}
          busy={lifecycleBusy}
          onMarkStale={() => void handleMarkStale()}
          onDeleteRejected={() => void handleDeleteRejected()}
          error={lifecycleError}
        />
      </aside>

      <main className="flex-1 px-10 py-10">
        <div className="card p-4 mb-6 flex items-center justify-between">
          <StatsBar stats={stats} onOpenTrends={() => setTrendsOpen(true)} />
          <div className="flex gap-3">
            <button
              type="button"
              className="btn-secondary px-4 py-2 flex items-center gap-2"
              onClick={() => setSettingsOpen(true)}
            >
              <IconSettings size={18} stroke={1.75} />
              Settings
            </button>
            <ExportButton />
            <button
              type="button"
              className="btn-primary px-4 py-2 flex items-center gap-2"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <IconPlus size={18} stroke={1.75} />
              Add application
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border-[0.5px] border-rose-100 bg-white px-3.5 py-2.5 text-[13px] text-rose-800 mb-6 flex items-center gap-2">
            {error}
            <button type="button" className="btn-ghost text-xs px-2 py-1" onClick={() => void load()}>
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <p className="text-center text-ink-soft py-10">Loading…</p>
        ) : (
          <>
            <ApplicationsTable
              applications={applications}
              onStatusChange={handleStatusChange}
              onEdit={(app) => {
                setEditing(app);
                setFormOpen(true);
              }}
              onDelete={handleDelete}
              onTailor={(app) => setTailoring(app)}
              busyId={busyId}
            />
            <Pagination
              page={filters.page}
              pageSize={pageSize}
              total={total}
              onPageChange={(page) => setFilters((f) => ({ ...f, page }))}
            />
          </>
        )}

        {formOpen && (
          <AddEditForm
            editing={editing}
            onSubmit={handleSubmit}
            onCancel={() => {
              setFormOpen(false);
              setEditing(null);
            }}
          />
        )}

        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

        {tailoring && (
          <TailorModal
            application={tailoring}
            onClose={() => setTailoring(null)}
            onTailored={() => void load()}
          />
        )}

        {trendsOpen && <TrendModal onClose={() => setTrendsOpen(false)} />}
      </main>
    </div>
  );
}
