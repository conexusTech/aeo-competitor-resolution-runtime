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
 */
export const COST = {
  /** With a part number in hand: one search, roughly one probe. */
  requestsPerItemWithPartNumber: 2,
  /** Without one: 2.70 probes plus a search-engine lookup plus a search. */
  requestsPerItemDerivedIdentity: 4.7,
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
      try {
        resolution = await resolveItem(item, adapter, fetcher, options);
      } catch (error) {
        // The pipeline could not complete. Recorded as a failure with its
        // reason — never as a clean miss, which would report "this retailer
        // does not carry it" for an item nobody managed to look up.
        resolution = {
          barcode: item.barcode,
          clientSku: item.clientSku,
          outcome: "not-found",
          identity: null,
          queriesTried: [],
          candidatesSeen: 0,
          probes: 0,
          requests: 0,
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
