import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  runDispatchedJob,
  type QueueRunDeps,
  type QueueRunResult,
} from "../src/queue-run.js";
import { FLUSH_EVERY_MS, GatewayReporter } from "../src/reporting/reporter.js";
import { RUN_DEFAULTS, runList } from "../src/run.js";
import { SHUTDOWN, StopSwitch } from "../src/stop-signal.js";
import { FakeClock, settle } from "./fake-clock.js";
import { filed, gatewayDouble, type Answer } from "./gateway-double.js";
import {
  ADAPTER,
  DISPATCH,
  ScriptedFetcher,
  barcodeOf,
  types,
} from "./run-doubles.js";

/**
 * A run told to stop by the cluster files what it found and hands the rest
 * back, inside the grace period.
 *
 * 🔴 **Measured in production, 2026-11-11:** an evicted 20-row run lost every
 * finding — 0 of 20 reported — because the process died on SIGTERM with its
 * findings buffered. Each check below is one way that hand-back could still
 * fail: buying more after the signal, dropping an item that was nearly done,
 * waiting on an item that never finishes, or waiting on a gateway that never
 * answers until SIGKILL lands.
 *
 * The real `runList`, reporter and gateway client; the stop is asked for
 * through the same `StopSwitch` SIGTERM feeds, on a fake clock.
 */

interface Setup {
  readonly items: number;
  /** Ask for the stop once this many items have finished. */
  readonly stopAfterFinished: number;
  /**
   * `between`: after that item is filed, before the next is taken.
   * `in-flight`: as the next item's first page is asked for, holding that
   * page this long.
   */
  readonly stopWhile?: "between" | { readonly hold: number | "forever" };
  readonly answer?: (event: Record<string, unknown>) => Answer;
  readonly budgetSec?: number;
  /** Keep every item's page as evidence, within a budget of ten. */
  readonly capture?: boolean;
}

