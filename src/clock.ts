/**
 * The clock a run's time budget, its shutdown waits and its findings' flush
 * interval are measured on.
 *
 * 🔑 **Injected, because every one of those is a statement about time that a
 * test must be able to make without waiting.** A budget of an hour, a flush
 * every minute and a 20-second grace are each checked against a fake clock
 * that a test moves by hand — never against a real sleep, which would either
 * make the suite slow or make the check too short to mean anything.
 */
export interface Clock {
  /** Milliseconds. Comparable only with another reading of the same clock. */
  now(): number;
  /**
   * Calls `fn` once, `ms` from now. Returns a cancel, safe to call more than
   * once and after `fn` has run.
   */
  after(ms: number, fn: () => void): () => void;
}

export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/** How a bounded wait ended. */
export type Within<T> =
  { readonly kind: "done"; readonly value: T } | { readonly kind: "timed-out" };

/**
 * Wait for `work`, but no longer than `ms` on `clock`.
 *
 * ⚠️ **Abandoning the wait does not stop the work.** A request still in flight
 * goes on; the caller only stops waiting for it. Its later rejection is
 * handled here, so it can never surface as an unhandled rejection that ends
 * the process. A rejection BEFORE the time is up is the caller's, as it would
 * be without the bound.
 */
export function within<T>(
  work: Promise<T>,
  ms: number,
  clock: Clock,
): Promise<Within<T>> {
  let cancel: () => void = () => undefined;
  const timedOut = new Promise<Within<T>>((resolve) => {
    cancel = clock.after(Math.max(0, ms), () => resolve({ kind: "timed-out" }));
  });
  const done = work.then((value): Within<T> => ({ kind: "done", value }));
  return Promise.race([done, timedOut]).finally(() => cancel());
}
