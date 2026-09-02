// Mirrors backend/src/resumeSchema.ts. Kept in sync manually (the project has
// no shared package). Only the coercion logic needed to parse a tailor run's
// JSON output for the preview modal is duplicated here — the dashboard never
// renders StructuredResume into a template itself (that only happens in the
// backend's download route), so this file doesn't need the render helpers.

export interface ResumeContact {
  name: string;
  email?: string;
  phone?: string;
  location?: string;
  links?: string[];
}

export interface ResumeExperienceEntry {
  title: string;
  company: string;
  location?: string;
  startDate: string;
  endDate: string;
  bullets: string[];
}

export interface ResumeProjectEntry {
  name: string;
  dateRange?: string;
  bullets: string[];
}

export interface ResumeEducationEntry {
  institution: string;
  degree: string;
  dates: string;
  honors?: string;
  coursework?: string;
}

export interface ResumeSkillCategory {
  label: string;
  items: string[];
}

export interface StructuredResume {
  contact: ResumeContact;
  summary?: string;
  experience: ResumeExperienceEntry[];
  projects?: ResumeProjectEntry[];
  education: ResumeEducationEntry[];
  skills: ResumeSkillCategory[];
}

export interface CoverLetterHeader {
  recipient: string;
  company: string;
}

export interface CoverLetter {
  contact: ResumeContact;
  date: string;
  header: CoverLetterHeader;
  body: string;
  footer: string;
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((item) => typeof item === 'string');
}

function coerceBullets(x: unknown): string[] {
  if (isStringArray(x)) return x;
  if (typeof x === 'string') {
    return x
      .split('\n')
      .map((line) => line.replace(/^[-*•]\s*/, '').trim())
      .filter(Boolean);
  }
  return [];
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function coerceExperienceEntry(x: unknown): ResumeExperienceEntry | null {
  if (!isPlainObject(x)) return null;
  if (typeof x.title !== 'string' || typeof x.company !== 'string') return null;
  return {
    title: x.title,
    company: x.company,
    location: typeof x.location === 'string' ? x.location : undefined,
    startDate: typeof x.startDate === 'string' ? x.startDate : '',
    endDate: typeof x.endDate === 'string' ? x.endDate : '',
    bullets: coerceBullets(x.bullets),
  };
}

function coerceProjectEntry(x: unknown): ResumeProjectEntry | null {
  if (!isPlainObject(x)) return null;
  if (typeof x.name !== 'string') return null;
  return {
    name: x.name,
    dateRange: typeof x.dateRange === 'string' ? x.dateRange : undefined,
    bullets: coerceBullets(x.bullets),
  };
}

function coerceEducationEntry(x: unknown): ResumeEducationEntry | null {
  if (!isPlainObject(x)) return null;
  if (typeof x.institution !== 'string' || typeof x.degree !== 'string') return null;
  return {
    institution: x.institution,
    degree: x.degree,
    dates: typeof x.dates === 'string' ? x.dates : '',
    honors: typeof x.honors === 'string' ? x.honors : undefined,
    coursework: typeof x.coursework === 'string' ? x.coursework : undefined,
  };
}

function coerceSkillCategory(x: unknown): ResumeSkillCategory | null {
  if (!isPlainObject(x)) return null;
  if (typeof x.label !== 'string') return null;
  return { label: x.label, items: coerceBullets(x.items) };
}

function coerceContact(x: unknown): ResumeContact | null {
  if (!isPlainObject(x) || typeof x.name !== 'string' || !x.name.trim()) return null;
  return {
    name: x.name,
    email: typeof x.email === 'string' ? x.email : undefined,
    phone: typeof x.phone === 'string' ? x.phone : undefined,
    location: typeof x.location === 'string' ? x.location : undefined,
    links: isStringArray(x.links) ? x.links : undefined,
  };
}

export function coerceStructuredResume(x: unknown): StructuredResume | null {
  if (!isPlainObject(x)) return null;
  const contact = coerceContact(x.contact);
  if (!contact) return null;
  if (!Array.isArray(x.experience) || !Array.isArray(x.education) || !Array.isArray(x.skills)) {
    return null;
  }

  return {
    contact,
    summary: typeof x.summary === 'string' ? x.summary : undefined,
    experience: x.experience.map(coerceExperienceEntry).filter((e): e is ResumeExperienceEntry => e !== null),
    projects: Array.isArray(x.projects)
      ? x.projects.map(coerceProjectEntry).filter((p): p is ResumeProjectEntry => p !== null)
      : undefined,
    education: x.education.map(coerceEducationEntry).filter((e): e is ResumeEducationEntry => e !== null),
    skills: x.skills.map(coerceSkillCategory).filter((s): s is ResumeSkillCategory => s !== null),
  };
}

export function coerceCoverLetter(x: unknown): CoverLetter | null {
  if (!isPlainObject(x)) return null;
  const contact = coerceContact(x.contact);
  if (!contact) return null;
  const header = x.header;
  if (
    !isPlainObject(header) ||
    typeof header.recipient !== 'string' ||
    typeof header.company !== 'string'
  ) {
    return null;
  }
  if (typeof x.body !== 'string' || !x.body.trim()) return null;

  return {
    contact,
    date: typeof x.date === 'string' ? x.date : '',
    header: { recipient: header.recipient, company: header.company },
    body: x.body,
    footer: typeof x.footer === 'string' ? x.footer : '',
  };
}
