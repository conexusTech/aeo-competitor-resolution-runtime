import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  bestbuyAdapter,
  parseProductPage,
  parseSearchResults,
  readListingPage,
} from "../src/adapters/bestbuy.js";
import { canQuery, type ParsedCandidate } from "../src/adapters/types.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchResult,
} from "../src/fetcher/types.js";
import { barcodeQuery } from "../src/query-plan.js";
import { probeOrder } from "../src/ranking.js";
import { DEFAULT_OPTIONS, resolveItem } from "../src/resolve.js";

/**
 * The Best Buy adapter, against the investigation's real pages (R6 fixtures,
 * distilled and proven parse-identical to the raw captures).
 *
 * 🔑 **Resolution is checked end to end where it matters**, through
 * `resolveItem` with a fetcher serving those pages, because the claims that
 * decide what a customer is told — verified, a miss, a failure — are claims
 * about the pipeline and the adapter together.
 */

const raw = (name: string): string =>
  gunzipSync(
    readFileSync(
      fileURLToPath(new URL(`./raw/${name}.html.gz`, import.meta.url)),
    ),
  ).toString("utf8");

const UPC_FIRST_PARTY = raw("bestbuy-search-upc-first-party");
const UPC_MARKETPLACE = raw("bestbuy-search-upc-marketplace");
const UPC_NO_RESULTS = raw("bestbuy-search-upc-no-results");
const EMPTY_63005 = raw("bestbuy-search-empty-63005");
const LOOKALIKES = raw("bestbuy-search-lookalikes-only");
const PART_NUMBER = raw("bestbuy-search-part-number");
const CATEGORY = raw("bestbuy-category-sponsored");
const PDP_M310 = raw("bestbuy-pdp-m310");
const PDP_BK350 = raw("bestbuy-pdp-marketplace-bk350");

const M310_UPC = "097855066237";
const M310_URL =
  "https://www.bestbuy.com/product/logitech-m310-wireless-optical-ambidextrous-mouse-wireless-silver/J7H7ZLV3V9/sku/1297054";
const BK350_UPC = "731304016298";
const BK350_URL =
  "https://www.bestbuy.com/product/apc-6-outlet-rj11-telco-350va-210w-back-ups-cs-tower-1020j-avr-bk350-beige/JXKZP6GJJF/sku/11521676";

/** The 42-byte body the vendor answered a refused request with, verbatim. */
const VENDOR_REFUSAL = "Manual expect is not enabled for this zone";

const searchUrl = (q: string): string => bestbuyAdapter.buildSearchUrl(q);

const candidatesOn = (html: string): ParsedCandidate[] => {
  const parsed = parseSearchResults(html);
  if (parsed === null) throw new Error("expected a results page, got null");
  return parsed;
};

/**
 * Serves pages by url; anything else is a fetch that failed, as one through
 * the vendor would — never a page.
 */
class Pages implements Fetcher {
  liveRequestCount = 0;
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  readonly asked: string[] = [];
  constructor(
    private readonly byUrl: Readonly<Record<string, string>>,
    private readonly otherwise: (url: string) => string | null = () => null,
  ) {}
  fetch(url: string): Promise<FetchResult> {
    this.asked.push(url);
    this.liveRequestCount++;
    const body = this.byUrl[url] ?? this.otherwise(url);
    if (body === null) {
      return Promise.reject(new FetchFailed(url, undefined, null, 1));
    }
    return Promise.resolve({ url, body, cached: false, attempts: 1 });
  }
}

/**
 * The client's own catalogue page, publishing its part number as structured
 * data — a double for the client, not a Best Buy page.
 */
const CATALOGUE = "https://client.test/p/{sku}";
const catalogue = (mpn: string, brand: string): string =>
  `<script type="application/ld+json">${JSON.stringify({
    "@type": "Product",
    sku: "SKU-1",
    mpn,
    brand: { "@type": "Brand", name: brand },
    name: `${brand} ${mpn}`,
  })}</script>`;
const WITH_CATALOGUE = {
  ...DEFAULT_OPTIONS,
  clientCatalogueUrlTemplate: CATALOGUE,
};

