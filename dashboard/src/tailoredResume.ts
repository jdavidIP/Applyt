import type { TailoredSections } from './types';

// Mirrors backend/src/tailoredResume.ts. Kept in sync manually (the project has
// no shared package). The AI is prompted to emit these four marker-delimited
// sections so a tailor run's raw output parses reliably for display.
type SectionName = 'TAILORED_RESUME' | 'MATCH_RATING' | 'MATCH_JUSTIFICATION' | 'SUGGESTIONS';
const SECTION_MARKER = /^===\s*(TAILORED_RESUME|MATCH_RATING|MATCH_JUSTIFICATION|SUGGESTIONS)\s*===$/;

const LEGACY_SUGGESTIONS_HEADING = /^suggestions:?\s*$/im;

function splitLegacy(text: string): { resume: string; suggestions: string } {
  const match = LEGACY_SUGGESTIONS_HEADING.exec(text);
  if (!match) return { resume: text.trim(), suggestions: '' };
  return { resume: text.slice(0, match.index).trim(), suggestions: text.slice(match.index).trim() };
}

export function parseTailoredResume(output: string): TailoredSections {
  const buckets: Partial<Record<SectionName, string[]>> = {};
  let current: SectionName | null = null;
  let sawMarker = false;

  for (const line of output.split(/\r?\n/)) {
    const marker = SECTION_MARKER.exec(line.trim());
    if (marker) {
      current = marker[1] as SectionName;
      buckets[current] = [];
      sawMarker = true;
      continue;
    }
    if (current) buckets[current]!.push(line);
  }

  if (!sawMarker) {
    const { resume, suggestions } = splitLegacy(output);
    return { resume, matchRating: null, matchJustification: '', suggestions };
  }

  const section = (name: SectionName): string => (buckets[name] ?? []).join('\n').trim();
  const ratingMatch = section('MATCH_RATING').match(/[0-5]/);

  return {
    resume: section('TAILORED_RESUME'),
    matchRating: ratingMatch ? Number(ratingMatch[0]) : null,
    matchJustification: section('MATCH_JUSTIFICATION'),
    suggestions: section('SUGGESTIONS'),
  };
}
