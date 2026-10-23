/**
 * Read mode: read the pages of listings the platform already knows, once each.
 *
 * A monitoring tick no longer has to re-search an item whose pairing is
 * settled: the gateway already knows the listing. So a read run hands this
 * container a retailer and its listings, and each page is fetched once, read by
 * the adapter, and reported with when it was read and what the container has
 * bought. The gateway files those readings into every list that watches the
 * listing — which is why a reading carries no organization at all.
 *
 * ── A throttled page is read again, at a measured pace ────────────────
 * 🔑 **The one exception to "once each".** A page the vendor answers with
 * nothing — the empty 200 the live fetcher calls a silent throttle, or a 429 —
 * has said *not now*, not *no*. The live fetcher already waits 5 s then 10 s
 * inside its own call; a page still throttled after that is caught in a burst,
 * and reading it again at once would join the same burst. So it is set aside,
 * the rest of the job carries on, and it is read again after a wait that
 * doubles each time (`READ_PACING`). Only after its last re-read is it
 * reported as not read, with the reason it always had.
 *
 * ⚠️ **Bounded twice.** Each page gets at most `rereadDelaysMs.length`
 * re-reads, and each job at most `rereadBudget(listings)` in all; a throttled
 * page found once the budget is spent is reported as not read at once, and
 * says so. Without the second bound a job the vendor throttles end to end
 * would quadruple its reads and its run time.
 *
 * ── What read mode does NOT do ────────────────────────────────────────
 * No search, no probe and no capture. A listing whose page has gone or no
 * longer agrees with its pairing is re-resolved by its own organization's run,
 * in the gateway's filing; nothing here decides that.
 *
 * ── A failure is a failure ────────────────────────────────────────────
 * 🔴 **A page that could not be fetched, or came back as something other than a
 * product page, is a failed reading with its reason — never "out of stock",
 * "no price" or "page not found".** Each of those is a statement about the
 * retailer; a failure is a statement about us. The same rule the resolution
 * path learned on 2026-10-22, when an expired proxy credential filed a whole
 * list as "not carried". So a failed reading carries `pageFound: null` and
 * every finding field `null`, and the type makes the two shapes impossible to
 * mix.
 *
 * ── Nothing here is shared with the resolution path ───────────────────
 * Every piece of state lives inside one call of `runReadJob`: the cursor, the
 * buffer, the clock. The resolution path's run memory, journals and reporter
 * are not touched, so a read cannot change what a resolution finds.
 */

import type { ListingReader } from "./adapters/types.js";
import { FetchFailed, isThrottled, type Fetcher } from "./fetcher/types.js";
import {
  MAX_READINGS_PER_EVENT,
  type ReadJob,
  type ReadListing,
  type ReportOutcome,
} from "./gateway/client.js";

/** The stable reason a reading failed. A failure string starts with one. */
export const READ_FAILURE = {
  /**
   * The vendor relayed a 404 or 410 for the page: the listing is gone.
   *
   * ⚠️ **The only failure that says something about the retailer**, and so
   * the only one with `pageFound: false`. Whether the proxy relays a
   * retailer's own 404 as its status has NOT been measured; until it is, a
   * delisted page may still arrive as `fetch-failed` or `not-a-product-page`.
   */
  notFound: "not-found",
  /** The page could not be had: refused, throttled, unreachable. */
  fetchFailed: "fetch-failed",
  /** A body arrived, and it is not a product page this build can read. */
  notAProductPage: "not-a-product-page",
  /** A product page whose offer this build cannot read. */
  unreadableOffer: "unreadable-offer",
} as const;

/** Statuses that mean the page is gone, rather than that we could not ask. */
const GONE_STATUSES: ReadonlySet<number> = new Set([404, 410]);

interface ReadingBase {
  /** The retailer's own id for the listing, as the job named it. */
  readonly itemId: string;
  /**
   * When the page was read, ISO 8601: the moment it arrived from the vendor,
   * before the fetcher cached it or waited out its politeness jitter. For a
   * failure, when the attempt ended.
   *
   * 🔑 **Not when the job started and not when the reading was reported.** It
   * is the "as of" every list watching this listing will show.
   */
  readonly readAt: string;
}

