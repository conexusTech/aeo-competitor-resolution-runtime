import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { costcoAdapter, SITEMAP_INDEX } from "../src/adapters/costco.js";
import type { ParsedProduct, RetailerAdapter } from "../src/adapters/types.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchResult,
} from "../src/fetcher/types.js";
import { resolveItem, type ResolveRequest } from "../src/resolve.js";

/**
 * 🔴 **A Costco pairing carries the price of the item that matched.**
 *
 * Costco's iPad and MacBook pages list several items (colours), and
 * `priceInfo` prices the one the page shows first. Before this, a page whose
 * other items were unpriced gave no price at all, so 12 of 15 pairings proven
 * by barcode in production carried none — while the item that matched was
 * exactly the one the page prices.
 *
 * The real pages, distilled from the investigation's cache:
 * - the iPad Air 11-inch 128GB page lists four colours and prices item 2042802
 *   (barcode 195950823578) at $649.99;
 * - the MacBook Neo page prices item 2046716, a sibling of the matched item
 *   2046718 (barcode 195950851809) — a price that must never be lent to it.
 */

const dir = (rel: string): string =>
  fileURLToPath(new URL(rel, import.meta.url));
const gunzip = (rel: string): string =>
  gunzipSync(readFileSync(dir(rel))).toString("utf8");

const PRODUCT_SITEMAP = "https://www.costco.com/sitemap_lw_p_mod_001.xml";
const IPAD_AIR_URL =
  "https://www.costco.com/p/-/ipad-air-11-inch-128gb-wi-fi-m4-chip-built-for-apple-intelligence/4000444349";
const MACBOOK_NEO_URL =
  "https://www.costco.com/p/-/macbook-neo-laptop-13-inch---apple-a18-pro-chip-built-for-apple-intelligence-6-core-cpu-5-core-gpu-8gb-memory-256gb-ssd-storage/4000447603";
const IPAD_AIR = gunzip("./raw/costco-pdp-ipad-air-11-several-items.html.gz");
const MACBOOK_NEO = gunzip(
  "./raw/costco-pdp-macbook-neo-sibling-priced.html.gz",
);
/** A real Costco page stating another product's UPC. */
const ANOTHER_PRODUCT = gunzip("./raw/costco-pdp-sl900uc.html.gz");

class CostcoFetcher implements Fetcher {
  liveRequestCount = 0;
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  private readonly bodies: Record<string, string> = {
    [SITEMAP_INDEX]: gunzip("./raw/costco-sitemap-index.xml.gz"),
    [PRODUCT_SITEMAP]: gunzip("./raw/costco-sitemap-p-mod-full.xml.gz"),
    [IPAD_AIR_URL]: IPAD_AIR,
    [MACBOOK_NEO_URL]: MACBOOK_NEO,
  };
  fetch(url: string): Promise<FetchResult> {
    const body =
      this.bodies[url] ??
      (url.startsWith("https://www.costco.com/p/-/")
        ? ANOTHER_PRODUCT
        : undefined);
    if (body === undefined)
      return Promise.reject(new FetchFailed(url, undefined, 502, 3));
    return Promise.resolve({ url, body, cached: true, attempts: 0 });
  }
}

const IPAD_NAME =
  "iPad Air 11-inch, 128GB Wi-Fi (M4 chip) Built For Apple Intelligence";

const resolve = (
  request: ResolveRequest,
  adapter: RetailerAdapter = costcoAdapter,
) => resolveItem(request, adapter, new CostcoFetcher());

describe("🔴 a Costco pairing carries the price of the item that matched", () => {
  it("the client's Space Gray iPad agrees with the item the page prices: verified at $649.99, from the product page", async () => {
    const r = await resolve({
      barcode: "195950823578",
      clientSku: "001339",
      productName: `${IPAD_NAME}, Space Gray`,
      partNumber: "MH304LL/A",
      brand: "Apple",
    });
    expect(r.outcome).toBe("verified");
    expect(r.match).toMatchObject({
      url: IPAD_AIR_URL,
      retailerBarcode: "195950823578",
      priceCents: 64999,
      priceSource: "product_page",
    });
  });

  it("🔴 the client's Starlight iPad agrees with a sibling the page does not price: verified, with no price", async () => {
    const r = await resolve({
      barcode: "195950824032",
      clientSku: "001354",
      productName: `${IPAD_NAME}, Starlight`,
      partNumber: null,
      brand: "Apple",
    });
    expect(r.outcome).toBe("verified");
    expect(r.match).toMatchObject({
      url: IPAD_AIR_URL,
      retailerBarcode: "195950824032",
      priceCents: null,
      priceSource: null,
    });
  });

  it("🔴 the MacBook Neo: the matched item is unpriced, and its priced sibling's $689.99 is never used", async () => {
    const r = await resolve({
      barcode: "195950851809",
      clientSku: "004069",
      productName:
        "MacBook Neo Laptop (13-inch) - Apple A18 Pro chip, Built for Apple Intelligence, 6-core CPU, 5-core GPU, 8GB Memory, 256GB SSD Storage, Citrus.",
      partNumber: "MHFD4LL/A",
      brand: "Apple",
    });
    expect(r.outcome).toBe("verified");
    expect(r.match).toMatchObject({
      url: MACBOOK_NEO_URL,
      retailerBarcode: "195950851809",
      priceCents: null,
      priceSource: null,
    });
  });

  it("matches the per-barcode price whatever encoding the client wrote", async () => {
    // The client's barcode as a GTIN-14; the page states a UPC-A.
    const r = await resolve({
      barcode: "00195950823578",
      clientSku: "001339",
      productName: `${IPAD_NAME}, Space Gray`,
      partNumber: "MH304LL/A",
      brand: "Apple",
    });
    expect(r.outcome).toBe("verified");
    expect(r.match?.priceCents).toBe(64999);
  });

  it("🔴 where a page prices per barcode, an unpriced barcode never takes the page's one price", async () => {
    // An adapter breaking the rule that `priceCents` is null beside
    // per-barcode prices: the pairing still takes only its own item's price.
    const alsoOnePrice: RetailerAdapter = {
      ...costcoAdapter,
      parseProductPage: (html: string): ParsedProduct | null => {
        const p = costcoAdapter.parseProductPage(html);
        if (p === null) return null;
        return p.barcodePrices === undefined ? p : { ...p, priceCents: 68999 };
      },
    };
    const r = await resolve(
      {
        barcode: "195950824032",
        clientSku: "001354",
        productName: `${IPAD_NAME}, Starlight`,
        partNumber: null,
        brand: "Apple",
      },
      alsoOnePrice,
    );
    expect(r.outcome).toBe("verified");
    expect(r.match).toMatchObject({ priceCents: null, priceSource: null });
  });

  it("CONTROL: an adapter stating no per-barcode price keeps the page's one price", async () => {
    // The same pages, with the per-barcode price taken away: the pairing
    // falls back to `priceCents`, which is null on a page of several items.
    const withoutPerBarcode: RetailerAdapter = {
      ...costcoAdapter,
      parseProductPage: (html: string): ParsedProduct | null => {
        const p = costcoAdapter.parseProductPage(html);
        if (p === null) return null;
        const { barcodePrices: _dropped, ...rest } = p;
        return rest;
      },
    };
    const r = await resolve(
      {
        barcode: "195950823578",
        clientSku: "001339",
        productName: `${IPAD_NAME}, Space Gray`,
        partNumber: "MH304LL/A",
        brand: "Apple",
      },
      withoutPerBarcode,
    );
    expect(r.outcome).toBe("verified");
    expect(r.match).toMatchObject({ priceCents: null, priceSource: null });
  });
});
