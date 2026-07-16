// Local (non-AI) heuristic check that a saved base resume contains the basic
// fields a resume is expected to have — similar in spirit to how a job
// application form auto-fills Name/Location/Phone/Experience/Education from
// an uploaded resume (Issue #14). This is advisory only: it never blocks
// saving, it just surfaces what it couldn't detect so the user can confirm
// whether that's intentional or a parsing miss. The AI-side relevance check
// (whether the text is a resume at all) is handled server-side, in the
// tailoring prompt itself — there's no reliable way to do that locally.

export type ResumeCompletenessField = 'name' | 'phone' | 'location' | 'experience' | 'education';

export interface MissingField {
  field: ResumeCompletenessField;
  label: string;
}

const FIELD_LABELS: Record<ResumeCompletenessField, string> = {
  name: 'a name',
  phone: 'a phone number',
  location: 'a location',
  experience: 'a professional experience / work history section',
  education: 'an education section',
};

// Treats the first non-blank line as the name if it's short and name-shaped
// (2-5 capitalized words, no digits, no sentence-ending punctuation) — the
// same convention the ATS resume template itself uses (name is always the
// first line, see backend/src/resumeRender.ts).
function hasName(lines: string[]): boolean {
  const candidate = lines.find((l) => l.trim().length > 0);
  if (!candidate) return false;
  const trimmed = candidate.trim();
  if (trimmed.length > 60 || /\d/.test(trimmed) || /[.!?]$/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  return words.every((w) => /^[A-ZÀ-Ý][\p{L}'.-]*$/u.test(w));
}

const PHONE_RE = /(\+?\d[\d\-.\s()]{7,}\d)/;
function hasPhone(text: string): boolean {
  return PHONE_RE.test(text);
}

// Looks for a "City, ST" / "City, Country"-style pattern only within the
// first few lines (the contact block) rather than the whole document, to
// avoid false positives from unrelated comma-separated text further down.
const LOCATION_RE = /\b[A-Z][a-zA-Z.\s]{1,25},\s?[A-Z]{2}\b|\b[A-Z][a-zA-Z.\s]{1,25},\s?[A-Z][a-zA-Z]{2,}\b/;
function hasLocation(lines: string[]): boolean {
  return LOCATION_RE.test(lines.slice(0, 6).join('\n'));
}

const EXPERIENCE_RE = /\b(experience|employment history|work history)\b/i;
function hasExperienceSection(text: string): boolean {
  return EXPERIENCE_RE.test(text);
}

const EDUCATION_RE = /\b(education|university|college|bachelor|master|degree|diploma|b\.?[as]\.?)\b/i;
function hasEducationSection(text: string): boolean {
  return EDUCATION_RE.test(text);
}

// Returns the fields that couldn't be detected. A genuinely empty resume
// returns no warnings — a blank base resume is a legitimate state (e.g. the
// user is only configuring their provider/API key so far) and flagging
// "everything is missing" on nothing typed at all is noise, not signal. Any
// non-empty text the user actually entered gets checked, however short —
// short garbage input ("hi") is exactly what this check exists to catch, not
// something to wave through as "not filled in yet".
export function checkResumeCompleteness(baseResume: string): MissingField[] {
  const text = baseResume ?? '';
  if (text.trim().length === 0) return [];

  const lines = text.split(/\r?\n/);
  const checks: { field: ResumeCompletenessField; present: boolean }[] = [
    { field: 'name', present: hasName(lines) },
    { field: 'phone', present: hasPhone(text) },
    { field: 'location', present: hasLocation(lines) },
    { field: 'experience', present: hasExperienceSection(text) },
    { field: 'education', present: hasEducationSection(text) },
  ];

  return checks
    .filter((c) => !c.present)
    .map((c) => ({ field: c.field, label: FIELD_LABELS[c.field] }));
}
