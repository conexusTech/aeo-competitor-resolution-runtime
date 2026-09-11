/**
 * Running a whole client list.
 *
 * A run is tens of thousands of paid requests and hours of wall clock, so the
 * three properties that matter are: it survives being killed, it never re-buys
 * what it already has, and it can say what it spent.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { RetailerAdapter } from "./adapters/types.js";
import { RequestMeter } from "./fetcher/meter.js";
import type { Fetcher } from "./fetcher/types.js";
import {
  DEFAULT_OPTIONS,
  resolveItem,
  type Resolution,
  type ResolveOptions,
  type ResolveRequest,
} from "./resolve.js";

/**
 * Measured request cost per row, from the handover's own 53-row run.
 *
 * ⚠️ **`USD_PER_1000_REQUESTS` has never been checked against an invoice.** The
 * request COUNTS are measured; the money is not. A figure derived from it is an
 * estimate and must never be presented to a client as a price.
 *
 * 🔴 **These are MEANS, not ceilings, and one caller labelled them
 * "worst-case" until 2026-09-11.** A live 3-row run spent 16 requests against
 * an estimate of 14. 🔑 **A miss costs more than a hit** — a verified row
 * stops when a candidate is proven, a not-found row exhausts every query
 * variant first — so a list with a worse hit rate than the spike's 53 rows
 * costs more per row than this predicts. Anything rendering these must not
 * call the result a maximum.
 */
export const COST = {
  /**
   * With a part number in hand: one search, roughly one probe.
   *
   * ⚠️ **NOT measured, and deliberately left alone.** The 53-row run this
   * module is derived from carries **no part numbers at all**, so every one of
   * its rows took the derived-identity path. This figure comes from the
   * handover's §8 as the baseline it compared inference against — reasoned,
   * not observed.
   *
   * 🔴 **It was tempting to "also bump this one" when the sibling below was
   * corrected, and that would have been the worse error**: laundering an
   * unmeasured number into a measured-looking one, in a block whose whole claim
   * is that its figures are traceable. It stays at 2 until a list WITH part
   * numbers is run.
   */
  requestsPerItemWithPartNumber: 2,
  /**
   * Without one: a search-engine lookup, the retailer searches, and the probes.
   *
   * 🔴 **This was 4.70 until 2026-09-11 and it was 42% low, because it
   * assumed ONE retailer search per row.** The old note read "one Google
   * resolve + one Newegg search + 2.70 product-page probes" — 1 + 1 + 2.70. But
   * the same 53-row fixture records **2.98 queries per row**, not one: a row
   * whose first query misses tries the next variant, up to
   * `MAX_QUERY_ATTEMPTS`.
   *
   * 🔑 **Corrected arithmetic over the same committed data:**
   * 1 lookup + 2.98 queries + 2.70 probes = **6.68**, rounded to 6.7.
   *
   * 🔑 **Three independent measurements agree and the old constant was the
   * outlier:**
   * - 6.68 — `test/fixtures/measured-run-53.json`, pinned by a check below
   * - 6.4 — the handover spike's OWN run log over its first 50 rows
   *   (322 requests, $0.32), in that repo at
   *   `recon/captures/newegg-upc/full-run.log`
   * - 6.2 — a live 10-row queue run on 2026-09-11
   *
   * ⚠️ **Rounded UP rather than down.** 6.7 slightly overstates 6.68, and for
   * a figure shown to a client before they authorise spend that is the safer
   * direction: a run that comes in under its estimate is a good surprise.
   */
  requestsPerItemDerivedIdentity: 6.7,
  usdPer1000Requests: 1,
} as const;

export interface RunProgress {
  readonly completed: number;
  readonly total: number;
  readonly outcomes: Readonly<Record<Resolution["outcome"], number>>;
  readonly liveRequests: number;
  readonly estimatedUsd: number;
}

export interface RunOptions extends ResolveOptions {
  /** Items resolved concurrently. Politeness, not throughput. */
  readonly concurrency: number;
  /** Directory for the journal. */
  readonly runDir: string;
  /** Journal filename within `runDir`. */
  readonly journalName: string;
  readonly onProgress?: ((progress: RunProgress) => void) | undefined;

  /**
   * Called once per resolution, **after** it is on disk.
   *
   * 🔑 The ordering is the point. A caller reporting a finding somewhere else —
   * the gateway — must never describe one the journal does not hold: a
   * container dying in that window would leave the finding filed remotely and
   * absent locally, so a resume would neither re-resolve it nor re-send it, and
   * nothing anywhere would say what became of that item.
   *
   * Awaited, so a slow consumer applies backpressure rather than growing an
   * unbounded queue behind a run that fetches for hours. A rejection is left to
   * propagate — the pipeline does not decide what a reporting failure means.
   */
  readonly onResolved?:
    ((resolution: Resolution) => void | Promise<void>) | undefined;

