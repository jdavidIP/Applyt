import { useEffect, useState } from 'react';
import { api } from '../api';
import { AI_PROVIDERS, type AiProvider, type ModelPricing, type SettingsInput } from '../types';

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

// Phase 4 settings (CLAUDE.md §7): the user's own AI provider, model, API key(s),
// and base resume. Everything here is stored only in the local backend settings
// file and is used solely to make the outbound tailoring call to the chosen
// provider — nothing is sent anywhere else.
export function SettingsModal({ onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [provider, setProvider] = useState<AiProvider>('anthropic');
  const [model, setModel] = useState('');
  const [baseResume, setBaseResume] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
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

  async function handleResumeFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file again later
    if (!file) return;
    setExtracting(true);
    setExtractError(null);
    try {
      const { text } = await api.extractResumeText(file);
      setBaseResume(text);
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

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!model.trim()) {
      setError('Model is required.');
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
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
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal modal-wide" onClick={(e) => e.stopPropagation()} onSubmit={handleSave}>
        <h2>Settings</h2>
        <p className="settings-hint">
          Your API key and resume are stored only on this machine and are sent only to your chosen
          AI provider when you tailor a resume.
        </p>

        {loading ? (
          <p className="empty">Loading…</p>
        ) : (
          <div className="form-grid">
            <label>
              AI provider
              <select value={provider} onChange={(e) => setProvider(e.target.value as AiProvider)}>
                {AI_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model
              <input
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
                <span className="settings-hint" style={{ margin: 0 }}>
                  {modelsLoading
                    ? 'Loading your account’s models…'
                    : availableModels.length > 0
                      ? `${availableModels.length} model${availableModels.length === 1 ? '' : 's'} available from your account — type to filter, or enter a custom id.`
                      : 'Could not load your account’s model list — enter a model id manually.'}
                </span>
              )}
            </label>
            <label>
              Anthropic API key
              <input
                type="password"
                value={anthropicKey}
                onChange={(e) => setAnthropicKey(e.target.value)}
                placeholder={hasAnthropicKey ? 'configured — leave blank to keep' : 'not set'}
                autoComplete="off"
              />
            </label>
            <label>
              OpenAI API key
              <input
                type="password"
                value={openaiKey}
                onChange={(e) => setOpenaiKey(e.target.value)}
                placeholder={hasOpenaiKey ? 'configured — leave blank to keep' : 'not set'}
                autoComplete="off"
              />
            </label>
            <label className="span-2">
              Base resume (plain text)
              <div className="resume-upload-row">
                <input
                  type="file"
                  accept=".pdf,.docx"
                  onChange={(e) => void handleResumeFile(e)}
                  disabled={extracting}
                />
                {extracting && (
                  <span className="settings-hint" style={{ margin: 0 }}>
                    Extracting text…
                  </span>
                )}
              </div>
              {extractError && <p className="form-error">{extractError}</p>}
              <textarea
                value={baseResume}
                onChange={(e) => setBaseResume(e.target.value)}
                rows={10}
                placeholder="Paste your resume as plain text…"
              />
              <span className="settings-hint" style={{ margin: 0 }}>
                Uploading a PDF or Word (.docx) file replaces the text above — review and edit
                before saving.
              </span>
            </label>

            <div className="span-2 pricing-section">
              <div className="pricing-header">
                <span className="stat-label">Model pricing (USD per million tokens)</span>
                <div className="pricing-header-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void syncModelsFromProviders()}
                    disabled={syncingModels || providersWithKeys.length === 0}
                    title={
                      providersWithKeys.length === 0
                        ? 'Configure an API key for at least one provider first'
                        : undefined
                    }
                  >
                    {syncingModels ? 'Syncing…' : 'Sync models'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={syncKnownPrices}
                    disabled={Object.keys(knownPricing).length === 0}
                  >
                    Sync known prices
                  </button>
                </div>
              </div>
              <p className="settings-hint">
                Used to estimate each tailor's cost. A model not listed here shows no cost. Models
                are only added via "Sync models", which fetches your current model list from every
                provider with a key configured — there's no manual add or rename, so this table can
                never drift from what your account actually offers.{' '}
                {knownPricingAsOf
                  ? `"Sync known prices" applies a curated snapshot last verified ${knownPricingAsOf} — always double-check against your provider's current pricing.`
                  : "Verify against your provider's current pricing."}
              </p>
              {syncModelsError && <p className="form-error">{syncModelsError}</p>}
              <div className="pricing-table">
                <div className="pricing-row pricing-row-head">
                  <span>Model</span>
                  <span>Input /M</span>
                  <span>Output /M</span>
                  <span aria-hidden></span>
                </div>
                {pricingRows.map((row, i) => (
                  <div className="pricing-row" key={i}>
                    <span className="pricing-model-name">{row.model}</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={row.input}
                      onChange={(e) => updateRow(i, { input: e.target.value })}
                    />
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={row.output}
                      onChange={(e) => updateRow(i, { output: e.target.value })}
                    />
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => removeRow(i)}
                      aria-label="Remove model"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {error && <p className="form-error">{error}</p>}
        {saved && <p className="form-success">Settings saved.</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Close
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </div>
  );
}
