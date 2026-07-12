import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { Application, ApplicationInput, Filters, Status } from './types';
import { ApplicationsTable } from './components/ApplicationsTable';
import { AddEditForm } from './components/AddEditForm';
import { FilterBar } from './components/FilterBar';
import { ExportButton } from './components/ExportButton';
import { LifecyclePanel } from './components/LifecyclePanel';

const DEFAULT_FILTERS: Filters = {
  platform: '',
  status: '',
  sort: 'date_applied',
  order: 'desc',
};

export default function App() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Application | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setApplications(await api.list(filters));
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
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Applyt</h1>
          <p className="subtitle">Your job applications, tracked locally.</p>
        </div>
        <div className="header-actions">
          <ExportButton />
          <button
            className="btn btn-primary"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            Add application
          </button>
        </div>
      </header>

      <LifecyclePanel onApplicationsChanged={() => void load()} />

      <FilterBar filters={filters} onChange={setFilters} />

      {error && (
        <div className="banner banner-error">
          {error} <button className="btn btn-ghost btn-sm" onClick={() => void load()}>Retry</button>
        </div>
      )}

      {loading ? (
        <p className="empty">Loading…</p>
      ) : (
        <ApplicationsTable
          applications={applications}
          onStatusChange={handleStatusChange}
          onEdit={(app) => {
            setEditing(app);
            setFormOpen(true);
          }}
          onDelete={handleDelete}
          busyId={busyId}
        />
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
    </div>
  );
}