describe("a run told to stop", () => {
  let runDir = "";
  beforeEach(async () => {
    runDir = await mkdtemp(path.join(os.tmpdir(), "sigterm-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  function start(setup: Setup) {
    const clock = new FakeClock();
    const stop = new StopSwitch(clock);
    const stopWhile = setup.stopWhile ?? "between";
    let finished = 0;
    let stopFetch: number | null = null;
    const fetcher = new ScriptedFetcher({
      clock,
      distinctListings: setup.capture === true,
      onFetch: (n) => {
        if (
          stopWhile !== "between" &&
          stopFetch === null &&
          finished === setup.stopAfterFinished
        ) {
          stopFetch = n;
          stop.request();
        }
      },
      holdFor: (n) =>
        n === stopFetch && stopWhile !== "between" ? stopWhile.hold : 0,
    });
    const job: Record<string, unknown> = {
      retailerSlug: "fake",
      items: Array.from({ length: setup.items }, (_, i) => ({
        barcode: barcodeOf(i),
        clientSku: `SKU-${i}`,
        capture: setup.capture === true,
      })),
      pagesAtOnce: 1,
      ...(setup.capture === true
        ? { capture: { enabled: true, budget: 10, format: "page_html" } }
        : {}),
      ...(setup.budgetSec === undefined
        ? {}
        : { stopTakingItemsAfterSec: setup.budgetSec }),
    };
    const gateway = gatewayDouble(job, setup.answer);
    const reporter = new GatewayReporter(gateway.client, {
      runDir,
      log: () => undefined,
      requestsSpent: () => fetcher.liveRequestCount,
      pagesDelivered: () => fetcher.pagesDelivered,
      clock,
    });
    /** Fetches made when each item was finished, in order. */
    const fetchesAtFinish: number[] = [];
    const hooked: QueueRunDeps["runList"] = (items, a, f, options) =>
      runList(items, a, f, {
        ...options,
        onResolved: async (resolution) => {
          await options.onResolved?.(resolution);
          fetchesAtFinish.push(fetcher.fetches);
          finished++;
          if (stopWhile === "between" && finished === setup.stopAfterFinished) {
            stop.request();
          }
        },
      });
    let result: QueueRunResult | null = null;
    const done = runDispatchedJob({
      dispatch: DISPATCH,
      client: gateway.client,
      reporter,
      adapterFor: () => ADAPTER,
      fetcher,
      runList: hooked,
      baseOptions: { ...RUN_DEFAULTS, runDir },
      clock,
      stop,
      log: () => undefined,
    }).then((r) => {
      result = r;
      return r;
    });
    return {
      done,
      gateway,
      clock,
      stop,
      fetcher,
      fetchesAtFinish,
      isDone: () => result !== null,
      /**
       * Once the stop has been asked for. ⚠️ Wait for this before moving the
       * clock: the items before it write real journals, and time moved before
       * the signal measures nothing about the shutdown.
       */
      stopped: async () => {
        await stop.asked;
        await settle();
      },
    };
  }

  it("takes no new item, files what it found, and answers `yielded`", async () => {
    const { done, gateway, fetcher, fetchesAtFinish } = start({
      items: 5,
      stopAfterFinished: 2,
    });
    const result = await done;
    expect(filed(gateway.events)).toEqual(["SKU-0", "SKU-1"]);
    expect(types(gateway.events)).toEqual(["resolutions", "yielded"]);
    expect(result.yielded).toBe(true);
    // Not one page bought after the signal.
    expect(fetcher.fetches).toBe(fetchesAtFinish[1]);
    // The container's own totals, as `completed` would carry them.
    const yielded = gateway.events[gateway.events.length - 1];
    expect(yielded?.["requests_spent"]).toBe(fetcher.liveRequestCount);
    expect(yielded?.["pages_delivered"]).toBe(fetcher.pagesDelivered);
  });

  it("files an item that was in flight and finishes within the wait", async () => {
    const { done, gateway, clock, isDone, stopped } = start({
      items: 5,
      stopAfterFinished: 2,
      stopWhile: { hold: 15_000 },
    });
    await stopped();
    await clock.advance(14_999);
    // Still waiting on the page — and nothing handed back yet.
    expect(isDone()).toBe(false);
    expect(types(gateway.events)).not.toContain("yielded");
    await clock.advance(1);
    await done;
    expect(filed(gateway.events)).toEqual(["SKU-0", "SKU-1", "SKU-2"]);
    expect(types(gateway.events)).toEqual(["resolutions", "yielded"]);
  });

  it("abandons an item still in flight after the wait, and hands back the rest inside the grace period", async () => {
    const { done, gateway, clock, isDone, stopped } = start({
      items: 5,
      stopAfterFinished: 2,
      stopWhile: { hold: "forever" },
    });
    await stopped();
    await clock.advance(SHUTDOWN.inFlightMs - 1);
    expect(isDone()).toBe(false);
    await clock.advance(1);
    const result = await done;
    expect(filed(gateway.events)).toEqual(["SKU-0", "SKU-1"]);
    expect(types(gateway.events)).toEqual(["resolutions", "yielded"]);
    expect(result.yielded).toBe(true);
    expect(clock.now()).toBeLessThanOrEqual(SHUTDOWN.finishByMs);
  });

  it("is not held past the grace period by a findings batch the gateway never answers", async () => {
    // The batch is out and unanswered; `yielded` must not overtake it, so it
    // is withheld — and the gateway learns how the container ended from the
    // queue instead. What must not happen is waiting for SIGKILL.
    const { done, gateway, clock, isDone, stopped } = start({
      items: 5,
      stopAfterFinished: 2,
      answer: (e) => (e["type"] === "resolutions" ? "hold" : "apply"),
    });
    await stopped();
    await clock.advance(SHUTDOWN.finishByMs - 1);
    expect(isDone()).toBe(false);
    await clock.advance(1);
    await done;
    expect(types(gateway.events)).toEqual(["resolutions"]);
    expect(clock.now()).toBeLessThan(SHUTDOWN.graceMs);
  });

  it("is not held past the grace period by a `yielded` the gateway never answers", async () => {
    const { done, gateway, clock, isDone, stopped } = start({
      items: 5,
      stopAfterFinished: 2,
      answer: (e) => (e["type"] === "yielded" ? "hold" : "apply"),
    });
    await stopped();
    await clock.advance(SHUTDOWN.finishByMs - 1);
    expect(isDone()).toBe(false);
    await clock.advance(1);
    await done;
    expect(types(gateway.events)).toEqual(["resolutions", "yielded"]);
    expect(gateway.answered.map((e) => e["type"])).not.toContain("yielded");
  });

  it("sends nothing after `yielded`, even when the abandoned item finishes while `yielded` is on its way", async () => {
    // 🔴 Found in review, 2026-11-11. The wait gives up at 20 s and `yielded`
    // is posted; the abandoned item finishes at 22 s, while that post is still
    // unanswered. Filed after `yielded`, the item would be reported twice —
    // once here, once by the next container — and its pages would be missing
    // from the spend `yielded` already carried. It is dropped instead: the
    // next container buys it again.
    const { done, gateway, clock, stopped } = start({
      items: 5,
      stopAfterFinished: 2,
      stopWhile: { hold: 22_000 },
      answer: (e) => (e["type"] === "yielded" ? "hold" : "apply"),
    });
    await stopped();
    await clock.advance(SHUTDOWN.inFlightMs);
    expect(types(gateway.events)).toEqual(["resolutions", "yielded"]);
    await clock.advance(2_000);
    gateway.release();
    await done;
    // Long enough for any timed send to have gone out.
    await clock.advance(FLUSH_EVERY_MS);
    expect(types(gateway.events)).toEqual(["resolutions", "yielded"]);
    expect(filed(gateway.events)).toEqual(["SKU-0", "SKU-1"]);
  });

  it("uploads no evidence for an item that finishes after the hand-back", async () => {
    // 🔴 Its finding is dropped, so its page would be evidence no finding
    // points at — and it would still count against the organization's
    // allowance. The next container captures it with its finding.
    const { done, gateway, clock, stopped } = start({
      items: 5,
      stopAfterFinished: 2,
      stopWhile: { hold: 22_000 },
      answer: (e) => (e["type"] === "yielded" ? "hold" : "apply"),
      capture: true,
    });
    await stopped();
    await clock.advance(SHUTDOWN.inFlightMs);
    await clock.advance(2_000);
    gateway.release();
    await done;
    await clock.advance(FLUSH_EVERY_MS);
    await settle();
    expect(filed(gateway.events)).toEqual(["SKU-0", "SKU-1"]);
    expect(gateway.captures.map((c) => c["client_sku"])).toEqual([
      "SKU-0",
      "SKU-1",
    ]);
  });

  it("CONTROL: with capture on and no stop, every item's evidence is uploaded", async () => {
    // Proves the check above sees uploads at all.
    const { done, gateway } = start({
      items: 3,
      stopAfterFinished: 99,
      capture: true,
    });
    await done;
    expect(gateway.captures.map((c) => c["client_sku"])).toEqual([
      "SKU-0",
      "SKU-1",
      "SKU-2",
    ]);
  });

  it("answers `completed` when told to stop after the last item finished — nothing is left", async () => {
    const { done, gateway } = start({ items: 3, stopAfterFinished: 3 });
    const result = await done;
    expect(filed(gateway.events)).toEqual(["SKU-0", "SKU-1", "SKU-2"]);
    expect(types(gateway.events)).toEqual(["resolutions", "completed"]);
    expect(result.yielded).toBe(false);
  });

  it("buys nothing and hands the whole run back when told to stop before the first item", async () => {
    const { done, gateway, fetcher, stop } = start({
      items: 3,
      stopAfterFinished: 0,
    });
    // Asked for before any item was taken.
    stop.request();
    await done;
    expect(fetcher.fetches).toBe(0);
    expect(types(gateway.events)).toEqual(["yielded"]);
    expect(gateway.events[0]?.["requests_spent"]).toBe(0);
  });

  it("CONTROL: a run never told to stop works the whole list and completes", async () => {
    const { done, gateway } = start({ items: 4, stopAfterFinished: 99 });
    const result = await done;
    await settle();
    expect(filed(gateway.events)).toHaveLength(4);
    expect(types(gateway.events)).toEqual(["resolutions", "completed"]);
    expect(result.yielded).toBe(false);
  });
});