/** A product page was read. */
export interface PageReading extends ReadingBase {
  readonly pageFound: true;
  /**
   * The listing the PAGE says it is. The gateway must refuse the reading when
   * this is not the `itemId` it asked for, `null` included.
   */
  readonly pageItemId: string | null;
  /** Trimmed. `""` = the page publishes the field empty; `null` = no field. */
  readonly barcode: string | null;
  readonly additionalBarcodes: readonly string[];
  /** `null` only where the page offers no price. Never 0. */
  readonly priceCents: number | null;
  /** `null` where the page states no availability this build recognises. */
  readonly inStock: boolean | null;
  readonly failure: null;
}

/**
 * The vendor said the page is gone (404 or 410).
 *
 * `pageFound: false` and a `not-found:` reason. Every finding field is `null`:
 * a page that is not there has no price and no stock to report.
 */
export interface GoneReading extends ReadingBase {
  readonly pageFound: false;
  readonly pageItemId: null;
  readonly barcode: null;
  readonly additionalBarcodes: readonly [];
  readonly priceCents: null;
  readonly inStock: null;
  readonly failure: string;
}

/**
 * The page could not be read.
 *
 * 🔴 **`pageFound` is `null`, not `false`.** `false` says the retailer answered
 * "no such product"; a failure says nothing about the retailer. Every finding
 * field is `null` for the same reason.
 */
export interface FailedReading extends ReadingBase {
  readonly pageFound: null;
  readonly pageItemId: null;
  readonly barcode: null;
  readonly additionalBarcodes: readonly [];
  readonly priceCents: null;
  readonly inStock: null;
  /** `<reason>: <detail>`, the reason one of `READ_FAILURE`. */
  readonly failure: string;
}

/** One listing's reading, as the gateway receives it. */
export type ListingReading = PageReading | GoneReading | FailedReading;

/** What a read run tells the gateway, and what it asks it. */
export interface ReadRunPort {
  fetchJob(): Promise<ReadJob>;
  reportReadings(
    readings: readonly ListingReading[],
    requestsSpent: number,
  ): Promise<ReportOutcome>;
  reportCompleted(requestsSpent: number): Promise<ReportOutcome>;
  reportError(message: string, requestsSpent: number): Promise<ReportOutcome>;
}

type FailureReason = Exclude<
  (typeof READ_FAILURE)[keyof typeof READ_FAILURE],
  typeof READ_FAILURE.notFound
>;

function failed(
  listing: ReadListing,
  readAt: Date,
  reason: FailureReason,
  detail: string,
): FailedReading {
  return {
    itemId: listing.itemId,
    readAt: readAt.toISOString(),
    pageFound: null,
    pageItemId: null,
    barcode: null,
    additionalBarcodes: [],
    priceCents: null,
    inStock: null,
    failure: `${reason}: ${detail}`,
  };
}

function gone(listing: ReadListing, readAt: Date, detail: string): GoneReading {
  return {
    itemId: listing.itemId,
    readAt: readAt.toISOString(),
    pageFound: false,
    pageItemId: null,
    barcode: null,
    additionalBarcodes: [],
    priceCents: null,
    inStock: null,
    failure: `${READ_FAILURE.notFound}: ${detail}`,
  };
}

/**
 * Read one listing: one fetch, one parse.
 *
 * ⚠️ **One call to the fetcher, whatever happens.** The live fetcher already
 * retries inside that call. A re-read of a throttled page is the job's
 * decision, paced and budgeted in `runReadJob`, never this function's.
 *
 * ⚠️ **A corpus gap is rethrown, not filed.** During a replay a missing page is
 * a defect in the test data, and filing it as a failed reading would make a
 * broken fixture look like a faithful outage — the rule the resolution path
 * follows too.
 */
export async function readListing(
  listing: ReadListing,
  reader: ListingReader,
  fetcher: Fetcher,
  now: () => Date,
): Promise<ListingReading> {
  return (await attemptListing(listing, reader, fetcher, now)).reading;
}

/** One read, and whether the vendor's answer was a throttle. */
interface Attempt {
  readonly reading: ListingReading;
  /** True only for a failed fetch the vendor answered with *not now*. */
  readonly throttled: boolean;
}

