import { useEffect, useState } from 'react';
import { IconRefresh, IconCurrencyDollar, IconTrash, IconAlertTriangle, IconEye, IconEyeOff } from '@tabler/icons-react';
import { api } from '../api';
import { AI_PROVIDERS, type AiProvider, type ModelPricing, type SettingsInput } from '../types';
import { checkResumeCompleteness, type MissingField } from '../resumeCompleteness';
import { Modal } from './Modal';
import { useToast } from './Toast';

interface Props {
  onClose: () => void;
}

const PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
};

// One editable pricing row. Prices are kept as strings while editing so the
// user can freely clear/retype; they're parsed to numbers on save.
interface PriceRow {
  model: string;
  input: string;
  output: string;
}

function pricingToRows(pricing: ModelPricing): PriceRow[] {
  return Object.entries(pricing).map(([model, p]) => ({
    model,
    input: String(p.inputPerMillion),
    output: String(p.outputPerMillion),
  }));
}

function rowsToPricing(rows: PriceRow[]): ModelPricing {
  const out: ModelPricing = {};
  for (const row of rows) {
    const model = row.model.trim();
    if (!model) continue; // skip blank rows
    out[model] = {
      inputPerMillion: Number(row.input) || 0,
      outputPerMillion: Number(row.output) || 0,
    };
  }
  return out;
}

const labelClass = 'text-[11px] text-ink-soft font-medium uppercase tracking-wide mb-1.5 block';
const hintClass = 'text-[11px] text-ink-soft mt-1';

