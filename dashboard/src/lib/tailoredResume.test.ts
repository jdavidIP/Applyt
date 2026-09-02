import { describe, test, expect } from 'vitest';
import { parseTailoredResume } from './tailoredResume';

// Mirrors the backend parser tests. The dashboard parses the raw tailored_output
// itself (rather than the backend returning pre-split fields), so this guards
// the client-side copy against drifting from the server's contract.
const JSON_ENVELOPE = JSON.stringify({
  resume: {
    contact: { name: 'Jane Doe' },
    experience: [
      { title: 'Frontend Engineer', company: 'Acme', startDate: '2022', endDate: 'Present', bullets: ['Built React apps'] },
    ],
    education: [],
    skills: [],
  },
  matchRating: 4,
  matchJustification: ['Strong frontend match'],
  suggestions: ['Mention your TypeScript depth'],
});

const LEGACY_MARKER_FORMAT = [
  '===TAILORED_RESUME===',
  'Jane Doe',
  '- Built React apps',
  '===MATCH_RATING===',
  '4',
  '===MATCH_JUSTIFICATION===',
  '- Strong frontend match',
  '===SUGGESTIONS===',
  '- Mention your TypeScript depth',
].join('\n');

describe('parseTailoredResume (dashboard)', () => {
  test('parses the JSON envelope into structured + flattened resume', () => {
    const parsed = parseTailoredResume(JSON_ENVELOPE);
    expect(parsed.structured?.contact.name).toBe('Jane Doe');
    expect(parsed.resume).toContain('Built React apps');
    expect(parsed.matchRating).toBe(4);
    expect(parsed.matchJustification).toContain('frontend match');
    expect(parsed.suggestions).toContain('TypeScript depth');
  });

  test('falls back to the old marker-delimited format', () => {
    const parsed = parseTailoredResume(LEGACY_MARKER_FORMAT);
    expect(parsed.structured).toBeNull();
    expect(parsed.resume).toBe('Jane Doe\n- Built React apps');
    expect(parsed.matchRating).toBe(4);
    expect(parsed.matchJustification).toContain('frontend match');
    expect(parsed.suggestions).toContain('TypeScript depth');
  });

  test('returns a null rating and empty meta for legacy pre-structured output', () => {
    const parsed = parseTailoredResume('Jane Doe\nEngineer\n\nSuggestions:\nDo X.');
    expect(parsed.structured).toBeNull();
    expect(parsed.resume).toBe('Jane Doe\nEngineer');
    expect(parsed.matchRating).toBeNull();
    expect(parsed.suggestions).toContain('Do X.');
  });
});