async function attemptListing(
  listing: ReadListing,
  reader: ListingReader,
  fetcher: Fetcher,
  now: () => Date,
): Promise<Attempt> {
  let body: string;
  let readAt: Date;
  try {
    const result = await fetcher.fetch(listing.url);
    body = result.body;
    // When the page arrived — not after the cache write and the jitter.
    readAt = result.fetchedAt ?? now();
  } catch (error) {
    if (!(error instanceof FetchFailed)) throw error;
    const cause =
      error.cause instanceof Error ? ` (${error.cause.message})` : "";
    const detail = `${error.message}${cause}`;
    if (error.status !== null && GONE_STATUSES.has(error.status)) {
      return { reading: gone(listing, now(), detail), throttled: false };
    }
    return {
      reading: failed(listing, now(), READ_FAILURE.fetchFailed, detail),
      throttled: isThrottled(error),
    };
  }
  return { reading: readBody(listing, reader, body, readAt), throttled: false };
}

function readBody(
  listing: ReadListing,
  reader: ListingReader,
  body: string,
  readAt: Date,
): ListingReading {
  const result = reader.readListingPage(body);
  if (result.kind === "not-a-product-page") {
    return failed(
      listing,
      readAt,
      READ_FAILURE.notAProductPage,
      `${listing.url} answered with ${body.length} bytes that are not a ` +
        `product page this build can read (${result.detail})`,
    );
  }
  if (result.kind === "unreadable-offer") {
    return failed(
      listing,
      readAt,
      READ_FAILURE.unreadableOffer,
      `${listing.url}: ${result.detail}`,
    );
  }
  const page = result.page;
  return {
    itemId: listing.itemId,
    pageItemId: page.pageItemId,
    readAt: readAt.toISOString(),
    pageFound: true,
    barcode: page.barcode,
    additionalBarcodes: page.additionalBarcodes,
    priceCents: page.priceCents,
    inStock: page.inStock,
    failure: null,
  };
}

/**
 * Refuse the job unless every listing is on one of the reader's own hosts.
 *
 * 🔴 **Whole, and before anything is bought.** The urls are fetched through a
 * paid proxy on the job's say-so; one listing pointing elsewhere means the job
 * is not what this build understands, and reading the rest first would spend
 * on a job about to be refused.
 */
function requireOwnHosts(job: ReadJob, reader: ListingReader): void {
  const hosts = new Set(reader.hosts);
  for (const [index, listing] of job.listings.entries()) {
    const host = new URL(listing.url).hostname.toLowerCase();
    if (!hosts.has(host)) {
      throw new Error(
        `listing ${index} of read run ${job.readRunId} is on host "${host}", ` +
          `which is not ${reader.slug}'s (${reader.hosts.join(", ")}) — ` +
          `refused before anything was bought`,
      );
    }
  }
}

/**
 * How a throttled page is read again. One schedule for every retailer: both
 * adapters reach their pages through the same fetcher, and neither has a
 * throttle signal of its own, so there is nothing per retailer to tune.
 *
 * 🔑 **The delays carry on the live fetcher's own doubling.** Inside one call
 * it waits 5 s then 10 s after an empty 200 — measured: a url that answered
 * 0 bytes twice answered 338 KB after 15 s. A page still throttled after that
 * has met a throttle that outlasted the measured recovery (three of 20 Amazon
 * rows did, 2026-09-13), so the next waits are the next rungs: 20 s, 40 s,
 * 80 s. ⚠️ **Reasoned, not measured.** No throttle has yet been seen in read
 * mode; when one is, these are the numbers to correct from it.
 *
 * 🔑 **The cap is a quarter of the job, at least 3 and at most 100 re-reads.**
 * The worst throttle rate measured on this vendor is a third of requests
 * (6 of 18, identity lookups, 2026-09) and the one measured on Amazon pages
 * 15% (3 of 20); a quarter covers the second with each throttled page re-read
 * about 1.7 times. The floor lets a small job take one page through every
 * re-read; the ceiling bounds the time a job can add whatever its size — 100
 * re-reads of at most ~63 s each, three at a time, plus the last page's
 * 140 s of waiting, is under 41 minutes against the catalog's 3 h and the
 * gateway's 6 h. Above 400 listings the ceiling binds, and a job the vendor
 * throttles harder than that reports the rest as not read.
 */