  /**
   * Asked before each item whether to keep going.
   *
   * The one thing that can stop a run early, and it exists for one case: the
   * gateway saying the run no longer exists. Continuing to buy pages for
   * findings nobody will accept is pure waste.
   */
  readonly shouldContinue?: (() => boolean) | undefined;
}

export const RUN_DEFAULTS: RunOptions = {
  ...DEFAULT_OPTIONS,
  concurrency: 3,
  runDir: "./runs",
  journalName: "resolutions.jsonl",
};

/**
 * Every resolution already on disk for this run, keyed by barcode.
 *
 * 🔑 This is the resume. Without it a run killed at hour three restarts at
 * hour zero and pays for the first three hours again.
 */
export async function readJournal(
  journalPath: string,
): Promise<Map<string, Resolution>> {
  const done = new Map<string, Resolution>();
  let text: string;
  try {
    text = await readFile(journalPath, "utf8");
  } catch {
    return done; // first run
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const resolution = JSON.parse(line) as Resolution;
      done.set(resolution.barcode, resolution);
    } catch {
      // A truncated final line is what a killed process leaves behind. Skipping
      // it costs one re-resolution; refusing to start costs the whole run.
      continue;
    }
  }
  return done;
}

export function estimateUsd(requests: number): number {
  return (requests / 1000) * COST.usdPer1000Requests;
}

/** What a list will cost before anything is fetched. */
export function estimateRun(
  itemCount: number,
  itemsWithPartNumber: number,
): { requests: number; usd: number } {
  const withPart = Math.min(itemsWithPartNumber, itemCount);
  const without = itemCount - withPart;
  const requests =
    withPart * COST.requestsPerItemWithPartNumber +
    without * COST.requestsPerItemDerivedIdentity;
  return { requests, usd: estimateUsd(requests) };
}

export async function runList(
  items: readonly ResolveRequest[],
  adapter: RetailerAdapter,
  fetcher: Fetcher,
  options: RunOptions = RUN_DEFAULTS,
): Promise<Resolution[]> {
  const journalPath = path.join(options.runDir, options.journalName);
  await mkdir(options.runDir, { recursive: true });

  const done = await readJournal(journalPath);
  const pending = items.filter((item) => !done.has(item.barcode));

  const outcomes: Record<Resolution["outcome"], number> = {
    verified: 0,
    unverifiable: 0,
    unconfirmed: 0,
    "not-found": 0,
  };
  for (const resolution of done.values()) outcomes[resolution.outcome]++;

  let cursor = 0;
  let completed = 0;

  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      // Checked before taking an item rather than after finishing one, so a
      // stop costs at most the item already in flight.
      if (options.shouldContinue?.() === false) return;
      const item = pending[cursor++];
      if (item === undefined) return;

      let resolution: Resolution;
      // 🔴 **Metered out here as well as inside `resolveItem`, because the
      // catch branch below needs a number and `resolveItem`'s own meter is
      // unreachable by the time it throws.** Without this the branch reported
      // `requests: 0` for an item whose pipeline had already bought pages —
      // the spend was real and vanished from the meter, which is the one
      // direction a cost figure must never be wrong in.
      const meter = new RequestMeter(fetcher);
      try {
        resolution = await resolveItem(item, adapter, meter, options);
      } catch (error) {
        // The pipeline could not complete. Recorded as a failure with its
        // reason — never as a clean miss, which would report "this retailer
        // does not carry it" for an item nobody managed to look up.
        resolution = {
          barcode: item.barcode,
          clientSku: item.clientSku,
          outcome: "not-found",
          identity: null,
          // A pipeline that could not complete has no ranking to offer.
          alternatives: [],
          queriesTried: [],
          candidatesSeen: 0,
          probes: 0,
          // What it had already bought when it threw — not zero. See the
          // meter above.
          requests: meter.liveRequestCount,
          match: null,
          failure: error instanceof Error ? error.message : String(error),
        };
      }

      done.set(resolution.barcode, resolution);
      outcomes[resolution.outcome]++;
      completed++;

      // Journalled per item, before anything else. A run must survive being
      // killed between any two items.
      await appendFile(journalPath, `${JSON.stringify(resolution)}\n`, "utf8");

      // Only now, and never before — see `onResolved` on why that ordering is
      // the correctness argument rather than a preference.
      await options.onResolved?.(resolution);

      options.onProgress?.({
        completed,
        total: pending.length,
        outcomes: { ...outcomes },
        liveRequests: fetcher.liveRequestCount,
        estimatedUsd: estimateUsd(fetcher.liveRequestCount),
      });
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, pending.length) },
      worker,
    ),
  );

  // Emit in input order regardless of completion order, so a run's output is
  // comparable across runs.
  return items
    .map((item) => done.get(item.barcode))
    .filter((r): r is Resolution => r !== undefined);
}
