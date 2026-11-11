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
