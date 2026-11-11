import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDispatchedJob, type QueueRunDeps } from "../src/queue-run.js";
import { GatewayReporter } from "../src/reporting/reporter.js";
import { RUN_DEFAULTS, runList } from "../src/run.js";
import { FakeClock } from "./fake-clock.js";
import { filed, gatewayDouble, record } from "./gateway-double.js";
import {
  ADAPTER,
  DISPATCH,
  ScriptedFetcher,
  barcodeOf,
  types,
} from "./run-doubles.js";

/**
 * A run with a time budget takes no new item once it is spent, files what it
 * found, and hands the rest back as `yielded`.
 *
 * 🔑 **Everything here is real except time, the retailer and the network.**
 * The real `runList` decides what is taken and when the retry pass runs; the
 * real reporter buffers and files; the real gateway client writes the wire
 * bodies the gateway will read. Time is a fake clock moved by the items
 * themselves — never a real sleep, which would make an hour's budget either
 * slow to check or too short to mean anything.
 */

const MINUTE = 60_000;

/** Each filed finding, by client SKU. */
function findings(
  events: readonly Record<string, unknown>[],
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (event["type"] !== "resolutions") continue;
    const list = event["resolutions"];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const finding = record(entry);
      out.set(String(finding["clientSku"]), finding);
    }
  }
  return out;
}

interface Setup {
  readonly items: number;
  /** `undefined` sends no budget at all, as a gateway predating it does. */
  readonly budgetSec?: number | null | undefined;
  /** Clock time each finished item takes. */
  readonly perItemMs?: number;
  /** Fetches refused first, each a pipeline that could not complete. */
  readonly failFirst?: number;
  /** Called on every fetch with its number and the run's clock. */
  readonly onFetch?: (fetchNumber: number, clock: FakeClock) => void;
  /** Under the test's directory, so two runs in one check never share a journal. */
  readonly dir?: string;
  /** The reporter's longest wait; its own default unless a check says. */
  readonly flushEveryMs?: number;
  /** The leg the job names, if any. */
  readonly legId?: string;
}

