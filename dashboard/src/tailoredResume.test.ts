import { describe, test, expect } from 'vitest';
import { parseTailoredResume } from './tailoredResume';

// Mirrors the backend parser tests. The dashboard parses the raw tailored_output
// itself (rather than the backend returning pre-split fields), so this guards
// the client-side copy against drifting from the server's contract.
const STRUCTURED = [
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
  test('splits the four marker-delimited sections', () => {
    const parsed = parseTailoredResume(STRUCTURED);
    expect(parsed.resume).toBe('Jane Doe\n- Built React apps');
    expect(parsed.matchRating).toBe(4);
    expect(parsed.matchJustification).toContain('frontend match');
    expect(parsed.suggestions).toContain('TypeScript depth');
  });

  test('returns a null rating and empty meta for legacy pre-structured output', () => {
    const parsed = parseTailoredResume('Jane Doe\nEngineer\n\nSuggestions:\nDo X.');
    expect(parsed.resume).toBe('Jane Doe\nEngineer');
    expect(parsed.matchRating).toBeNull();
    expect(parsed.suggestions).toContain('Do X.');
  });
});
