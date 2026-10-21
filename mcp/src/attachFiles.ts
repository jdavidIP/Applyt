import fs from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';

// Reads a user's own resume / cover-letter file for attach_files. The model
// supplies the path, so this is a guard as much as a reader: a confused or
// prompt-injected Claude must not be able to pull arbitrary files (SSH keys,
// .env) off the disk into Applyt. Only absolute paths to regular .pdf/.docx
// files of a sane size are read, and their leading bytes must match the
// extension. The backend re-checks the format fully (incl. the DOCX archive
// contents) — this side only needs to refuse anything that isn't plausibly one.

// Same limit as backend/src/resume/fileFormat.ts — duplicated on purpose,
// the workspaces share no package.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const SIGNATURES = { pdf: Buffer.from('%PDF-'), docx: Buffer.from([0x50, 0x4b, 0x03, 0x04]) };

export async function readAttachment(
  path: string,
): Promise<{ filename: string; format: 'pdf' | 'docx'; data: Buffer }> {
  const fail = (reason: string) => new Error(`Can't attach ${path}: ${reason}`);
  if (!isAbsolute(path)) {
    throw fail('the path must be absolute (the full path, e.g. C:\\Users\\you\\Downloads\\resume.pdf).');
  }
  const ext = extname(path).toLowerCase();
  if (ext !== '.pdf' && ext !== '.docx') throw fail('only .pdf or .docx files can be attached.');
  const format = ext === '.pdf' ? 'pdf' : 'docx';

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(path);
  } catch {
    throw fail('the file does not exist or cannot be read.');
  }
  if (!stat.isFile()) throw fail('it is not a file.');
  if (stat.size === 0) throw fail('the file is empty.');
  if (stat.size > MAX_ATTACHMENT_BYTES) throw fail('the file is larger than 5 MB.');

  const data = await fs.promises.readFile(path);
  if (!data.subarray(0, SIGNATURES[format].length).equals(SIGNATURES[format])) {
    throw fail(`its contents are not a ${format === 'pdf' ? 'PDF' : 'Word (.docx)'} file.`);
  }
  return { filename: basename(path), format, data };
}
