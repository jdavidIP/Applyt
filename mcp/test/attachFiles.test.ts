import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAttachment, MAX_ATTACHMENT_BYTES } from '../src/attachFiles.ts';

let dir: string;
const PDF = Buffer.from('%PDF-1.4\nfake pdf body');
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('zip body')]);

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'applyt-attach-'));
  mkdirSync(join(dir, 'My Docs'));
  writeFileSync(join(dir, 'My Docs', 'My Resume.pdf'), PDF);
  writeFileSync(join(dir, 'r.docx'), DOCX);
  writeFileSync(join(dir, 'notes.txt'), 'hello');
  mkdirSync(join(dir, 'folder.pdf'));
  writeFileSync(join(dir, 'empty.pdf'), Buffer.alloc(0));
  writeFileSync(join(dir, 'big.pdf'), Buffer.concat([PDF, Buffer.alloc(MAX_ATTACHMENT_BYTES)]));
  writeFileSync(join(dir, 'fake.pdf'), 'this is text, not a pdf');
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('accepts an absolute .pdf in a directory with spaces', async () => {
  const a = await readAttachment(join(dir, 'My Docs', 'My Resume.pdf'));
  assert.equal(a.filename, 'My Resume.pdf');
  assert.equal(a.format, 'pdf');
  assert.deepEqual(a.data, PDF);
});

test('accepts a .docx that starts with a ZIP header', async () => {
  const a = await readAttachment(join(dir, 'r.docx'));
  assert.equal(a.format, 'docx');
});

test('rejects relative and ~ paths as not absolute', async () => {
  await assert.rejects(readAttachment('resume.pdf'), /absolute/);
  await assert.rejects(readAttachment('~/resume.pdf'), /absolute/);
});

test('rejects other extensions, directories, empty and mislabelled files', async () => {
  await assert.rejects(readAttachment(join(dir, 'notes.txt')), /\.pdf or \.docx/);
  await assert.rejects(readAttachment(join(dir, 'folder.pdf')), /not a file/);
  await assert.rejects(readAttachment(join(dir, 'empty.pdf')), /empty/);
  await assert.rejects(readAttachment(join(dir, 'fake.pdf')), /not a PDF/);
});

test('rejects a file over 5 MB without reading it', async () => {
  const spy = mock.method(fs.promises, 'readFile');
  try {
    await assert.rejects(readAttachment(join(dir, 'big.pdf')), /5 MB/);
    assert.equal(spy.mock.callCount(), 0);
  } finally {
    spy.mock.restore();
  }
});
