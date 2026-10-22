import { gunzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  amazonAdapter,
  readListingPage as readAmazonPage,
} from "../src/adapters/amazon.js";
import {
  neweggAdapter,
  readListingPage as readNeweggPage,
} from "../src/adapters/newegg.js";
import type {
  ListingPageResult,
  ListingReader,
} from "../src/adapters/types.js";
import { LIVE_DEFAULTS, LiveFetcher } from "../src/fetcher/live.js";
import { ReplayFetcher } from "../src/fetcher/replay.js";
import {
  readFetcherFromEnv,
  REPLAY_CORPUS_ENV,
} from "../src/fetcher/select.js";
import {
  FetchFailed,
  NotInCorpus,
  type Fetcher,
  type FetchResult,
} from "../src/fetcher/types.js";
import {
  MAX_READINGS_PER_EVENT,
  ReadRunClient,
  ReadRunGone,
  parseReadJob,
  type ReadJob,
  type ReportOutcome,
} from "../src/gateway/client.js";
import {
  BootstrapError,
  queueDispatchFromPayload,
} from "../src/queue/task-record.js";
import {
  READ_FAILURE,
  readListing,
  runReadJob,
  type ListingReading,
  type ReadRunPort,
} from "../src/read-run.js";

/**
 * Read mode: the runtime reads pages it already knows, once each.
 *
 * 🔑 **The contract here is the one the gateway's read-run tasks are built
 * against**, so every field of a reading and every rule about a failure is
 * asserted by name rather than by shape.
 *
 * 🔴 **A page nobody could read is a failed reading, never a finding.** A fetch
 * that failed, or a body that is not a product page, must never reach the
 * gateway as "out of stock" or "no price" — each of those is a statement about
 * the retailer, and a failure is a statement about us. Only a 404 or 410 the
 * vendor relayed is "page not found".
 *
 * Offline throughout: real captured product pages from `test/raw`, served by
 * the replay fetcher or by a scripted fetcher that counts and times each call,
 * and hand-built variants of them where a case has no capture.
 */

const raw = (name: string): string => {
  const url = new URL(`./raw/${name}.html.gz`, import.meta.url);
  return gunzipSync(readFileSync(fileURLToPath(url))).toString("utf8");
};

const PAGES = {
  barcode12: raw("pdp-barcode-12"),
  barcode13: raw("pdp-barcode-13"),
  barcode14: raw("pdp-barcode-14"),
  barcodeEmpty: raw("pdp-barcode-empty"),
  amazon: raw("amazon-pdp-gtin-labelled"),
  neweggSearch: raw("search-many-results"),
  amazonSearch: raw("amazon-search-results"),
};

/**
 * The committed Amazon page with its FIRST buying option rewritten.
 *
 * 🔑 The page carries two options — the open one at $472.00, "Only 8 left in
 * stock", and a second at $479.99, "In Stock". Rewriting only the first is
 * what proves the reader takes price and availability from the same row and
 * never borrows either from the second.
 */
function amazonWithFirstOption(
  rewrite: (row: string) => string,
  page: string = PAGES.amazon,
): string {
  const start = page.indexOf('id="newAccordionRow_0"');
  const end = page.indexOf('id="newAccordionRow_1"');
  if (start < 0 || end < start) throw new Error("fixture has moved");
  return (
    page.slice(0, start) + rewrite(page.slice(start, end)) + page.slice(end)
  );
}

const noPrice = (row: string): string =>
  row.replace(/apex-pricetopay-value/g, "apex-removed-value");
const availability =
  (said: string) =>
  (row: string): string =>
    row.replace(" Only 8 left in stock - order soon. ", ` ${said} `);
const noAvailability = (row: string): string =>
  row.replace(/primary-availability-message/g, "removed-message");

/** A page result that must be a page; fails loudly otherwise. */
function pageResult(
  result: ListingPageResult,
): Extract<ListingPageResult, { kind: "page" }>["page"] {
  if (result.kind !== "page") {
    throw new Error(`expected a page, got ${result.kind}: ${result.detail}`);
  }
  return result.page;
}

/** A reading that must have read a page; fails loudly otherwise. */
function pageOf(
  reading: ListingReading | undefined,
): Extract<ListingReading, { pageFound: true }> {
  if (reading === undefined) throw new Error("expected a reading, got none");
  if (reading.pageFound !== true) {
    throw new Error(`expected a page, got failure ${reading.failure}`);
  }
  return reading;
}

/** A reading that must have failed; fails loudly otherwise. */
function failureOf(
  reading: ListingReading | undefined,
): Extract<ListingReading, { pageFound: null }> {
  if (reading === undefined) throw new Error("expected a reading, got none");
  if (reading.pageFound !== null) {
    throw new Error("expected a failed reading, got a page");
  }
  return reading;
}

// ── A clock the tests own ───────────────────────────────────────────────

class Clock {
  private ms = Date.parse("2026-10-23T06:22:00.000Z");
  advance(by: number): void {
    this.ms += by;
  }
  now = (): Date => new Date(this.ms);
}

/**
 * A fetcher that records every call, stamps when each page arrived, then lets
 * the clock run on — the live fetcher's cache write and politeness jitter —
 * before handing the page back. Bills a request for every page it serves.
 */
class ScriptedFetcher implements Fetcher {
  liveRequestCount = 0;
  readonly calls: string[] = [];
  /** When each url's page arrived, by the test's clock. */
  readonly completedAt = new Map<string, string>();

  constructor(
    private readonly pages: ReadonlyMap<string, string>,
    private readonly clock: Clock,
    /** Urls the vendor answers with this HTTP status instead of a page. */
    private readonly statuses: ReadonlyMap<string, number> = new Map(),
  ) {}

  async fetch(url: string): Promise<FetchResult> {
    this.calls.push(url);
    // Yield, so concurrent workers genuinely interleave.
    await Promise.resolve();
    this.clock.advance(60_000);
    const fetchedAt = this.clock.now();
    this.completedAt.set(url, fetchedAt.toISOString());
    const status = this.statuses.get(url);
    if (status !== undefined) {
      throw new FetchFailed(url, new Error(`status=${status} bytes=0`), status);
    }
    const body = this.pages.get(url);
    if (body === undefined) {
      throw new FetchFailed(url, new Error("status=403 bytes=0"), 403);
    }
    this.liveRequestCount++;
    // The cache write and the jitter happen after the page is in hand.
    this.clock.advance(5_000);
    return { url, body, cached: false, fetchedAt };
  }
}

