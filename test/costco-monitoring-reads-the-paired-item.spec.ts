import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  amazonAdapter,
  readListingPage as readAmazonPage,
} from "../src/adapters/amazon.js";
import { readListingPage as readBestBuyPage } from "../src/adapters/bestbuy.js";
import { readListingPage as readBhPage } from "../src/adapters/bh.js";
import {
  costcoAdapter,
  readListingPage as readCostcoPage,
} from "../src/adapters/costco.js";
import { readListingPage as readNeweggPage } from "../src/adapters/newegg.js";
import type {
  CategoryReading,
  ListingPageResult,
  ListingReader,
} from "../src/adapters/types.js";
import type { Fetcher, FetchResult } from "../src/fetcher/types.js";
import { ReadRunClient } from "../src/gateway/client.js";
import { readListing, runReadJob } from "../src/read-run.js";
import { MAX_PRICE_CENTS } from "../src/wire-limits.js";

import manifest from "./raw/manifest.json" with { type: "json" };

/**
 * 🔴 **A daily read of a Costco page listing several items reads it.**
 *
 * Costco's iPad and MacBook pages list several items (colours) and price only
 * the one they show first. A read job carries no barcode to choose with, so
 * before this every such page was an `unreadable-offer` — every monitored
 * iPad or MacBook at Costco would fail its daily read. The reading now carries
 * every barcode the page publishes, each with its own item's price or none,
 * and the gateway files each pairing at the price of the barcode it was
 * proven by. `priceCents` stays `null`: it answers for every barcode, and the
 * page does not price them all.
 */

const dir = (rel: string): string =>
  fileURLToPath(new URL(rel, import.meta.url));
const raw = (name: string): string =>
  gunzipSync(readFileSync(dir(`./raw/${name}.gz`))).toString("utf8");

const IPAD_AIR = raw("costco-pdp-ipad-air-11-several-items.html");
const MACBOOK_NEO = raw("costco-pdp-macbook-neo-sibling-priced.html");
const GOLD_BAR = raw("costco-pdp-gold-bar-member-only.html");
const SL900 = raw("costco-pdp-sl900uc.html");

const IPAD_AIR_URL =
  "https://www.costco.com/p/-/ipad-air-11-inch-128gb-wi-fi-m4-chip-built-for-apple-intelligence/4000444349";
const SL900_URL =
  "https://www.costco.com/p/-/cyberpower-900va450w-simulated-sine-wave-slim-ups-battery-backup-with-surge-protection/4000193283";

/** The four colours' barcodes, as the page lists them; only the first priced. */
const IPAD_BARCODE_PRICES = [
  { barcode: "195950823578", priceCents: 64999 },
  { barcode: "195950824032", priceCents: null },
  { barcode: "195950823806", priceCents: null },
  { barcode: "195950824261", priceCents: null },
];

/** A SYNTHETIC product page in Costco's format: flight data and JSON-LD. */
function costcoPage(details: unknown, ld: unknown = null): string {
  const flight = `"productDetailsData":${JSON.stringify(details)}`;
  return (
    '<html><head><link href="/consumer-web/product/prd/details-usbc/x.css">' +
    (ld === null
      ? ""
      : `<script type="application/ld+json">${JSON.stringify(ld)}</script>`) +
    `</head><body><script>self.__next_f.push([1,${JSON.stringify(flight)}])</script></body></html>`
  );
}
const item = (id: string, upc: string, over: object = {}) => ({
  id,
  upc,
  isMembershipReqd: false,
  dispPriceInCartOnly: 0,
  descriptions: [{ shortDescription: `item ${id}` }],
  ...over,
});
const priced = (id: string, dollars: number) => ({
  id,
  displayPrice: { onlinePrice: dollars, aggregatedDiscountAmt: 0 },
});
/** Two colours of one product; `priceInfo` prices the first, as Costco's do. */
const twoColours = (over: object = {}) => ({
  productData: {
    id: "9",
    childCatalogData: [
      item("111", "036000291452", over),
      item("112", "036000291469", over),
    ],
  },
  priceInfo: priced("111", 10),
});

function pageOf(
  result: ListingPageResult,
): Extract<ListingPageResult, { kind: "page" }>["page"] {
  if (result.kind !== "page") {
    throw new Error(`expected a page, got ${result.kind}: ${result.detail}`);
  }
  return result.page;
}

/** Serves fixed bodies; counts each page it serves. */
class PagesFetcher implements Fetcher {
  liveRequestCount = 0;
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  constructor(private readonly pages: ReadonlyMap<string, string>) {}
  fetch(url: string): Promise<FetchResult> {
    const body = this.pages.get(url);
    if (body === undefined) throw new Error(`no page for ${url}`);
    this.liveRequestCount++;
    return Promise.resolve({
      url,
      body,
      cached: false,
      attempts: 1,
      fetchedAt: new Date("2026-11-12T06:00:00.000Z"),
    });
  }
}

const now = (): Date => new Date("2026-11-12T06:00:00.000Z");