// Phase 4 settings (CLAUDE.md §7): the user's own AI provider, model, API key(s),
// and base resume. Everything here is stored only in the local backend settings
// file and is used solely to make the outbound tailoring call to the chosen
// provider — nothing is sent anywhere else.
export function SettingsModal({ onClose }: Props) {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [provider, setProvider] = useState<AiProvider>('anthropic');
  const [model, setModel] = useState('');
  const [baseResume, setBaseResume] = useState('');
  // Local, non-AI heuristic (Issue #14): fields checkResumeCompleteness
  // couldn't detect in baseResume, shown as a dismissible warning on Save
  // rather than a hard block — the user may genuinely have no phone number,
  // or the heuristic may just have missed it. Reset to null on any edit so a
  // stale warning doesn't linger after the user changes the text.
  const [completenessWarning, setCompletenessWarning] = useState<MissingField[] | null>(null);
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [showAnthropicKey, setShowAnthropicKey] = useState(false);
  const [showOpenaiKey, setShowOpenaiKey] = useState(false);
  const [hasAnthropicKey, setHasAnthropicKey] = useState(false);
  const [hasOpenaiKey, setHasOpenaiKey] = useState(false);
  const [pricingRows, setPricingRows] = useState<PriceRow[]>([]);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [knownPricing, setKnownPricing] = useState<ModelPricing>({});
  const [knownPricingAsOf, setKnownPricingAsOf] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const s = await api.getSettings();
        if (!active) return;
        setProvider(s.provider);
        setModel(s.model);
        setBaseResume(s.baseResume);
        setHasAnthropicKey(s.hasAnthropicKey);
        setHasOpenaiKey(s.hasOpenaiKey);
        setPricingRows(pricingToRows(s.modelPricing));
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load settings.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Live model list for the current provider (CLAUDE.md §8 open question). Only
  // meaningful once a key is configured for that provider; failures (no key yet,
  // provider unreachable) are silent since the model field still accepts free
  // text via the datalist fallback below.
  const hasKeyForProvider = provider === 'anthropic' ? hasAnthropicKey : hasOpenaiKey;
  useEffect(() => {
    if (loading || !hasKeyForProvider) {
      setAvailableModels([]);
      return;
    }
    let active = true;
    setModelsLoading(true);
    void (async () => {
      try {
        const { models } = await api.getModels(provider);
        if (active) setAvailableModels(models);
      } catch {
        if (active) setAvailableModels([]);
      } finally {
        if (active) setModelsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [provider, hasKeyForProvider, loading]);

  // Curated known-pricing snapshot (backend/src/knownPricing.ts) — static
  // local data, no API key or network call needed, so fetch it unconditionally.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { asOf, pricing } = await api.getKnownPricing();
        if (active) {
          setKnownPricing(pricing);
          setKnownPricingAsOf(asOf);
        }
      } catch {
        // Non-fatal: the sync buttons below just won't find any known prices.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // "Sync models" — call the live model-list endpoint for every provider that
  // has a key configured (not just the one currently selected in the dropdown
  // above), and add any model missing from the pricing table, pre-filled with
  // a known price when available. This is the one-click way to make sure the
  // pricing table has every model actually available to the user, across both
  // services, without them having to flip the provider selector back and forth.
  const [syncingModels, setSyncingModels] = useState(false);
  const [syncModelsError, setSyncModelsError] = useState<string | null>(null);
  const providersWithKeys = AI_PROVIDERS.filter((p) =>
    p === 'anthropic' ? hasAnthropicKey : hasOpenaiKey,
  );

  async function syncModelsFromProviders() {
    setSyncingModels(true);
    setSyncModelsError(null);
    try {
      const results = await Promise.allSettled(providersWithKeys.map((p) => api.getModels(p)));
      const fetched = new Set<string>();
      let anySucceeded = false;
      for (const result of results) {
        if (result.status === 'fulfilled') {
          anySucceeded = true;
          for (const m of result.value.models) fetched.add(m);
        }
      }
      if (!anySucceeded) {
        setSyncModelsError('Could not reach any configured provider to fetch its model list.');
        return;
      }
      setPricingRows((rows) => {
        const existing = new Set(rows.map((r) => r.model.trim()));
        const additions = [...fetched]
          .filter((m) => !existing.has(m))
          .map((m) => {
            const known = knownPricing[m];
            return {
              model: m,
              input: known ? String(known.inputPerMillion) : '',
              output: known ? String(known.outputPerMillion) : '',
            };
          });
        return additions.length > 0 ? [...rows, ...additions] : rows;
      });
    } finally {
      setSyncingModels(false);
    }
  }

  // "Sync known prices" — for whichever models are already in the table
  // (any provider), overwrite their price with the curated known value when
  // one exists. Rows with no known match are left exactly as the user set them.
  function syncKnownPrices() {
    setPricingRows((rows) =>
      rows.map((row) => {
        const known = knownPricing[row.model.trim()];
        return known
          ? { ...row, input: String(known.inputPerMillion), output: String(known.outputPerMillion) }
          : row;
      }),
    );
  }

  // Upload a PDF/DOCX resume and extract plain text from it, so users don't
  // have to paste their resume by hand. Deliberately does NOT save on its
  // own: extraction is imperfect (column layouts, tables), so the result
  // just replaces the textarea below for the user to review/edit before
  // clicking the existing Save button.
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  // Any edit to the resume text invalidates a previously-shown completeness
  // warning, so the next Save attempt re-checks the new text rather than
  // trusting a confirmation the user gave for different content.
  function updateBaseResume(text: string) {
    setBaseResume(text);
    setCompletenessWarning(null);
  }

  async function handleResumeFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file again later
    if (!file) return;
    setExtracting(true);
    setExtractError(null);
    try {
      const { text } = await api.extractResumeText(file);
      updateBaseResume(text);
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : 'Could not read this file.');
    } finally {
      setExtracting(false);
    }
  }

  function updateRow(index: number, patch: Partial<PriceRow>) {
    setPricingRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function removeRow(index: number) {
    setPricingRows((rows) => rows.filter((_, i) => i !== index));
  }

  async function performSave() {
    setSaving(true);
    setError(null);
    // Key fields are write-only: only send one if the user typed a new value,
    // so leaving it blank preserves the existing (never-displayed) key.
    const input: SettingsInput = {
      provider,
      model: model.trim(),
      baseResume,
      modelPricing: rowsToPricing(pricingRows),
    };
    if (anthropicKey.trim()) input.anthropicApiKey = anthropicKey.trim();
    if (openaiKey.trim()) input.openaiApiKey = openaiKey.trim();
    try {
      const s = await api.saveSettings(input);
      setHasAnthropicKey(s.hasAnthropicKey);
      setHasOpenaiKey(s.hasOpenaiKey);
      setPricingRows(pricingToRows(s.modelPricing));
      setAnthropicKey('');
      setOpenaiKey('');
      setCompletenessWarning(null);
      showToast({ tone: 'success', message: 'Settings saved.' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!model.trim()) {
      setError('Model is required.');
      return;
    }
    // Local completeness heuristic (Issue #14): advisory only, never blocks —
    // surface what looks missing and let the user confirm it's intentional
    // (or go back and fix a genuine parsing miss) before actually saving.
    if (completenessWarning === null) {
      const missing = checkResumeCompleteness(baseResume);
      if (missing.length > 0) {
        setCompletenessWarning(missing);
        return;
      }
    }
    await performSave();
  }

  return (
    <Modal
      title="Settings"
      wide
      onClose={onClose}
      onSubmit={handleSave}
      footer={
        <>
          <button type="button" className="btn-ghost px-5 py-2 min-w-[100px]" onClick={onClose} disabled={saving}>
            Close
          </button>
          <button type="submit" className="btn-primary px-6 py-2 min-w-[100px]" disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </>
      }
    >
      <p className={hintClass}>
        Your API key and resume are stored only on this machine and are sent only to your chosen AI
        provider when you tailor a resume.
      </p>

      {completenessWarning && completenessWarning.length > 0 && (
        <div className="bg-amber-100 p-4 rounded-xl flex items-center justify-between gap-4 mt-4">
          <div className="flex items-start gap-3">
            <IconAlertTriangle size={18} stroke={1.75} className="text-amber-800 mt-0.5 shrink-0" />
            <p className="text-amber-800 leading-tight m-0">
              We couldn't detect {completenessWarning.map((m) => m.label).join(', ')} in your base
              resume. Is that missing on purpose, or did we just miss it while checking?
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              type="button"
              className="px-3 py-1.5 text-xs font-medium bg-white/50 hover:bg-white text-amber-800 rounded-lg transition-colors"
              onClick={() => setCompletenessWarning(null)}
              disabled={saving}
            >
              Let me check
            </button>
            <button
              type="button"
              className="px-3 py-1.5 text-xs font-medium bg-amber-800 text-white rounded-lg disabled:opacity-55"
              onClick={() => void performSave()}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save anyway'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-center text-ink-soft py-6">Loading…</p>
      ) : (
        <div className="flex flex-col gap-8 mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <label>
              <span className={labelClass}>AI provider</span>
              <select
                className="input-field w-full"
                value={provider}
                onChange={(e) => setProvider(e.target.value as AiProvider)}
              >
                {AI_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className={labelClass}>Model</span>
              <input
                className="input-field w-full"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="e.g. claude-sonnet-5 or gpt-4o"
                list="model-options"
                required
              />
              <datalist id="model-options">
                {availableModels.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              {hasKeyForProvider && (
                <p className={hintClass}>
                  {modelsLoading
                    ? 'Loading your account’s models…'
                    : availableModels.length > 0
                      ? `${availableModels.length} model${availableModels.length === 1 ? '' : 's'} available from your account — type to filter, or enter a custom id.`
                      : 'Could not load your account’s model list — enter a model id manually.'}
                </p>
              )}
            </label>
            <label>
              <span className={labelClass}>Anthropic API key</span>
              <div className="relative flex items-center">
                <input
                  className="input-field pr-9"
                  type={showAnthropicKey ? 'text' : 'password'}
                  value={anthropicKey}
                  onChange={(e) => setAnthropicKey(e.target.value)}
                  placeholder={hasAnthropicKey ? 'configured — leave blank to keep' : 'not set'}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowAnthropicKey((v) => !v)}
                  className="absolute right-2.5 text-ink-soft hover:text-ink"
                  aria-label={showAnthropicKey ? 'Hide API key' : 'Show API key'}
                >
                  {showAnthropicKey ? <IconEyeOff size={16} stroke={1.75} /> : <IconEye size={16} stroke={1.75} />}
                </button>
              </div>
            </label>
            <label>
              <span className={labelClass}>OpenAI API key</span>
              <div className="relative flex items-center">
                <input
                  className="input-field pr-9"
                  type={showOpenaiKey ? 'text' : 'password'}
                  value={openaiKey}
                  onChange={(e) => setOpenaiKey(e.target.value)}
                  placeholder={hasOpenaiKey ? 'configured — leave blank to keep' : 'not set'}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowOpenaiKey((v) => !v)}
                  className="absolute right-2.5 text-ink-soft hover:text-ink"
                  aria-label={showOpenaiKey ? 'Hide API key' : 'Show API key'}
                >
                  {showOpenaiKey ? <IconEyeOff size={16} stroke={1.75} /> : <IconEye size={16} stroke={1.75} />}
                </button>
              </div>
            </label>
          </div>

          <div className="flex flex-col gap-4">
            <label>
              <span className={labelClass}>Base resume (plain text)</span>
              <div className="flex items-center gap-3">
                <input
                  type="file"
                  accept=".pdf,.docx"
                  onChange={(e) => void handleResumeFile(e)}
                  disabled={extracting}
                  className="text-[13px]"
                />
                {extracting && <span className="text-[11px] text-ink-soft">Extracting text…</span>}
              </div>
            </label>
            {extractError && <p className="text-rose-800 text-[13px]">{extractError}</p>}
            <textarea
              className="input-field min-h-[160px] font-mono text-[12px] leading-relaxed"
              value={baseResume}
              onChange={(e) => updateBaseResume(e.target.value)}
              rows={10}
              placeholder="Paste your resume as plain text…"
            />
            <p className={hintClass}>
              Uploading a PDF or Word (.docx) file replaces the text above — review and edit before
              saving.
            </p>
          </div>

          <div className="flex flex-col gap-4 pt-4 border-t border-matcha-100">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className={`${labelClass} mb-0`}>Model pricing (USD per million tokens)</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-ghost px-3 py-1.5 text-xs flex items-center gap-1.5"
                  onClick={() => void syncModelsFromProviders()}
                  disabled={syncingModels || providersWithKeys.length === 0}
                  title={
                    providersWithKeys.length === 0
                      ? 'Configure an API key for at least one provider first'
                      : undefined
                  }
                >
                  <IconRefresh size={14} stroke={1.75} />
                  {syncingModels ? 'Syncing…' : 'Sync models'}
                </button>
                <button
                  type="button"
                  className="btn-ghost px-3 py-1.5 text-xs flex items-center gap-1.5"
                  onClick={syncKnownPrices}
                  disabled={Object.keys(knownPricing).length === 0}
                >
                  <IconCurrencyDollar size={14} stroke={1.75} />
                  Sync known prices
                </button>
              </div>
            </div>
            <p className={`${hintClass} mt-0`}>
              Used to estimate each tailor's cost. A model not listed here shows no cost. Models are
              only added via "Sync models", which fetches your current model list from every provider
              with a key configured — there's no manual add or rename, so this table can never drift
              from what your account actually offers.{' '}
              {knownPricingAsOf
                ? `"Sync known prices" applies a curated snapshot last verified ${knownPricingAsOf} — always double-check against your provider's current pricing.`
                : "Verify against your provider's current pricing."}
            </p>
            {syncModelsError && <p className="text-rose-800 text-[13px]">{syncModelsError}</p>}
            <div className="overflow-hidden rounded-xl border-[0.5px] border-matcha-200">
              <table className="w-full text-left">
                <thead className="bg-matcha-50 border-b border-matcha-200">
                  <tr className="text-[10px] uppercase font-semibold text-ink-soft">
                    <th className="px-4 py-2.5">Model</th>
                    <th className="px-4 py-2.5 w-[140px]">Input / 1M</th>
                    <th className="px-4 py-2.5 w-[140px]">Output / 1M</th>
                    <th className="px-4 py-2.5 w-[40px] text-center" aria-hidden></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-matcha-100">
                  {pricingRows.map((row, i) => (
                    <tr key={i}>
                      <td className="px-4 py-3 font-mono text-xs">{row.model}</td>
                      <td className="px-4 py-3">
                        <div className="relative flex items-center">
                          <span className="absolute left-3 text-ink-soft text-[11px]">$</span>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            className="input-field w-full pl-6 py-1 h-[30px]"
                            value={row.input}
                            onChange={(e) => updateRow(i, { input: e.target.value })}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="relative flex items-center">
                          <span className="absolute left-3 text-ink-soft text-[11px]">$</span>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            className="input-field w-full pl-6 py-1 h-[30px]"
                            value={row.output}
                            onChange={(e) => updateRow(i, { output: e.target.value })}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          type="button"
                          onClick={() => removeRow(i)}
                          aria-label="Remove model"
                          className="text-ink-soft hover:text-rose-800 transition-colors"
                        >
                          <IconTrash size={16} stroke={1.75} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {error && <p className="text-rose-800 text-[13px] mt-3">{error}</p>}
    </Modal>
  );
}
