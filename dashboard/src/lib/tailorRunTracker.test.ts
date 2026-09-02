import { describe, test, expect } from 'vitest';
import { isTailorRunning, trackTailorRun, getTailorRun } from './tailorRunTracker';

// Covers the concurrency guard behind issue #37: a run must stay visible via
// isTailorRunning/getTailorRun for as long as its promise is pending, and
// clear once it settles, so a remounted TailorModal can tell whether to
// rejoin an outstanding run or start a new one.
describe('tailorRunTracker', () => {
  test('tracks a run as in-flight until its promise settles', async () => {
    expect(isTailorRunning(1)).toBe(false);

    let resolve!: (v: string) => void;
    const promise = new Promise<string>((r) => (resolve = r));
    trackTailorRun(1, promise);

    expect(isTailorRunning(1)).toBe(true);
    expect(getTailorRun(1)).toBe(promise);

    resolve('done');
    await promise;
    // finally() handlers run as a microtask after the awaited promise settles.
    await Promise.resolve();

    expect(isTailorRunning(1)).toBe(false);
  });

  test('clears on rejection too', async () => {
    const promise = trackTailorRun(2, Promise.reject(new Error('boom')));
    expect(isTailorRunning(2)).toBe(true);
    await promise.catch(() => {});
    await Promise.resolve();
    expect(isTailorRunning(2)).toBe(false);
  });

  test('a stale run settling late does not clobber a newer run for the same id', async () => {
    let resolveFirst!: () => void;
    const first = new Promise<void>((r) => (resolveFirst = r));
    trackTailorRun(3, first);

    let resolveSecond!: () => void;
    const second = new Promise<void>((r) => (resolveSecond = r));
    trackTailorRun(3, second);

    resolveFirst();
    await first;
    await Promise.resolve();
    // The first (stale) run settling must not clear the second, still-current entry.
    expect(getTailorRun(3)).toBe(second);

    resolveSecond();
    await second;
    await Promise.resolve();
    expect(isTailorRunning(3)).toBe(false);
  });

  test('isolates tracking per application id', () => {
    trackTailorRun(4, new Promise(() => {}));
    expect(isTailorRunning(4)).toBe(true);
    expect(isTailorRunning(5)).toBe(false);
  });
});
