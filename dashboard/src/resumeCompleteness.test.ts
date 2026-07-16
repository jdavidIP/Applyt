import { describe, test, expect } from 'vitest';
import { checkResumeCompleteness } from './resumeCompleteness';

const FULL_RESUME = `Jane Doe
jane@example.com | +1 (548) 390-4453 | Waterloo, ON

PROFESSIONAL EXPERIENCE
Software Engineer — Acme Corp
- Built things.

EDUCATION
Bachelor of Computer Science — State University
`;

describe('checkResumeCompleteness', () => {
  test('detects nothing missing in a well-formed resume', () => {
    expect(checkResumeCompleteness(FULL_RESUME)).toEqual([]);
  });

  test('flags a missing phone number', () => {
    const noPhone = FULL_RESUME.replace('+1 (548) 390-4453 | ', '');
    const missing = checkResumeCompleteness(noPhone);
    expect(missing.map((m) => m.field)).toContain('phone');
  });

  test('flags a missing name (first line looks like a sentence, not a name)', () => {
    const noName = 'Experienced software engineer looking for new opportunities.\n' + FULL_RESUME.slice(9);
    const missing = checkResumeCompleteness(noName);
    expect(missing.map((m) => m.field)).toContain('name');
  });

  test('flags a missing location', () => {
    const noLocation = FULL_RESUME.replace(' | Waterloo, ON', '');
    const missing = checkResumeCompleteness(noLocation);
    expect(missing.map((m) => m.field)).toContain('location');
  });

  test('flags a missing experience section', () => {
    const noExperience = FULL_RESUME.replace(/PROFESSIONAL EXPERIENCE[\s\S]*?\n\n/, '');
    const missing = checkResumeCompleteness(noExperience);
    expect(missing.map((m) => m.field)).toContain('experience');
  });

  test('flags a missing education section', () => {
    const noEducation = FULL_RESUME.replace(/EDUCATION[\s\S]*/, '');
    const missing = checkResumeCompleteness(noEducation);
    expect(missing.map((m) => m.field)).toContain('education');
  });

  test('returns no warnings for a genuinely empty resume (not yet filled in)', () => {
    expect(checkResumeCompleteness('')).toEqual([]);
    expect(checkResumeCompleteness('   ')).toEqual([]);
  });

  test('flags short garbage input as missing everything, rather than treating it as "not filled in"', () => {
    const missing = checkResumeCompleteness('hi').map((m) => m.field);
    expect(missing).toEqual(
      expect.arrayContaining(['name', 'phone', 'location', 'experience', 'education']),
    );
  });

  test('flags everything missing for clearly unrelated text', () => {
    const jobPosting =
      'We are hiring a Senior React Developer. Requirements: 5+ years experience, strong TypeScript skills, and a passion for building great products.';
    const missing = checkResumeCompleteness(jobPosting);
    expect(missing.map((m) => m.field)).toEqual(
      expect.arrayContaining(['name', 'phone', 'location']),
    );
  });
});
