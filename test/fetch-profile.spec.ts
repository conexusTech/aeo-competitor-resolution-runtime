import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { amazonAdapter } from "../src/adapters/amazon.js";
import { neweggAdapter } from "../src/adapters/newegg.js";
import type { ListingReader, RetailerAdapter } from "../src/adapters/types.js";
import {
  LiveFetcher,
  LIVE_DEFAULTS,
  type LiveFetcherOptions,
} from "../src/fetcher/live.js";
import { RequestMeter } from "../src/fetcher/meter.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchProfile,
  type FetchResult,
} from "../src/fetcher/types.js";
import type { ReadJob, ReportOutcome } from "../src/gateway/client.js";
import { runReadJob, type ReadRunPort } from "../src/read-run.js";
import { DEFAULT_OPTIONS, resolveItem } from "../src/resolve.js";

/**
 * How a competitor's pages are fetched: a country, and a client timeout.
 *
 * 🔑 **Facts about the retailer, so they are on the adapter** (the lead,
 * 2026-11-10). Newegg and Amazon state the vendor's defaults, and the check
 * that matters most for them is that the request they send is byte for byte
 * what it was before profiles existed.
 */

let cacheDir: string;
const opts = (over: Partial<LiveFetcherOptions> = {}): LiveFetcherOptions => ({
  ...LIVE_DEFAULTS,
  apiKey: "k",
  zone: "z",
  cacheDir,
  delayMinMs: 0,
  delayMaxMs: 0,
  ...over,
});

const PAGE = "x".repeat(5000);
const realSetTimeout = globalThis.setTimeout;

/** Every request the stubbed vendor was sent. */
let sent: RequestInit[];

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(os.tmpdir(), "fetch-profile-"));
  sent = [];
  // The retry backoff runs at once; an abort timer is not this function, so a
  // timeout still takes its real few milliseconds.
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: () => void) => {
    fn();
    return realSetTimeout(() => undefined, 0);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(cacheDir, { recursive: true, force: true });
});

function vendorAnswering(answer: (init: RequestInit) => Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      sent.push(init);
      return answer(init);
    }),
  );
}
const page = (): Promise<Response> =>
  Promise.resolve(new Response(PAGE, { status: 200 }));

/** Never answers; rejects as `fetch` does when its signal aborts. */
const hangs = (init: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    const signal = init.signal;
    if (signal === undefined || signal === null) return;
    signal.addEventListener("abort", () => {
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("aborted"),
      );
    });
  });

