import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTailoredResume, flattenStructuredResume } from '../src/tailoredResume.ts';

const MINIMAL_ENVELOPE = {
  resume: {
    contact: { name: 'Jane Doe' },
    experience: [],
    education: [],
    skills: [],
  },
};

test('parses a valid JSON envelope with no code fence', () => {
  const parsed = parseTailoredResume(JSON.stringify(MINIMAL_ENVELOPE));
  assert.ok(parsed.structured);
  assert.equal(parsed.structured?.contact.name, 'Jane Doe');
  assert.match(parsed.resume, /Jane Doe/);
});

test('strips a markdown code fence around the JSON', () => {
  const fenced = '```json\n' + JSON.stringify(MINIMAL_ENVELOPE) + '\n```';
  const parsed = parseTailoredResume(fenced);
  assert.ok(parsed.structured);
  assert.equal(parsed.structured?.contact.name, 'Jane Doe');
});

test('strips a bare code fence (no "json" language tag)', () => {
  const fenced = '```\n' + JSON.stringify(MINIMAL_ENVELOPE) + '\n```';
  const parsed = parseTailoredResume(fenced);
  assert.ok(parsed.structured);
});

test('extracts the JSON object from surrounding prose', () => {
  const withProse = `Here's your resume:\n${JSON.stringify(MINIMAL_ENVELOPE)}\nHope that helps!`;
  const parsed = parseTailoredResume(withProse);
  assert.ok(parsed.structured);
  assert.equal(parsed.structured?.contact.name, 'Jane Doe');
});

test('falls back to legacy parsing on truncated/malformed JSON', () => {
  const truncated = '{"resume": {"contact": {"name": "Jane Doe"';
  const parsed = parseTailoredResume(truncated);
  assert.equal(parsed.structured, null);
  assert.ok(parsed.resume.length > 0);
});

test('falls back to legacy parsing when JSON parses but fails shape validation', () => {
  const noName = JSON.stringify({ resume: { contact: {}, experience: [], education: [], skills: [] } });
  const parsed = parseTailoredResume(noName);
  assert.equal(parsed.structured, null);
});

test('parses optional fields correctly when populated', () => {
  const full = {
    resume: {
      contact: { name: 'Jane Doe', email: 'jane@example.com', phone: '555-0100', location: 'City, ST', links: ['github.com/jd'] },
      summary: 'A summary.',
      experience: [
        { title: 'Engineer', company: 'Acme', location: 'City, ST', startDate: '2020', endDate: 'Present', bullets: ['Did X'] },
      ],
      projects: [{ name: 'Side Project', dateRange: '2023', bullets: ['Built Y'] }],
      education: [{ institution: 'State U', degree: 'B.S.', dates: '2016-2020', honors: 'Cum Laude', coursework: 'Algorithms' }],
      skills: [{ label: 'Languages', items: ['Python', 'TypeScript'] }],
    },
    matchRating: 5,
    matchJustification: ['Meets everything'],
    suggestions: ['Mention X'],
  };
  const parsed = parseTailoredResume(JSON.stringify(full));
  assert.ok(parsed.structured);
  assert.equal(parsed.structured?.projects?.[0].name, 'Side Project');
  assert.equal(parsed.matchRating, 5);
  assert.match(parsed.matchJustification, /Meets everything/);
  assert.match(parsed.suggestions, /Mention X/);
});

test('does not crash when optional fields (projects, summary) are omitted', () => {
  const parsed = parseTailoredResume(JSON.stringify(MINIMAL_ENVELOPE));
  assert.ok(parsed.structured);
  assert.equal(parsed.structured?.projects, undefined);
  assert.equal(parsed.structured?.summary, undefined);
});

test('coerces a bullets field sent as a newline-separated string instead of an array', () => {
  const withStringBullets = {
    resume: {
      contact: { name: 'Jane Doe' },
      experience: [
        { title: 'Engineer', company: 'Acme', startDate: '2020', endDate: 'Present', bullets: '- Did X\n- Did Y' },
      ],
      education: [],
      skills: [],
    },
  };
  const parsed = parseTailoredResume(JSON.stringify(withStringBullets));
  assert.ok(parsed.structured);
  assert.deepEqual(parsed.structured?.experience[0].bullets, ['Did X', 'Did Y']);
});

test('routes old marker-delimited output to the legacy marker path', () => {
  const markerText = [
    '===TAILORED_RESUME===',
    'Jane Doe',
    '- Built React apps',
    '===MATCH_RATING===',
    '4',
    '===MATCH_JUSTIFICATION===',
    '- Strong match',
    '===SUGGESTIONS===',
    '- Mention TypeScript',
  ].join('\n');
  const parsed = parseTailoredResume(markerText);
  assert.equal(parsed.structured, null);
  assert.equal(parsed.resume, 'Jane Doe\n- Built React apps');
  assert.equal(parsed.matchRating, 4);
});

test('routes old flat legacy text (no markers, no JSON) to the flat-text path', () => {
  const parsed = parseTailoredResume('Jane Doe\nEngineer\n\nSuggestions:\nDo X.');
  assert.equal(parsed.structured, null);
  assert.equal(parsed.resume, 'Jane Doe\nEngineer');
  assert.equal(parsed.matchRating, null);
  assert.match(parsed.suggestions, /Do X\./);
});

test('flattenStructuredResume renders sections in order and skips empty ones', () => {
  const flat = flattenStructuredResume({
    contact: { name: 'Jane Doe', email: 'jane@example.com' },
    experience: [{ title: 'Engineer', company: 'Acme', startDate: '2020', endDate: 'Present', bullets: ['Did X'] }],
    education: [],
    skills: [],
  });
  assert.match(flat, /Jane Doe/);
  assert.match(flat, /PROFESSIONAL EXPERIENCE/);
  assert.doesNotMatch(flat, /PROJECTS/);
  assert.doesNotMatch(flat, /EDUCATION/);
  assert.doesNotMatch(flat, /TECHNICAL SKILLS/);
});
