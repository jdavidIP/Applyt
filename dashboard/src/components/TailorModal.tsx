import { useEffect, useMemo, useRef, useState } from 'react';
import {
  IconChevronDown,
  IconCheck,
  IconCopy,
  IconFileTypePdf,
  IconFileTypeDocx,
  IconFileText,
  IconStar,
  IconStarFilled,
  IconSparkles,
  IconBulb,
} from '@tabler/icons-react';
import { api } from '../api';
import { formatDate } from '../labels';
import { triggerBlobDownload } from '../download';
import { parseTailoredResume } from '../tailoredResume';
import type { Application, ResumeVersion, TailorEstimate, ResumeDownloadFormat } from '../types';
import { Modal } from './Modal';

// Strips characters that aren't filesystem-safe on Windows/macOS/Linux,
// collapsing runs of them to a single hyphen.
function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'resume';
}

const DOWNLOAD_META: Record<ResumeDownloadFormat, { label: string; icon: typeof IconFileTypePdf }> = {
  pdf: { label: 'PDF', icon: IconFileTypePdf },
  docx: { label: 'Word', icon: IconFileTypeDocx },
  txt: { label: 'txt', icon: IconFileText },
};

// Renders the 0–5 match rating as filled/empty star icons plus an "N/5 Match Rating" label.
function MatchStars({ rating }: { rating: number }) {
  const filled = Math.max(0, Math.min(5, rating));
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-0.5" aria-label={`Match rating ${filled} out of 5`}>
        {Array.from({ length: 5 }, (_, i) =>
          i < filled ? (
            <IconStarFilled key={i} size={18} className="text-amber-800" />
          ) : (
            <IconStar key={i} size={18} className="text-matcha-200" />
          ),
        )}
      </div>
      <span className="font-medium text-amber-800">{filled}/5 Match Rating</span>
    </div>
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
  const [includeMatchRating, setIncludeMatchRating] = useState(true);
  const [includeSuggestions, setIncludeSuggestions] = useState(true);
  const [targetOnePage, setTargetOnePage] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!optionsOpen) return;
    const onClickAway = (e: MouseEvent) => {
      if (optionsRef.current && !optionsRef.current.contains(e.target as Node)) setOptionsOpen(false);
    };
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, [optionsOpen]);

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
      const version = await api.tailor(application.id, {
        includeMatchRating,
        includeSuggestions,
        targetOnePage,
      });
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

  const optionRows: { label: string; checked: boolean; onToggle: () => void }[] = [
    { label: 'Include match rating', checked: includeMatchRating, onToggle: () => setIncludeMatchRating((v) => !v) },
    {
      label: 'Include interview & cover-letter suggestions',
      checked: includeSuggestions,
      onToggle: () => setIncludeSuggestions((v) => !v),
    },
    { label: 'Target one page', checked: targetOnePage, onToggle: () => setTargetOnePage((v) => !v) },
  ];

  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <IconSparkles size={18} className="text-matcha-400" />
          {`Tailor resume — ${application.title} at ${application.company}`}
        </span>
      }
      wide
      onClose={onClose}
      footer={
        <button type="button" className="btn-ghost px-6 py-2 text-sm" onClick={onClose}>
          Close
        </button>
      }
    >
      {!hasJobDescription && (
        <div className="bg-amber-100 text-amber-800 rounded-xl p-3.5 text-[13px] mb-4">
          This application has no job description yet. Add one via Edit before tailoring.
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-4">
          <div className="relative flex items-center" ref={optionsRef}>
            <button
              type="button"
              onClick={() => void handleGenerate()}
              disabled={generating || !hasJobDescription}
              className="bg-matcha-400 hover:bg-matcha-600 disabled:opacity-55 disabled:cursor-not-allowed text-white font-medium text-sm px-6 py-2.5 rounded-l-lg transition-colors flex items-center gap-2"
            >
              {generating ? 'Generating…' : versions.length ? 'Generate new version' : 'Tailor for this job'}
            </button>
            <button
              type="button"
              onClick={() => setOptionsOpen((v) => !v)}
              aria-label="Tailoring options"
              className="bg-matcha-400 hover:bg-matcha-600 text-white px-2 py-2.5 rounded-r-lg border-l border-white/20 transition-colors flex items-center"
            >
              <IconChevronDown size={18} />
            </button>
            {optionsOpen && (
              <div className="absolute top-full left-0 mt-2 w-72 bg-white border-[0.5px] border-matcha-200 rounded-xl z-10 py-1.5">
                {optionRows.map((row) => (
                  <div
                    key={row.label}
                    onClick={row.onToggle}
                    className="px-4 py-2 hover:bg-matcha-50 cursor-pointer flex justify-between items-center transition-colors"
                  >
                    <span className="text-ink">{row.label}</span>
                    {row.checked ? <IconCheck size={18} className="text-matcha-600" /> : <div className="w-[18px]" />}
                  </div>
                ))}
              </div>
            )}
          </div>
          <span className="text-ink-soft text-[11px]">{versions.length} version(s) saved</span>
        </div>
        {estimate && <p className="text-ink-soft text-[10px] italic">{estimateSummary(estimate)}</p>}
      </div>

      {error && <p className="text-rose-800 text-[13px] mt-3">{error}</p>}

      {selected && sections && (
        <div className="border-t border-matcha-200 pt-6 mt-6 flex flex-col gap-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex flex-col">
              <span className="text-[11px] font-medium text-ink-soft uppercase tracking-wider">
                {selected.ai_provider} · {formatDate(selected.created_at)}
              </span>
              <span className="text-[10px] text-ink-soft">{usageSummary(selected)}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-secondary flex items-center gap-1.5 px-3 py-1.5 text-[12px] whitespace-nowrap"
                onClick={() => void handleCopy()}
              >
                <IconCopy size={14} />
                {copied ? 'Copied' : 'Copy'}
              </button>
              {(['pdf', 'docx', 'txt'] as const).map((format) => {
                const { label, icon: Icon } = DOWNLOAD_META[format];
                return (
                  <button
                    key={format}
                    type="button"
                    className="btn-secondary flex items-center gap-1.5 px-3 py-1.5 text-[12px] whitespace-nowrap disabled:opacity-55"
                    onClick={() => void handleDownload(format)}
                    disabled={downloading !== null}
                  >
                    <Icon size={14} />
                    {downloading === format ? '…' : label}
                  </button>
                );
              })}
            </div>
          </div>

          {(sections.matchRating !== null || sections.matchJustification) && (
            <div className="card p-4 flex flex-col gap-3">
              {sections.matchRating !== null && <MatchStars rating={sections.matchRating} />}
              {sections.matchJustification && (
                <p className="text-ink leading-relaxed m-0">{sections.matchJustification}</p>
              )}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <label className="text-[11px] font-medium text-ink-soft uppercase tracking-wider">Tailored resume</label>
            <textarea
              readOnly
              value={sections.resume}
              rows={16}
              className="w-full card p-4 font-mono text-xs leading-relaxed focus:outline-none bg-matcha-50/20"
            />
          </div>

          {sections.suggestions && (
            <div className="card p-4 flex flex-col gap-2">
              <div className="flex items-center gap-2 font-medium text-matcha-800">
                <IconBulb size={16} />
                <span>Suggestions &amp; Interview Prep</span>
              </div>
              <div className="text-ink leading-relaxed whitespace-pre-wrap">{sections.suggestions}</div>
            </div>
          )}
        </div>
      )}

      {versions.length > 1 && (
        <div className="flex flex-wrap gap-2 pt-4">
          {versions.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setSelected(v)}
              className={`filter-chip ${selected?.id === v.id ? 'filter-chip-active' : 'filter-chip-inactive'}`}
            >
              {v.ai_provider} · {formatDate(v.created_at)}
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