describe("the live fetcher sends the profile", () => {
  for (const adapter of [neweggAdapter, amazonAdapter]) {
    it(`🔴 sends ${adapter.slug}'s request byte for byte as before profiles`, async () => {
      vendorAnswering(page);
      const url = `https://www.${adapter.slug}.com/p/X`;
      await new LiveFetcher(opts({ serveFromCache: false })).fetch(
        url,
        adapter.fetchProfile,
      );
      await new LiveFetcher(opts({ serveFromCache: false })).fetch(url);

      const today = `{"zone":"z","url":"${url}","format":"raw"}`;
      expect(sent.map((init) => init.body)).toEqual([today, today]);
      // No signal either: the init is what it was, not only the body.
      expect(sent.every((init) => !("signal" in init))).toBe(true);
    });
  }

  it("states the vendor's defaults for Newegg and Amazon", () => {
    for (const adapter of [neweggAdapter, amazonAdapter]) {
      expect(adapter.fetchProfile).toEqual({ country: null, timeoutMs: null });
    }
  });

  it("adds the country when the profile sets one", async () => {
    vendorAnswering(page);
    const url = "https://shop.test/p/1";
    await new LiveFetcher(opts()).fetch(url, {
      country: "us",
      timeoutMs: null,
    });
    expect(sent[0]?.body).toBe(
      `{"zone":"z","url":"${url}","format":"raw","country":"us"}`,
    );
  });

  it("🔴 abandons an attempt after the profile's timeout, as a failed attempt", async () => {
    vendorAnswering(hangs);
    const fetcher = new LiveFetcher(opts({ attempts: 1 }));
    const error = await fetcher
      .fetch("https://shop.test/p/2", { country: null, timeoutMs: 20 })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(FetchFailed);
    // Counted as a request sent (`resolution-runtime-counts-a-bought-request`).
    expect(error instanceof FetchFailed ? error.attempts : null).toBe(1);
    expect(fetcher.liveRequestCount).toBe(1);
    expect(fetcher.pagesDelivered).toBe(0);
  });

  it("retries a timed-out attempt like any other failure", async () => {
    let n = 0;
    vendorAnswering((init) => (++n === 1 ? hangs(init) : page()));
    const fetcher = new LiveFetcher(opts());

    const result = await fetcher.fetch("https://shop.test/p/3", {
      country: null,
      timeoutMs: 20,
    });

    expect(result.body).toBe(PAGE);
    expect(result.attempts).toBe(2);
    expect(fetcher.liveRequestCount).toBe(2);
  });

  it("🔴 takes a body as short as the profile's own minimum, and only that one", async () => {
    // Costco's sitemap index is a real 1,547-byte file.
    const list = "x".repeat(1547);
    vendorAnswering(() => Promise.resolve(new Response(list, { status: 200 })));
    const url = "https://shop.test/index.xml";
    const result = await new LiveFetcher(opts()).fetch(url, {
      country: "us",
      timeoutMs: null,
      minBodyBytes: 500,
    });
    expect(result.body).toBe(list);
    // Client-side only: the vendor is sent exactly the body it always was.
    expect(sent[0]?.body).toBe(
      `{"zone":"z","url":"${url}","format":"raw","country":"us"}`,
    );

    // CONTROL: the same body for a request that names no minimum is refused.
    const refused = await new LiveFetcher(
      opts({ attempts: 1, serveFromCache: false }),
    )
      .fetch(url, { country: "us", timeoutMs: null })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(refused).toBeInstanceOf(FetchFailed);
  });

  it("the meter hands the profile through", async () => {
    vendorAnswering(page);
    await new RequestMeter(new LiveFetcher(opts())).fetch(
      "https://shop.test/p/4",
      {
        country: "us",
        timeoutMs: null,
      },
    );
    expect(sent[0]?.body).toBe(
      `{"zone":"z","url":"https://shop.test/p/4","format":"raw","country":"us"}`,
    );
  });
});

/** Records which profile each url was fetched with. */
class ProfileRecorder implements Fetcher {
  liveRequestCount = 0;
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  readonly asked: { url: string; profile: FetchProfile | undefined }[] = [];
  constructor(private readonly body: (url: string) => string) {}
  fetch(url: string, profile?: FetchProfile): Promise<FetchResult> {
    this.asked.push({ url, profile });
    this.liveRequestCount++;
    return Promise.resolve({
      url,
      body: this.body(url),
      cached: false,
      attempts: 1,
    });
  }
}

const PROFILE: FetchProfile = { country: "us", timeoutMs: 150_000 };

describe("resolve sends the competitor's profile on competitor pages only", () => {
  const adapter: RetailerAdapter = {
    slug: "fake",
    querySupport: {
      maxNumericQueryDigits: null,
      barcodeIsSearchable: false,
      partNumberNeedsBrand: false,
    },
    pacing: { pagesAtOnce: 3 },
    fetchProfile: PROFILE,
    maxProbes: null,
    productIndex: null,
    hosts: ["r.test"],
    buildSearchUrl: (q) => `https://r.test/s?q=${encodeURIComponent(q)}`,
    parseSearchResults: () => [
      {
        itemId: "I1",
        url: "https://r.test/p/I1",
        model: "CF-08LB",
        title: "Kingwin CF-08LB 80mm Fan",
        brand: "Kingwin",
        priceCents: 899,
        inStock: true,
        isFirstParty: true,
        sellerName: null,
        imageUrl: null,
        partialMatch: false,
      },
    ],
    parseProductPage: () => ({
      barcode: null,
      additionalBarcodes: [],
      priceCents: null,
      inStock: null,
      title: null,
      sellerName: null,
      isFirstParty: null,
      unverifiableReason: null,
    }),
  };

  it("🔑 searches and probes carry it; the catalogue and the search engine do not", async () => {
    const fetcher = new ProfileRecorder((url) =>
      url.includes("google.com")
        ? `<h3>Kingwin CF-08LB Fan</h3><h3>Kingwin CF-08LB 80mm</h3><p>CF-08LB CF-08LB</p>`
        : "<html></html>",
    );
    await resolveItem(
      { barcode: "812348010548", clientSku: "SKU-1" },
      adapter,
      fetcher,
      {
        ...DEFAULT_OPTIONS,
        clientCatalogueUrlTemplate: "https://client.test/p/{sku}",
      },
    );

    const competitor = fetcher.asked.filter((a) =>
      a.url.startsWith("https://r.test/"),
    );
    const other = fetcher.asked.filter(
      (a) => !a.url.startsWith("https://r.test/"),
    );
    // Not vacuous: both kinds were fetched, a search and a probe among them.
    expect(competitor.some((a) => a.url.includes("/s?q="))).toBe(true);
    expect(competitor.some((a) => a.url.includes("/p/I1"))).toBe(true);
    expect(other.map((a) => new URL(a.url).hostname).sort()).toEqual([
      "client.test",
      "www.google.com",
    ]);
    expect(competitor.every((a) => a.profile === PROFILE)).toBe(true);
    expect(other.every((a) => a.profile === undefined)).toBe(true);
  });
});

