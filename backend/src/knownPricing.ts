import type { ModelPricing } from './types.js';

// Curated, manually-maintained snapshot of published list prices (USD per
// MILLION tokens). Neither Anthropic nor OpenAI expose a pricing API, so this
// is a dated snapshot rather than a live fetch — scraping their marketing/docs
// pages at request time would be exactly the kind of fragile, markup-dependent
// integration CLAUDE.md §6 already warns against for job-site selectors.
// Re-check the source URLs below and bump KNOWN_PRICING_AS_OF to refresh.
//
// Sources (checked 2026-07-13):
//   https://platform.claude.com/docs/en/about-claude/pricing
//   https://developers.openai.com/api/docs/pricing
export const KNOWN_PRICING_AS_OF = '2026-07-13';

export const KNOWN_MODEL_PRICING: ModelPricing = {
  // Anthropic
  'claude-fable-5': { inputPerMillion: 10, outputPerMillion: 50 },
  'claude-opus-4-8': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-opus-4-7': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-opus-4-6': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-opus-4-5': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-opus-4-1': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-opus-4': { inputPerMillion: 15, outputPerMillion: 75 },
  // claude-sonnet-5 is on introductory pricing ($2/$10) through 2026-08-31,
  // reverting to standard ($3/$15) on 2026-09-01 — re-sync after that date.
  'claude-sonnet-5': { inputPerMillion: 2, outputPerMillion: 10 },
  'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-sonnet-4-5': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-sonnet-4': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5 },
  'claude-haiku-3-5': { inputPerMillion: 0.8, outputPerMillion: 4 },

  // OpenAI
  'gpt-5.6-sol': { inputPerMillion: 5, outputPerMillion: 30 },
  'gpt-5.6-terra': { inputPerMillion: 2.5, outputPerMillion: 15 },
  'gpt-5.6-luna': { inputPerMillion: 1, outputPerMillion: 6 },
  'gpt-5.5': { inputPerMillion: 5, outputPerMillion: 30 },
  'gpt-5.5-pro': { inputPerMillion: 30, outputPerMillion: 180 },
  'gpt-5.4': { inputPerMillion: 2.5, outputPerMillion: 15 },
  'gpt-5.4-mini': { inputPerMillion: 0.75, outputPerMillion: 4.5 },
  'gpt-5.4-nano': { inputPerMillion: 0.2, outputPerMillion: 1.25 },
  'gpt-5.4-pro': { inputPerMillion: 30, outputPerMillion: 180 },
  'chat-latest': { inputPerMillion: 5, outputPerMillion: 30 },
  // gpt-5.3-codex intentionally omitted: it's a coding-specialized variant,
  // irrelevant to this app's plain-text resume tailoring (see ai.ts's
  // OPENAI_IRRELEVANT filter, which excludes it from the live model list too).
};
