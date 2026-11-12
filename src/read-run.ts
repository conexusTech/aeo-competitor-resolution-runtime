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

import { SYSTEM_CLOCK, type Clock } from "./clock.js";
import { isOwnHostUrl } from "./own-hosts.js";
import {
  MAX_PAGES_AT_ONCE,
  pagesAtOnce,
  type BarcodePrice,
  type CategoryReading,
  type ListingCategory,
  type ListingReader,
} from "./adapters/types.js";
import {
  categoryKey,
  MAX_CATEGORY_PAGES_PER_JOB,
  settleWalk,
  walkCategory,
  type CardPrice,
  type CategoryReport,
} from "./category-walk.js";
import { FetchFailed, isThrottled, type Fetcher } from "./fetcher/types.js";
import {
  MAX_READINGS_PER_EVENT,
  type ReadCategory,
  type ReadJob,
  type ReadListing,
  type ReportOutcome,
} from "./gateway/client.js";
import { priceWithinLimits } from "./wire-limits.js";
import {
  NEVER_STOPPED,
  SHUTDOWN,
  boundAfterStop,
  type StopRequest,
} from "./stop-signal.js";

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

/**
 * Which kind of page a reading read.
 *
 * 🔑 **Every price says where it came from.** A card on a category page and
 * an offer on a product page are both the retailer's price, read differently,
 * and a person comparing two readings of one listing must be able to tell
 * which was which.
 */
export const PRICE_SOURCE = {
  /** The listing's own page — every product read, failed ones included. */
  productPage: "product_page",
  /** A card on its category's page. */
  categoryPage: "category_page",
} as const;

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
  /**
   * `null` where the page offers no price — and always `null` beside
   * `barcodePrices`, which then speaks for each barcode. Never 0.
   */
  readonly priceCents: number | null;
  /**
   * Each published barcode with its own item's price, or `null` for one the
   * page does not price — only where the page lists several items not all at
   * one price. The gateway files each pairing at the price of the barcode it
   * was proven by.
   *
   * 🔴 **Absent, not empty, everywhere else**: a reading without it is the
   * reading every gateway built before it already takes, byte for byte.
   */
  readonly barcodePrices?: readonly BarcodePrice[];
  /** `null` where the page states no availability this build recognises. */
  readonly inStock: boolean | null;
  readonly failure: null;
  readonly priceSource: typeof PRICE_SOURCE.productPage;
  /**
   * The category the page's breadcrumb names, as the reader reads it, or
   * `null` where it names none — how the gateway learns which category a
   * watched listing could be priced from.
   */
  readonly category: ListingCategory | null;
}

/**
 * A watched listing priced from its card on its category's page.
 *
 * 🔑 **The fields a product page's reading has, where a card knows them**: a
 * price (always — a card with none sends its listing to its own page), stock
 * or `null`, and `pageFound: true`. No barcode is read from a card, so the
 * barcode fields say none, and the category is `null`: a card names no
 * breadcrumb.
 */
export interface CategoryPageReading extends ReadingBase {
  readonly pageFound: true;
  /** The card's id, which is how it found this listing: equal to `itemId`. */
  readonly pageItemId: string;
  readonly barcode: null;
  readonly additionalBarcodes: readonly [];
  /** Above 0. A card with no price is never a category reading. */
  readonly priceCents: number;
  readonly inStock: boolean | null;
  readonly failure: null;
  readonly priceSource: typeof PRICE_SOURCE.categoryPage;
  readonly category: null;
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
  /** The page that was asked for, and said it is gone. */
  readonly priceSource: typeof PRICE_SOURCE.productPage;
  readonly category: null;
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
  /**
   * The page that was tried. A walk that failed is never a reading of its
   * own: its listings are each read from their product pages.
   */
  readonly priceSource: typeof PRICE_SOURCE.productPage;
  readonly category: null;
}

/** One listing's reading, as the gateway receives it. */
export type ListingReading =
  PageReading | CategoryPageReading | GoneReading | FailedReading;

