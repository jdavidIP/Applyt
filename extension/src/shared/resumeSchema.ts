// Mirrors backend/src/resumeSchema.ts (and the dashboard copy). The extension
// is bundled separately from the backend, so this is a hand-copied mirror kept
// in sync manually rather than a cross-workspace import. Only the coercion
// logic needed to parse a tailor run's JSON output for the popup preview is
// duplicated here — the extension never renders StructuredResume into a
// template itself (that only happens in the backend's download route).

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

export function coerceStructuredResume(x: unknown): StructuredResume | null {
  if (!isPlainObject(x)) return null;
  const contact = x.contact;
  if (!isPlainObject(contact) || typeof contact.name !== 'string' || !contact.name.trim()) {
    return null;
  }
  if (!Array.isArray(x.experience) || !Array.isArray(x.education) || !Array.isArray(x.skills)) {
    return null;
  }

  return {
    contact: {
      name: contact.name,
      email: typeof contact.email === 'string' ? contact.email : undefined,
      phone: typeof contact.phone === 'string' ? contact.phone : undefined,
      location: typeof contact.location === 'string' ? contact.location : undefined,
      links: isStringArray(contact.links) ? contact.links : undefined,
    },
    summary: typeof x.summary === 'string' ? x.summary : undefined,
    experience: x.experience.map(coerceExperienceEntry).filter((e): e is ResumeExperienceEntry => e !== null),
    projects: Array.isArray(x.projects)
      ? x.projects.map(coerceProjectEntry).filter((p): p is ResumeProjectEntry => p !== null)
      : undefined,
    education: x.education.map(coerceEducationEntry).filter((e): e is ResumeEducationEntry => e !== null),
    skills: x.skills.map(coerceSkillCategory).filter((s): s is ResumeSkillCategory => s !== null),
  };
}