export const READ_PACING = {
  /** The wait before each re-read; its length is the re-reads per page. */
  rereadDelaysMs: [20_000, 40_000, 80_000],
  /** Re-reads per job, as a share of its listings. */
  rereadShare: 0.25,
  rereadFloor: 3,
  rereadCeiling: 100,
} as const;

export type ReadPacing = {
  readonly rereadDelaysMs: readonly number[];
  readonly rereadShare: number;
  readonly rereadFloor: number;
  readonly rereadCeiling: number;
};

/** How many re-reads a job of this many listings may make in all. */
export function rereadBudget(
  listings: number,
  pacing: ReadPacing = READ_PACING,
): number {
  return Math.min(
    pacing.rereadCeiling,
    Math.max(pacing.rereadFloor, Math.ceil(listings * pacing.rereadShare)),
  );
}

/** A failed reading with a note on why it was not read again. */
function noted(reading: ListingReading, note: string): ListingReading {
  return reading.failure === null
    ? reading
    : { ...reading, failure: `${reading.failure} — ${note}` };
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface ReadRunDeps {
  readonly client: ReadRunPort;
  /** Resolved from the job's retailer slug. */
  readonly readerFor: (retailerSlug: string) => ListingReader;
  readonly fetcher: Fetcher;
  readonly now?: () => Date;
  /** Listings read at once. The resolution default, for the same proxy. */
  readonly concurrency?: number;
  /** Readings buffered before a batch is sent; capped at the gateway's limit. */
  readonly flushAt?: number;
  /** How a throttled page is read again. `READ_PACING` unless a test says. */
  readonly pacing?: ReadPacing;
  /** Waits out a re-read's delay. A test passes one that moves its clock. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (message: string) => void;
}

export interface ReadRunResult {
  readonly readings: readonly ListingReading[];
  readonly liveRequests: number;
  /** True when the gateway said the read run had ended and reading stopped. */
  readonly stoppedEarly: boolean;
  /** Readings the gateway never accepted. Non-zero ends the run in `error`. */
  readonly undelivered: number;
  /** Throttled pages read again, across the whole job. */
  readonly rereads: number;
}

export const READ_DEFAULTS = { concurrency: 3, flushAt: 100 } as const;

/**
 * Run one read job end to end.
 *
 * The order encodes three decisions:
 * - **The job first, before anything is bought.** A read run that has ended
 *   answers 404 there, and that is what stops a restarted container spending.
 * - **Every reading delivered before the terminal event**, so `completed`
 *   never claims a reading the gateway has not filed. A batch the gateway
 *   refused, or could not be reached for, ends the run in `error` naming how
 *   many readings were lost — the gateway then files those listings as
 *   missing, which is what they are.
 * - **The cost on every event**: each batch, the completion and the error all
 *   carry what this container has bought so far.
 */
export async function runReadJob(deps: ReadRunDeps): Promise<ReadRunResult> {
  const log = deps.log ?? console.log;
  const now = deps.now ?? ((): Date => new Date());
  const concurrency = Math.max(
    1,
    deps.concurrency ?? READ_DEFAULTS.concurrency,
  );
  const flushAt = Math.min(
    Math.max(1, deps.flushAt ?? READ_DEFAULTS.flushAt),
    MAX_READINGS_PER_EVENT,
  );
  const spent = (): number => deps.fetcher.liveRequestCount;
  const pacing = deps.pacing ?? READ_PACING;
  const sleep = deps.sleep ?? realSleep;

  const job = await deps.client.fetchJob();

  const readings: ListingReading[] = [];
  const buffer: ListingReading[] = [];
  let undelivered = 0;
  let gone = false;
  // Batches are sent one at a time, in order, whatever the workers are doing.
  let sending: Promise<void> = Promise.resolve();

  const sendBatch = async (batch: readonly ListingReading[]): Promise<void> => {
    if (gone) {
      undelivered += batch.length;
      return;
    }
    const outcome = await deps.client.reportReadings(batch, spent());
    if (outcome.kind === "applied") return;
    undelivered += batch.length;
    if (outcome.kind === "run-gone") {
      gone = true;
      log(`stopping: ${outcome.detail}`);
      return;
    }
    log(
      `${batch.length} reading(s) not filed (${outcome.kind}: ${outcome.detail})`,
    );
  };

  const flush = (all: boolean): Promise<void> => {
    while (buffer.length >= (all ? 1 : flushAt)) {
      const batch = buffer.splice(0, flushAt);
      sending = sending.then(() => sendBatch(batch));
    }
    return sending;
  };

  try {
    const reader = deps.readerFor(job.retailerSlug);
    requireOwnHosts(job, reader);
    const budget = rereadBudget(job.listings.length, pacing);
    const maxReads = 1 + pacing.rereadDelaysMs.length;
    log(
      `listing read ${job.readRunId}: ${job.listings.length} listing(s) on ` +
        `${reader.slug}, one read each, a throttled page up to ${maxReads}, ` +
        `${budget} re-read(s) in all`,
    );

    const record = (reading: ListingReading): void => {
      readings.push(reading);
      buffer.push(reading);
    };

    /** A throttled page waiting to be read again. */
    interface SetAside {
      readonly listing: ReadListing;
      /** Reads made so far, the first included. */
      readonly reads: number;
      readonly dueAt: number;
    }
    const setAside: SetAside[] = [];
    let rereads = 0;
    let capLogged = false;

    /** The page to read next, or how long until one is due, or nothing. */
    const take = (): SetAside | number | null => {
      const at = now().getTime();
      // A due re-read first, so its wait is the wait it was given.
      const due = setAside.findIndex((s) => s.dueAt <= at);
      if (due >= 0) return setAside.splice(due, 1)[0] ?? null;
      // 🔑 One shared cursor: each index is taken by exactly one worker, so
      // each listing's first read happens exactly once however many workers.
      const listing = job.listings[next];
      if (listing !== undefined) {
        next++;
        return { listing, reads: 0, dueAt: at };
      }
      if (setAside.length === 0) return null;
      return Math.max(1, Math.min(...setAside.map((s) => s.dueAt)) - at);
    };

    let next = 0;
    const worker = async (): Promise<void> => {
      while (!gone) {
        const task = take();
        if (task === null) return;
        if (typeof task === "number") {
          await sleep(task);
          continue;
        }
        const { listing } = task;
        const attempt = await attemptListing(
          listing,
          reader,
          deps.fetcher,
          now,
        );
        const reads = task.reads + 1;
        let reading = attempt.reading;
        if (attempt.throttled) {
          const delay = pacing.rereadDelaysMs[reads - 1];
          if (delay === undefined) {
            reading = noted(reading, `throttled on all ${reads} reads`);
          } else if (rereads < budget) {
            // 🔴 Set aside, NOT recorded: a reading is posted once, when the
            // page is finally read or finally fails.
            rereads++;
            setAside.push({ listing, reads, dueAt: now().getTime() + delay });
            continue;
          } else {
            if (!capLogged) {
              capLogged = true;
              log(
                `re-read cap reached: ${budget} re-read(s) spent; further ` +
                  `throttled pages are reported as not read`,
              );
            }
            reading = noted(
              reading,
              `throttled, not read again: this job's re-read cap of ` +
                `${budget} is spent`,
            );
          }
        }
        record(reading);
        if (buffer.length >= flushAt) await flush(false);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, job.listings.length) },
        worker,
      ),
    );
    await flush(true);

    const failures = readings.filter((r) => r.failure !== null).length;
    log(
      `read ${readings.length} of ${job.listings.length} listing(s): ` +
        `${readings.length - failures} page(s), ${failures} failed reading(s), ` +
        `${rereads} re-read(s) of a throttled page, ${spent()} request(s)`,
    );

    if (gone) {
      return {
        readings,
        liveRequests: spent(),
        stoppedEarly: true,
        undelivered,
        rereads,
      };
    }

    if (undelivered > 0) {
      await deps.client.reportError(
        `${undelivered} of ${readings.length} reading(s) were not accepted ` +
          `by the gateway`,
        spent(),
      );
    } else {
      await deps.client.reportCompleted(spent());
    }
    return {
      readings,
      liveRequests: spent(),
      stoppedEarly: false,
      undelivered,
      rereads,
    };
  } catch (error) {
    // Whatever was read is still worth filing before the run is marked failed
    // — and a failure to file it must not mask the error being reported.
    await flush(true).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    await deps.client.reportError(message, spent());
    throw error;
  }
}