describe("the configuration", () => {
  it("asks the barcode first, and the digit cap does not refuse it", () => {
    expect(bestbuyAdapter.querySupport).toEqual({
      maxNumericQueryDigits: null,
      barcodeIsSearchable: true,
      partNumberNeedsBrand: false,
    });
    const query = barcodeQuery(M310_UPC, bestbuyAdapter.querySupport);
    expect(query).toBe(M310_UPC);
    expect(canQuery(bestbuyAdapter.querySupport, query ?? "")).toBe(true);
  });

  it("reads 4 pages at once, from the us, waits 150 s an attempt, probes 3", () => {
    expect(bestbuyAdapter.pacing).toEqual({ pagesAtOnce: 4 });
    expect(bestbuyAdapter.fetchProfile).toEqual({
      country: "us",
      timeoutMs: 150_000,
    });
    expect(bestbuyAdapter.maxProbes).toBe(3);
  });

  it("searches the website, never the developer API", () => {
    expect(searchUrl("910-001675")).toBe(
      "https://www.bestbuy.com/site/searchpage.jsp?st=910-001675",
    );
  });
});

describe("parseSearchResults", () => {
  it("reads a barcode search's one listing with its model, price and seller", () => {
    const [m310, ...rest] = candidatesOn(UPC_FIRST_PARTY);
    expect(rest).toEqual([]);
    expect(m310).toMatchObject({
      itemId: "1297054",
      url: M310_URL,
      model: "910-001675",
      title:
        "Logitech - M310 Wireless Optical Ambidextrous Mouse - Wireless - Silver",
      brand: "Logitech",
      priceCents: 1699,
      inStock: true,
    });
    expect(m310?.imageUrl).toMatch(/^https:\/\/pisces\.bbystatic\.com\//);
  });

  it("🔴 1P is first party, sold by Best Buy", () => {
    const [m310] = candidatesOn(UPC_FIRST_PARTY);
    expect(m310?.isFirstParty).toBe(true);
    expect(m310?.sellerName).toBe("Best Buy");
  });

  it("🔴 3P is a marketplace listing, and the card does not name its seller", () => {
    const [bk350] = candidatesOn(UPC_MARKETPLACE);
    expect(bk350?.itemId).toBe("11521676");
    expect(bk350?.isFirstParty).toBe(false);
    // The seller's name is on the product page; see the resolution checks.
    expect(bk350?.sellerName).toBeNull();
    expect(bk350?.model).toBe("BK350");
  });

  it("reads SOLD_OUT as out of stock — seen live, on the BK350's listing", () => {
    expect(candidatesOn(UPC_MARKETPLACE)[0]?.inStock).toBe(false);
  });

  it("🔴 answers a barcode search with nothing as [] — and reads no advert", () => {
    // The page carries a second search result: a twelve-ad "no results"
    // carousel, a Dell laptop among them, for a UPS's barcode. An advert is
    // not a result, and probing one spends a request on it.
    expect(UPC_NO_RESULTS).toContain('"skuId":"6668952"');
    expect(candidatesOn(UPC_NO_RESULTS)).toEqual([]);
  });

  it("🔴 reads the results grid, never the carousel ads beside it", () => {
    const ids = candidatesOn(CATEGORY).map((c) => c.itemId);
    for (const ad of ["6640850", "6594154", "6621858", "6628326"]) {
      expect(CATEGORY).toContain(`"skuId":"${ad}"`);
      expect(ids).not.toContain(ad);
    }
  });

  it("🔴 search-empty-63005 is a miss: an answered page with nothing on it", () => {
    expect(parseSearchResults(EMPTY_63005)).toEqual([]);
  });

  it("🔴 the 18 air-filter look-alike page is not a match: dvsOnly answers []", () => {
    expect(LOOKALIKES).toContain('"recallStrategy":"dvsOnly"');
    expect(LOOKALIKES).toContain("Filterbuy");
    expect(parseSearchResults(LOOKALIKES)).toEqual([]);
  });

  it("CONTROL: the same look-alike page read as a hybrid page would offer the filters", () => {
    // Proves the rule above is what empties it, not a parse that reads nothing.
    const hybrid = LOOKALIKES.replace(
      '"recallStrategy":"dvsOnly"',
      '"recallStrategy":"dvsTextMatchHybrid"',
    );
    expect(candidatesOn(hybrid).length).toBeGreaterThan(0);
  });

  it("drops what Best Buy marks isTermMatch false, keeps the exact part number first", () => {
    const candidates = candidatesOn(PART_NUMBER);
    expect(candidates[0]?.itemId).toBe("1297054");
    expect(candidates[0]?.model).toBe("910-001675");
    expect(candidates).toHaveLength(4);
    // 6571665 is a Signature M550 L the page marks as not matching the query.
    expect(PART_NUMBER).toContain('"skuId":"6571665"');
    expect(candidates.find((c) => c.itemId === "6571665")).toBeUndefined();
  });

  it("reads organic listings first, then the sponsored ones in the results grid", () => {
    const ids = candidatesOn(CATEGORY).map((c) => c.itemId);
    // In the grid 6640837 (sponsored) comes BEFORE the two organic listings.
    expect(CATEGORY.indexOf('"skuId":"6640837"')).toBeLessThan(
      CATEGORY.indexOf('"skuId":"6440334"'),
    );
    expect(ids).toEqual(["6440334", "6630902", "6640837", "6640816"]);
  });

  it("🔴 takes the model from manufacturer.modelNumber only", () => {
    const unstated = UPC_FIRST_PARTY.replace(
      '"manufacturer":{"modelNumber":"910-001675"},',
      "",
    );
    expect(unstated).not.toContain("modelNumber");
    // The url and the image still name the product; neither is a model field.
    const [m310] = candidatesOn(unstated);
    expect(m310?.itemId).toBe("1297054");
    expect(m310?.model).toBeNull();
  });

  it("🔴 an empty body, a vendor refusal or a product page is not a results page", () => {
    expect(parseSearchResults("")).toBeNull();
    expect(parseSearchResults(VENDOR_REFUSAL)).toBeNull();
    expect(parseSearchResults(PDP_M310)).toBeNull();
  });
});

describe("parseProductPage", () => {
  it("reads every UPC the page states, its price, stock, title and seller", () => {
    expect(parseProductPage(PDP_M310)).toEqual({
      barcode: M310_UPC,
      additionalBarcodes: [],
      priceCents: 1699,
      inStock: true,
      title:
        "Logitech - M310 Wireless Optical Ambidextrous Mouse - Wireless - Silver",
      sellerName: "Best Buy",
    });
  });

  it("names a marketplace listing's seller from the page", () => {
    expect(parseProductPage(PDP_BK350)).toMatchObject({
      barcode: BK350_UPC,
      priceCents: 12310,
      inStock: false,
      sellerName: "IPC-STORE",
    });
  });

  /**
   * ⚠️ **Not seen live.** The investigation's 38 product pages each stated one
   * UPC, equal in all three places; no page with several was captured. This is
   * the real M310 page with a second UPC spliced into its `upc` field, to
   * prove the split — the case Amazon measured, where the client's barcode was
   * the second of two values in one field.
   */
  it("several barcodes: every value of a field, the first as barcode (spliced, not seen live)", () => {
    const spliced = PDP_M310.replace(
      `"upc":"${M310_UPC}"`,
      `"upc":"036000291452 ${M310_UPC}"`,
    );
    expect(spliced).not.toBe(PDP_M310);
    expect(parseProductPage(spliced)).toMatchObject({
      barcode: "036000291452",
      additionalBarcodes: [M310_UPC],
    });
  });

  it("removing the UPC from all three places leaves no barcode", () => {
    const removed = PDP_M310.split(M310_UPC).join("");
    expect(parseProductPage(removed)).toMatchObject({
      barcode: null,
      additionalBarcodes: [],
    });
  });

  it("🔴 a page with no product payload is not a product page: null", () => {
    expect(parseProductPage("")).toBeNull();
    expect(parseProductPage(VENDOR_REFUSAL)).toBeNull();
    // A search page carries no product payload either.
    expect(parseProductPage(UPC_FIRST_PARTY)).toBeNull();
    expect(parseProductPage(CATEGORY)).toBeNull();
  });
});

describe("resolution at Best Buy", () => {
  it("🔴 verifies on the UPC the page publishes — M310, 097855066237 — in two requests", async () => {
    const fetcher = new Pages({
      [searchUrl(M310_UPC)]: UPC_FIRST_PARTY,
      [M310_URL]: PDP_M310,
    });
    const r = await resolveItem(
      { barcode: M310_UPC, clientSku: "SKU-1" },
      bestbuyAdapter,
      fetcher,
      WITH_CATALOGUE,
    );

    expect(r.outcome).toBe("verified");
    expect(r.failure).toBeNull();
    expect(r.match?.itemId).toBe("1297054");
    expect(r.match?.retailerBarcode).toBe(M310_UPC);
    expect(r.match?.isFirstParty).toBe(true);
    expect(r.match?.sellerName).toBe("Best Buy");
    expect(r.match?.priceCents).toBe(1699);
    // The barcode found it and proved it: no catalogue page was bought.
    expect(fetcher.asked).toEqual([searchUrl(M310_UPC), M310_URL]);
    expect(r.requests).toBe(2);
    expect(r.identity).toBeNull();
  });

  it("🔴 removing the UPC makes it unverifiable, never verified or a mismatch", async () => {
    const fetcher = new Pages(
      {
        [searchUrl(M310_UPC)]: UPC_FIRST_PARTY,
        [M310_URL]: PDP_M310.split(M310_UPC).join(""),
        "https://client.test/p/SKU-1": catalogue("910-001675", "Logitech"),
      },
      (url) => (url.startsWith(searchUrl("")) ? PART_NUMBER : null),
    );
    const r = await resolveItem(
      { barcode: M310_UPC, clientSku: "SKU-1" },
      bestbuyAdapter,
      fetcher,
      WITH_CATALOGUE,
    );

    expect(r.outcome).toBe("unverifiable");
    expect(r.match?.itemId).toBe("1297054");
    expect(r.match?.retailerBarcode).toBeNull();
  });

  it("several barcodes verify on the value that agrees (spliced, not seen live)", async () => {
    const spliced = PDP_M310.replace(
      `"upc":"${M310_UPC}"`,
      `"upc":"036000291452 ${M310_UPC}"`,
    );
    const r = await resolveItem(
      { barcode: M310_UPC, clientSku: "SKU-1" },
      bestbuyAdapter,
      new Pages({
        [searchUrl(M310_UPC)]: UPC_FIRST_PARTY,
        [M310_URL]: spliced,
      }),
      WITH_CATALOGUE,
    );
    expect(r.outcome).toBe("verified");
    expect(r.match?.retailerBarcode).toBe(M310_UPC);
  });

  it("🔴 3P is a marketplace match with the seller's name, its price and its stock from the page", async () => {
    const r = await resolveItem(
      { barcode: BK350_UPC, clientSku: "SKU-1" },
      bestbuyAdapter,
      new Pages({
        [searchUrl(BK350_UPC)]: UPC_MARKETPLACE,
        [BK350_URL]: PDP_BK350,
      }),
      WITH_CATALOGUE,
    );
    expect(r.outcome).toBe("verified");
    expect(r.match?.isFirstParty).toBe(false);
    expect(r.match?.sellerName).toBe("IPC-STORE");
    expect(r.match?.priceCents).toBe(12310);
    expect(r.match?.inStock).toBe(false);
  });

  it("🔴 a vendor refusal is a failure, not a miss", async () => {
    const r = await resolveItem(
      { barcode: M310_UPC, clientSku: "SKU-1" },
      bestbuyAdapter,
      // The barcode search answered with the vendor's refusal; nothing else
      // can be had either.
      new Pages({ [searchUrl(M310_UPC)]: VENDOR_REFUSAL }),
      WITH_CATALOGUE,
    );
    expect(r.outcome).toBe("not-found");
    expect(r.searchesNotResultsPage).toBe(1);
    expect(r.failure).not.toBeNull();
  });

  it("🔴 an empty body is a failure, not a miss", async () => {
    const r = await resolveItem(
      { barcode: M310_UPC, clientSku: "SKU-1" },
      bestbuyAdapter,
      new Pages({ [searchUrl(M310_UPC)]: "" }),
      WITH_CATALOGUE,
    );
    expect(r.outcome).toBe("not-found");
    expect(r.failure).not.toBeNull();
  });

  it("🔴 search-empty-63005 is a miss: every search answered with nothing", async () => {
    const barcode = "813810010431";
    const r = await resolveItem(
      { barcode, clientSku: "SKU-1" },
      bestbuyAdapter,
      new Pages(
        {
          [searchUrl(barcode)]: UPC_NO_RESULTS,
          "https://client.test/p/SKU-1": catalogue("63005", "SteelSeries"),
        },
        (url) => (url.startsWith(searchUrl("")) ? EMPTY_63005 : null),
      ),
      WITH_CATALOGUE,
    );
    expect(r.outcome).toBe("not-found");
    expect(r.failure).toBeNull();
    expect(r.queriesTried[0]).toBe(barcode);
    expect(r.queriesTried).toContain("63005");
  });

  it("🔴 the air-filter look-alike page is not-found, never unconfirmed", async () => {
    // The client's part number IS a model on that page — the case a parser
    // keeping look-alikes would report as an unconfirmed pairing.
    const lookalikeModel = "AFB30x32x1M11Apk6";
    expect(LOOKALIKES).toContain(lookalikeModel);
    const barcode = "649532012008";
    const r = await resolveItem(
      { barcode, clientSku: "SKU-1" },
      bestbuyAdapter,
      new Pages(
        {
          [searchUrl(barcode)]: UPC_NO_RESULTS,
          "https://client.test/p/SKU-1": catalogue(lookalikeModel, "Filterbuy"),
        },
        (url) => (url.startsWith(searchUrl("")) ? LOOKALIKES : null),
      ),
      WITH_CATALOGUE,
    );
    expect(r.outcome).toBe("not-found");
    expect(r.match).toBeNull();
    expect(r.failure).toBeNull();
  });

  it("🔴 at equal score the 1P listing is probed first", () => {
    const [marketplace] = candidatesOn(UPC_MARKETPLACE);
    const [own] = candidatesOn(UPC_FIRST_PARTY);
    if (marketplace === undefined || own === undefined)
      throw new Error("pages");
    const order = probeOrder([
      { candidate: marketplace, score: 12 },
      { candidate: own, score: 12 },
    ]).map((e) => e.candidate.itemId);
    expect(order).toEqual(["1297054", "11521676"]);
  });
});

describe("readListingPage", () => {
  it("🔴 reads its page: the SKU, the UPC, the price and the stock", () => {
    expect(readListingPage(PDP_M310)).toEqual({
      kind: "page",
      page: {
        pageItemId: "1297054",
        barcode: M310_UPC,
        additionalBarcodes: [],
        priceCents: 1699,
        inStock: true,
      },
    });
  });

  it("reads a sold-out listing that still shows a price", () => {
    expect(readListingPage(PDP_BK350)).toEqual({
      kind: "page",
      page: {
        pageItemId: "11521676",
        barcode: BK350_UPC,
        additionalBarcodes: [],
        priceCents: 12310,
        inStock: false,
      },
    });
  });

  it("keeps an empty UPC field as empty, not as no field", () => {
    const empty = PDP_M310.split(M310_UPC).join("");
    const result = readListingPage(empty);
    expect(result.kind).toBe("page");
    if (result.kind === "page") expect(result.page.barcode).toBe("");
  });

  it("🔴 in stock with no readable price is an unreadable offer, not a free one", () => {
    const unpriced = PDP_M310.replace(
      /"(customerPrice|displayableCustomerPrice)":16\.99/g,
      '"$1":null',
    );
    expect(readListingPage(unpriced)).toEqual({
      kind: "unreadable-offer",
      detail: "in stock with no readable price",
    });
  });

  it("a search page, an empty body or a refusal is not a product page", () => {
    for (const body of [UPC_FIRST_PARTY, "", VENDOR_REFUSAL]) {
      expect(readListingPage(body).kind).toBe("not-a-product-page");
    }
  });

  it("is sent only to Best Buy's own hosts", () => {
    expect([...bestbuyAdapter.hosts].sort()).toEqual([
      "bestbuy.com",
      "www.bestbuy.com",
    ]);
    expect(bestbuyAdapter.slug).toBe("bestbuy");
  });
});
