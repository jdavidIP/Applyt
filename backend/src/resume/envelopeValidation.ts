import { isPlainObject, isStringArray } from '../types/resumeSchema.js';

// Strict counterpart to the lenient coerce* functions in types/resumeSchema.ts,
// for input that arrives through POST /applications/:id/resume-versions (the
// MCP server).
// The coercers silently drop malformed nested entries — right for a model's
// raw output, wrong for an API caller who would never learn a bullet was
// dropped. Returns the first offending field path + reason, or null if valid.
export function findEnvelopeError(x: unknown): string | null {
  if (!isPlainObject(x)) return 'body must be a JSON object';
  const resumeErr = findResumeError(x.resume, 'resume');
  if (resumeErr) return resumeErr;
  if (x.coverLetter !== undefined) {
    const clErr = findCoverLetterError(x.coverLetter, 'coverLetter');
    if (clErr) return clErr;
  }
  if (
    x.matchRating !== undefined &&
    !(Number.isInteger(x.matchRating) && (x.matchRating as number) >= 0 && (x.matchRating as number) <= 5)
  ) {
    return 'matchRating must be an integer from 0 to 5';
  }
  for (const key of ['matchJustification', 'suggestions'] as const) {
    if (x[key] !== undefined && !isStringArray(x[key])) return `${key} must be an array of strings`;
  }
  return null;
}

const str = (v: unknown) => typeof v === 'string';
const optStr = (v: unknown) => v === undefined || typeof v === 'string';

function findContactError(c: unknown, path: string): string | null {
  if (!isPlainObject(c)) return `${path} must be an object`;
  if (!str(c.name) || !(c.name as string).trim()) return `${path}.name must be a non-empty string`;
  for (const k of ['email', 'phone', 'location'] as const) {
    if (!optStr(c[k])) return `${path}.${k} must be a string`;
  }
  if (c.links !== undefined && !isStringArray(c.links)) return `${path}.links must be an array of strings`;
  return null;
}

// fields: [key, required] pairs of string fields; arrays: string-array fields (always required).
function findEntryError(
  e: unknown,
  path: string,
  fields: [string, boolean][],
  arrays: string[],
): string | null {
  if (!isPlainObject(e)) return `${path} must be an object`;
  for (const [k, required] of fields) {
    if (required ? !str(e[k]) : !optStr(e[k])) return `${path}.${k} must be a string`;
  }
  for (const k of arrays) {
    if (!isStringArray(e[k])) return `${path}.${k} must be an array of strings`;
  }
  return null;
}

function findListError(
  list: unknown,
  path: string,
  required: boolean,
  check: (item: unknown, itemPath: string) => string | null,
): string | null {
  if (list === undefined && !required) return null;
  if (!Array.isArray(list)) return `${path} must be an array`;
  for (let i = 0; i < list.length; i++) {
    const err = check(list[i], `${path}[${i}]`);
    if (err) return err;
  }
  return null;
}

function findResumeError(r: unknown, path: string): string | null {
  if (!isPlainObject(r)) return `${path} is required and must be an object`;
  return (
    findContactError(r.contact, `${path}.contact`) ??
    (optStr(r.summary) ? null : `${path}.summary must be a string`) ??
    findListError(r.experience, `${path}.experience`, true, (e, p) =>
      findEntryError(
        e,
        p,
        [['title', true], ['company', true], ['location', false], ['startDate', true], ['endDate', true]],
        ['bullets'],
      ),
    ) ??
    findListError(r.projects, `${path}.projects`, false, (e, p) =>
      findEntryError(e, p, [['name', true], ['dateRange', false]], ['bullets']),
    ) ??
    findListError(r.education, `${path}.education`, true, (e, p) =>
      findEntryError(
        e,
        p,
        [['institution', true], ['degree', true], ['dates', true], ['honors', false], ['coursework', false]],
        [],
      ),
    ) ??
    findListError(r.skills, `${path}.skills`, true, (e, p) => findEntryError(e, p, [['label', true]], ['items']))
  );
}

function findCoverLetterError(c: unknown, path: string): string | null {
  if (!isPlainObject(c)) return `${path} must be an object`;
  const contactErr = findContactError(c.contact, `${path}.contact`);
  if (contactErr) return contactErr;
  if (!isPlainObject(c.header) || !str(c.header.recipient) || !str(c.header.company)) {
    return `${path}.header must be an object with string recipient and company`;
  }
  if (!str(c.body) || !(c.body as string).trim()) return `${path}.body must be a non-empty string`;
  if (!str(c.date)) return `${path}.date must be a string`;
  if (!str(c.footer)) return `${path}.footer must be a string`;
  return null;
}
