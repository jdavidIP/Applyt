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

  function updateRow(index: number, patch: Partial<PriceRow>) {
    setPricingRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setPricingRows((rows) => [...rows, { model: '', input: '', output: '' }]);
  }
  function removeRow(index: number) {
    setPricingRows((rows) => rows.filter((_, i) => i !== index));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
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
              />
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
              <textarea
                value={baseResume}
                onChange={(e) => setBaseResume(e.target.value)}
                rows={10}
                placeholder="Paste your resume as plain text…"
              />
            </label>

            <div className="span-2 pricing-section">
              <div className="pricing-header">
                <span className="stat-label">Model pricing (USD per million tokens)</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={addRow}>
                  + Add model
                </button>
              </div>
              <p className="settings-hint">
                Used to estimate each tailor's cost. Defaults are approximate — verify against your
                provider's current pricing. A model not listed here shows no cost.
              </p>
              <div className="pricing-table">
                <div className="pricing-row pricing-row-head">
                  <span>Model</span>
                  <span>Input /M</span>
                  <span>Output /M</span>
                  <span aria-hidden></span>
                </div>
                {pricingRows.map((row, i) => (
                  <div className="pricing-row" key={i}>
                    <input
                      value={row.model}
                      onChange={(e) => updateRow(i, { model: e.target.value })}
                      placeholder="model id"
                    />
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
