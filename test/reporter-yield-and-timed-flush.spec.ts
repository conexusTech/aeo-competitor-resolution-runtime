import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FLUSH_AT,
  FLUSH_EVERY_MS,
  GatewayReporter,
} from "../src/reporting/reporter.js";
import type { Resolution } from "../src/resolve.js";
import { FakeClock, settle } from "./fake-clock.js";
import {
  filed,
  gatewayDouble,
  typesOf,
  type Answer,
} from "./gateway-double.js";

/**
 * How the reporter hands a run back, and how long a finding may wait.
 *
 * Real reporter, real gateway client, real journal on disk; the gateway's
 * answers and the clock are the only doubles.
 */

const resolution = (clientSku: string): Resolution => ({
  barcode: "649532609635",
  clientSku,
  outcome: "not-found",
  identity: null,
  alternatives: [],
  queriesTried: [],
  candidatesSeen: 0,
  probes: 0,
  requests: 1,
  match: null,
  failure: null,
  searchesUnfetched: 0,
  searchesNotResultsPage: 0,
  probesUnanswered: 0,
});

describe("handing a run back", () => {
  let runDir = "";
  beforeEach(async () => {
    runDir = await mkdtemp(path.join(os.tmpdir(), "reporter-yield-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const reporterFor = (answer?: (e: Record<string, unknown>) => Answer) => {
    const gateway = gatewayDouble({}, answer);
    const reporter = new GatewayReporter(gateway.client, {
      runDir,
      log: () => undefined,
    });
    return { gateway, reporter };
  };

  it("files every buffered finding before it says `yielded`", async () => {
    // 🔑 The gateway works out the next container's items from the findings it
    // holds when `yielded` arrives. One still in the buffer would be bought
    // again by the next container.
    const { gateway, reporter } = reporterFor((e) =>
      e["type"] === "resolutions" ? "hold" : "apply",
    );
    await reporter.load();
    await reporter.offer(resolution("A"));
    await reporter.offer(resolution("B"));
    const handing = reporter.reportYielded(42, 40);
    await settle();
    // The batch is out, unanswered — and `yielded` has not been sent.
    expect(typesOf(gateway.events)).toEqual(["resolutions"]);
    gateway.release();
    await handing;
    expect(typesOf(gateway.events)).toEqual(["resolutions", "yielded"]);
    expect(filed(gateway.events)).toEqual(["A", "B"]);
    expect(gateway.events[1]?.["requests_spent"]).toBe(42);
  });

  it("files nothing and ticks nothing once the run is handed back", async () => {
    // 🔴 Sealed at the terminal decision: a finding offered afterwards —
    // an item abandoned in flight that finished late — is dropped, not sent
    // after `yielded`. The next container buys it again.
    const { gateway, reporter } = reporterFor();
    await reporter.load();
    await reporter.offer(resolution("A"));
    await reporter.reportYielded(3);
    await reporter.offer(resolution("LATE"));
    await reporter.reportProgress({ itemsReported: 2, requestsSpent: 4 });
    await reporter.flush();
    // Every event, progress included: a tick after the seal is the failure.
    expect(gateway.events.map((e) => e["type"])).toEqual([
      "resolutions",
      "yielded",
    ]);
    expect(filed(gateway.events)).toEqual(["A"]);
  });

  it("never lets a progress tick still on its way land after the terminal event", async () => {
    // A tick is not awaited by the run, so one can be in flight when the run
    // ends. The terminal event waits for it to be answered.
    const { gateway, reporter } = reporterFor((e) =>
      e["type"] === "progress" ? "hold" : "apply",
    );
    await reporter.load();
    void reporter.reportProgress({ itemsReported: 25, requestsSpent: 60 });
    const ending = reporter.reportCompleted(61);
    await settle();
    expect(gateway.events.map((e) => e["type"])).toEqual(["progress"]);
    gateway.release();
    await ending;
    expect(gateway.answered.map((e) => e["type"])).toEqual([
      "progress",
      "completed",
    ]);
  });

  it("does not say `yielded` once the gateway has refused findings, as `completed` is not said", async () => {
    // A refusal turns reporting off; the gateway then learns how the
    // container ended from the queue.
    const { gateway, reporter } = reporterFor((e) =>
      e["type"] === "resolutions" ? "refuse" : "apply",
    );
    await reporter.load();
    await reporter.offer(resolution("A"));
    await reporter.reportYielded(5);
    expect(typesOf(gateway.events)).toEqual(["resolutions"]);
  });

  it("does not say `yielded` to a run the gateway says is gone", async () => {
    const { gateway, reporter } = reporterFor((e) =>
      e["type"] === "resolutions" ? "gone" : "apply",
    );
    await reporter.load();
    await reporter.offer(resolution("A"));
    await reporter.reportYielded(5);
    expect(typesOf(gateway.events)).toEqual(["resolutions"]);
  });
});

/**
 * A finding never waits more than a minute to be sent.
 *
 * 🔴 **Measured in production, 2026-11-11:** a 20-row Best Buy run was evicted
 * after about seven minutes and every finding was lost — 0 of 20 reported —
 * because nothing is sent until 100 have piled up, and a 20-row list never
 * gets there. So a short list held everything until its end, and the gateway
 * could not tell a container that had made progress from one that had not.
 */
describe("findings are sent at least every minute", () => {
  let runDir = "";
  beforeEach(async () => {
    runDir = await mkdtemp(path.join(os.tmpdir(), "reporter-timed-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const reporterFor = (answer?: (e: Record<string, unknown>) => Answer) => {
    const clock = new FakeClock();
    const gateway = gatewayDouble({}, answer);
    const reporter = new GatewayReporter(gateway.client, {
      runDir,
      log: () => undefined,
      clock,
    });
    return { gateway, reporter, clock };
  };

  it("sends a lone finding a minute after it was offered, not before", async () => {
    const { gateway, reporter, clock } = reporterFor();
    await reporter.load();
    await reporter.offer(resolution("A"));
    await clock.advance(FLUSH_EVERY_MS - 1);
    expect(filed(gateway.events)).toEqual([]);
    await clock.advance(1);
    expect(filed(gateway.events)).toEqual(["A"]);
  });

  it("counts the minute from the oldest waiting finding, not the newest", async () => {
    // A minute per finding would let a steady trickle wait for ever.
    const { gateway, reporter, clock } = reporterFor();
    await reporter.load();
    await reporter.offer(resolution("A"));
    await clock.advance(30_000);
    await reporter.offer(resolution("B"));
    await clock.advance(30_000);
    expect(gateway.events.map((e) => filed([e]))).toEqual([["A", "B"]]);
    await clock.advance(FLUSH_EVERY_MS);
    expect(gateway.events).toHaveLength(1);
  });

  it("starts a fresh minute for a finding offered after a timed send", async () => {
    const { gateway, reporter, clock } = reporterFor();
    await reporter.load();
    await reporter.offer(resolution("A"));
    await clock.advance(FLUSH_EVERY_MS);
    await clock.advance(10_000);
    await reporter.offer(resolution("C"));
    await clock.advance(FLUSH_EVERY_MS - 1);
    expect(filed(gateway.events)).toEqual(["A"]);
    await clock.advance(1);
    expect(filed(gateway.events)).toEqual(["A", "C"]);
  });

  it("still sends at once at the batch size, and leaves no timer behind", async () => {
    const { gateway, reporter, clock } = reporterFor();
    await reporter.load();
    for (let i = 0; i < FLUSH_AT; i++)
      await reporter.offer(resolution(`S${i}`));
    expect(filed(gateway.events)).toHaveLength(FLUSH_AT);
    expect(clock.pending).toBe(0);
  });

  it("leaves no timer behind once nothing is waiting, so a finished run never waits a minute to exit", async () => {
    const { reporter, clock } = reporterFor();
    await reporter.load();
    await reporter.offer(resolution("A"));
    expect(clock.pending).toBe(1);
    await reporter.reportCompleted(1);
    expect(clock.pending).toBe(0);
  });

  it("never sends a terminal event while a timed send is still in flight", async () => {
    // 🔴 The gateway drops a findings batch that lands after a terminal event.
    // A timed send can be in flight at the moment the run ends — so the
    // terminal report waits for it, then sends the rest, then ends the run.
    let holdFirst = true;
    const { gateway, reporter, clock } = reporterFor((e) => {
      if (e["type"] === "resolutions" && holdFirst) {
        holdFirst = false;
        return "hold";
      }
      return "apply";
    });
    await reporter.load();
    await reporter.offer(resolution("A"));
    await clock.advance(FLUSH_EVERY_MS);
    expect(typesOf(gateway.events)).toEqual(["resolutions"]);
    await reporter.offer(resolution("B"));
    const ending = reporter.reportCompleted(9);
    await settle();
    // B is not sent beside A's open request, and the run is not ended.
    expect(typesOf(gateway.events)).toEqual(["resolutions"]);
    gateway.release();
    await ending;
    expect(typesOf(gateway.events)).toEqual([
      "resolutions",
      "resolutions",
      "completed",
    ]);
    expect(filed(gateway.events)).toEqual(["A", "B"]);
    expect(typesOf(gateway.answered)).toEqual([
      "resolutions",
      "resolutions",
      "completed",
    ]);
  });
});