// ── A port that records what the run told the gateway ───────────────────

interface Sent {
  readonly type: "readings" | "completed" | "error";
  readonly readings: readonly ListingReading[];
  readonly requestsSpent: number;
  readonly message: string | null;
}

class RecordingPort implements ReadRunPort {
  readonly sent: Sent[] = [];
  answerReadings: (batch: number) => ReportOutcome = () => ({
    kind: "applied",
  });
  private batches = 0;

  constructor(private readonly job: ReadJob) {}

  fetchJob(): Promise<ReadJob> {
    return Promise.resolve(this.job);
  }

  reportReadings(
    readings: readonly ListingReading[],
    requestsSpent: number,
  ): Promise<ReportOutcome> {
    this.sent.push({
      type: "readings",
      readings: [...readings],
      requestsSpent,
      message: null,
    });
    return Promise.resolve(this.answerReadings(this.batches++));
  }

  reportCompleted(requestsSpent: number): Promise<ReportOutcome> {
    this.sent.push({
      type: "completed",
      readings: [],
      requestsSpent,
      message: null,
    });
    return Promise.resolve({ kind: "applied" });
  }

  reportError(message: string, requestsSpent: number): Promise<ReportOutcome> {
    this.sent.push({ type: "error", readings: [], requestsSpent, message });
    return Promise.resolve({ kind: "applied" });
  }

  get delivered(): ListingReading[] {
    return this.sent.flatMap((s) => [...s.readings]);
  }
}

/**
 * Four listings, each id the one its committed page identifies itself by — the
 * canonical id a search would have produced for it.
 */
const NEWEGG_LISTINGS = [
  {
    itemId: "N82E16886949047",
    url: "https://www.newegg.com/p/N82E16886949047",
  },
  { itemId: "1W7-00T2-01021", url: "https://www.newegg.com/p/1W7-00T2-01021" },
  {
    itemId: "N82E16826197074",
    url: "https://www.newegg.com/p/N82E16826197074",
  },
  { itemId: "2VR-0680-00002", url: "https://www.newegg.com/p/2VR-0680-00002" },
] as const;

const NEWEGG_PAGES = new Map<string, string>([
  [NEWEGG_LISTINGS[0].url, PAGES.barcode12],
  [NEWEGG_LISTINGS[1].url, PAGES.barcode13],
  [NEWEGG_LISTINGS[2].url, PAGES.barcode14],
  [NEWEGG_LISTINGS[3].url, PAGES.barcodeEmpty],
]);

const neweggJob = (
  listings: readonly { itemId: string; url: string }[] = NEWEGG_LISTINGS,
): ReadJob => ({
  readRunId: "55555555-5555-4555-8555-555555555555",
  retailerSlug: "newegg",
  listings,
});

const readers = (slug: string): ListingReader => {
  if (slug === neweggAdapter.slug) return neweggAdapter;
  if (slug === amazonAdapter.slug) return amazonAdapter;
  throw new Error(`no adapter for retailer "${slug}"`);
};

const quiet = (): void => undefined;

// ════════════════════════════════════════════════════════════════════════

