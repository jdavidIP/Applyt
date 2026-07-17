import { useState } from 'react';
import {
  PLATFORMS,
  APPLY_METHODS,
  STATUSES,
  type Application,
  type ApplicationInput,
} from '../types';
import { PLATFORM_LABELS, APPLY_METHOD_LABELS, STATUS_LABELS } from '../labels';
import { Modal } from './Modal';

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
      job_description: editing.job_description ?? '',
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
    job_description: '',
  };
}

const labelClass = 'text-[11px] text-ink-soft font-medium uppercase tracking-wide mb-1.5 block';

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
        job_description: form.job_description?.trim() || null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={editing ? 'Edit application' : 'Add application'}
      onClose={onCancel}
      onSubmit={handleSubmit}
      footer={
        <>
          <button type="button" className="btn-ghost px-5 py-2" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn-primary px-6 py-2" disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-5">
        <label className="col-span-1">
          <span className={labelClass}>
            Company <span className="text-matcha-600">*</span>
          </span>
          <input
            className="input-field"
            value={form.company}
            onChange={(e) => set('company', e.target.value)}
            required
            autoFocus
          />
        </label>
        <label className="col-span-1">
          <span className={labelClass}>
            Title <span className="text-matcha-600">*</span>
          </span>
          <input className="input-field" value={form.title} onChange={(e) => set('title', e.target.value)} required />
        </label>
        <label className="col-span-1">
          <span className={labelClass}>Platform</span>
          <select
            className="input-field"
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
        <label className="col-span-1">
          <span className={labelClass}>Apply method</span>
          <select
            className="input-field"
            value={form.apply_method}
            onChange={(e) => set('apply_method', e.target.value as ApplicationInput['apply_method'])}
          >
            {APPLY_METHODS.map((m) => (
              <option key={m} value={m}>
                {APPLY_METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="col-span-1">
          <span className={labelClass}>Status</span>
          <select
            className="input-field"
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
        <label className="col-span-1">
          <span className={labelClass}>Job URL</span>
          <input
            className="input-field"
            value={form.job_url ?? ''}
            onChange={(e) => set('job_url', e.target.value)}
            placeholder="https://…"
          />
        </label>
        <label className="col-span-2">
          <span className={labelClass}>Notes</span>
          <textarea
            className="input-field resize-none"
            value={form.notes ?? ''}
            onChange={(e) => set('notes', e.target.value)}
            rows={3}
          />
        </label>
        <label className="col-span-2">
          <span className={labelClass}>Job description</span>
          <textarea
            className="input-field resize-none text-[12px]"
            value={form.job_description ?? ''}
            onChange={(e) => set('job_description', e.target.value)}
            rows={5}
            placeholder="Paste the job posting text here — used as the input for AI resume tailoring."
          />
          <p className="mt-1.5 text-[11px] text-ink-soft italic">This data stays private and local on your machine.</p>
        </label>
      </div>

      {error && <p className="text-rose-800 mt-3 text-[13px]">{error}</p>}
    </Modal>
  );
}
