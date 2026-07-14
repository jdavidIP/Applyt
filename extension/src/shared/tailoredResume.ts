// Mirror of backend/src/tailoredResume.ts (and the dashboard copy). The
// extension is bundled separately from the backend, so — like shared/types.ts —
// this is a hand-copied mirror kept in sync manually rather than a cross-
// workspace import. The popup parses a tailor run's raw tailored_output into
// its sections itself, so it must agree with the backend's marker contract.
//
// ===TAILORED_RESUME===
// ===MATCH_RATING===          (a single integer 0–5)
// ===MATCH_JUSTIFICATION===
// ===SUGGESTIONS===

export interface TailoredSections {
  resume: string;
  matchRating: number | null; // integer 0–5; 5 = strongest match, 0 = out of scope
  matchJustification: string;
  suggestions: string;
}

type SectionName = 'TAILORED_RESUME' | 'MATCH_RATING' | 'MATCH_JUSTIFICATION' | 'SUGGESTIONS';
const SECTION_MARKER = /^===\s*(TAILORED_RESUME|MATCH_RATING|MATCH_JUSTIFICATION|SUGGESTIONS)\s*===$/;

// Fallback for output that predates the structured format (or a model that
// ignored it): split on a loose "Suggestions:" heading, treating everything
// before it as the resume.
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

  // Tolerate a rating expressed as "4", "4/5", "4 stars", etc. — take the first
  // 0–5 digit. Null when the section is missing or has no parseable digit.
  const ratingMatch = section('MATCH_RATING').match(/[0-5]/);

  return {
    resume: section('TAILORED_RESUME'),
    matchRating: ratingMatch ? Number(ratingMatch[0]) : null,
    matchJustification: section('MATCH_JUSTIFICATION'),
    suggestions: section('SUGGESTIONS'),
  };
}