describe("the adapter reads a product page it already knows", () => {
  it("reads identity, barcode, price and stock off each real Newegg product page", () => {
    expect(readNeweggPage(PAGES.barcode12)).toEqual({
      kind: "page",
      page: {
        pageItemId: "N82E16886949047",
        barcode: "065030870382",
        additionalBarcodes: [],
        priceCents: 7126,
        inStock: true,
      },
    });
    expect(readNeweggPage(PAGES.barcode13)).toEqual({
      kind: "page",
      page: {
        pageItemId: "1W7-00T2-01021",
        barcode: "5028551561707",
        additionalBarcodes: [],
        priceCents: 1953,
        inStock: true,
      },
    });
    // The 14-digit page is discounted: 299.99 struck through, 199.99 offered.
    expect(readNeweggPage(PAGES.barcode14)).toEqual({
      kind: "page",
      page: {
        pageItemId: "N82E16826197074",
        barcode: "00097855114693",
        additionalBarcodes: [],
        priceCents: 19999,
        inStock: true,
      },
    });
  });

  it("🔴 identifies a Newegg page as its canonical listing, not the offer it shows", () => {
    // `pdp-barcode-12` shows a marketplace offer (`9SIA6ZPK9U9854`) of the
    // warehouse product `86-949-047`. A search names that product
    // `N82E16886949047`, so that is what the page must say it is — or the
    // gateway would refuse every reading of a page showing a seller's offer.
    expect(pageResult(readNeweggPage(PAGES.barcode12)).pageItemId).toBe(
      "N82E16886949047",
    );
    // With no parent, the item itself, in its public form.
    expect(pageResult(readNeweggPage(PAGES.barcode14)).pageItemId).toBe(
      "N82E16826197074",
    );
  });

  it("🔴 keeps an empty barcode as the empty string", () => {
    // The retailer publishes the field and leaves it empty — 91 of 255
    // captured pages. That is what the page said (trimmed, never normalised).
    const page = pageResult(readNeweggPage(PAGES.barcodeEmpty));
    expect(page.barcode).toBe("");
    expect(page.priceCents).toBe(42999);
  });

  it("reads the featured offer and the ASIN off a real Amazon product page", () => {
    expect(readAmazonPage(PAGES.amazon)).toEqual({
      kind: "page",
      page: {
        pageItemId: "B0BFGB2D2Z",
        barcode: "04713294232687",
        additionalBarcodes: [],
        priceCents: 47200,
        inStock: true,
      },
    });
  });

  it("🔴 says a search page is not a product page, on both retailers", () => {
    expect(readNeweggPage(PAGES.neweggSearch).kind).toBe("not-a-product-page");
    expect(readAmazonPage(PAGES.amazonSearch).kind).toBe("not-a-product-page");
  });

  it("🔴 says a block page or a body cut short is not a product page", () => {
    const block = "<html><body>Are you a human? Please verify.</body></html>";
    expect(readNeweggPage(block).kind).toBe("not-a-product-page");
    expect(readAmazonPage(block).kind).toBe("not-a-product-page");
    expect(readNeweggPage("").kind).toBe("not-a-product-page");
    // Cut inside the embedded state, before its closing script tag.
    const anchor = PAGES.barcode12.indexOf("window.__initialState__ =");
    expect(readNeweggPage(PAGES.barcode12.slice(0, anchor + 2000)).kind).toBe(
      "not-a-product-page",
    );
  });

  it("🔴 refuses an in-stock page whose price it cannot read, rather than report no price", () => {
    // An offer in stock always has a price. Seeing one without a price means
    // the markup moved, and "no price" would be a claim about the retailer.
    const neweggNoPrice = PAGES.barcode12.replace(
      /"FinalPrice":71\.26/g,
      '"FinalPrice":"n/a"',
    );
    expect(readNeweggPage(neweggNoPrice).kind).toBe("unreadable-offer");
    expect(readAmazonPage(amazonWithFirstOption(noPrice)).kind).toBe(
      "unreadable-offer",
    );
  });

  it("🔴 takes Amazon's price and availability from the same buying option", () => {
    // With the first option's price gone, the second option's $479.99 is right
    // there. Borrowing it would pair one offer's price with another's stock.
    const result = readAmazonPage(amazonWithFirstOption(noPrice));
    expect(result.kind).toBe("unreadable-offer");
    // And the second option saying "unavailable" does not touch the first.
    const secondSoldOut = PAGES.amazon.replace(
      " In Stock </span>",
      " Currently unavailable. </span>",
    );
    expect(secondSoldOut).not.toBe(PAGES.amazon);
    expect(pageResult(readAmazonPage(secondSoldOut)).inStock).toBe(true);
  });

  it("🔴 refuses a page whose price and availability are both missing", () => {
    const neweggBoth = PAGES.barcode12
      .replace(/"FinalPrice":71\.26/g, '"FinalPrice":"n/a"')
      .replace(/"Instock":true/g, '"Instock":"?"');
    expect(readNeweggPage(neweggBoth).kind).toBe("unreadable-offer");
    const amazonBoth = amazonWithFirstOption((row) =>
      noAvailability(noPrice(row)),
    );
    expect(readAmazonPage(amazonBoth).kind).toBe("unreadable-offer");
  });

  it("CONTROL: Amazon's own 'no featured offers' message makes both-missing a page", () => {
    const marked = amazonWithFirstOption(
      (row) =>
        `${noAvailability(noPrice(row))}<span class="a-size-base">No featured offers available</span>`,
    );
    expect(readAmazonPage(marked)).toEqual({
      kind: "page",
      page: {
        pageItemId: "B0BFGB2D2Z",
        barcode: "04713294232687",
        additionalBarcodes: [],
        priceCents: null,
        inStock: null,
      },
    });
  });

  it("reads an out-of-stock Amazon page as a page with no price", () => {
    const soldOut = amazonWithFirstOption((row) =>
      availability("Currently unavailable.")(noPrice(row)),
    );
    const page = pageResult(readAmazonPage(soldOut));
    expect(page.inStock).toBe(false);
    expect(page.priceCents).toBeNull();
  });

  it("🔴 reads back-order wording as not in stock", () => {
    for (const said of [
      "In stock soon. Order it now.",
      "In Stock on November 3, 2026.",
      "Temporarily out of stock.",
    ]) {
      const page = pageResult(
        readAmazonPage(amazonWithFirstOption(availability(said))),
      );
      expect([said, page.inStock]).toEqual([said, false]);
      // The price is still the offer's.
      expect(page.priceCents).toBe(47200);
    }
  });

  it("🔴 reads a zero price as no price, on both retailers", () => {
    const amazonZero = amazonWithFirstOption((row) =>
      availability("Currently unavailable.")(row.replace("$472.00", "$0.00")),
    );
    expect(pageResult(readAmazonPage(amazonZero)).priceCents).toBeNull();
    const neweggZero = PAGES.barcode12
      .replace(/"FinalPrice":71\.26/g, '"FinalPrice":0')
      .replace(/"Instock":true/g, '"Instock":false');
    expect(pageResult(readNeweggPage(neweggZero)).priceCents).toBeNull();
  });

  it("CONTROL: an out-of-stock Newegg page with no price is a page, not a failure", () => {
    const soldOut = PAGES.barcode12
      .replace(/"FinalPrice":71\.26/g, '"FinalPrice":null')
      .replace(/"Instock":true/g, '"Instock":false');
    expect(pageResult(readNeweggPage(soldOut))).toEqual({
      pageItemId: "N82E16886949047",
      barcode: "065030870382",
      additionalBarcodes: [],
      priceCents: null,
      inStock: false,
    });
  });

  it("CONTROL: reading leaves the resolution parse exactly as it was", () => {
    // The resolution path collapses an empty barcode to null; reading must not
    // have changed that, or the 53-row split moves.
    expect(
      neweggAdapter.parseProductPage(PAGES.barcodeEmpty).barcode,
    ).toBeNull();
    expect(neweggAdapter.parseProductPage(PAGES.barcode12)).toEqual({
      barcode: "065030870382",
      additionalBarcodes: [],
      priceCents: null,
      inStock: null,
      title: null,
    });
  });

  it("names the hosts each reader may be sent to", () => {
    expect([...neweggAdapter.hosts].sort()).toEqual([
      "newegg.com",
      "www.newegg.com",
    ]);
    expect([...amazonAdapter.hosts].sort()).toEqual([
      "amazon.com",
      "www.amazon.com",
    ]);
  });
});

