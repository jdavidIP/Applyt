import type { TailoredSections } from './types.js';
import { coerceStructuredResume, type StructuredResume } from './resumeSchema.js';

// The AI (ai.ts) is prompted to return a single JSON object (a
// TailorResponseEnvelope) containing the tailored resume as structured
// sections plus optional match rating/justification/suggestions, so
// resumeRender.ts can lay it out into a real ATS template. parseTailoredResume
// is the single place that turns a resume_versions.tailored_output blob back
// into usable pieces, and it must keep working for rows written before this
// format existed:
//
//   1. New format: a JSON object (this file's primary path).
//   2. Old marker-delimited format (Phase 4's original format):
//      ===TAILORED_RESUME=== / ===MATCH_RATING=== / ===MATCH_JUSTIFICATION===
//      / ===SUGGESTIONS===
//   3. Oldest format (pre-Phase-4): flat text with a loose "Suggestions:"
//      heading, or no structure at all.
//
// Only path 1 populates `structured`; paths 2 and 3 return `structured: null`
// and resumeRender.ts falls back to its plain-text renderer for those rows.

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

function parseLegacyMarkerFormat(output: string): TailoredSections | null {
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

  if (!sawMarker) return null;

  const section = (name: SectionName): string => (buckets[name] ?? []).join('\n').trim();

  // Tolerate a rating expressed as "4", "4/5", "4 stars", etc. — take the first
  // 0–5 digit. Null when the section is missing or has no parseable digit.
  const ratingMatch = section('MATCH_RATING').match(/[0-5]/);

  return {
    resume: section('TAILORED_RESUME'),
    structured: null,
    matchRating: ratingMatch ? Number(ratingMatch[0]) : null,
    matchJustification: section('MATCH_JUSTIFICATION'),
    suggestions: section('SUGGESTIONS'),
  };
}

// Strips a leading/trailing markdown code fence and any prose surrounding the
// JSON object — common LLM JSON-output gotchas even when the prompt asks for
// raw JSON only.
function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  const unfenced = fenceMatch ? fenceMatch[1].trim() : trimmed;
  if (unfenced.startsWith('{')) return unfenced;

  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return unfenced;
  return unfenced.slice(start, end + 1);
}

function bulletLines(bullets: string[]): string[] {
  return bullets.map((b) => `- ${b}`);
}

// Turns a StructuredResume back into the same flat plain-text convention the
// old renderer/dashboard understand ("- " bullets), so `.resume` stays
// meaningful for the txt download format and any other consumer expecting a
// flat string.
export function flattenStructuredResume(resume: StructuredResume): string {
  const lines: string[] = [];
  const { contact } = resume;

  lines.push(contact.name);
  const contactLine = [contact.email, contact.phone, ...(contact.links ?? []), contact.location]
    .filter(Boolean)
    .join(' | ');
  if (contactLine) lines.push(contactLine);

  if (resume.summary) {
    lines.push('', 'PROFESSIONAL SUMMARY', resume.summary);
  }

  if (resume.experience.length) {
    lines.push('', 'PROFESSIONAL EXPERIENCE');
    for (const e of resume.experience) {
      lines.push(`${e.title} — ${e.company}${e.location ? `, ${e.location}` : ''} (${e.startDate} – ${e.endDate})`);
      lines.push(...bulletLines(e.bullets));
    }
  }

  if (resume.projects?.length) {
    lines.push('', 'PROJECTS');
    for (const p of resume.projects) {
      lines.push(p.dateRange ? `${p.name} (${p.dateRange})` : p.name);
      lines.push(...bulletLines(p.bullets));
    }
  }

  if (resume.skills.length) {
    lines.push('', 'TECHNICAL SKILLS');
    for (const s of resume.skills) {
      lines.push(`${s.label}: ${s.items.join(', ')}`);
    }
  }

  if (resume.education.length) {
    lines.push('', 'EDUCATION');
    for (const e of resume.education) {
      lines.push(`${e.institution} — ${e.degree} (${e.dates})`);
      if (e.honors) lines.push(e.honors);
      if (e.coursework) lines.push(e.coursework);
    }
  }

  return lines.join('\n').trim();
}

function parseJsonEnvelope(output: string): TailoredSections | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonPayload(output));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const envelope = parsed as Record<string, unknown>;

  const structured = coerceStructuredResume(envelope.resume);
  if (!structured) return null;

  const matchRating =
    typeof envelope.matchRating === 'number' && envelope.matchRating >= 0 && envelope.matchRating <= 5
      ? Math.round(envelope.matchRating)
      : null;
  const matchJustification = Array.isArray(envelope.matchJustification)
    ? bulletLines(envelope.matchJustification.filter((s): s is string => typeof s === 'string')).join('\n')
    : '';
  const suggestions = Array.isArray(envelope.suggestions)
    ? bulletLines(envelope.suggestions.filter((s): s is string => typeof s === 'string')).join('\n')
    : '';

  return {
    resume: flattenStructuredResume(structured),
    structured,
    matchRating,
    matchJustification,
    suggestions,
  };
}

export function parseTailoredResume(output: string): TailoredSections {
  const jsonResult = parseJsonEnvelope(output);
  if (jsonResult) return jsonResult;

  const markerResult = parseLegacyMarkerFormat(output);
  if (markerResult) return markerResult;

  const { resume, suggestions } = splitLegacy(output);
  return { resume, structured: null, matchRating: null, matchJustification: '', suggestions };
}
