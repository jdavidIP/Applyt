import { useState } from 'react';
import {
  PLATFORMS,
  APPLY_METHODS,
  STATUSES,
  type Application,
  type ApplicationInput,
} from '../types';
import { PLATFORM_LABELS, APPLY_METHOD_LABELS, STATUS_LABELS } from '../labels';

interface Props {
  editing: Application | null;
  onSubmit: (input: ApplicationInput) => Promise<void>;
  onCancel: () => void;
}

function initialState(editing: Application | null): ApplicationInput {
  if (editing) {
    return {
      platform: editing.platform,
      company: editing.company,
      title: editing.title,
      job_url: editing.job_url ?? '',
      platform_job_id: editing.platform_job_id ?? '',
      apply_method: editing.apply_method,
      status: editing.status,
      notes: editing.notes ?? '',
    };
  }
  return {
    platform: 'manual',
    company: '',
    title: '',
    job_url: '',
    platform_job_id: '',
    apply_method: 'manual',
    status: 'applied',
    notes: '',
  };
}

// Manual add / edit form. company + title are required; enum fields are dropdowns
// bound to the same unions as the backend so invalid values can't be submitted.
export function AddEditForm({ editing, onSubmit, onCancel }: Props) {
  const [form, setForm] = useState<ApplicationInput>(() => initialState(editing));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function set<K extends keyof ApplicationInput>(key: K, value: ApplicationInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.company.trim() || !form.title.trim()) {
      setError('Company and title are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        ...form,
        company: form.company.trim(),
        title: form.title.trim(),
        job_url: form.job_url?.trim() || null,
        platform_job_id: form.platform_job_id?.trim() || null,
        notes: form.notes?.trim() || null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <h2>{editing ? 'Edit application' : 'Add application'}</h2>

        <div className="form-grid">
          <label>
            Company *
            <input
              value={form.company}
              onChange={(e) => set('company', e.target.value)}
              required
              autoFocus
            />
          </label>
          <label>
            Title *
            <input value={form.title} onChange={(e) => set('title', e.target.value)} required />
          </label>
          <label>
            Platform
            <select
              value={form.platform}
              onChange={(e) => set('platform', e.target.value as ApplicationInput['platform'])}
            >
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {PLATFORM_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Apply method
            <select
              value={form.apply_method}
              onChange={(e) =>
                set('apply_method', e.target.value as ApplicationInput['apply_method'])
              }
            >
              {APPLY_METHODS.map((m) => (
                <option key={m} value={m}>
                  {APPLY_METHOD_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select
              value={form.status}
              onChange={(e) => set('status', e.target.value as ApplicationInput['status'])}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Job URL
            <input
              value={form.job_url ?? ''}
              onChange={(e) => set('job_url', e.target.value)}
              placeholder="https://…"
            />
          </label>
          <label className="span-2">
            Notes
            <textarea
              value={form.notes ?? ''}
              onChange={(e) => set('notes', e.target.value)}
              rows={3}
            />
          </label>
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add'}
          </button>
        </div>
      </form>
    </div>
  );
}
