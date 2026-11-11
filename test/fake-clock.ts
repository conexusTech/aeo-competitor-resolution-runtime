import type { Clock } from "../src/clock.js";

/**
 * A clock a test moves by hand.
 *
 * 🔑 **One instance is handed to everything that reads time in a check** — the
 * run's budget, the reporter's flush interval, the shutdown's waits — so they
 * all agree on what "now" is, as they do in production.
 */
export class FakeClock implements Clock {
  private time = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.time;
  }

  after(ms: number, fn: () => void): () => void {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), fn });
    return () => {
      this.timers.delete(id);
    };
  }

  /** Timers not yet run or cancelled. */
  get pending(): number {
    return this.timers.size;
  }

  /**
   * Move time forward synchronously, running every timer that falls due, in
   * order. For use inside code the run is executing, where awaiting is not
   * possible.
   */
  tick(ms: number): void {
    const until = this.time + ms;
    for (;;) {
      const next = this.nextDue(until);
      if (next === null) break;
      this.timers.delete(next.id);
      this.time = next.at;
      next.fn();
    }
    this.time = until;
  }

  /**
   * Move time forward, running each due timer in order and letting the
   * promise work it starts settle before the next one. For use from a test.
   */
  async advance(ms: number): Promise<void> {
    const until = this.time + ms;
    await settle();
    for (;;) {
      const next = this.nextDue(until);
      if (next === null) break;
      this.timers.delete(next.id);
      this.time = next.at;
      next.fn();
      await settle();
    }
    this.time = until;
    await settle();
  }

  private nextDue(
    until: number,
  ): { id: number; at: number; fn: () => void } | null {
    let best: { id: number; at: number; fn: () => void } | null = null;
    for (const [id, timer] of this.timers) {
      if (timer.at > until) continue;
      if (best === null || timer.at < best.at) best = { id, ...timer };
    }
    return best;
  }
}

/**
 * Let pending promise work run: a few turns of the real event loop.
 *
 * ⚠️ Real `setImmediate`, so real file writes started by the code under test
 * (the journals) get to finish too.
 */
export async function settle(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