/** What a read run tells the gateway, and what it asks it. */
export interface ReadRunPort {
  fetchJob(): Promise<ReadJob>;
  /**
   * @param requestsSpent Every attempt sent so far, a running total.
   * @param pagesDelivered Of those, pages the vendor delivered.
   */
  reportReadings(
    readings: readonly ListingReading[],
    requestsSpent: number,
    pagesDelivered: number,
  ): Promise<ReportOutcome>;
  /**
   * What became of each category the job asked for: once, after the last
   * readings and before the terminal event, and only when the job asked for
   * a category.
   */
  reportCategories(
    categories: readonly CategoryReport[],
    requestsSpent: number,
    pagesDelivered: number,
  ): Promise<ReportOutcome>;
  reportCompleted(
    requestsSpent: number,
    pagesDelivered: number,
  ): Promise<ReportOutcome>;
  reportError(
    message: string,
    requestsSpent: number,
    pagesDelivered: number,
  ): Promise<ReportOutcome>;
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
    priceSource: PRICE_SOURCE.productPage,
    category: null,
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
    priceSource: PRICE_SOURCE.productPage,
    category: null,
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
    const result = await fetcher.fetch(listing.url, reader.fetchProfile);
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
  // 🔴 Absent, never empty: an empty list says nothing per barcode.
  const barcodePrices =
    page.barcodePrices === undefined || page.barcodePrices.length === 0
      ? undefined
      : page.barcodePrices.map((b) => ({
          barcode: b.barcode,
          // 🔴 One price past the gateway's limits would refuse the reading.
          priceCents: priceWithinLimits(b.priceCents),
        }));
  return {
    itemId: listing.itemId,
    pageItemId: page.pageItemId,
    readAt: readAt.toISOString(),
    pageFound: true,
    barcode: page.barcode,
    additionalBarcodes: page.additionalBarcodes,
    // 🔴 Never a page price beside per-barcode prices: the gateway takes a
    // pairing's price from those alone, and expects `null` here.
    priceCents: barcodePrices === undefined ? page.priceCents : null,
    ...(barcodePrices === undefined ? {} : { barcodePrices }),
    inStock: page.inStock,
    failure: null,
    priceSource: PRICE_SOURCE.productPage,
    category: page.category,
  };
}

