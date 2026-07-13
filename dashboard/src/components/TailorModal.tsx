import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { formatDate } from '../labels';
import { triggerBlobDownload } from '../download';
import { parseTailoredResume } from '../tailoredResume';
import type { Application, ResumeVersion, TailorEstimate, ResumeDownloadFormat } from '../types';

// Strips characters that aren't filesystem-safe on Windows/macOS/Linux,
// collapsing runs of them to a single hyphen.
function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'resume';
}

const DOWNLOAD_LABELS: Record<ResumeDownloadFormat, string> = {
  pdf: 'Download PDF',
  docx: 'Download Word',
  txt: 'Download .txt',
};

// Renders the 0–5 match rating as filled/empty stars plus an "(N/5)" label.
function MatchStars({ rating }: { rating: number }) {
  const filled = Math.max(0, Math.min(5, rating));
  return (
    <span className="match-stars" aria-label={`Match rating ${filled} out of 5`}>
      <span className="match-stars-glyphs" aria-hidden>
        {'★'.repeat(filled)}
        {'☆'.repeat(5 - filled)}
      </span>
      <span className="match-stars-label">{filled}/5</span>
    </span>
  );
}

interface Props {
  application: Application;
  onClose: () => void;
  // Tailoring links a new resume_version to the application, so the parent
  // list should refresh to reflect resume_version_id.
  onTailored: () => void;
}

// Formats the stored per-run cost. Shows more precision for sub-cent amounts so
// a $0.004 tailor doesn't round to "$0.00". null means the model had no pricing
// configured — we say "unknown", never a fabricated number.
function formatCost(cost: number | null): string {
  if (cost === null || cost === undefined) return 'cost unknown';
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function usageSummary(v: ResumeVersion): string {
  const tokens =
    v.input_tokens != null && v.output_tokens != null
      ? `${v.input_tokens.toLocaleString()} in / ${v.output_tokens.toLocaleString()} out tokens`
      : null;
  return [v.model, tokens, formatCost(v.cost)].filter(Boolean).join(' · ');
}

// Describes a pre-generate estimate. 'historical' is the trustworthy case
// (extrapolated from this model's own real cost history); 'static' is a rough
// chars/4-token guess with no history yet; 'unavailable' means the model has
// neither, so no number is shown at all — never a fabricated one.
function estimateSummary(e: TailorEstimate): string {
  if (e.source === 'unavailable' || e.estimatedCost === null) {
    return `Cost estimate unavailable — no pricing configured for ${e.model}.`;
  }
  const cost = formatCost(e.estimatedCost);
  if (e.source === 'historical') {
    return `Estimated cost: ~${cost} (based on ${e.sampleSize} previous run${e.sampleSize === 1 ? '' : 's'})`;
  }
  return `Estimated cost: ~${cost} (rough estimate, no history yet for ${e.model})`;
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
  const [estimate, setEstimate] = useState<TailorEstimate | null>(null);
  const [downloading, setDownloading] = useState<ResumeDownloadFormat | null>(null);

  const hasJobDescription = Boolean(application.job_description?.trim());

  // Parse the raw stored output into its four sections for display. Handles
  // both the current marker-delimited format and older pre-structured rows.
  const sections = useMemo(
    () => (selected ? parseTailoredResume(selected.tailored_output ?? '') : null),
    [selected],
  );

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

  useEffect(() => {
    if (!hasJobDescription) {
      setEstimate(null);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const est = await api.estimateTailorCost(application.id);
        if (active) setEstimate(est);
      } catch {
        // Estimate is supplementary (e.g. no base resume configured yet) —
        // fail silently rather than blocking the tailor action on it.
        if (active) setEstimate(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [application.id, hasJobDescription]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const version = await api.tailor(application.id);
      setVersions((prev) => [version, ...prev]);
      setSelected(version);
      onTailored();
      // Refresh the estimate so a follow-up run in this session reflects the
      // history this run just added.
      try {
        setEstimate(await api.estimateTailorCost(application.id));
      } catch {
        // Non-critical; leave the previous estimate displayed.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to tailor resume.');
    } finally {
      setGenerating(false);
    }
  }

  // Renders the stored version on demand into the requested format (server
  // side, resumeRender.ts) — every past or present version is downloadable
  // in any format, not just whatever was chosen when it was generated.
  async function handleDownload(format: ResumeDownloadFormat) {
    if (!selected) return;
    setDownloading(format);
    setError(null);
    try {
      const blob = await api.downloadResumeVersion(application.id, selected.id, format);
      const filename = `${sanitizeFilenamePart(application.company)}-${sanitizeFilenamePart(application.title)}-resume.${format}`;
      triggerBlobDownload(blob, filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to download the ${format.toUpperCase()}.`);
    } finally {
      setDownloading(null);
    }
  }

  async function handleCopy() {
    // Copy just the tailored resume (what's shown in the textarea), not the
    // match/suggestions meta — that's the text the user actually pastes.
    if (!sections?.resume) return;
    try {
      await navigator.clipboard.writeText(sections.resume);
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

        {estimate && <p className="muted-note tailor-estimate">{estimateSummary(estimate)}</p>}

        {error && <p className="form-error">{error}</p>}

        {selected && sections && (
          <div className="tailor-output">
            <div className="tailor-output-header">
              <span className="stat-label">
                {selected.ai_provider} · {formatDate(selected.created_at)}
              </span>
              <div className="tailor-output-actions">
                <button className="btn btn-secondary btn-sm" onClick={() => void handleCopy()}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
                {(['pdf', 'docx', 'txt'] as const).map((format) => (
                  <button
                    key={format}
                    className="btn btn-secondary btn-sm"
                    onClick={() => void handleDownload(format)}
                    disabled={downloading !== null}
                  >
                    {downloading === format ? 'Downloading…' : DOWNLOAD_LABELS[format]}
                  </button>
                ))}
              </div>
            </div>
            <p className="tailor-usage">{usageSummary(selected)}</p>

            {(sections.matchRating !== null || sections.matchJustification) && (
              <div className="tailor-match">
                <div className="tailor-section-head">
                  <span className="stat-label">Match</span>
                  {sections.matchRating !== null && <MatchStars rating={sections.matchRating} />}
                </div>
                {sections.matchJustification && (
                  <div className="tailor-section-body">{sections.matchJustification}</div>
                )}
              </div>
            )}

            <span className="stat-label">Tailored resume</span>
            <textarea readOnly value={sections.resume} rows={16} />

            {sections.suggestions && (
              <div className="tailor-suggestions">
                <span className="stat-label">Interview &amp; cover-letter suggestions</span>
                <div className="tailor-section-body">{sections.suggestions}</div>
              </div>
            )}
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
