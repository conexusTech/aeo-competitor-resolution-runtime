import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { amazonAdapter } from "../src/adapters/amazon.js";
import { bestbuyAdapter } from "../src/adapters/bestbuy.js";
import { bhAdapter } from "../src/adapters/bh.js";
import { costcoAdapter } from "../src/adapters/costco.js";
import { neweggAdapter } from "../src/adapters/newegg.js";
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
 * 🔴 **Who sells a listing comes from the page that proved it**, where the
 * search card does not say.
 *
 * Best Buy hydrates only the first few cards of a search server-side; the rest
 * carry a SKU and no seller, so their `isFirstParty` is `null` — unknown. The
 * product page states `seller.classification` (`1P` Best Buy, `3P` a
 * marketplace seller), and the evidence ignored it: a Best Buy first-party
 * listing found on an unhydrated card was stored as unknown, which the gateway
 * persists as a marketplace listing.
 */

const raw = (name: string): string =>
  gunzipSync(
    readFileSync(fileURLToPath(new URL(`./raw/${name}.gz`, import.meta.url))),
  ).toString("utf8");

const M310_PAGE = raw("bestbuy-pdp-m310.html");
const BK350_PAGE = raw("bestbuy-pdp-marketplace-bk350.html");
const M310_URL =
  "https://www.bestbuy.com/product/logitech-m310-wireless-optical-ambidextrous-mouse-wireless-silver/J7H7ZLV3V9/sku/1297054";
const BK350_URL =
  "https://www.bestbuy.com/product/apc-6-outlet-rj11-telco-350va-210w-back-ups-cs-tower-1020j-avr-bk350-beige/JXKZP6GJJF/sku/11521676";

describe("parseProductPage states who sells the page's offer", () => {
  it("Best Buy reads its page's seller classification", () => {
    expect(bestbuyAdapter.parseProductPage(M310_PAGE)?.isFirstParty).toBe(true);
    expect(bestbuyAdapter.parseProductPage(BK350_PAGE)?.isFirstParty).toBe(
      false,
    );
  });

  it("B&H and Costco sell everything they list: true", () => {
    expect(
      bhAdapter.parseProductPage(raw("bh-pdp-m310.html"))?.isFirstParty,
    ).toBe(true);
    expect(
      costcoAdapter.parseProductPage(raw("costco-pdp-sl900uc.html"))
        ?.isFirstParty,
    ).toBe(true);
  });

  it("Newegg and Amazon do not read it from the page: null", () => {
    // A body each recognises as its own product page.
    const newegg = (
      JSON.parse(
        gunzipSync(
          readFileSync(
            fileURLToPath(
              new URL("./corpus/launch-retailer-53.json.gz", import.meta.url),
            ),
          ),
        ).toString("utf8"),
      ) as { entries: { url: string; body: string }[] }
    ).entries
      .map((e) => neweggAdapter.parseProductPage(e.body))
      .find((p) => p !== null);
    expect(newegg).toBeDefined();
    expect(newegg?.isFirstParty).toBeNull();
    const amazon = amazonAdapter.parseProductPage(
      raw("amazon-pdp-gtin-labelled.html"),
    );
    expect(amazon).not.toBeNull();
    expect(amazon?.isFirstParty).toBeNull();
  });
});

/** An unhydrated Best Buy card: a SKU and a url, no seller. */
const unhydrated = (itemId: string, url: string): ParsedCandidate => ({
  itemId,
  url,
  model: null,
  title: "Logitech mouse",
  brand: null,
  priceCents: null,
  inStock: null,
  isFirstParty: null,
  sellerName: null,
  imageUrl: null,
  partialMatch: false,
});

const withCard = (card: ParsedCandidate): RetailerAdapter => ({
  ...bestbuyAdapter,
  parseSearchResults: () => [card],
});

const serving = (bodies: Record<string, string>): Fetcher => ({
  liveRequestCount: 0,
  pagesDelivered: 0,
  fetch(url: string): Promise<FetchResult> {
    const body = url.includes("/searchpage.jsp") ? "SEARCH" : bodies[url];
    if (body === undefined)
      return Promise.reject(new FetchFailed(url, undefined, 502, 3));
    return Promise.resolve({ url, body, cached: true, attempts: 0 });
  },
});

describe("🔴 the evidence takes the page's seller class over an unknown card's", () => {
  it("an unhydrated card whose page says 1P is first party, sold by Best Buy", async () => {
    expect(bestbuyAdapter.buildSearchUrl("097855066237")).toContain(
      "/searchpage.jsp",
    );
    const r = await resolveItem(
      { barcode: "097855066237", clientSku: "SKU-M310" },
      withCard(unhydrated("1297054", M310_URL)),
      serving({ [M310_URL]: M310_PAGE }),
      DEFAULT_OPTIONS,
    );
    expect(r.outcome).toBe("verified");
    expect(r.match?.isFirstParty).toBe(true);
    expect(r.match?.sellerName).toBe("Best Buy");
  });

  it("an unhydrated card whose page says 3P is a marketplace listing, with its seller", async () => {
    const r = await resolveItem(
      { barcode: "731304016298", clientSku: "SKU-BK350" },
      withCard(unhydrated("11521676", BK350_URL)),
      serving({ [BK350_URL]: BK350_PAGE }),
      DEFAULT_OPTIONS,
    );
    expect(r.outcome).toBe("verified");
    expect(r.match?.isFirstParty).toBe(false);
    expect(r.match?.sellerName).toBe("IPC-STORE");
  });
});
