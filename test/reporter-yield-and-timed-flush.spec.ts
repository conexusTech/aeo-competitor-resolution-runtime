import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GatewayReporter } from "../src/reporting/reporter.js";
import type { Resolution } from "../src/resolve.js";
import { settle } from "./fake-clock.js";
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