describe("🔴 a Costco page listing several items is read, not failed", () => {
  it("the iPad Air page reads as a page: four barcodes, $649.99 for the colour it prices only", () => {
    expect(readCostcoPage(IPAD_AIR)).toStrictEqual({
      kind: "page",
      page: {
        pageItemId: "4000444349",
        barcode: "195950823578",
        additionalBarcodes: ["195950824032", "195950823806", "195950824261"],
        // 🔴 Answers for every barcode, and three are unpriced.
        priceCents: null,
        barcodePrices: IPAD_BARCODE_PRICES,
        inStock: null,
        category: null,
      },
    });
  });

  it("🔴 the MacBook Neo page reads with no price for either barcode: its priced sibling lends none", () => {
    expect(readCostcoPage(MACBOOK_NEO)).toStrictEqual({
      kind: "page",
      page: {
        pageItemId: "4000447603",
        barcode: "195950851809",
        additionalBarcodes: ["195950853681"],
        priceCents: null,
        barcodePrices: [
          { barcode: "195950851809", priceCents: null },
          { barcode: "195950853681", priceCents: null },
        ],
        inStock: null,
        category: null,
      },
    });
  });

  it("states the same per-barcode prices resolution does, for every Costco page", () => {
    for (const body of [IPAD_AIR, MACBOOK_NEO, GOLD_BAR, SL900]) {
      const reading = readCostcoPage(body);
      const product = costcoAdapter.parseProductPage(body);
      expect(
        reading.kind === "page" ? reading.page.barcodePrices : "not a page",
      ).toEqual(product?.barcodePrices);
    }
  });

  it("CONTROL: the member-only gold bar is unchanged — a page with no price, and no per-barcode prices", () => {
    expect(readCostcoPage(GOLD_BAR)).toStrictEqual({
      kind: "page",
      page: {
        pageItemId: "4000284893",
        barcode: null,
        additionalBarcodes: [],
        priceCents: null,
        inStock: null,
        category: null,
      },
    });
  });

  it("CONTROL: a page with one price states none per barcode", () => {
    expect(pageOf(readCostcoPage(SL900))).not.toHaveProperty("barcodePrices");
    expect(pageOf(readCostcoPage(SL900)).priceCents).toBe(6997);
  });

  it("CONTROL SYNTHETIC: several items whose price is withheld keep today's answers", () => {
    // Member-only and in-cart-only: a page with no price, nothing per barcode.
    for (const over of [
      { isMembershipReqd: true },
      { dispPriceInCartOnly: 1 },
    ]) {
      const page = pageOf(readCostcoPage(costcoPage(twoColours(over))));
      expect(page.priceCents).toBeNull();
      expect(page).not.toHaveProperty("barcodePrices");
    }
    // No price shown at all: still an unreadable offer.
    const noPrice = costcoPage({
      productData: twoColours().productData,
    });
    expect(readCostcoPage(noPrice).kind).toBe("unreadable-offer");
  });

  it("🔴 SYNTHETIC: several items with no barcode to price stay an unreadable offer, never a page with no price", () => {
    // The shown price belongs to item 111, and no barcode can carry it: a
    // page read with no price would hide that this build could not tie it.
    const body = costcoPage(twoColours({ upc: null }));
    expect(readCostcoPage(body)).toStrictEqual({
      kind: "unreadable-offer",
      detail: "several items, not all at one price this build can read",
    });
  });
});