describe("one listing, read", () => {
  it("carries every field of the contract for a page that was read", async () => {
    const clock = new Clock();
    const fetcher = new ScriptedFetcher(NEWEGG_PAGES, clock);
    const reading = await readListing(
      NEWEGG_LISTINGS[0],
      neweggAdapter,
      fetcher,
      clock.now,
    );
    expect(reading).toEqual({
      itemId: "N82E16886949047",
      pageItemId: "N82E16886949047",
      readAt: fetcher.completedAt.get(NEWEGG_LISTINGS[0].url),
      pageFound: true,
      barcode: "065030870382",
      additionalBarcodes: [],
      priceCents: 7126,
      inStock: true,
      failure: null,
    });
  });

  it("🔴 reports the identity the PAGE gives, not the one the job asked for", async () => {
    // A listing url that now lands on a different product must be visible to
    // the gateway, which refuses the mismatch. Echoing the job's id would hide it.
    const clock = new Clock();
    const asked = { itemId: "N82E16899999999", url: NEWEGG_LISTINGS[0].url };
    const reading = pageOf(
      await readListing(
        asked,
        neweggAdapter,
        new ScriptedFetcher(NEWEGG_PAGES, clock),
        clock.now,
      ),
    );
    expect(reading.itemId).toBe("N82E16899999999");
    expect(reading.pageItemId).toBe("N82E16886949047");
  });

  it("🔴 reports a failed fetch as a failure — never as page not found, out of stock or no price", async () => {
    const clock = new Clock();
    const fetcher = new ScriptedFetcher(new Map(), clock);
    const reading = failureOf(
      await readListing(NEWEGG_LISTINGS[0], neweggAdapter, fetcher, clock.now),
    );
    expect(reading.failure.startsWith(`${READ_FAILURE.fetchFailed}:`)).toBe(
      true,
    );
    // The vendor's own reason survives, so an operator can act on it.
    expect(reading.failure).toContain("status=403");
    // Every finding field is unknown rather than a statement.
    expect(reading.pageFound).toBeNull();
    expect(reading.pageItemId).toBeNull();
    expect(reading.inStock).toBeNull();
    expect(reading.priceCents).toBeNull();
    expect(reading.barcode).toBeNull();
    expect(reading.additionalBarcodes).toEqual([]);
    expect(reading.readAt).toBe(
      fetcher.completedAt.get(NEWEGG_LISTINGS[0].url),
    );
  });

  it("🔴 reports a relayed 404 or 410 as page not found, with a stable reason", async () => {
    for (const status of [404, 410]) {
      const clock = new Clock();
      const url = NEWEGG_LISTINGS[0].url;
      const reading = await readListing(
        NEWEGG_LISTINGS[0],
        neweggAdapter,
        new ScriptedFetcher(NEWEGG_PAGES, clock, new Map([[url, status]])),
        clock.now,
      );
      expect(reading.pageFound).toBe(false);
      expect(reading.failure?.startsWith(`${READ_FAILURE.notFound}:`)).toBe(
        true,
      );
      expect(reading.inStock).toBeNull();
      expect(reading.priceCents).toBeNull();
    }
  });

  it("CONTROL: every other status, and none at all, stays a failed fetch", async () => {
    for (const status of [400, 403, 429, 500, 503]) {
      const clock = new Clock();
      const url = NEWEGG_LISTINGS[0].url;
      const reading = failureOf(
        await readListing(
          NEWEGG_LISTINGS[0],
          neweggAdapter,
          new ScriptedFetcher(NEWEGG_PAGES, clock, new Map([[url, status]])),
          clock.now,
        ),
      );
      expect(reading.failure.startsWith(`${READ_FAILURE.fetchFailed}:`)).toBe(
        true,
      );
    }
    // A failure the vendor gave no status for — a dropped connection.
    const noStatus: Fetcher = {
      liveRequestCount: 0,
      fetch: (url) => Promise.reject(new FetchFailed(url, new Error("reset"))),
    };
    const reading = failureOf(
      await readListing(
        NEWEGG_LISTINGS[0],
        neweggAdapter,
        noStatus,
        () => new Date(),
      ),
    );
    expect(reading.failure.startsWith(`${READ_FAILURE.fetchFailed}:`)).toBe(
      true,
    );
  });

  it("🔴 reports a body that is not a product page as a failure with its reason", async () => {
    const clock = new Clock();
    const url = NEWEGG_LISTINGS[0].url;
    const fetcher = new ScriptedFetcher(
      new Map([[url, PAGES.neweggSearch]]),
      clock,
    );
    const reading = failureOf(
      await readListing(NEWEGG_LISTINGS[0], neweggAdapter, fetcher, clock.now),
    );
    expect(reading.failure.startsWith(`${READ_FAILURE.notAProductPage}:`)).toBe(
      true,
    );
    expect(reading.pageFound).toBeNull();
    expect(reading.inStock).toBeNull();
    expect(reading.priceCents).toBeNull();
  });

  it("🔴 reports an offer it cannot read as a failure with its own reason", async () => {
    const clock = new Clock();
    const url = "https://www.amazon.com/dp/B0BFGB2D2Z";
    const reading = failureOf(
      await readListing(
        { itemId: "B0BFGB2D2Z", url },
        amazonAdapter,
        new ScriptedFetcher(
          new Map([[url, amazonWithFirstOption(noPrice)]]),
          clock,
        ),
        clock.now,
      ),
    );
    expect(reading.failure.startsWith(`${READ_FAILURE.unreadableOffer}:`)).toBe(
      true,
    );
  });

  it("🔴 takes the read time from when the page arrived, not after the cache write and jitter", async () => {
    const clock = new Clock();
    const fetcher = new ScriptedFetcher(NEWEGG_PAGES, clock);
    const reading = await readListing(
      NEWEGG_LISTINGS[0],
      neweggAdapter,
      fetcher,
      clock.now,
    );
    expect(reading.readAt).toBe(
      fetcher.completedAt.get(NEWEGG_LISTINGS[0].url),
    );
    // The clock ran on by five seconds before the page was handed back.
    expect(clock.now().toISOString()).not.toBe(reading.readAt);
  });

  it("refuses to file a corpus gap as a failed reading", async () => {
    // During a replay a missing page is a defect in the test data, not a
    // simulated outage — the same rule the resolution path follows.
    const replay = new ReplayFetcher({ entries: [] });
    await expect(
      readListing(NEWEGG_LISTINGS[0], neweggAdapter, replay, () => new Date()),
    ).rejects.toBeInstanceOf(NotInCorpus);
  });
});

// ── The live fetcher, as read mode uses it ──────────────────────────────

