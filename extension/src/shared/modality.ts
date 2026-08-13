import type { Modality } from './types';

export interface ModalityTextMatches {
  hybrid: string[];
  remote: string[];
  on_site: string[];
}

// Shared across all three content scripts' modalityTextMatches config (same
// shape, different phrases per platform's selectors JSON). Checked in a fixed
// order since a scope could in principle contain more than one phrase.
export function detectModality(scopeText: string, matches: ModalityTextMatches): Modality | undefined {
  const lower = scopeText.toLowerCase();
  if (matches.hybrid.some((phrase) => lower.includes(phrase))) return 'hybrid';
  if (matches.remote.some((phrase) => lower.includes(phrase))) return 'remote';
  if (matches.on_site.some((phrase) => lower.includes(phrase))) return 'on_site';
  return undefined;
}
