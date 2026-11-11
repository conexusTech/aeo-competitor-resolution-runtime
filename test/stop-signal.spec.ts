import { describe, expect, it } from "vitest";

import {
  NEVER_STOPPED,
  SHUTDOWN,
  StopSwitch,
  boundAfterStop,
  watchForTermination,
  type ProcessHooks,
} from "../src/stop-signal.js";
import { FakeClock, settle } from "./fake-clock.js";

/**
 * How the container hears that the cluster wants it gone.
 *
 * 🔑 **The process is a seam, not a global.** Real signals cannot be sent to a
 * test runner without killing it, so the signal source, the exit and the
 * clock are handed in — and the check sends SIGTERM by calling the handler
 * the module registered.
 */

function fakeProcess() {
  const clock = new FakeClock();
  const handlers = new Map<string, () => void>();
  const exits: number[] = [];
  const lines: string[] = [];
  const hooks: ProcessHooks = {
    onSignal: (signal, handler) => {
      handlers.set(signal, handler);
      return () => {
        handlers.delete(signal);
      };
    },
    exit: (code) => {
      exits.push(code);
    },
    clock,
    log: (message) => lines.push(message),
  };
  const send = (signal: string): void => {
    const handler = handlers.get(signal);
    if (handler === undefined) throw new Error(`nothing listens for ${signal}`);
    handler();
  };
  return { hooks, clock, handlers, exits, lines, send };
}

describe("hearing SIGTERM", () => {
  it("listens for SIGTERM, and is not stopped until it arrives", () => {
    const p = fakeProcess();
    const stop = watchForTermination(p.hooks);
    expect([...p.handlers.keys()]).toEqual(["SIGTERM"]);
    expect(stop.askedAt).toBeNull();
  });

  it("records when the stop was asked for, on the run's clock, and settles `asked`", async () => {
    const p = fakeProcess();
    const stop = watchForTermination(p.hooks);
    let heard = false;
    void stop.asked.then(() => {
      heard = true;
    });
    await p.clock.advance(5_000);
    p.send("SIGTERM");
    await settle();
    expect(stop.askedAt).toBe(5_000);
    expect(heard).toBe(true);
    expect(p.exits).toEqual([]);
  });

  it("ignores a second SIGTERM rather than starting the shutdown again or dying mid-flush", async () => {
    const p = fakeProcess();
    const stop = watchForTermination(p.hooks);
    p.send("SIGTERM");
    await p.clock.advance(3_000);
    p.send("SIGTERM");
    // Still the first signal's time, and still one backstop, not two.
    expect(stop.askedAt).toBe(0);
    expect(p.clock.pending).toBe(1);
    expect(p.lines.join(" ")).toMatch(/already stopping/);
    expect(p.exits).toEqual([]);
  });

  it("ends the process itself before the cluster's grace period, however far the shutdown got", async () => {
    // 🔴 The backstop for a hung flush or a hung `yielded`: every wait in the
    // shutdown is bounded, and this bounds the ones nobody thought of.
    const p = fakeProcess();
    watchForTermination(p.hooks);
    p.send("SIGTERM");
    await p.clock.advance(SHUTDOWN.hardExitMs - 1);
    expect(p.exits).toEqual([]);
    await p.clock.advance(1);
    expect(p.exits).toEqual([1]);
    expect(SHUTDOWN.hardExitMs).toBeLessThan(SHUTDOWN.graceMs);
  });

  it("stops listening when disposed, so a run that already ended is not held up", () => {
    const p = fakeProcess();
    const stop = watchForTermination(p.hooks);
    stop.dispose();
    expect(p.handlers.size).toBe(0);
  });

  it("orders its limits: in flight, then filing and yielding, then the backstop, all inside the grace", () => {
    expect(SHUTDOWN.inFlightMs).toBeLessThan(SHUTDOWN.finishByMs);
    expect(SHUTDOWN.finishByMs).toBeLessThan(SHUTDOWN.hardExitMs);
    expect(SHUTDOWN.hardExitMs).toBeLessThan(SHUTDOWN.graceMs);
    expect(SHUTDOWN.graceMs).toBe(30_000);
  });
});

describe("a stop switch", () => {
  it("is asked once, at the time it was first asked", async () => {
    const clock = new FakeClock();
    const stop = new StopSwitch(clock);
    await clock.advance(7);
    stop.request();
    await clock.advance(7);
    stop.request();
    expect(stop.askedAt).toBe(7);
  });

  it("NEVER_STOPPED is never asked", () => {
    expect(NEVER_STOPPED.askedAt).toBeNull();
  });
});

describe("a wait bounded by the stop", () => {
  const never = new Promise<string>(() => undefined);

  it("waits as long as it takes while no stop is asked for, leaving no timer", async () => {
    const clock = new FakeClock();
    const stop = new StopSwitch(clock);
    let finish: (v: string) => void = () => undefined;
    const work = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const waiting = boundAfterStop(work, stop, clock, 1_000);
    await clock.advance(10 * 60_000);
    expect(clock.pending).toBe(0);
    finish("done");
    expect(await waiting).toEqual({ kind: "done", value: "done" });
    // A stop after it settled starts nothing.
    stop.request();
    await settle();
    expect(clock.pending).toBe(0);
  });

  it("is cut off at the limit after the stop, for a wait already under way", async () => {
    const clock = new FakeClock();
    const stop = new StopSwitch(clock);
    let outcome: unknown = null;
    void boundAfterStop(never, stop, clock, 1_000).then((o) => {
      outcome = o;
    });
    await clock.advance(5_000);
    stop.request();
    await clock.advance(999);
    expect(outcome).toBeNull();
    await clock.advance(1);
    expect(outcome).toEqual({ kind: "timed-out" });
  });

  it("is measured from the stop, not from the call, for a wait started after it", async () => {
    // So no wait in the shutdown can outlast the limit by starting late.
    const clock = new FakeClock();
    const stop = new StopSwitch(clock);
    stop.request();
    await clock.advance(600);
    let outcome: unknown = null;
    void boundAfterStop(never, stop, clock, 1_000).then((o) => {
      outcome = o;
    });
    await clock.advance(399);
    expect(outcome).toBeNull();
    await clock.advance(1);
    expect(outcome).toEqual({ kind: "timed-out" });
  });

  it("passes on a rejection that comes before the limit", async () => {
    const clock = new FakeClock();
    const stop = new StopSwitch(clock);
    await expect(
      boundAfterStop(Promise.reject(new Error("boom")), stop, clock, 1_000),
    ).rejects.toThrow("boom");
  });
});
