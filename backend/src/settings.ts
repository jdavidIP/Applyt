import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiProvider, PublicSettings, Settings, UpdateSettingsBody } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default settings location: backend/data/settings.json (gitignored, per-user).
// Holds the user's own AI API key(s) and base resume in plaintext — acceptable
// because this is a local, single-user tool and the file never leaves the
// machine (CLAUDE.md §3). Overridable via SETTINGS_PATH (used by tests).
function resolveSettingsPath(): string {
  const envPath = process.env.SETTINGS_PATH;
  if (envPath && envPath.trim() !== '') return envPath;
  return resolve(__dirname, '..', 'data', 'settings.json');
}

const DEFAULTS: Settings = {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  anthropicApiKey: '',
  openaiApiKey: '',
  baseResume: '',
};

export interface SettingsStore {
  /** Full settings incl. secrets — for server-side use only, never sent to a client. */
  read(): Settings;
  /** Apply a partial update, persist it, and return the new full settings. */
  update(patch: UpdateSettingsBody): Settings;
  /** Client-safe view: provider/model/baseResume + booleans for key presence. */
  getPublic(): PublicSettings;
  /** The API key for a provider, preferring an env var over the stored value. */
  resolveApiKey(provider: AiProvider): string | undefined;
}

export function createSettingsStore(path: string = resolveSettingsPath()): SettingsStore {
  function read(): Settings {
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Settings>;
      // Merge over defaults so a file written by an older version (missing keys)
      // still yields a complete, well-typed record.
      return { ...DEFAULTS, ...parsed };
    } catch {
      // Missing or unparseable file → fall back to defaults. A first-run install
      // has no settings.json until the user saves settings once.
      return { ...DEFAULTS };
    }
  }

  function update(patch: UpdateSettingsBody): Settings {
    const current = read();
    // Only overwrite keys the caller actually sent (partial update). An empty
    // string is a deliberate "clear this value", so it IS applied; only an
    // absent/undefined field is left unchanged.
    const next: Settings = {
      provider: patch.provider ?? current.provider,
      model: patch.model ?? current.model,
      anthropicApiKey: patch.anthropicApiKey ?? current.anthropicApiKey,
      openaiApiKey: patch.openaiApiKey ?? current.openaiApiKey,
      baseResume: patch.baseResume ?? current.baseResume,
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  function resolveApiKey(provider: AiProvider): string | undefined {
    const stored = read();
    // Env var wins: lets a security-conscious user keep the key out of the
    // on-disk settings file entirely (CLAUDE.md §4 — key from .env or settings).
    if (provider === 'anthropic') {
      return process.env.ANTHROPIC_API_KEY?.trim() || stored.anthropicApiKey || undefined;
    }
    return process.env.OPENAI_API_KEY?.trim() || stored.openaiApiKey || undefined;
  }

  function getPublic(): PublicSettings {
    const s = read();
    return {
      provider: s.provider,
      model: s.model,
      baseResume: s.baseResume,
      hasAnthropicKey: Boolean(resolveApiKey('anthropic')),
      hasOpenaiKey: Boolean(resolveApiKey('openai')),
    };
  }

  return { read, update, getPublic, resolveApiKey };
}
