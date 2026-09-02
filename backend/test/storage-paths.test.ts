import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDbPath } from '../src/storage/db.ts';
import { resolveSettingsPath } from '../src/storage/settings.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Regression test for a bug where the storage/ restructure shifted db.ts and
// settings.ts one folder deeper without updating their default-path math,
// silently pointing a fresh `npm run dev` at a new, empty backend/src/data/
// instead of the user's real backend/data/ — losing no data, but making it
// look lost. DB_PATH/SETTINGS_PATH are asserted unset here since every other
// test in this suite sets them, which is exactly how this slipped through.

test('resolveDbPath defaults to backend/data/applications.db', () => {
  assert.equal(process.env.DB_PATH, undefined);
  assert.equal(resolveDbPath(), resolve(__dirname, '..', 'data', 'applications.db'));
});

test('resolveSettingsPath defaults to backend/data/settings.json', () => {
  assert.equal(process.env.SETTINGS_PATH, undefined);
  assert.equal(resolveSettingsPath(), resolve(__dirname, '..', 'data', 'settings.json'));
});