/** A listing priced from its card. */
function fromCard({ listing, card, readAt }: CardPrice): CategoryPageReading {
  return {
    itemId: listing.itemId,
    pageItemId: card.itemId,
    readAt: readAt.toISOString(),
    pageFound: true,
    barcode: null,
    additionalBarcodes: [],
    priceCents: card.priceCents,
    inStock: card.inStock,
    failure: null,
    priceSource: PRICE_SOURCE.categoryPage,
    category: null,
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
function requireOwnHosts(
  job: ReadJob,
  reader: ListingReader & CategoryReading,
): void {
  const refuse = (what: string): never => {
    throw new Error(
      `${what} of read run ${job.readRunId} is not an https page ` +
        `on one of ${reader.slug}'s own hosts (${reader.hosts.join(", ")}), ` +
        `with no userinfo and no port — refused before anything was bought`,
    );
  };
  for (const [index, listing] of job.listings.entries()) {
    // 🔴 The gateway's own rule (`isOwnHostUrl`): https, no userinfo, no
    // port, the exact host — not merely a hostname that matches.
    if (!isOwnHostUrl(listing.url, reader.hosts)) refuse(`listing ${index}`);
  }
  // 🔴 A category's pages and its listings' pages are bought on the job's
  // say-so too.
  const pages = new Map<string, number>();
  for (const [index, category] of (job.categories ?? []).entries()) {
    if (!isOwnHostUrl(category.url, reader.hosts)) {
      refuse(`category ${index}`);
    }
    // 🔴 One category, one walk: two addresses the reader builds the same
    // page 1 from — B&H's `/pn/2` and its category, say — are one category,
    // and walking both would buy every page twice.
    const page1 = categoryKey(
      reader.categoryReader?.pageUrl(category.url, 1) ?? category.url,
    );
    const first = pages.get(page1);
    if (first !== undefined) {
      throw new Error(
        `category ${index} of read run ${job.readRunId} names a category ` +
          `twice (category ${first} reads the same pages) — refused before ` +
          `anything was bought`,
      );
    }
    pages.set(page1, index);
    for (const [at, listing] of category.listings.entries()) {
      if (!isOwnHostUrl(listing.url, reader.hosts)) {
        refuse(`listing ${at} of category ${index}`);
      }
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
  /**
   * Resolved from the job's retailer slug: its product-page reader, and its
   * category reader or `null` where it has none.
   */
  readonly readerFor: (retailerSlug: string) => ListingReader & CategoryReading;
  readonly fetcher: Fetcher;
  readonly now?: () => Date;
  /**
   * Listings read at once, when the job does not say. Absent, the reader's
   * own `pacing.pagesAtOnce`. The job's figure wins over this, and the result
   * is clamped to `MAX_PAGES_AT_ONCE`.
   */
  readonly concurrency?: number;
  /** Readings buffered before a batch is sent; capped at the gateway's limit. */
  readonly flushAt?: number;
  /** How a throttled page is read again. `READ_PACING` unless a test says. */
  readonly pacing?: ReadPacing;
  /** Waits out a re-read's delay. A test passes one that moves its clock. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (message: string) => void;
  /**
   * The cluster telling this container to stop (SIGTERM). Never, unless the
   * caller wires one — see `watchForTermination`.
   */
  readonly stop?: StopRequest;
  /** What the shutdown's waits are measured on. The system clock unless a check says. */
  readonly clock?: Clock;
}

export interface ReadRunResult {
  readonly readings: readonly ListingReading[];
  /** Requests sent to the vendor: every attempt. */
  readonly liveRequests: number;
  /** Of those, pages the vendor delivered. */
  readonly pagesDelivered: number;
  /** True when the gateway said the read run had ended and reading stopped. */
  readonly stoppedEarly: boolean;
  /** Readings the gateway never accepted. Non-zero ends the run in `error`. */
  readonly undelivered: number;
  /** Throttled pages read again, across the whole job. */
  readonly rereads: number;
  /**
   * True when the container was told to stop with listings still unread, and
   * ended the batch with an error saying how far it got.
   */
  readonly stopped: boolean;
  /**
   * What became of each category this container finished, in the job's
   * order. Empty for a job that asked for none.
   */
  readonly categories: readonly CategoryReport[];
}

export const READ_DEFAULTS = { flushAt: 100 } as const;

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
  const flushAt = Math.min(
    Math.max(1, deps.flushAt ?? READ_DEFAULTS.flushAt),
    MAX_READINGS_PER_EVENT,
  );
  const spent = (): number => deps.fetcher.liveRequestCount;
  const delivered = (): number => deps.fetcher.pagesDelivered;
  const pacing = deps.pacing ?? READ_PACING;
  const sleep = deps.sleep ?? realSleep;
  const clock = deps.clock ?? SYSTEM_CLOCK;
  const stop = deps.stop ?? NEVER_STOPPED;
  const stopAsked = (): boolean => stop.askedAt !== null;
  /**
   * A closing step: waited for in full, unless the container has been told
   * to stop — then only until `SHUTDOWN.finishByMs` after the signal.
   */
  const closing = async (work: Promise<unknown>, what: string) => {
    const outcome = await boundAfterStop(
      work,
      stop,
      clock,
      SHUTDOWN.finishByMs,
    );
    if (outcome.kind === "timed-out") {
      log(`gave up waiting to ${what}: the grace period is nearly over`);
    }
  };

  const job = await deps.client.fetchJob();
  const categories: readonly ReadCategory[] = job.categories ?? [];
  /**
   * 🔑 Every watched listing ends the job with exactly one reading — from
   * its card or from its own page — unless the container is stopped first.
   */
  const expected =
    job.listings.length +
    categories.reduce((n, category) => n + category.listings.length, 0);
  /** Each finished category's outcome, by its id. */
  const reports = new Map<string, CategoryReport>();
  /** The finished categories' outcomes, in the job's order. */
  const finished = (): CategoryReport[] =>
    categories.flatMap((c) => {
      const report = reports.get(c.categoryId);
      return report === undefined ? [] : [report];
    });

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
    const outcome = await deps.client.reportReadings(
      batch,
      spent(),
      delivered(),
    );
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
    // 🔑 After the reader, because its `pacing` is the fallback: the job's
    // registry figure first, then the caller's, then the reader's own.
    const concurrency = pagesAtOnce(
      job.pagesAtOnce ?? deps.concurrency ?? null,
      reader.pacing,
    );
    // 🔑 Sized by every watched listing: a walk's pages and the product
    // reads it falls back to draw on the same budget.
    const budget = rereadBudget(expected, pacing);
    const maxReads = 1 + pacing.rereadDelaysMs.length;
    log(
      `listing read ${job.readRunId}: ${job.listings.length} listing(s) on ` +
        `${reader.slug}, one read each, a throttled page up to ${maxReads}, ` +
        `${budget} re-read(s) in all, ${concurrency} page(s) at once ` +
        `(at most ${MAX_PAGES_AT_ONCE})`,
    );
    if (categories.length > 0) {
      log(
        `and ${categories.length} categor${categories.length === 1 ? "y" : "ies"} ` +
          `read from their own pages, pricing ${expected - job.listings.length} ` +
          `watched listing(s); a listing a walk does not price is read from ` +
          `its own page, within the same ${concurrency} page(s) at once`,
      );
    }

    /**
     * 🔴 Set once the batch's end is decided. A page abandoned in flight can
     * still arrive afterwards; recorded, it could be sent after the event
     * that ended the batch. Dropped instead — the listing is read again at
     * the next slot.
     */
    let sealed = false;
    const record = (reading: ListingReading): void => {
      if (sealed) return;
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
    /** Re-reads promised to set-aside pages; what the budget is spent on. */
    let reserved = 0;
    /** Re-reads actually fetched. */
    let rereads = 0;
    /** Category pages taken, against `MAX_CATEGORY_PAGES_PER_JOB`. */
    let categoryPages = 0;
    /**
     * 🔴 **Set on the first worker's crash, so the others buy nothing more.**
     * `Promise.all` rejects at once while the rest carry on, and a worker
     * waiting out a re-read would otherwise buy it after the error was sent.
     * Apart from `gone`, which also stops the sending of readings.
     */
    let halted = false;
    let capLogged = false;

    /** Categories not yet started, by their place in the job. */
    let nextCategory = 0;
    /** Walks under way. A worker with nothing to do waits for them. */
    let walking = 0;
    /**
     * Watched listings a finished walk did not price: read from their own
     * pages, exactly as the job's own listings are.
     */
    const fallback: ReadListing[] = [];
    let nextFallback = 0;
    /**
     * Settles when a walk leaves listings to read, or ends, waking a worker
     * waiting on one.
     */
    let walkNews: () => void = () => undefined;
    let walkSignal = new Promise<void>((resolve) => {
      walkNews = resolve;
    });
    const wakeIdleWorkers = (): void => {
      const wake = walkNews;
      walkSignal = new Promise<void>((resolve) => {
        walkNews = resolve;
      });
      wake();
    };

    /** Nothing to read yet: wait this long (or for a walk), or `null`: a walk only. */
    interface Wait {
      readonly waitMs: number | null;
    }
    interface Walk {
      readonly walk: ReadCategory;
    }

    /** The page to read next, a walk to make, or how long until one is due, or nothing. */
    const take = (): SetAside | Walk | Wait | null => {
      const at = now().getTime();
      // A due re-read first, so its wait is the wait it was given.
      const due = setAside.findIndex((s) => s.dueAt <= at);
      if (due >= 0) return setAside.splice(due, 1)[0] ?? null;
      // 🔑 Walks before product reads: a walk is many pages, and the
      // listings it does not price can only be read once it ends.
      const category = categories[nextCategory];
      if (category !== undefined) {
        nextCategory++;
        walking++;
        return { walk: category };
      }
      // 🔑 One shared cursor: each index is taken by exactly one worker, so
      // each listing's first read happens exactly once however many workers.
      const listing = job.listings[next];
      if (listing !== undefined) {
        next++;
        return { listing, reads: 0, dueAt: at };
      }
      const left = fallback[nextFallback];
      if (left !== undefined) {
        nextFallback++;
        return { listing: left, reads: 0, dueAt: at };
      }
      if (setAside.length === 0) return walking > 0 ? { waitMs: null } : null;
      return {
        waitMs: Math.max(1, Math.min(...setAside.map((s) => s.dueAt)) - at),
      };
    };

    /**
     * Walk one category, then record what its cards priced and queue the
     * rest for their own pages.
     */
    const walk = async (category: ReadCategory): Promise<void> => {
      try {
        const walked = await walkCategory(category, reader.categoryReader, {
          fetcher: deps.fetcher,
          profile: reader.fetchProfile,
          now,
          rereadDelaysMs: pacing.rereadDelaysMs,
          takeReread: () => {
            if (reserved >= budget) return false;
            reserved++;
            rereads++;
            return true;
          },
          takePage: () => {
            if (categoryPages >= MAX_CATEGORY_PAGES_PER_JOB) return false;
            categoryPages++;
            return true;
          },
          // ⚠️ A stop ends the wait at once, as for a set-aside page.
          wait: async (ms) => {
            await Promise.race([sleep(ms), stop.asked]);
          },
          shouldStop: () => gone || halted || stopAsked(),
        });
        // 🔴 Stopped part-way: no outcome, no readings. Its listings stay
        // unread and the gateway plans the category again next time.
        if (walked === null || sealed) return;
        reports.set(category.categoryId, walked.report);
        const settled = settleWalk(category, walked);
        for (const price of settled.priced) record(fromCard(price));
        for (const listing of settled.fallback) {
          fallback.push({ itemId: listing.itemId, url: listing.url });
        }
        // 🔑 Wake an idle worker now, not after this walk's batch is sent: the
        // listings it left are ready to read.
        if (settled.fallback.length > 0) wakeIdleWorkers();
        const { report } = walked;
        log(
          `category ${category.categoryId} (${category.kind}): ${report.status}, ` +
            `${report.pagesRead} page(s), ${report.productsSeen} product(s), ` +
            `${settled.priced.length} of ${category.listings.length} watched ` +
            `listing(s) priced from it, ${settled.fallback.length} to read ` +
            `from their own pages` +
            (report.error === null ? "" : ` — ${report.error}`),
        );
        if (buffer.length >= flushAt) await flush(false);
      } finally {
        walking--;
        wakeIdleWorkers();
      }
    };

    let next = 0;
    const work = async (): Promise<void> => {
      // 🔴 A stop takes no new listing: the cluster is ending the container.
      while (!gone && !halted && !stopAsked()) {
        const task = take();
        if (task === null) return;
        if ("waitMs" in task) {
          // 🔑 Send what is finished before waiting: a container killed in a
          // long re-read tail then loses only what is in flight, and a run the
          // gateway has ended is learnt of now rather than at the end.
          await flush(true);
          if (gone || halted || stopAsked()) return;
          // ⚠️ A stop ends the wait at once: a re-read delay is up to 80 s,
          // far past the grace period. A walk ending ends it too: the walk
          // may have left listings to read.
          // 🔴 The walk it was waiting for may have ended while the batch
          // was sent: then there is nothing to wait for, and the listings it
          // left are taken at once rather than never.
          if (task.waitMs === null && walking === 0) continue;
          const waits: Promise<unknown>[] = [stop.asked];
          if (task.waitMs !== null) waits.push(sleep(task.waitMs));
          if (walking > 0) waits.push(walkSignal);
          await Promise.race(waits);
          continue;
        }
        if ("walk" in task) {
          await walk(task.walk);
          continue;
        }
        const { listing } = task;
        if (task.reads > 0) rereads++;
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
          } else if (reserved < budget) {
            // 🔴 Set aside, NOT recorded: a reading is posted once, when the
            // page is finally read or finally fails.
            reserved++;
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
    const worker = async (): Promise<void> => {
      try {
        await work();
      } catch (error) {
        halted = true;
        throw error;
      }
    };
    // 🔑 Never more workers than pages at once: each worker — a walk or a
    // product read — has at most one page in flight.
    const working = Promise.all(
      Array.from(
        { length: Math.min(concurrency, expected + categories.length) },
        worker,
      ),
    );
    // 🔑 Every listing is read — unless the container is told to stop. Then
    // pages in flight get `SHUTDOWN.inFlightMs` from the signal; one still
    // going after that is abandoned, so the readings already made are still
    // filed before SIGKILL.
    const ran = await boundAfterStop(working, stop, clock, SHUTDOWN.inFlightMs);
    sealed = true;
    await closing(flush(true), "file the last readings");

    const failures = readings.filter((r) => r.failure !== null).length;
    log(
      `read ${readings.length} of ${expected} listing(s): ` +
        `${readings.length - failures} page(s), ${failures} failed reading(s), ` +
        `${rereads} re-read(s) of a throttled page, ${spent()} request(s) ` +
        `sent, ${delivered()} page(s) delivered`,
    );

    const ended = (stoppedEarly: boolean, stopped: boolean): ReadRunResult => ({
      readings,
      liveRequests: spent(),
      pagesDelivered: delivered(),
      stoppedEarly,
      undelivered,
      rereads,
      stopped,
      categories: finished(),
    });

    if (gone) return ended(true, false);

    // 🔴 **Told to stop with listings unread: `error`, never `completed`.**
    // `completed` would say the batch read its listings. The error is what the
    // gateway records from the queue for a killed batch anyway — here it comes
    // at once, after the readings that were made, and says how far it got.
    if (
      stopAsked() &&
      (ran.kind === "timed-out" || readings.length < expected)
    ) {
      // The categories that finished still say what they were; one stopped
      // part-way says nothing, and is planned again next time.
      if (reports.size > 0) {
        await closing(
          deps.client.reportCategories(finished(), spent(), delivered()),
          "report the categories",
        );
      }
      const lost =
        undelivered > 0
          ? `; ${undelivered} reading(s) were not accepted by the gateway`
          : "";
      await closing(
        deps.client.reportError(
          `the container was told to stop (SIGTERM) after reading ` +
            `${readings.length} of ${expected} listing(s); the ` +
            `rest were not read${lost}`,
          spent(),
          delivered(),
        ),
        "end the batch",
      );
      return ended(false, true);
    }

    // 🔑 After every reading and before the terminal event, so `completed`
    // never claims a category the gateway has not been told about.
    let categoriesLost: string | null = null;
    if (reports.size > 0) {
      const outcome = await deps.client.reportCategories(
        finished(),
        spent(),
        delivered(),
      );
      if (outcome.kind === "run-gone") {
        log(`stopping: ${outcome.detail}`);
        return ended(true, false);
      }
      if (outcome.kind !== "applied") {
        categoriesLost = `${outcome.kind}: ${outcome.detail}`;
        log(`the categories were not filed (${categoriesLost})`);
      }
    }

    if (undelivered > 0 || categoriesLost !== null) {
      const problems = [
        ...(undelivered > 0
          ? [
              `${undelivered} of ${readings.length} reading(s) were not ` +
                `accepted by the gateway`,
            ]
          : []),
        ...(categoriesLost === null
          ? []
          : [
              `the categories were not accepted by the gateway ` +
                `(${categoriesLost})`,
            ]),
      ];
      await deps.client.reportError(problems.join("; "), spent(), delivered());
    } else {
      await deps.client.reportCompleted(spent(), delivered());
    }
    return ended(false, false);
  } catch (error) {
    // Whatever was read is still worth filing before the run is marked failed
    // — and a failure to file it must not mask the error being reported.
    await closing(
      flush(true).catch(() => undefined),
      "file the last readings",
    );
    const message = error instanceof Error ? error.message : String(error);
    await closing(
      deps.client.reportError(message, spent(), delivered()),
      "report the error",
    );
    throw error;
  }
}
