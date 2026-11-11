import type {
  ParsedCandidate,
  ParsedProduct,
  RetailerAdapter,
} from "../src/adapters/types.js";
import type { Fetcher, FetchResult } from "../src/fetcher/types.js";
import type { DispatchPayload } from "../src/queue/task-record.js";
import type { FakeClock } from "./fake-clock.js";
import { typesOf } from "./gateway-double.js";

/**
 * A retailer, a fetcher and a dispatch for checks that drive the real
 * `runList` through `runDispatchedJob`: a fake retailer whose every search
 * yields one probeable candidate, and a fetcher a check can script — fail,
 * hold a page in flight on a fake clock, or act as a page is asked for.
 */

export const DISPATCH: DispatchPayload = {
  resolutionRunId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  organizationId: "33333333-3333-4333-8333-333333333333",
  watchlistId: "44444444-4444-4444-8444-444444444444",
  retailerSlug: "fake",
  itemsTotal: null,
};

const SERP_BODY = `<h3>Kingwin CF-08LB Fan</h3><h3>Kingwin CF-08LB 80mm</h3><p>CF-08LB CF-08LB</p>`;

/** A retailer whose every search yields one probeable candidate. */
export const ADAPTER: RetailerAdapter = {
  slug: "fake",
  querySupport: {
    maxNumericQueryDigits: 9,
    barcodeIsSearchable: false,
    partNumberNeedsBrand: false,
  },
  pacing: { pagesAtOnce: 1 },
  fetchProfile: { country: null, timeoutMs: null },
  maxProbes: null,
  productIndex: null,
  hosts: ["r.test"],
  buildSearchUrl: (q) => `https://r.test/s?q=${encodeURIComponent(q)}`,
  parseSearchResults: (html): ParsedCandidate[] =>
    html.startsWith("SEARCH ")
      ? [
          {
            itemId: "I1",
            url: `https://r.test/p/${encodeURIComponent(html.slice(7))}`,
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
        ]
      : [],
  parseProductPage: (): ParsedProduct => ({
    barcode: null,
    additionalBarcodes: [],
    priceCents: 899,
    inStock: true,
    title: "Kingwin CF-08LB 80mm Fan",
    sellerName: null,
    isFirstParty: null,
    unverifiableReason: null,
  }),
};

/** What a `ScriptedFetcher` does, by the number of the fetch (from 1). */
export interface FetchScript {
  /**
   * Refuse this many fetches first — with a plain error, which is the
   * pipeline not completing, so the item is deferred to the retry pass.
   */
  readonly failFirst?: number | undefined;
  /** Called as each fetch starts: a check moves the clock or asks for a stop here. */
  readonly onFetch?: ((fetchNumber: number) => void) | undefined;
  /** Hold the page this long on `clock` before answering, or for ever. */
  readonly holdFor?: ((fetchNumber: number) => number | "forever") | undefined;
  readonly clock?: FakeClock | undefined;
}

/** Serves a body for any url and counts what it sold. */
export class ScriptedFetcher implements Fetcher {
  liveRequestCount = 0;
  fetches = 0;
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  constructor(private readonly script: FetchScript = {}) {}
  fetch(url: string): Promise<FetchResult> {
    const n = ++this.fetches;
    this.script.onFetch?.(n);
    if (n <= (this.script.failFirst ?? 0)) {
      return Promise.reject(new Error(`boom on ${url}`));
    }
    const answer = (): FetchResult => {
      this.liveRequestCount++;
      const body = url.includes("google.com/search")
        ? SERP_BODY
        : url.includes("/s?q=")
          ? `SEARCH ${url}`
          : `PRODUCT ${url}`;
      return { url, body, cached: false, attempts: 1 };
    };
    const hold = this.script.holdFor?.(n) ?? 0;
    if (hold === 0) return Promise.resolve(answer());
    return new Promise<FetchResult>((resolve) => {
      // Never answered: a page stuck in the vendor for good.
      if (hold === "forever") return;
      const clock = this.script.clock;
      if (clock === undefined) throw new Error("a held fetch needs a clock");
      clock.after(hold, () => resolve(answer()));
    });
  }
}

export const barcodeOf = (i: number): string => `81234801054${i}`;

/**
 * The event types in order, progress left out and a run of findings batches
 * read as one: how many batches a run takes depends on the minute, and what
 * matters here is that every finding comes before the one terminal event.
 */
export const types = (events: readonly Record<string, unknown>[]): unknown[] =>
  typesOf(events).filter(
    (t, i, all) => !(t === "resolutions" && all[i - 1] === "resolutions"),
  );