describe("the read run sends the reader's profile", () => {
  it("on every listing it reads", async () => {
    const reader: ListingReader = {
      slug: "fake",
      hosts: ["r.test"],
      pacing: { pagesAtOnce: 3 },
      fetchProfile: PROFILE,
      readListingPage: () => ({ kind: "not-a-product-page", detail: "test" }),
    };
    const job: ReadJob = {
      readRunId: "read-1",
      retailerSlug: "fake",
      listings: [
        { itemId: "A", url: "https://r.test/p/A" },
        { itemId: "B", url: "https://r.test/p/B" },
      ],
      pagesAtOnce: null,
    };
    const applied = (): Promise<ReportOutcome> =>
      Promise.resolve({ kind: "applied" });
    const port: ReadRunPort = {
      fetchJob: () => Promise.resolve(job),
      reportReadings: applied,
      reportCompleted: applied,
      reportError: applied,
    };
    const fetcher = new ProfileRecorder(() => "<html></html>");

    await runReadJob({
      client: port,
      readerFor: () => reader,
      fetcher,
      log: () => {},
    });

    expect(fetcher.asked).toHaveLength(2);
    expect(fetcher.asked.every((a) => a.profile === PROFILE)).toBe(true);
  });
});

describe("a screenshot is taken with the competitor's profile too", () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  const png = (): Promise<Response> =>
    Promise.resolve(new Response(PNG, { status: 200 }));

  it("🔴 adds the country and a client timeout when the profile sets them", async () => {
    vendorAnswering(png);
    const url = "https://shop.test/p/shot";
    await new LiveFetcher(opts()).fetchScreenshot(url, PROFILE);

    expect(sent[0]?.body).toBe(
      `{"zone":"z","url":"${url}","format":"raw","data_format":"screenshot","country":"us"}`,
    );
    expect(sent[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("abandons a screenshot attempt after the profile's timeout, as a failed attempt", async () => {
    vendorAnswering(hangs);
    const fetcher = new LiveFetcher(opts({ attempts: 1 }));
    const error = await fetcher
      .fetchScreenshot("https://shop.test/p/shot2", {
        country: null,
        timeoutMs: 20,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(FetchFailed);
    expect(error instanceof FetchFailed ? error.attempts : null).toBe(1);
  });

  for (const adapter of [neweggAdapter, amazonAdapter]) {
    it(`CONTROL: ${adapter.slug}'s screenshot request is byte for byte as before profiles`, async () => {
      vendorAnswering(png);
      const url = `https://www.${adapter.slug}.com/p/X`;
      await new LiveFetcher(opts()).fetchScreenshot(url, adapter.fetchProfile);
      await new LiveFetcher(opts()).fetchScreenshot(url);

      const today = `{"zone":"z","url":"${url}","format":"raw","data_format":"screenshot"}`;
      expect(sent.map((init) => init.body)).toEqual([today, today]);
      expect(sent.every((init) => !("signal" in init))).toBe(true);
    });
  }

  it("the meter hands the profile through to a screenshot", async () => {
    vendorAnswering(png);
    const meter = new RequestMeter(new LiveFetcher(opts()));
    await meter.fetchScreenshot?.("https://shop.test/p/shot3", PROFILE);
    expect(sent[0]?.body).toContain(`"country":"us"`);
  });
});
