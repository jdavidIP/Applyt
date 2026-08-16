// Structured resume shape (Phase 5: ATS resume template). The AI is prompted
// (ai.ts) to return a tailored resume as this JSON structure instead of a flat
// text blob, so resumeRender.ts has real sections to lay out into a proper
// template rather than dumb-dumping lines into a PDF/DOCX.
//
// Every field beyond `contact.name` is optional: the AI won't always have a
// project section, honors line, etc. to fill in, and the renderer must skip
// sections that aren't present rather than emit an empty heading.

export interface ResumeContact {
  name: string;
  email?: string;
  phone?: string;
  location?: string;
  links?: string[]; // pre-formatted display strings, e.g. "github.com/x" — no protocol required
}

export interface ResumeExperienceEntry {
  title: string;
  company: string;
  location?: string;
  startDate: string; // free text, e.g. "Jun 2022" — resumes use fuzzy dates, not real Date values
  endDate: string; // "Present" allowed
  bullets: string[]; // no leading "-"/"•" — the renderer adds the glyph
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
  honors?: string; // e.g. "With Distinction, Major in Cybersecurity"
  coursework?: string; // e.g. "Relevant Coursework: Data Structures, ..."
}

export interface ResumeSkillCategory {
  label: string; // e.g. "Languages"
  items: string[]; // rendered comma-separated
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
  recipient: string; // e.g. "Hiring Team", or a named contact from the job description
  company: string;
}

export interface CoverLetter {
  contact: ResumeContact;
  date: string; // free text, e.g. "August 10, 2026"
  header: CoverLetterHeader;
  body: string; // 3-4 paragraphs joined by "\n\n", no bullets
  footer: string; // sign-off, e.g. "Sincerely, Jane Doe"
}

// The full JSON object the AI is asked to return in one shot (ai.ts). Match
// rating/justification/suggestions/coverLetter live alongside the resume
// itself so there's a single parse, single failure mode — see
// tailoredResume.ts.
export interface TailorResponseEnvelope {
  resume: StructuredResume;
  coverLetter?: CoverLetter;
  matchRating?: number; // integer 0-5
  matchJustification?: string[]; // bullet strings, no leading "-"
  suggestions?: string[]; // bullet strings, no leading "-"
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((item) => typeof item === 'string');
}

// Coerces a bullets field that should be string[] but came back as a single
// newline-separated string (a real thing models do despite explicit schema
// instructions) rather than rejecting the whole entry over it.
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

// Strict on top-level shape (a resume without a name, or with an unusable
// experience/education/skills array, isn't worth rendering as structured
// data), lenient on nested fields (one malformed bullet or missing date
// shouldn't nuke the whole tailored resume) — malformed nested items are
// dropped rather than failing the whole parse.
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

// Lenient like coerceStructuredResume: a cover letter needs a real contact,
// header (recipient + company), and non-empty body to be worth rendering;
// date/footer fall back to an empty string rather than failing the parse.
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

export function isStructuredResume(x: unknown): x is StructuredResume {
  return coerceStructuredResume(x) !== null;
}
