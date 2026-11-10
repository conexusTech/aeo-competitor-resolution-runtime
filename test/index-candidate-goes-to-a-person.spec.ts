import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { costcoAdapter, SITEMAP_INDEX } from "../src/adapters/costco.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchResult,
} from "../src/fetcher/types.js";
import { DEFAULT_OPTIONS, resolveItem } from "../src/resolve.js";
import investigation from "./fixtures/costco-investigation-20.json" with { type: "json" };

/**
 * 🔴 **Jody's rule: a candidate without a barcode match goes to a person.**
 *
 * Costco's sitemap states no model, so a candidate from its product index
 * carries none — and before this, no index candidate could ever clear the
 * part-number evidence floor, so one whose page publishes no UPC ended
 * `not-found`: filed as not carried, when it is exactly the listing a person
 * should look at.
 *
 * 🔑 **For a candidate from a product index, the lead word it matched by —
 * the item's brand, or its product line — is the floor for `unverifiable`
 * only.** It never makes a pairing `unconfirmed` (a page whose UPC disagrees
 * is another product), and nothing but an agreeing barcode verifies.
 */

const dir = (rel: string): string =>
  fileURLToPath(new URL(rel, import.meta.url));
const gunzip = (rel: string): string =>
  gunzipSync(readFileSync(dir(rel))).toString("utf8");

const airpods = investigation.airpods;
const PRODUCT_SITEMAP = "https://www.costco.com/sitemap_lw_p_mod_001.xml";
const CATALOGUE = "https://catalogue.test/item/{sku}";
const AIRPODS_URL =
  "https://www.costco.com/p/-/airpods-4-with-active-noise-cancellation/4000308504";
const AIRPODS_PAGE = gunzip("./raw/costco-pdp-airpods-4-anc.html.gz");
/** A real Costco page stating another product's UPC. */
const ANOTHER_PRODUCT = gunzip("./raw/costco-pdp-sl900uc.html.gz");

/** The AirPods page as Costco would serve it with its item's UPC left out. */
const WITHOUT_UPC = AIRPODS_PAGE.replace(
  '\\"upc\\":\\"195949689604\\"',
  '\\"upc\\":\\"\\"',
);
/** …and with a UPC that is not the client's. */
const OTHER_UPC = AIRPODS_PAGE.replace(
  '\\"upc\\":\\"195949689604\\"',
  '\\"upc\\":\\"012345678905\\"',
);

class CostcoFetcher implements Fetcher {
  liveRequestCount = 0;
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  private readonly bodies: Record<string, string>;
  constructor(airpodsPage: string) {
    this.bodies = {
      [SITEMAP_INDEX]: gunzip("./raw/costco-sitemap-index.xml.gz"),
      [PRODUCT_SITEMAP]: gunzip("./raw/costco-sitemap-p-mod-full.xml.gz"),
      [CATALOGUE.replace("{sku}", airpods.microCenterSku)]:
        `<script type="application/ld+json">${JSON.stringify({
          "@type": "Product",
          sku: airpods.microCenterSku,
          mpn: airpods.mpn,
          brand: { "@type": "Brand", name: airpods.brand },
        })}</script>`,
      [AIRPODS_URL]: airpodsPage,
    };
  }
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

const resolveAirpods = (page: string) =>
  resolveItem(
    {
      barcode: airpods.upc,
      clientSku: airpods.microCenterSku,
      productName: airpods.productName,
    },
    costcoAdapter,
    new CostcoFetcher(page),
    { ...DEFAULT_OPTIONS, clientCatalogueUrlTemplate: CATALOGUE },
  );

describe("🔴 a Costco index candidate whose page publishes no UPC", () => {
  it("the pages are what they say", () => {
    expect(WITHOUT_UPC).not.toBe(AIRPODS_PAGE);
    expect(costcoAdapter.parseProductPage(WITHOUT_UPC)?.barcode).toBeNull();
    expect(costcoAdapter.parseProductPage(OTHER_UPC)?.barcode).toBe(
      "012345678905",
    );
    expect(costcoAdapter.parseProductPage(ANOTHER_PRODUCT)?.barcode).toBe(
      "649532936564",
    );
  });

  it("goes to a person as unverifiable, never not found", async () => {
    const r = await resolveAirpods(WITHOUT_UPC);
    expect(r.outcome).toBe("unverifiable");
    expect(r.failure).toBeNull();
    expect(r.match).toMatchObject({
      itemId: "4000308504",
      url: AIRPODS_URL,
      retailerBarcode: null,
      // Its name has no "apple": never read into it.
      brand: null,
    });
  });

  it("🔴 a page whose UPC disagrees is never unconfirmed: another product, not a lead", async () => {
    const r = await resolveAirpods(OTHER_UPC);
    expect(r.outcome).toBe("not-found");
    expect(r.match).toBeNull();
    expect(r.failure).toBeNull();
  });

  it("CONTROL: with its UPC, it verifies", async () => {
    const r = await resolveAirpods(AIRPODS_PAGE);
    expect(r.outcome).toBe("verified");
  });
});