describe("the live fetcher, for a read", () => {
  let cacheDir: string;
  /** One attempt, so a failure costs no backoff; jitter set per test. */
  const options = (
    overrides: { serveFromCache?: boolean; jitterMs?: number } = {},
  ) => ({
    ...LIVE_DEFAULTS,
    apiKey: "k",
    zone: "z",
    cacheDir,
    attempts: 1,
    delayMinMs: overrides.jitterMs ?? 0,
    delayMaxMs: overrides.jitterMs ?? 0,
    serveFromCache: overrides.serveFromCache ?? true,
  });
  const respond = (status: number, body: string): Response =>
    new Response(body, { status });
  const PAGE = "<html>" + "x".repeat(LIVE_DEFAULTS.minBodyBytes) + "</html>";

  beforeEach(() => {
    cacheDir = mkdtempSync(path.join(os.tmpdir(), "read-live-spec-"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("🔴 never serves a read from the disk cache", async () => {
    const vendor = vi.fn(() => Promise.resolve(respond(200, PAGE)));
    vi.stubGlobal("fetch", vendor);
    // A resolution run bought the page earlier and cached it.
    await new LiveFetcher(options()).fetch("https://www.newegg.com/p/A");
    expect(vendor).toHaveBeenCalledTimes(1);

    const fresh = new LiveFetcher(options({ serveFromCache: false }));
    const result = await fresh.fetch("https://www.newegg.com/p/A");
    expect(result.cached).toBe(false);
    expect(vendor).toHaveBeenCalledTimes(2);
    expect(fresh.liveRequestCount).toBe(1);
  });

  it("CONTROL: the default still serves the cache, as resolution relies on", async () => {
    const vendor = vi.fn(() => Promise.resolve(respond(200, PAGE)));
    vi.stubGlobal("fetch", vendor);
    await new LiveFetcher(options()).fetch("https://www.newegg.com/p/A");
    const again = await new LiveFetcher(options()).fetch(
      "https://www.newegg.com/p/A",
    );
    expect(again.cached).toBe(true);
    expect(vendor).toHaveBeenCalledTimes(1);
  });

  it("🔴 stamps when the page arrived, before the cache write and the jitter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(respond(200, PAGE))),
    );
    const before = Date.now();
    const result = await new LiveFetcher(
      options({ serveFromCache: false, jitterMs: 60 }),
    ).fetch("https://www.newegg.com/p/A");
    const handedBack = Date.now();
    const fetchedAt = result.fetchedAt?.getTime() ?? Number.NaN;
    expect(fetchedAt).toBeGreaterThanOrEqual(before);
    // Sixty milliseconds of jitter ran after the stamp, not before it.
    expect(handedBack - fetchedAt).toBeGreaterThanOrEqual(45);
  });

  it("🔴 carries the status the vendor relayed on a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(respond(404, "gone"))),
    );
    const failure = await new LiveFetcher(options())
      .fetch("https://www.newegg.com/p/A")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FetchFailed);
    expect(failure instanceof FetchFailed ? failure.status : "none").toBe(404);
  });

  it("CONTROL: a short 200 and a dropped connection carry no 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(respond(200, ""))),
    );
    const throttled = await new LiveFetcher(options())
      .fetch("https://www.newegg.com/p/A")
      .catch((error: unknown) => error);
    expect(throttled instanceof FetchFailed ? throttled.status : "none").toBe(
      200,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("reset"))),
    );
    const dropped = await new LiveFetcher(options())
      .fetch("https://www.newegg.com/p/B")
      .catch((error: unknown) => error);
    expect(dropped instanceof FetchFailed ? dropped.status : "none").toBeNull();
  });

  it("🔴 takes the status from the LAST attempt, not an earlier one", async () => {
    // A 404 followed by a dropped connection is a dropped connection: the
    // page was not shown to be gone by the attempt that settled it.
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        call++ === 0
          ? Promise.resolve(respond(404, "gone"))
          : Promise.reject(new Error("reset")),
      ),
    );
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn) => {
      fn();
      // A real handle of the right type, cleared at once so nothing lingers.
      const handle = setInterval(() => undefined, 1_000_000);
      clearInterval(handle);
      return handle;
    });
    const failure = await new LiveFetcher({ ...options(), attempts: 2 })
      .fetch("https://www.newegg.com/p/A")
      .catch((error: unknown) => error);
    expect(failure instanceof FetchFailed ? failure.status : "none").toBeNull();
  });

  it("🔴 a read run's live fetcher is built with the cache off", () => {
    vi.stubEnv("BRIGHTDATA_API_KEY", "k");
    vi.stubEnv("BRIGHTDATA_UNLOCKER_ZONE", "z");
    const fetcher = readFetcherFromEnv({});
    expect(fetcher).toBeInstanceOf(LiveFetcher);
    expect(
      fetcher instanceof LiveFetcher ? fetcher.servesFromCache : "not live",
    ).toBe(false);
  });

  it("CONTROL: a read run that names a corpus replays it", () => {
    const corpus = path.join(cacheDir, "corpus.json");
    writeFileSync(corpus, JSON.stringify({ entries: [] }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readFetcherFromEnv({ [REPLAY_CORPUS_ENV]: corpus })).toBeInstanceOf(
      ReplayFetcher,
    );
  });
});

