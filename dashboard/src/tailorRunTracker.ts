// Tracks tailor runs per application id outside any single TailorModal
// instance's React state. Closing and reopening the modal (issue #37)
// unmounts/remounts the component, which would otherwise lose track of an
// outstanding run — a freshly mounted instance can call getTailorRun() to
// rejoin it and learn when it settles, instead of the guard only living in
// state that resets on remount.
const runs = new Map<number, Promise<unknown>>();

export function isTailorRunning(id: number): boolean {
  return runs.has(id);
}

// Registers `promise` as the outstanding run for `id` and returns it
// unchanged so the caller can await it directly. Clears the entry once
// settled, but only if nothing newer has replaced it in the meantime.
export function trackTailorRun<T>(id: number, promise: Promise<T>): Promise<T> {
  runs.set(id, promise);
  // The caller (and only the caller) is responsible for handling a rejection
  // from the returned promise — this internal chain must swallow it here or
  // it surfaces as an unhandled rejection.
  promise
    .finally(() => {
      if (runs.get(id) === promise) runs.delete(id);
    })
    .catch(() => {});
  return promise;
}

// Returns the outstanding run for `id`, if any, so a newly-mounted component
// can attach to it.
export function getTailorRun(id: number): Promise<unknown> | undefined {
  return runs.get(id);
}
