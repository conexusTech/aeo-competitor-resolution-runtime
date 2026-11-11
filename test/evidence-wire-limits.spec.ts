import { describe, expect, it } from "vitest";

import type {
  ParsedCandidate,
  ParsedProduct,
  RetailerAdapter,
} from "../src/adapters/types.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchResult,
} from "../src/fetcher/types.js";
import { DEFAULT_OPTIONS, resolveItem } from "../src/resolve.js";
import { EVIDENCE_LIMITS, MAX_QUERY_LENGTH } from "../src/wire-limits.js";

/**
 * 🔴 **Every string a competitor's page puts on a finding is held to the
 * gateway's own limit** (security finding 2). `ResolutionEvidenceDto` in
 * `aeo-backend` validates `title` at 512, `sellerName` 255, `brand` 160,
 * `model` 128 and `itemId` 128, and a query trail entry at 500 — and one
 * field past its limit answers the WHOLE resolutions batch with a 400 the
 * runtime never retries. A page stating a 10,000-character title would cost
 * every finding beside it.
 */

const BARCODE = "812348010548";
const LONG = 10_000;

const card = (over: Partial<ParsedCandidate>): ParsedCandidate => ({
  itemId: "ITEM-1",
  url: "https://r.test/p/ITEM-1",
  model: "CF-08LB",
  title: "Kingwin CF-08LB 80mm Fan",
  brand: "Kingwin",
  priceCents: 899,
  inStock: true,
  isFirstParty: true,
  sellerName: "Retailer",
  imageUrl: null,
  partialMatch: false,
  ...over,
});

/** Two listings found by the item's name; the second verifies. */
function resolveWith(
  over: Partial<ParsedCandidate>,
  page: Partial<ParsedProduct> = {},
  productName = "Kingwin CF-08LB",
) {
  const runnerUp = card({
    ...over,
    itemId: "ITEM-2",
    url: "https://r.test/p/ITEM-2",
  });
  const chosen = card(over);
  const adapter: RetailerAdapter = {
    slug: "fake",
    querySupport: {
      maxNumericQueryDigits: null,
      barcodeIsSearchable: false,
      partNumberNeedsBrand: false,
    },
    pacing: { pagesAtOnce: 3 },
    fetchProfile: { country: null, timeoutMs: null },
    maxProbes: null,
    productIndex: null,
    hosts: ["r.test"],
    buildSearchUrl: (q) => `https://r.test/s?q=${encodeURIComponent(q)}`,
    parseSearchResults: () => [chosen, runnerUp],
    parseProductPage: (html) => ({
      barcode: html === "ITEM-1" ? BARCODE : "036000291452",
      additionalBarcodes: [],
      priceCents: null,
      inStock: null,
      title: null,
      sellerName: null,
      isFirstParty: null,
      unverifiableReason: null,
      category: null,
      ...page,
    }),
  };
  const fetcher: Fetcher = {
    liveRequestCount: 0,
    pagesDelivered: 0,
    fetch(url: string): Promise<FetchResult> {
      const body = url.startsWith("https://client.test/")
        ? CLIENT_PAGE
        : url.startsWith("https://r.test/s?")
          ? "SEARCH"
          : url.startsWith("https://r.test/p/")
            ? url.slice("https://r.test/p/".length)
            : undefined;
      if (body === undefined)
        return Promise.reject(new FetchFailed(url, undefined, 502, 1));
      return Promise.resolve({ url, body, cached: true, attempts: 0 });
    },
  };
  return resolveItem(
    { barcode: BARCODE, clientSku: "SKU-1", productName },
    adapter,
    fetcher,
    {
      ...DEFAULT_OPTIONS,
      clientCatalogueUrlTemplate: "https://client.test/{sku}",
    },
  );
}

/** The client's own page: the part number, so runners-up show evidence. */
const CLIENT_PAGE = `<script type="application/ld+json">${JSON.stringify({
  "@type": "Product",
  sku: "SKU-1",
  mpn: "CF-08LB",
  brand: { "@type": "Brand", name: "Kingwin" },
})}</script>`;

describe("the gateway's limits, in one place", () => {
  it("are the DTO's", () => {
    expect(EVIDENCE_LIMITS).toEqual({
      title: 512,
      sellerName: 255,
      brand: 160,
      model: 128,
      itemId: 128,
    });
    expect(MAX_QUERY_LENGTH).toBe(500);
  });
});

describe("🔴 a page-derived string past its limit is held to it", () => {
  for (const field of [
    "title",
    "brand",
    "model",
    "itemId",
    "sellerName",
  ] as const) {
    it(`${field}: on the match and every alternative`, async () => {
      const long = `${field === "brand" ? "Kingwin" : "CF-08LB"} ${"x".repeat(LONG)}`;
      const r = await resolveWith({ [field]: long });
      const max = EVIDENCE_LIMITS[field];
      const value = r.match?.[field];
      expect(typeof value).toBe("string");
      expect(String(value).length).toBe(max);
      expect(String(value).startsWith(long.slice(0, 20))).toBe(true);
      expect(r.alternatives.length).toBeGreaterThan(0);
      for (const alt of r.alternatives) {
        expect(String(alt[field]).length).toBeLessThanOrEqual(max);
      }
    });
  }

  it("sellerName from the page, too", async () => {
    const r = await resolveWith({}, { sellerName: "S".repeat(LONG) });
    expect(r.match?.sellerName?.length).toBe(EVIDENCE_LIMITS.sellerName);
  });

  it("each queriesTried entry, a 10,000-character client name included", async () => {
    const name = `Kingwin ${"y".repeat(LONG)}`;
    // A retailer that answers every search with nothing, so the client's
    // name is asked.
    const nothing: RetailerAdapter = {
      slug: "fake",
      querySupport: {
        maxNumericQueryDigits: null,
        barcodeIsSearchable: false,
        partNumberNeedsBrand: false,
      },
      pacing: { pagesAtOnce: 3 },
      fetchProfile: { country: null, timeoutMs: null },
      maxProbes: null,
      productIndex: null,
      hosts: ["r.test"],
      buildSearchUrl: (q) => `https://r.test/s?q=${encodeURIComponent(q)}`,
      parseSearchResults: () => [],
      parseProductPage: () => null,
    };
    const r = await resolveItem(
      { barcode: BARCODE, clientSku: "SKU-1", productName: name },
      nothing,
      {
        liveRequestCount: 0,
        pagesDelivered: 0,
        fetch: (url) =>
          url.startsWith("https://r.test/s?")
            ? Promise.resolve({
                url,
                body: "SEARCH",
                cached: true,
                attempts: 0,
              })
            : Promise.reject(new FetchFailed(url, undefined, 502, 1)),
      },
      DEFAULT_OPTIONS,
    );
    expect(r.queriesTried).toHaveLength(1);
    expect(r.queriesTried[0]?.length).toBe(MAX_QUERY_LENGTH);
    expect(r.queriesTried[0]?.startsWith("Kingwin yyy")).toBe(true);
  });

  it("CONTROL: strings within their limits are untouched", async () => {
    const r = await resolveWith({});
    expect(r.match).toMatchObject({
      itemId: "ITEM-1",
      title: "Kingwin CF-08LB 80mm Fan",
      brand: "Kingwin",
      model: "CF-08LB",
      sellerName: "Retailer",
    });
    expect(r.outcome).toBe("verified");
  });
});
