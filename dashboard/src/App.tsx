import { useCallback, useEffect, useState } from 'react';
import { IconCircleCheck, IconSettings, IconPlus } from '@tabler/icons-react';
import { api } from './api';
import type { Application, ApplicationInput, Filters, Status } from './types';
import { ApplicationsTable } from './components/ApplicationsTable';
import { AddEditForm } from './components/AddEditForm';
import { FilterBar } from './components/FilterBar';
import { ExportButton } from './components/ExportButton';
import { LifecyclePanel } from './components/LifecyclePanel';
import { Pagination } from './components/Pagination';
import { SettingsModal } from './components/SettingsModal';
import { TailorModal } from './components/TailorModal';
import { useToast } from './components/Toast';

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
  const { showToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.list(filters);
      setApplications(res.items);
      setTotal(res.total);
      setPageSize(res.pageSize);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load applications.');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

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
  return (
    <div className="min-h-screen bg-cream [zoom:1.12]">
      <div className="max-w-[1100px] mx-auto px-5 py-10">
        <header className="flex justify-between items-start mb-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <IconCircleCheck className="text-matcha-400" size={28} stroke={1.75} />
              <h1 className="text-2xl font-medium tracking-tight text-ink m-0">Applyt</h1>
            </div>
            <p className="text-ink-soft m-0">Your job applications, tracked locally.</p>
          </div>
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
        </header>

        <LifecyclePanel onApplicationsChanged={() => void load()} />

        <FilterBar filters={filters} onChange={(next) => setFilters({ ...next, page: 1 })} />

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
      </div>
    </div>
  );
}