describe("a read job", () => {
  it("reads the committed pages through the replay fetcher, buying nothing", async () => {
    const replay = new ReplayFetcher({
      entries: NEWEGG_LISTINGS.map((l) => ({
        url: l.url,
        body: NEWEGG_PAGES.get(l.url) ?? "",
      })),
    });
    const port = new RecordingPort(neweggJob());
    const result = await runReadJob({
      client: port,
      readerFor: readers,
      fetcher: replay,
      log: quiet,
    });
    expect(result.stoppedEarly).toBe(false);
    expect(replay.unusedEntryCount).toBe(0);
    expect(port.delivered.map((r) => [r.itemId, r.barcode])).toEqual([
      ["N82E16886949047", "065030870382"],
      ["1W7-00T2-01021", "5028551561707"],
      ["N82E16826197074", "00097855114693"],
      ["2VR-0680-00002", ""],
    ]);
    expect(port.sent.at(-1)).toEqual({
      type: "completed",
      readings: [],
      requestsSpent: 0,
      message: null,
    });
  });

  it("🔴 fetches each listing exactly once — no search, no probe, no retry", async () => {
    const clock = new Clock();
    // One listing fails: a failure must not be retried by the read either.
    const pages = new Map(NEWEGG_PAGES);
    pages.delete(NEWEGG_LISTINGS[1].url);
    const fetcher = new ScriptedFetcher(pages, clock);
    const port = new RecordingPort(neweggJob());
    await runReadJob({
      client: port,
      readerFor: readers,
      fetcher,
      now: clock.now,
      concurrency: 3,
      log: quiet,
    });
    expect([...fetcher.calls].sort()).toEqual(
      NEWEGG_LISTINGS.map((l) => l.url).sort(),
    );
    // And each listing is reported exactly once.
    expect(port.delivered.map((r) => r.itemId).sort()).toEqual(
      NEWEGG_LISTINGS.map((l) => l.itemId).sort(),
    );
  });

  it("CONTROL: with more workers than listings, still one fetch each", async () => {
    const clock = new Clock();
    const fetcher = new ScriptedFetcher(NEWEGG_PAGES, clock);
    const port = new RecordingPort(neweggJob(NEWEGG_LISTINGS.slice(0, 2)));
    await runReadJob({
      client: port,
      readerFor: readers,
      fetcher,
      now: clock.now,
      concurrency: 8,
      log: quiet,
    });
    expect(fetcher.calls).toHaveLength(2);
    expect(new Set(fetcher.calls).size).toBe(2);
  });

  it("🔴 files a failed fetch as a failed reading and still completes", async () => {
    const clock = new Clock();
    const pages = new Map(NEWEGG_PAGES);
    pages.delete(NEWEGG_LISTINGS[1].url);
    const port = new RecordingPort(neweggJob());
    await runReadJob({
      client: port,
      readerFor: readers,
      fetcher: new ScriptedFetcher(pages, clock),
      now: clock.now,
      log: quiet,
    });
    const failed = failureOf(
      port.delivered.find((r) => r.itemId === NEWEGG_LISTINGS[1].itemId),
    );
    expect(failed.failure.startsWith(`${READ_FAILURE.fetchFailed}:`)).toBe(
      true,
    );
    // The others are pages, untouched by their neighbour's failure.
    expect(
      pageOf(port.delivered.find((r) => r.itemId === NEWEGG_LISTINGS[0].itemId))
        .priceCents,
    ).toBe(7126);
    expect(port.sent.at(-1)?.type).toBe("completed");
  });

  it("🔴 stamps each reading with when its page was read, not when the job began or was reported", async () => {
    const clock = new Clock();
    const startedAt = clock.now().toISOString();
    const fetcher = new ScriptedFetcher(NEWEGG_PAGES, clock);
    const port = new RecordingPort(neweggJob());
    await runReadJob({
      client: port,
      readerFor: readers,
      fetcher,
      now: clock.now,
      concurrency: 1,
      log: quiet,
    });
    const readAts = port.delivered.map((r) => r.readAt);
    for (const reading of port.delivered) {
      const listing = NEWEGG_LISTINGS.find((l) => l.itemId === reading.itemId);
      expect(reading.readAt).toBe(fetcher.completedAt.get(listing?.url ?? ""));
      expect(reading.readAt).not.toBe(startedAt);
    }
    // Four pages, read a minute apart: four different times.
    expect(new Set(readAts).size).toBe(4);
  });

  it("🔴 carries the run's cost on every batch and on the end of the run", async () => {
    const clock = new Clock();
    const pages = new Map(NEWEGG_PAGES);
    pages.delete(NEWEGG_LISTINGS[3].url);
    const fetcher = new ScriptedFetcher(pages, clock);
    const port = new RecordingPort(neweggJob());
    const result = await runReadJob({
      client: port,
      readerFor: readers,
      fetcher,
      now: clock.now,
      concurrency: 1,
      flushAt: 2,
      log: quiet,
    });
    // Three pages bought, one failed: a failed fetch is not a purchase.
    expect(result.liveRequests).toBe(3);
    expect(
      port.sent.map((s) => [s.type, s.readings.length, s.requestsSpent]),
    ).toEqual([
      ["readings", 2, 2],
      ["readings", 2, 3],
      ["completed", 0, 3],
    ]);
  });

  it("never sends a batch larger than the gateway accepts", async () => {
    const many = Array.from({ length: MAX_READINGS_PER_EVENT + 7 }, (_, i) => ({
      itemId: `item-${i}`,
      url: `https://www.newegg.com/p/item-${i}`,
    }));
    const pages = new Map(many.map((l) => [l.url, PAGES.barcode12]));
    const clock = new Clock();
    const port = new RecordingPort(neweggJob(many));
    await runReadJob({
      client: port,
      readerFor: readers,
      fetcher: new ScriptedFetcher(pages, clock),
      now: clock.now,
      flushAt: 10_000,
      log: quiet,
    });
    const batches = port.sent.filter((s) => s.type === "readings");
    for (const b of batches) {
      expect(b.readings.length).toBeLessThanOrEqual(MAX_READINGS_PER_EVENT);
    }
    expect(port.delivered).toHaveLength(many.length);
  });

  it("stops buying pages once the gateway says the read run is gone", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      itemId: `item-${i}`,
      url: `https://www.newegg.com/p/item-${i}`,
    }));
    const pages = new Map(many.map((l) => [l.url, PAGES.barcode12]));
    const clock = new Clock();
    const fetcher = new ScriptedFetcher(pages, clock);
    const port = new RecordingPort(neweggJob(many));
    port.answerReadings = () => ({ kind: "run-gone", detail: "ended" });
    const result = await runReadJob({
      client: port,
      readerFor: readers,
      fetcher,
      now: clock.now,
      concurrency: 1,
      flushAt: 2,
      log: quiet,
    });
    expect(result.stoppedEarly).toBe(true);
    expect(fetcher.calls.length).toBeLessThan(many.length);
    // Not a completion, and not an error: the gateway already knows.
    expect(port.sent.some((s) => s.type !== "readings")).toBe(false);
  });

  it("ends in error, not completed, when readings could not be delivered", async () => {
    const clock = new Clock();
    const port = new RecordingPort(neweggJob());
    port.answerReadings = () => ({
      kind: "refused",
      status: 400,
      detail: "bad shape",
    });
    const result = await runReadJob({
      client: port,
      readerFor: readers,
      fetcher: new ScriptedFetcher(NEWEGG_PAGES, clock),
      now: clock.now,
      log: quiet,
    });
    expect(result.undelivered).toBe(4);
    const last = port.sent.at(-1);
    expect(last?.type).toBe("error");
    expect(last?.message).toContain("4");
    expect(last?.requestsSpent).toBe(4);
  });

  it("reports a crash as an error carrying what was spent, then rethrows", async () => {
    const clock = new Clock();
    const port = new RecordingPort({ ...neweggJob(), retailerSlug: "nowhere" });
    await expect(
      runReadJob({
        client: port,
        readerFor: readers,
        fetcher: new ScriptedFetcher(NEWEGG_PAGES, clock),
        now: clock.now,
        log: quiet,
      }),
    ).rejects.toThrow(/nowhere/);
    expect(
      port.sent.map((s) => [s.type, s.readings.length, s.requestsSpent]),
    ).toEqual([["error", 0, 0]]);
    expect(port.sent[0]?.message).toContain("nowhere");
  });

  it("🔴 refuses a listing on another host before buying anything", async () => {
    for (const url of [
      "https://evil.example/p/A",
      "https://www.newegg.com.evil.example/p/A",
      "https://www.amazon.com/dp/B0BFGB2D2Z",
    ]) {
      const clock = new Clock();
      const fetcher = new ScriptedFetcher(NEWEGG_PAGES, clock);
      const port = new RecordingPort(
        neweggJob([...NEWEGG_LISTINGS, { itemId: "X", url }]),
      );
      await expect(
        runReadJob({
          client: port,
          readerFor: readers,
          fetcher,
          now: clock.now,
          log: quiet,
        }),
      ).rejects.toThrow(/host/);
      // Refused whole, before a single page was bought.
      expect(fetcher.calls).toEqual([]);
      expect(port.sent.map((s) => s.type)).toEqual(["error"]);
    }
  });

  it("CONTROL: the bare retailer host is accepted", async () => {
    const clock = new Clock();
    const url = "https://newegg.com/p/N82E16886949047";
    const fetcher = new ScriptedFetcher(
      new Map([[url, PAGES.barcode12]]),
      clock,
    );
    const port = new RecordingPort(
      neweggJob([{ itemId: "N82E16886949047", url }]),
    );
    await runReadJob({
      client: port,
      readerFor: readers,
      fetcher,
      now: clock.now,
      log: quiet,
    });
    expect(fetcher.calls).toEqual([url]);
  });

  it("reads an Amazon listing through the same path", async () => {
    const clock = new Clock();
    const url = "https://www.amazon.com/dp/B0BFGB2D2Z";
    const port = new RecordingPort({
      readRunId: "66666666-6666-4666-8666-666666666666",
      retailerSlug: "amazon",
      listings: [{ itemId: "B0BFGB2D2Z", url }],
    });
    await runReadJob({
      client: port,
      readerFor: readers,
      fetcher: new ScriptedFetcher(new Map([[url, PAGES.amazon]]), clock),
      now: clock.now,
      log: quiet,
    });
    expect(pageOf(port.delivered[0]).priceCents).toBe(47200);
  });
});