describe("a run with a time budget", () => {
  let runDir = "";
  beforeEach(async () => {
    runDir = await mkdtemp(path.join(os.tmpdir(), "time-budget-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  async function run(setup: Setup) {
    const clock = new FakeClock();
    const onFetch = setup.onFetch;
    const fetcher = new ScriptedFetcher({
      failFirst: setup.failFirst ?? 0,
      onFetch: (n) => onFetch?.(n, clock),
    });
    const dir = path.join(runDir, setup.dir ?? "run");
    const job: Record<string, unknown> = {
      retailerSlug: "fake",
      items: Array.from({ length: setup.items }, (_, i) => ({
        barcode: barcodeOf(i),
        clientSku: `SKU-${i}`,
      })),
      pagesAtOnce: 1,
      ...(setup.budgetSec === undefined
        ? {}
        : { stopTakingItemsAfterSec: setup.budgetSec }),
      ...(setup.legId === undefined ? {} : { legId: setup.legId }),
    };
    const { client, events } = gatewayDouble(job);
    // 🔑 The same clock as the run's, as in production: the budget and the
    // reporter's minute are both measured on it.
    const reporter = new GatewayReporter(client, {
      runDir: dir,
      log: () => undefined,
      requestsSpent: () => fetcher.liveRequestCount,
      pagesDelivered: () => fetcher.pagesDelivered,
      clock,
      ...(setup.flushEveryMs === undefined
        ? {}
        : { flushEveryMs: setup.flushEveryMs }),
    });
    const perItemMs = setup.perItemMs ?? 10 * MINUTE;
    /** Fetches made when each item was finished, in order. */
    const fetchesAtFinish: number[] = [];
    /** Findings the gateway had been sent when each item was finished. */
    const filedAtFinish: number[] = [];
    // The real `runList`; the only addition is that finishing an item takes
    // clock time, so the budget is spent by the work itself.
    const timedRunList: QueueRunDeps["runList"] = (items, a, f, options) =>
      runList(items, a, f, {
        ...options,
        onResolved: async (resolution) => {
          filedAtFinish.push(filed(events).length);
          clock.tick(perItemMs);
          fetchesAtFinish.push(fetcher.fetches);
          await options.onResolved?.(resolution);
        },
      });
    const result = await runDispatchedJob({
      dispatch: DISPATCH,
      client,
      reporter,
      adapterFor: (slug) => {
        if (slug !== "fake") throw new Error(`no adapter for "${slug}"`);
        return ADAPTER;
      },
      fetcher,
      runList: timedRunList,
      baseOptions: { ...RUN_DEFAULTS, runDir: dir },
      clock,
      log: () => undefined,
    });
    return { result, events, fetcher, fetchesAtFinish, filedAtFinish, clock };
  }

  it("takes no new item once the budget is spent, and answers `yielded`, not `completed`", async () => {
    // 10 minutes an item, 25 minutes of budget: the third item is taken at
    // minute 20, the fourth would be taken at minute 30 and is not.
    const { result, events } = await run({
      items: 5,
      budgetSec: 25 * 60,
    });
    expect(filed(events)).toEqual(["SKU-0", "SKU-1", "SKU-2"]);
    expect(types(events)).toEqual(["resolutions", "yielded"]);
    expect(result.yielded).toBe(true);
    expect(result.stoppedEarly).toBe(false);
  });

  it("buys nothing for an item it did not take", async () => {
    const { fetcher, fetchesAtFinish } = await run({
      items: 5,
      budgetSec: 25 * 60,
    });
    // Not one fetch after the third item was finished.
    expect(fetchesAtFinish).toHaveLength(3);
    expect(fetcher.fetches).toBe(fetchesAtFinish[2]);
  });

  it("finishes the item in flight when the budget runs out, and files it", async () => {
    // How many fetches one item makes, so the jump below lands on the first
    // page of the third item whatever the query plan's shape.
    const probe = await run({ items: 1, perItemMs: 0, dir: "probe" });
    const perItem = probe.fetcher.fetches;
    expect(perItem).toBeGreaterThan(0);

    // The whole hour passes while item 2's first page is being fetched. The
    // item is already taken, so it is finished and filed; item 3 never starts.
    const { result, events, fetcher } = await run({
      items: 5,
      budgetSec: 3600,
      perItemMs: 0,
      onFetch: (n, clock) => {
        if (n === 2 * perItem + 1) clock.tick(60 * MINUTE);
      },
    });
    expect(filed(events)).toEqual(["SKU-0", "SKU-1", "SKU-2"]);
    expect(fetcher.fetches).toBe(3 * perItem);
    expect(types(events)).toEqual(["resolutions", "yielded"]);
    expect(result.yielded).toBe(true);
  });

  it("answers `completed` exactly as before when every item finishes inside the budget", async () => {
    const { result, events } = await run({ items: 3, budgetSec: 3600 });
    expect(filed(events)).toEqual(["SKU-0", "SKU-1", "SKU-2"]);
    expect(types(events)).toEqual(["resolutions", "completed"]);
    expect(result.yielded).toBe(false);
  });

  it("answers `completed` when the budget ran out during the last item — nothing is left to hand back", async () => {
    // 3 items × 10 minutes against 25: the last is taken at minute 20 and
    // finished at 30, after the budget. Nothing is unfinished, so a `yielded`
    // would start a container with no work.
    const { result, events } = await run({ items: 3, budgetSec: 25 * 60 });
    expect(filed(events)).toEqual(["SKU-0", "SKU-1", "SKU-2"]);
    expect(types(events)).toEqual(["resolutions", "completed"]);
    expect(result.yielded).toBe(false);
  });

  it("CONTROL: with no budget a run never yields, however long it takes", async () => {
    // A stop that fired without a budget would pass the checks above while
    // cutting every run short.
    for (const budgetSec of [undefined, null] as const) {
      const { result, events } = await run({
        items: 5,
        budgetSec,
        perItemMs: 10 * 60 * MINUTE,
        dir: String(budgetSec),
      });
      expect(filed(events)).toHaveLength(5);
      expect(types(events)).toEqual(["resolutions", "completed"]);
      expect(result.yielded).toBe(false);
    }
  });

  it("files every finding before `yielded`, and `yielded` carries the container's own totals", async () => {
    const { events, fetcher } = await run({ items: 5, budgetSec: 25 * 60 });
    const last = events[events.length - 1];
    expect(last?.["type"]).toBe("yielded");
    expect(last?.["requests_spent"]).toBe(fetcher.liveRequestCount);
    expect(last?.["pages_delivered"]).toBe(fetcher.pagesDelivered);
    // Nothing after it: the gateway works out the next container's items
    // from the findings it holds when `yielded` arrives.
    expect(events.filter((e) => e["type"] === "yielded")).toHaveLength(1);
  });

  it("retries this container's held-back items before handing back, and files them", async () => {
    // 🔴 Architecture review, 2026-11-11. Items whose first attempt failed are
    // held for the end-of-run retry. Skipped on a budget yield, they were never
    // filed, so they were unfinished — and the gateway serves unfinished items
    // first, so every later container re-bought every persistent failure
    // before reaching new work, until a container could file nothing at all.
    // Items 0 and 1 fail first; 2–4 spend the 25 minutes; 5 and 6 are never
    // taken. The retry runs within the 30 minutes after the limit.
    const { events, fetcher, fetchesAtFinish } = await run({
      items: 7,
      budgetSec: 25 * 60,
      failFirst: 2,
    });
    expect(filed(events)).toEqual([
      "SKU-2",
      "SKU-3",
      "SKU-4",
      "SKU-0",
      "SKU-1",
    ]);
    const byItem = findings(events);
    expect(byItem.get("SKU-0")?.["failure"]).toBeNull();
    expect(byItem.get("SKU-1")?.["failure"]).toBeNull();
    expect(types(events)).toEqual(["resolutions", "yielded"]);
    // Items 5 and 6 are left unfinished and bought nothing.
    expect(fetcher.fetches).toBe(fetchesAtFinish[fetchesAtFinish.length - 1]);
  });

  it("stops retrying 30 minutes past the limit and files what is left as the failure it was", async () => {
    // 20 minutes an item: 2 and 3 finish at minutes 20 and 40, past the
    // 25-minute limit. The retry of item 0 starts at 40, before the cap at 55,
    // and ends at 60; item 1 is not retried and is filed with its first
    // attempt — a failure with its reason, never "not carried".
    const { events, fetchesAtFinish } = await run({
      items: 7,
      budgetSec: 25 * 60,
      perItemMs: 20 * MINUTE,
      failFirst: 2,
    });
    expect(filed(events)).toEqual(["SKU-2", "SKU-3", "SKU-0", "SKU-1"]);
    const byItem = findings(events);
    expect(byItem.get("SKU-0")?.["failure"]).toBeNull();
    expect(String(byItem.get("SKU-1")?.["failure"])).toMatch(/boom/);
    expect(byItem.get("SKU-1")?.["outcome"]).toBe("not-found");
    // Item 1's filing bought nothing: no retry was made for it.
    expect(fetchesAtFinish[3]).toBe(fetchesAtFinish[2]);
    expect(types(events)).toEqual(["resolutions", "yielded"]);
  });

  it("files every item at most once: nothing is both filed and handed back", async () => {
    for (const perItemMs of [10 * MINUTE, 20 * MINUTE]) {
      const { events, fetchesAtFinish } = await run({
        items: 7,
        budgetSec: 25 * 60,
        perItemMs,
        failFirst: 2,
        dir: String(perItemMs),
      });
      const skus = filed(events);
      expect(new Set(skus).size).toBe(skus.length);
      // Settled once each, not merely sent once: the reporter drops a repeat
      // it has already filed, which would hide one from the gateway's view.
      expect(fetchesAtFinish).toHaveLength(skus.length);
      // The unfinished are exactly the items never taken.
      const unfinished = Array.from({ length: 7 }, (_, i) => `SKU-${i}`).filter(
        (sku) => !skus.includes(sku),
      );
      expect(
        unfinished.every((sku) => ["SKU-4", "SKU-5", "SKU-6"].includes(sku)),
      ).toBe(true);
    }
  });

  it("CONTROL: with budget left, the retry pass runs and the failed item is filed", async () => {
    const { events } = await run({
      items: 3,
      budgetSec: 3600,
      failFirst: 1,
    });
    expect([...filed(events)].sort()).toEqual(["SKU-0", "SKU-1", "SKU-2"]);
    expect(types(events)).toEqual(["resolutions", "completed"]);
  });

  it("files a short list's findings while it runs, not only at its end", async () => {
    // 🔴 The production case: 20 rows, about seven minutes, nothing reported
    // when the container was evicted. Ten seconds an item here, so a minute
    // holds about six findings — and the gateway has most of the list before
    // the last item is even finished.
    const { events, filedAtFinish } = await run({
      items: 20,
      perItemMs: 10_000,
    });
    expect(filed(events)).toHaveLength(20);
    expect(
      events.filter((e) => e["type"] === "resolutions").length,
    ).toBeGreaterThanOrEqual(3);
    expect(filedAtFinish[19]).toBeGreaterThanOrEqual(12);
    expect(types(events)[types(events).length - 1]).toBe("completed");
  });

  it("CONTROL: without the minute, a short list files nothing until its end", async () => {
    // Proves the check above measures the timed send, not something else
    // that happens to send early: the same run with an unreachable minute.
    const { events, filedAtFinish } = await run({
      items: 20,
      perItemMs: 10_000,
      flushEveryMs: Number.MAX_SAFE_INTEGER,
    });
    expect(filed(events)).toHaveLength(20);
    expect(filedAtFinish[19]).toBe(0);
  });

  it("names the job's leg on every event a run posts, and on none when the job names no leg", async () => {
    // The real fetch of the job is what tells the client its leg.
    const leg = "9f1c2b3a-4d5e-4f60-8a7b-0c1d2e3f4a5b";
    const named = await run({ items: 5, budgetSec: 25 * 60, legId: leg });
    expect(types(named.events)).toEqual(["resolutions", "yielded"]);
    for (const event of named.events) expect(event["leg_id"]).toBe(leg);
    const unnamed = await run({ items: 3, dir: "unnamed" });
    expect(types(unnamed.events)).toEqual(["resolutions", "completed"]);
    for (const event of unnamed.events) expect("leg_id" in event).toBe(false);
  });
});
