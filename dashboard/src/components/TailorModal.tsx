import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatDate } from '../labels';
import type { Application, ResumeVersion } from '../types';

interface Props {
  application: Application;
  onClose: () => void;
  // Tailoring links a new resume_version to the application, so the parent
  // list should refresh to reflect resume_version_id.
  onTailored: () => void;
}

// Phase 4 (CLAUDE.md §7): "Tailor for this job" — sends the base resume + this
// application's job description to the configured AI provider and stores the
// result. Prior tailored versions for the job are listed and viewable.
export function TailorModal({ application, onClose, onTailored }: Props) {
  const [versions, setVersions] = useState<ResumeVersion[]>([]);
  const [selected, setSelected] = useState<ResumeVersion | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const hasJobDescription = Boolean(application.job_description?.trim());

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const list = await api.listResumeVersions(application.id);
        if (!active) return;
        setVersions(list);
        setSelected(list[0] ?? null);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load versions.');
      }
    })();
    return () => {
      active = false;
    };
  }, [application.id]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const version = await api.tailor(application.id);
      setVersions((prev) => [version, ...prev]);
      setSelected(version);
      onTailored();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to tailor resume.');
    } finally {
      setGenerating(false);
    }
  }

  async function handleCopy() {
    if (!selected?.tailored_output) return;
    try {
      await navigator.clipboard.writeText(selected.tailored_output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (permissions); the textarea is selectable as a fallback.
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>
          Tailor resume — {application.title} at {application.company}
        </h2>

        {!hasJobDescription && (
          <p className="banner banner-warn">
            This application has no job description yet. Add one via Edit before tailoring.
          </p>
        )}

        <div className="tailor-actions">
          <button
            className="btn btn-primary"
            onClick={() => void handleGenerate()}
            disabled={generating || !hasJobDescription}
          >
            {generating ? 'Generating…' : versions.length ? 'Generate new version' : 'Tailor for this job'}
          </button>
          {versions.length > 0 && (
            <span className="muted-note">{versions.length} version(s) saved</span>
          )}
        </div>

        {error && <p className="form-error">{error}</p>}

        {selected && (
          <div className="tailor-output">
            <div className="tailor-output-header">
              <span className="stat-label">
                {selected.ai_provider} · {formatDate(selected.created_at)}
              </span>
              <button className="btn btn-secondary btn-sm" onClick={() => void handleCopy()}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <textarea readOnly value={selected.tailored_output ?? ''} rows={16} />
          </div>
        )}

        {versions.length > 1 && (
          <div className="version-list">
            <span className="stat-label">Previous versions</span>
            <ul>
              {versions.map((v) => (
                <li key={v.id}>
                  <button
                    className={`btn btn-ghost btn-sm ${selected?.id === v.id ? 'is-active' : ''}`}
                    onClick={() => setSelected(v)}
                  >
                    {v.ai_provider} · {formatDate(v.created_at)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