// ── The gateway seam ────────────────────────────────────────────────────

interface Captured {
  readonly url: string;
  readonly method: string;
  readonly auth: string | null;
  readonly body: Record<string, unknown> | null;
}

function recordingFetch(answer: (n: number) => Response): {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const text = typeof init?.body === "string" ? init.body : null;
    const parsed: unknown = text === null ? null : JSON.parse(text);
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? "GET",
      auth: headers.get("Authorization"),
      body:
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? Object.fromEntries(Object.entries(parsed))
          : null,
    });
    return Promise.resolve(answer(calls.length - 1));
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const CREDS = {
  baseUrl: "http://gateway.local",
  user: "ci",
  password: "secret",
};
const READ_RUN_ID = "55555555-5555-4555-8555-555555555555";
const noSleep = (): Promise<void> => Promise.resolve();

describe("the read run's gateway client", () => {
  it("fetches the job from the read route, with Basic auth", async () => {
    const { fetch, calls } = recordingFetch(() =>
      json({
        retailerSlug: "newegg",
        listings: [{ itemId: "A", url: "https://www.newegg.com/p/A" }],
      }),
    );
    const client = new ReadRunClient(CREDS, READ_RUN_ID, { fetch });
    const job = await client.fetchJob();
    expect(calls[0]?.url).toBe(
      `http://gateway.local/runtime/insights/reads/${READ_RUN_ID}`,
    );
    expect(calls[0]?.auth).toBe(
      `Basic ${Buffer.from("ci:secret").toString("base64")}`,
    );
    expect(job).toEqual({
      readRunId: READ_RUN_ID,
      retailerSlug: "newegg",
      listings: [{ itemId: "A", url: "https://www.newegg.com/p/A" }],
    });
  });

  it("treats a 404 on the job as the read run having ended", async () => {
    const { fetch } = recordingFetch(() => json({}, 404));
    const client = new ReadRunClient(CREDS, READ_RUN_ID, { fetch });
    await expect(client.fetchJob()).rejects.toBeInstanceOf(ReadRunGone);
  });

  it("🔴 posts readings with the counter and no tenant, organization or list", async () => {
    const { fetch, calls } = recordingFetch(() => json({ applied: 1 }));
    const client = new ReadRunClient(CREDS, READ_RUN_ID, {
      fetch,
      sleep: noSleep,
    });
    const reading: ListingReading = {
      itemId: "A",
      pageItemId: "A",
      readAt: "2026-10-23T06:23:00.000Z",
      pageFound: true,
      barcode: "065030870382",
      additionalBarcodes: [],
      priceCents: 7126,
      inStock: true,
      failure: null,
    };
    expect(await client.reportReadings([reading], 7)).toEqual({
      kind: "applied",
    });
    expect(await client.reportCompleted(9)).toEqual({ kind: "applied" });
    expect(await client.reportError("boom", 9)).toEqual({ kind: "applied" });

    for (const call of calls) {
      expect(call.url).toBe(
        `http://gateway.local/runtime/insights/reads/${READ_RUN_ID}/events`,
      );
      expect(call.method).toBe("POST");
      const keys = Object.keys(call.body ?? {});
      for (const forbidden of [
        "tenant_id",
        "organization_id",
        "watchlist_id",
        "resolution_run_id",
      ]) {
        expect(keys).not.toContain(forbidden);
      }
      expect(keys).toContain("runtime_version");
    }
    expect(calls[0]?.body).toMatchObject({
      type: "readings",
      requests_spent: 7,
      readings: [reading],
    });
    expect(calls[1]?.body).toMatchObject({
      type: "completed",
      requests_spent: 9,
    });
    expect(calls[2]?.body).toMatchObject({
      type: "error",
      requests_spent: 9,
      message: "boom",
    });
  });

  it("retries a 5xx, refuses a 4xx, and reads 404 as the run gone", async () => {
    const retried = recordingFetch((n) => (n < 2 ? json({}, 503) : json({})));
    const client = new ReadRunClient(CREDS, READ_RUN_ID, {
      fetch: retried.fetch,
      sleep: noSleep,
    });
    expect(await client.reportCompleted(1)).toEqual({ kind: "applied" });
    expect(retried.calls).toHaveLength(3);

    const refused = recordingFetch(() => json({ message: "no" }, 400));
    const refusing = new ReadRunClient(CREDS, READ_RUN_ID, {
      fetch: refused.fetch,
      sleep: noSleep,
    });
    expect((await refusing.reportCompleted(1)).kind).toBe("refused");
    expect(refused.calls).toHaveLength(1);

    const gone = recordingFetch(() => json({}, 404));
    const ended = new ReadRunClient(CREDS, READ_RUN_ID, {
      fetch: gone.fetch,
      sleep: noSleep,
    });
    expect((await ended.reportCompleted(1)).kind).toBe("run-gone");
  });

  it("refuses a batch over the gateway's cap rather than send it", async () => {
    const { fetch, calls } = recordingFetch(() => json({}));
    const client = new ReadRunClient(CREDS, READ_RUN_ID, { fetch });
    const reading: ListingReading = {
      itemId: "A",
      pageItemId: null,
      readAt: "2026-10-23T06:23:00.000Z",
      pageFound: null,
      barcode: null,
      additionalBarcodes: [],
      priceCents: null,
      inStock: null,
      failure: `${READ_FAILURE.fetchFailed}: x`,
    };
    await expect(
      client.reportReadings(
        Array.from({ length: MAX_READINGS_PER_EVENT + 1 }, () => reading),
        0,
      ),
    ).rejects.toThrow(/at most/);
    expect(calls).toHaveLength(0);
  });
});

