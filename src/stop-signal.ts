/**
 * The cluster telling this container to stop, and how long it has to do so.
 *
 * Kubernetes ends a container with SIGTERM, then SIGKILL once the pod's grace
 * period is over — 30 seconds by default, and the queue's Jobs set none. It
 * does so at the queue's deadline, on a cancel, on a node drain and when the
 * node autoscaler consolidates an underused node.
 *
 * 🔴 **Measured in production, 2026-11-11:** the first Best Buy release-check
 * run was evicted after about seven minutes ("Evicted pod: Underutilized").
 * With no handler the process died on the spot, with every finding still in
 * its buffer — 0 of 20 reported — and the gateway heard nothing until its
 * five-minute poll. So on SIGTERM a run stops taking items, gives the items in
 * flight a bounded time, files what it found and hands the run back with
 * `yielded`, inside the grace period. See `runDispatchedJob`.
 *
 * ⚠️ **The process is injected** (`ProcessHooks`), so the whole of this is
 * checked by calling the handler it registered rather than by signalling the
 * test runner.
 */

import { SYSTEM_CLOCK, type Clock, type Within } from "./clock.js";

/**
 * The shutdown's limits, each measured from the moment SIGTERM arrived.
 *
 * 🔑 **Ordered, and the order is the design:** items in flight first, then
 * the last findings and `yielded`, then the backstop — all before SIGKILL.
 */
export const SHUTDOWN = {
  /** Kubernetes' default grace period; SIGKILL follows SIGTERM after it. */
  graceMs: 30_000,
  /**
   * Items already taken get this long to finish. An item is a handful of
   * pages, each normally a second or two, so most finish; one stuck in a
   * vendor's backoff is abandoned and goes to the next container.
   */
  inFlightMs: 20_000,
  /**
   * The last flush and `yielded` are abandoned at this point. Seven seconds
   * at least, after the longest in-flight wait — a request normally takes
   * well under one.
   */
  finishByMs: 27_000,
  /**
   * The process ends itself here whatever is still running. Reached only by a
   * wait the run's closing steps do not bound — the task record and the job
   * fetch before the run starts, and the journal loads; a hand-back the
   * gateway does not answer is abandoned at `finishByMs` instead, and the
   * process exits 0. Before SIGKILL, so the container's last log line says why.
   */
  hardExitMs: 28_500,
} as const;

/** Whether, and when, this container was told to stop. */
export interface StopRequest {
  /** When the stop was asked for, on the run's clock; `null` until then. */
  readonly askedAt: number | null;
  /** Settles when the stop is asked for. Never rejects; pending for ever if it never is. */
  readonly asked: Promise<void>;
}

/** A stop nothing will ever ask for: file mode, and checks about something else. */
export const NEVER_STOPPED: StopRequest = {
  askedAt: null,
  asked: new Promise<void>(() => undefined),
};

/**
 * Wait for `work` — for as long as it takes until a stop is asked for, and
 * from then on only until `limitMs` after the stop.
 *
 * 🔑 **Bounded from the stop, not from the call.** A report already under way
 * when SIGTERM arrives is cut off at the same moment as one started after it,
 * so no wait in the shutdown can outlast its limit by starting early.
 *
 * ⚠️ **Abandoning the wait does not stop the work.** A request still in
 * flight goes on; the caller only stops waiting for it, and the process ends
 * soon after, which is what stops it. Its later rejection is handled here, so
 * it can never surface as an unhandled rejection. A rejection BEFORE the time
 * is up is the caller's, as it would be without the bound.
 */
export function boundAfterStop<T>(
  work: Promise<T>,
  stop: StopRequest,
  clock: Clock,
  limitMs: number,
): Promise<Within<T>> {
  let settled = false;
  let cancel: () => void = () => undefined;
  const over = stop.asked.then(
    () =>
      new Promise<Within<T>>((resolve) => {
        // Settled before the stop: nothing to bound, and no timer to leave.
        if (settled) return;
        const askedAt = stop.askedAt ?? clock.now();
        cancel = clock.after(askedAt + limitMs - clock.now(), () =>
          resolve({ kind: "timed-out" }),
        );
      }),
  );
  const done = work.then((value): Within<T> => ({ kind: "done", value }));
  return Promise.race([done, over]).finally(() => {
    settled = true;
    cancel();
  });
}

/** A stop asked for by calling `request()`. The first call wins. */
export class StopSwitch implements StopRequest {
  private at: number | null = null;
  private settle: () => void = () => undefined;
  readonly asked: Promise<void>;

  constructor(private readonly clock: Clock) {
    this.asked = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
  }

  get askedAt(): number | null {
    return this.at;
  }

  request(): void {
    if (this.at !== null) return;
    this.at = this.clock.now();
    this.settle();
  }
}

/** The parts of the process the shutdown touches. */
export interface ProcessHooks {
  /** Listen for a signal. Returns a function that stops listening. */
  readonly onSignal: (
    signal: NodeJS.Signals,
    handler: () => void,
  ) => () => void;
  /** End the process with this code. */
  readonly exit: (code: number) => void;
  readonly clock: Clock;
  readonly log: (message: string) => void;
}

/** The real process. */
export function processHooks(): ProcessHooks {
  return {
    onSignal: (signal, handler) => {
      process.on(signal, handler);
      return () => {
        process.off(signal, handler);
      };
    },
    exit: (code) => process.exit(code),
    clock: SYSTEM_CLOCK,
    log: (message) => console.log(message),
  };
}

/** A stop request fed by SIGTERM. */
export interface TerminationWatch extends StopRequest {
  /** Stop listening. A stop already asked for stays asked for. */
  dispose(): void;
}

/**
 * Listen for SIGTERM.
 *
 * - The first one asks for the stop and arms the backstop: the process ends
 *   itself `SHUTDOWN.hardExitMs` later, with code 1, if nothing has ended it
 *   first. Code 1 because reaching it means a wait nothing else bounds — the
 *   job fetch, say — was still going, so no hand-back was even attempted.
 * - 🔴 **A second one is ignored.** Installing a listener replaces Node's
 *   default of dying on the spot; dying on a repeated signal would throw away
 *   the flush the first one started. The backstop already bounds the wait.
 */
export function watchForTermination(hooks: ProcessHooks): TerminationWatch {
  const stop = new StopSwitch(hooks.clock);
  const onTerm = (): void => {
    if (stop.askedAt !== null) {
      hooks.log(
        "SIGTERM again: already stopping — ignored; the shutdown is bounded " +
          "and ends on its own",
      );
      return;
    }
    stop.request();
    hooks.log(
      `SIGTERM: taking no new item; items in flight get ` +
        `${SHUTDOWN.inFlightMs / 1000}s, then what was found is filed and ` +
        `the run is handed back`,
    );
    hooks.clock.after(SHUTDOWN.hardExitMs, () => {
      hooks.log(
        `the shutdown did not finish within ${SHUTDOWN.hardExitMs / 1000}s ` +
          `of SIGTERM; ending the process before the cluster kills it`,
      );
      hooks.exit(1);
    });
  };
  const off = hooks.onSignal("SIGTERM", onTerm);
  return {
    get askedAt() {
      return stop.askedAt;
    },
    asked: stop.asked,
    dispose: off,
  };
}
