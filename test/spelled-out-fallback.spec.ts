import { describe, expect, it } from "vitest";

import type {
  ParsedCandidate,
  RetailerAdapter,
} from "../src/adapters/types.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchResult,
} from "../src/fetcher/types.js";
import { DEFAULT_OPTIONS, resolveItem } from "../src/resolve.js";

/**
 * 🔴 **The spelled-out name is a fallback, and a fallback costs nothing when
 * the first answer was enough.** 220 of Micro Center's 227 names differ when
 * spelled out, so asking both on every row would add about 220 paid searches
 * per retailer per run. It is asked only after the name as written was
 * ANSWERED with an empty results page — never after a failed fetch or a page
 * that was not a results page, which say nothing about the name.
 */

const NAME = "MAG X870E TOMAHAWK MAX WF";
const SPELLED_OUT = "MSI MAG X870E TOMAHAWK MAX WIFI";
/** An EAN-13 too long for a UPC-A: it derives no item reference to search. */
const BARCODE = "4006381333931";
const SERP = `https://www.google.com/search?q=%22${BARCODE}%22`;

const SEARCH_PREFIX = "https://retailer.test/s?q=";
const searchUrl = (q: string): string =>
  `${SEARCH_PREFIX}${encodeURIComponent(q)}`;

const listing: ParsedCandidate = {
  itemId: "N82E1",
  url: "https://retailer.test/p/N82E1",
  model: null,
  title: "MSI MAG X870E TOMAHAWK MAX WIFI AM5 ATX Motherboard",
  brand: "MSI",
  priceCents: 29999,
  inStock: true,
  isFirstParty: true,
  sellerName: null,
  imageUrl: null,
  partialMatch: false,
};

/** How each search answers: candidates, `null` for not a results page, or a failed fetch. */
type Answer = ParsedCandidate[] | null | "fails";

/**
 * A retailer whose every search answers an empty results page unless the
 * test says otherwise. The search page's body is the query itself, so the
 * parser knows which one it is reading.
 */
const retailer = (answers: Record<string, Answer>) => {
  const searched: string[] = [];
  let serpBody: string | null = null;
  const adapter: RetailerAdapter = {
    slug: "fake",
    querySupport: {
      maxNumericQueryDigits: 9,
      barcodeIsSearchable: false,
      partNumberNeedsBrand: false,
    },
    pacing: { pagesAtOnce: 3 },
    fetchProfile: { country: null, timeoutMs: null },
    maxProbes: null,
    productIndex: null,
    hosts: ["retailer.test"],
    buildSearchUrl: searchUrl,
    parseSearchResults: (body) => {
      const answer = answers[body];
      return answer === undefined || answer === "fails" ? [] : answer;
    },
    parseProductPage: () => null,
  };
  const fetcher: Fetcher = {
    liveRequestCount: 0,
    pagesDelivered: 0,
    fetch(url: string): Promise<FetchResult> {
      if (url.startsWith(SEARCH_PREFIX)) {
        const query = decodeURIComponent(url.slice(SEARCH_PREFIX.length));
        searched.push(query);
        if (answers[query] === "fails")
          return Promise.reject(new FetchFailed(url, undefined, 502, 3));
        return Promise.resolve({
          url,
          body: query,
          cached: false,
          attempts: 1,
        });
      }
      if (url === SERP && serpBody !== null)
        return Promise.resolve({
          url,
          body: serpBody,
          cached: false,
          attempts: 1,
        });
      return Promise.reject(new FetchFailed(url, undefined, 502, 3));
    },
  };
  return {
    adapter,
    fetcher,
    searched,
    /** Make the barcode's search-engine page infer part numbers. */
    serp: (body: string) => {
      serpBody = body;
    },
  };
};

const resolve = (
  r: ReturnType<typeof retailer>,
  partNumber: string | null = null,
) =>
  resolveItem(
    {
      barcode: BARCODE,
      clientSku: "SKU-1",
      brand: "MSI",
      partNumber,
      productName: NAME,
    },
    r.adapter,
    r.fetcher,
    DEFAULT_OPTIONS,
  );

describe("🔴 the spelled-out name is asked only when the name as written found nothing", () => {
  it("is NOT asked when the name as written found a listing — one request fewer", async () => {
    const r = retailer({ [NAME]: [listing] });
    await resolve(r);
    expect(r.searched).toEqual([NAME]);
  });

  it("is asked, after it, when the name as written answered an empty results page", async () => {
    const r = retailer({ [NAME]: [] });
    const result = await resolve(r);
    expect(r.searched).toEqual([NAME, SPELLED_OUT]);
    expect(result.queriesTried).toEqual([NAME, SPELLED_OUT]);
  });

  it("is NOT asked when the name as written could not be fetched", async () => {
    const r = retailer({ [NAME]: "fails" });
    await resolve(r);
    expect(r.searched).toEqual([NAME]);
  });

  it("is NOT asked when the name as written answered something that was not a results page", async () => {
    const r = retailer({ [NAME]: null });
    await resolve(r);
    expect(r.searched).toEqual([NAME]);
  });

  it("finds the listing the name as written could not", async () => {
    const r = retailer({ [NAME]: [], [SPELLED_OUT]: [listing] });
    const result = await resolve(r);
    expect(result.candidatesSeen).toBe(1);
  });
});

describe("🔴 keyed on the CLIENT's part number, not on what was inferred", () => {
  it("never asks it for a row whose client supplied a part number", async () => {
    // Every search answers empty, so only the client's part number keeps it
    // off — and this is what goes red if resolve stops handing it over.
    const r = retailer({});
    await resolve(r, "7E59-001R");
    expect(r.searched).toContain(NAME);
    expect(r.searched).not.toContain(SPELLED_OUT);
  });

  it("still asks it where the part numbers were only inferred from the barcode's search page", async () => {
    // The `HTTPS` case: the search engine's page yields candidates that are
    // not the product's part number at all.
    const r = retailer({});
    r.serp(
      "<h3>MSI ZQ-9000 Board</h3><h3>MSI ZQ-9000</h3><p>ZQ-9000 ZQ-9000</p>",
    );
    const result = await resolve(r);
    expect(result.queriesTried.some((q) => q.includes("ZQ-9000"))).toBe(true);
    expect(r.searched).toContain(SPELLED_OUT);
    expect(r.searched.indexOf(SPELLED_OUT)).toBeGreaterThan(
      r.searched.indexOf(NAME),
    );
  });
});