describe("the read job, as the gateway serves it", () => {
  const listing = { itemId: "A", url: "https://www.newegg.com/p/A" };

  it("refuses a job naming no retailer, or carrying no listings", () => {
    expect(() => parseReadJob({ listings: [listing] }, READ_RUN_ID)).toThrow(
      /retailer/,
    );
    expect(() => parseReadJob({ retailerSlug: "newegg" }, READ_RUN_ID)).toThrow(
      /listings/,
    );
    expect(() =>
      parseReadJob({ retailerSlug: "newegg", listings: [] }, READ_RUN_ID),
    ).toThrow(/no listings/);
    expect(() => parseReadJob(null, READ_RUN_ID)).toThrow(/not an object/);
  });

  it("refuses a listing with no id or no fetchable url", () => {
    for (const bad of [
      { url: listing.url },
      { itemId: "", url: listing.url },
      { itemId: "A" },
      { itemId: "A", url: "javascript:alert(1)" },
      { itemId: "A", url: "http://www.newegg.com/p/A" },
      { itemId: "A", url: "https://user:pw@www.newegg.com/p/A" },
      { itemId: "A", url: "https://www.newegg.com:8443/p/A" },
      { itemId: "A", url: "https://" },
      "A",
    ]) {
      expect(() =>
        parseReadJob({ retailerSlug: "newegg", listings: [bad] }, READ_RUN_ID),
      ).toThrow(/listing 0/);
    }
  });

  it("🔴 refuses a job that lists one listing twice, rather than pay for it twice", () => {
    expect(() =>
      parseReadJob(
        { retailerSlug: "newegg", listings: [listing, { ...listing }] },
        READ_RUN_ID,
      ),
    ).toThrow(/twice/);
    expect(() =>
      parseReadJob(
        {
          retailerSlug: "newegg",
          listings: [listing, { itemId: "B", url: listing.url }],
        },
        READ_RUN_ID,
      ),
    ).toThrow(/twice/);
  });
});

describe("which mode a dispatched container runs in", () => {
  const RESOLUTION = {
    resolution_run_id: "11111111-1111-4111-8111-111111111111",
    tenant_id: "22222222-2222-4222-8222-222222222222",
    organization_id: "33333333-3333-4333-8333-333333333333",
    watchlist_id: "44444444-4444-4444-8444-444444444444",
    retailer_slug: "newegg",
    items_total: 20,
  };
  const READ = { listing_read_run_id: READ_RUN_ID };

  it("a resolution run id selects resolution mode, with its fields unchanged", () => {
    const dispatch = queueDispatchFromPayload(RESOLUTION);
    expect(dispatch).toEqual({
      mode: "resolution",
      resolution: {
        resolutionRunId: RESOLUTION.resolution_run_id,
        tenantId: RESOLUTION.tenant_id,
        organizationId: RESOLUTION.organization_id,
        watchlistId: RESOLUTION.watchlist_id,
        retailerSlug: "newegg",
        itemsTotal: 20,
      },
    });
  });

  it("a listing read run id selects read mode", () => {
    expect(queueDispatchFromPayload(READ)).toEqual({
      mode: "read",
      read: { listingReadRunId: READ_RUN_ID },
    });
  });

  it("🔴 refuses a payload carrying both, or neither", () => {
    expect(() => queueDispatchFromPayload({ ...RESOLUTION, ...READ })).toThrow(
      BootstrapError,
    );
    expect(() => queueDispatchFromPayload({ ...RESOLUTION, ...READ })).toThrow(
      /both/,
    );
    expect(() => queueDispatchFromPayload({ retailer_slug: "newegg" })).toThrow(
      /listing_read_run_id[\s\S]*resolution_run_id|resolution_run_id[\s\S]*listing_read_run_id/,
    );
    expect(() => queueDispatchFromPayload(null)).toThrow(/no object payload/);
  });

  it("🔴 refuses a read payload that names a tenant, an organization or a list", () => {
    for (const key of ["tenant_id", "organization_id", "watchlist_id"]) {
      expect(() => queueDispatchFromPayload({ ...READ, [key]: "x" })).toThrow(
        new RegExp(key),
      );
    }
  });

  it("refuses an empty read run id", () => {
    expect(() => queueDispatchFromPayload({ listing_read_run_id: "" })).toThrow(
      BootstrapError,
    );
  });
});