describe("🔴 the reading event carries the per-barcode prices", () => {
  it("a read of the iPad page posts every barcode with its own price, and no page price", async () => {
    const calls: Record<string, unknown>[] = [];
    const gateway = (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (typeof init?.body === "string") {
        const parsed: unknown = JSON.parse(init.body);
        if (parsed !== null && typeof parsed === "object") {
          calls.push(Object.fromEntries(Object.entries(parsed)));
        }
        return Promise.resolve(Response.json({ applied: 1 }));
      }
      return Promise.resolve(
        Response.json({
          retailerSlug: "costco",
          listings: [
            { itemId: "4000444349", url: IPAD_AIR_URL },
            { itemId: "4000193283", url: SL900_URL },
          ],
        }),
      );
    };
    const client = new ReadRunClient(
      { baseUrl: "http://gateway.local", user: "ci", password: "secret" },
      "55555555-5555-4555-8555-555555555555",
      { fetch: gateway, sleep: () => Promise.resolve() },
    );
    const result = await runReadJob({
      client,
      readerFor: () => costcoAdapter,
      fetcher: new PagesFetcher(
        new Map([
          [IPAD_AIR_URL, IPAD_AIR],
          [SL900_URL, SL900],
        ]),
      ),
      now,
      concurrency: 1,
      log: () => undefined,
    });
    expect(result.undelivered).toBe(0);

    const event = calls.find((c) => c["type"] === "readings");
    const sent: unknown = event?.["readings"];
    const readings: readonly unknown[] = Array.isArray(sent) ? sent : [];
    expect(readings).toEqual([
      {
        itemId: "4000444349",
        pageItemId: "4000444349",
        readAt: "2026-11-12T06:00:00.000Z",
        pageFound: true,
        barcode: "195950823578",
        additionalBarcodes: ["195950824032", "195950823806", "195950824261"],
        priceCents: null,
        barcodePrices: IPAD_BARCODE_PRICES,
        inStock: null,
        failure: null,
        priceSource: "product_page",
        category: null,
      },
      {
        itemId: "4000193283",
        pageItemId: "4000193283",
        readAt: "2026-11-12T06:00:00.000Z",
        pageFound: true,
        barcode: "649532936564",
        additionalBarcodes: [],
        priceCents: 6997,
        inStock: null,
        failure: null,
        priceSource: "product_page",
        category: null,
      },
    ]);
    // 🔴 Byte for byte: a page with one price posts no such key at all.
    const onePrice: unknown = readings[1];
    expect(
      onePrice !== null && typeof onePrice === "object"
        ? Object.keys(onePrice)
        : "not a reading",
    ).not.toContain("barcodePrices");
  });

  /** A reader that answers one fixed result for every body. */
  const answering = (
    result: ListingPageResult,
  ): ListingReader & CategoryReading => ({
    ...amazonAdapter,
    readListingPage: () => result,
  });
  const LISTING = { itemId: "X", url: "https://www.amazon.com/dp/X" };
  const page = {
    pageItemId: "X",
    barcode: "036000291452",
    additionalBarcodes: ["036000291469"],
    inStock: null,
    category: null,
  };

  it("🔴 a reading with per-barcode prices sends no page price, whatever the reader said", async () => {
    // The gateway takes a pairing's price from `barcodePrices` alone, and
    // expects `priceCents` null beside it.
    const reading = await readListing(
      LISTING,
      answering({
        kind: "page",
        page: {
          ...page,
          priceCents: 1000,
          barcodePrices: [
            { barcode: "036000291452", priceCents: 1000 },
            { barcode: "036000291469", priceCents: 1200 },
          ],
        },
      }),
      new PagesFetcher(new Map([[LISTING.url, "<html></html>"]])),
      now,
    );
    expect(reading.priceCents).toBeNull();
    expect(reading).toHaveProperty("barcodePrices", [
      { barcode: "036000291452", priceCents: 1000 },
      { barcode: "036000291469", priceCents: 1200 },
    ]);
  });

  it("🔴 a per-barcode price the gateway would refuse is sent as no price, never as a refused reading", async () => {
    const reading = await readListing(
      LISTING,
      answering({
        kind: "page",
        page: {
          ...page,
          priceCents: null,
          barcodePrices: [
            { barcode: "036000291452", priceCents: MAX_PRICE_CENTS + 1 },
            { barcode: "036000291469", priceCents: 12.5 },
          ],
        },
      }),
      new PagesFetcher(new Map([[LISTING.url, "<html></html>"]])),
      now,
    );
    expect(reading).toHaveProperty("barcodePrices", [
      { barcode: "036000291452", priceCents: null },
      { barcode: "036000291469", priceCents: null },
    ]);
  });

  it("🔴 an empty list of per-barcode prices is never sent: the key is absent", async () => {
    const reading = await readListing(
      LISTING,
      answering({
        kind: "page",
        page: { ...page, priceCents: 1000, barcodePrices: [] },
      }),
      new PagesFetcher(new Map([[LISTING.url, "<html></html>"]])),
      now,
    );
    expect(reading).not.toHaveProperty("barcodePrices");
    // With nothing per barcode, the page's own price speaks as before.
    expect(reading.priceCents).toBe(1000);
  });

  it("CONTROL: the largest price the gateway takes is sent as it is", async () => {
    const reading = await readListing(
      LISTING,
      answering({
        kind: "page",
        page: {
          ...page,
          priceCents: null,
          barcodePrices: [
            { barcode: "036000291452", priceCents: MAX_PRICE_CENTS },
            { barcode: "036000291469", priceCents: 1 },
          ],
        },
      }),
      new PagesFetcher(new Map([[LISTING.url, "<html></html>"]])),
      now,
    );
    expect(reading).toHaveProperty("barcodePrices", [
      { barcode: "036000291452", priceCents: MAX_PRICE_CENTS },
      { barcode: "036000291469", priceCents: 1 },
    ]);
  });
});

describe("CONTROL: no other retailer's reader states per-barcode prices", () => {
  it("Newegg, Amazon, Best Buy and B&H readings carry no such key, on every committed product page", () => {
    const names = manifest.fixtures.map((f) => f.name);
    const readers: [string, (html: string) => ListingPageResult][] = [
      ["bestbuy-", readBestBuyPage],
      ["bh-", readBhPage],
      ["amazon-", readAmazonPage],
      ["pdp-", readNeweggPage],
    ];
    let pages = 0;
    for (const [prefix, read] of readers) {
      for (const name of names.filter((n) => n.startsWith(prefix))) {
        const result = read(raw(`${name}.html`));
        if (result.kind !== "page") continue;
        pages++;
        expect(result.page, name).not.toHaveProperty("barcodePrices");
      }
    }
    // Not vacuous: a page from every one of them.
    expect(pages).toBeGreaterThanOrEqual(8);
  });
});
