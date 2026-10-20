import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// resumeSchema.ts and tailoredResume.ts are hand-copied into the dashboard and
// extension (no shared package). Import paths differ per workspace, so import
// statements (single- or multi-line) are ignored; everything else must match
// the backend copy exactly.
const root = new URL('../../', import.meta.url);
const body = (path: string) =>
  readFileSync(new URL(path, root), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^import [\s\S]*?;\n/gm, '');

const MIRRORS: Record<string, string[]> = {
  'backend/src/types/resumeSchema.ts': ['dashboard/src/types/resumeSchema.ts', 'extension/src/shared/resumeSchema.ts'],
  'backend/src/resume/tailoredResume.ts': ['dashboard/src/lib/tailoredResume.ts', 'extension/src/shared/tailoredResume.ts'],
};

for (const [source, copies] of Object.entries(MIRRORS)) {
  for (const copy of copies) {
    test(`${copy} mirrors ${source}`, () => {
      assert.equal(body(copy), body(source), `${copy} drifted from ${source} — apply the same change to every copy`);
    });
  }
}
