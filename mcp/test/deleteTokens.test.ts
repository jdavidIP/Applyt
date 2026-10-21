import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeleteTokenStore, DELETE_TOKEN_TTL_MS } from '../src/deleteTokens.ts';

function store(start = 0) {
  let t = start;
  let n = 0;
  const s = createDeleteTokenStore({ now: () => t, newToken: () => `tok${++n}` });
  return { s, advance: (ms: number) => (t += ms) };
}

test('issue then take with the right count succeeds, ids sorted and deduped', () => {
  const { s } = store();
  const token = s.issue([3, 1, 3, 2], { kind: 'ids' });
  const r = s.take(token, 3);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.pending.ids, [1, 2, 3]);
});

test('unknown token is refused', () => {
  const { s } = store();
  const r = s.take('nope', 1);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /unknown or already used/);
});

test('token is single use, even after a failed take', () => {
  const { s } = store();
  const token = s.issue([1, 2], { kind: 'ids' });
  assert.equal(s.take(token, 5).ok, false); // count mismatch consumes it
  const again = s.take(token, 2);
  assert.equal(again.ok, false);
  assert.match(!again.ok ? again.reason : '', /unknown or already used/);
});

test('count mismatch is refused with both numbers', () => {
  const { s } = store();
  const r = s.take(s.issue([1, 2], { kind: 'ids' }), 3);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /expected 3.*preview matched 2/);
});

test('expired token is refused', () => {
  const { s, advance } = store();
  const token = s.issue([1], { kind: 'ids' });
  advance(DELETE_TOKEN_TTL_MS + 1);
  const r = s.take(token, 1);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /expired/);
});

test('token just inside the TTL still works', () => {
  const { s, advance } = store();
  const token = s.issue([1], { kind: 'status', status: 'rejected' });
  advance(DELETE_TOKEN_TTL_MS);
  const r = s.take(token, 1);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.pending.target, { kind: 'status', status: 'rejected' });
});
