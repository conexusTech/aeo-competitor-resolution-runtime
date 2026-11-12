import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  COSTCO_PRODUCT_INDEX,
  costcoAdapter,
  indexCandidates,
  isCostcoInternalUpc,
  parseProductPage,
  parseSearchResults,
  parseSitemap,
  parseSitemapIndex,
  readListingPage,
  SITEMAP_INDEX,
} from "../src/adapters/costco.js";
import type { ProductIndexEntry } from "../src/adapters/types.js";

/**
 * The Costco adapter, on Costco's own pages (`test/raw/costco-*`, distilled
 * from the investigation's captures and proven to parse as the raw did).
 *
 * Where a case was never seen on a real page — several items on one product
 * — the page is SYNTHETIC, built in Costco's own format, and says so.
 */

const raw = (name: string): string =>
  gunzipSync(
    readFileSync(fileURLToPath(new URL(`./raw/${name}.gz`, import.meta.url))),
  ).toString("utf8");

const SL900 = raw("costco-pdp-sl900uc.html");
const CST1500 = raw("costco-pdp-cst1500suc-internal-parent-upc.html");
const GOLD_BAR = raw("costco-pdp-gold-bar-member-only.html");
const SHELL = raw("costco-pdp-shell-no-slug.html");
const AIRPODS = raw("costco-pdp-airpods-4-anc.html");
const IPAD_AIR = raw("costco-pdp-ipad-air-11-several-items.html");
const MACBOOK_NEO = raw("costco-pdp-macbook-neo-sibling-priced.html");
const SEARCH = raw("costco-search-upc-649532936564.html");
const INDEX = raw("costco-sitemap-index.xml");
const EXCERPT = raw("costco-sitemap-p-mod-excerpt.xml");
const FULL = raw("costco-sitemap-p-mod-full.xml");

/** A SYNTHETIC product page in Costco's format: flight data and JSON-LD. */
function page(details: unknown, ld: unknown = null): string {
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
  ...over,
});
const priced = (id: string, dollars: number) => ({
  id,
  displayPrice: { onlinePrice: dollars, aggregatedDiscountAmt: 0 },
});

describe("Costco's configuration", () => {
  it("never searches: a product index, and neither barcode nor part number searchable", () => {
    expect(costcoAdapter.slug).toBe("costco");
    expect(costcoAdapter.querySupport).toEqual({
      maxNumericQueryDigits: null,
      barcodeIsSearchable: false,
      partNumberNeedsBrand: false,
    });
    expect(costcoAdapter.productIndex).toBe(COSTCO_PRODUCT_INDEX);
    expect(COSTCO_PRODUCT_INDEX.urls).toEqual([
      "https://www.costco.com/sitemap_lw_index.xml",
    ]);
    // 🔴 It lists one product file today; a list naming more than five is
    // refused rather than read (security finding 4).
    expect(COSTCO_PRODUCT_INDEX.maxFiles).toBe(5);
    expect(parseSitemapIndex(INDEX)?.length ?? 0).toBeLessThanOrEqual(
      COSTCO_PRODUCT_INDEX.maxFiles,
    );
  });

  it("is read four pages at once, from the us, with a 280 s timeout and three probes", () => {
    expect(costcoAdapter.pacing).toEqual({ pagesAtOnce: 4 });
    expect(costcoAdapter.fetchProfile).toEqual({
      country: "us",
      timeoutMs: 280_000,
    });
    expect(costcoAdapter.maxProbes).toBe(3);
    expect(costcoAdapter.hosts).toEqual(["www.costco.com"]);
  });

  it("🔴 never reaches Costco's internal catalogue API, only its website", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/adapters/costco.ts", import.meta.url)),
      "utf8",
    );
    // Named in prose as the thing never called; never in a url built here.
    const code = source
      .split("\n")
      .filter((l) => !/^\s*(?:\*|\/\*|\/\/)/.test(l))
      .join("\n");
    expect(code).not.toContain("gdx-api");
    expect(costcoAdapter.buildSearchUrl("SL900UC")).toBe(
      "https://www.costco.com/s?keyword=SL900UC",
    );
  });
});

describe("search", () => {
  it("🔴 a search page is a shell: nobody answered, never 'not carried'", () => {
    // SL900UC's own UPC, which Costco sells.
    expect(parseSearchResults(SEARCH)).toBeNull();
    expect(parseSearchResults("")).toBeNull();
  });
});

describe("parseProductPage", () => {
  it("reads the item's UPC and the shown price, sold by Costco", () => {
    expect(parseProductPage(SL900)).toEqual({
      barcode: "649532936564",
      additionalBarcodes: [],
      priceCents: 6997,
      inStock: null,
      title:
        "CyberPower 900VA/450W Simulated Sine Wave Slim UPS Battery Backup with Surge Protection",
      sellerName: "Costco",
      isFirstParty: true,
      unverifiableReason: null,
      // Costco has no category reads, so no listing is placed in one.
      category: null,
    });
  });

  it("🔴 a Costco-internal parent UPC is never published as a barcode", () => {
    const p = parseProductPage(CST1500);
    expect(CST1500).toContain("499995717503");
    expect(p?.barcode).toBe("649532935468");
    expect(p?.additionalBarcodes).toEqual([]);
    expect(p?.priceCents).toBe(20999);
  });

  it("🔴 a member-only item has no price, though its source holds one", () => {
    const p = parseProductPage(GOLD_BAR);
    expect(GOLD_BAR).toContain("4089.99");
    expect(p?.priceCents).toBeNull();
    // Its only number is Costco's own: no barcode at all.
    expect(p?.barcode).toBeNull();
    expect(p?.additionalBarcodes).toEqual([]);
  });

  it("🔴 the product app with no product in it is not a product page", () => {
    expect(parseProductPage(SHELL)).toBeNull();
    expect(parseProductPage(SEARCH)).toBeNull();
    expect(parseProductPage("")).toBeNull();
  });

  it("reads the AirPods page the investigation proved by UPC", () => {
    const p = parseProductPage(AIRPODS);
    expect(p?.barcode).toBe("195949689604");
    expect(p?.priceCents).toBe(9997);
    expect(p?.inStock).toBeNull();
  });

  it("states no stock, whatever its JSON-LD availability says", () => {
    // The AirPods page's JSON-LD says InStock and the investigation saw
    // OutOfStock on in-stock items: neither is a signal.
    for (const body of [SL900, CST1500, GOLD_BAR, AIRPODS]) {
      expect(parseProductPage(body)?.inStock).toBeNull();
    }
  });

  it("SYNTHETIC: every item's UPC, items first, the parent's last", () => {
    const p = parseProductPage(
      page({
        productData: {
          id: "9",
          upc: "000000000017",
          childCatalogData: [
            item("111", "036000291452"),
            item("112", "4000000000112"),
          ],
        },
        priceInfo: priced("111", 10),
      }),
    );
    expect(p?.barcode).toBe("036000291452");
    expect(p?.additionalBarcodes).toEqual(["000000000017"]);
  });
});

/**
 * 🔴 **A page listing several items prices the one that matched, and only
 * that one.** `priceCents` answers for every barcode a page publishes, so it is
 * `null` on a page whose items (colours, versions) are not all priced; the
 * per-barcode price is what lets the pairing proven by ONE item's barcode carry
 * that item's price. `parseProductPage` never sees the client's barcode, so it
 * prices every barcode it publishes and the comparison picks.
 */
describe("🔴 a price per barcode, on a page listing several items", () => {
  it("the iPad Air page: four colours, priceInfo pricing item 2042802 at $649.99", () => {
    // What the page itself states, read before the parse is trusted.
    for (const id of ["2042802", "2042803", "2042804", "2042805"]) {
      expect(IPAD_AIR).toContain(`\\"id\\":\\"${id}\\"`);
    }
    expect(IPAD_AIR).toContain('\\"priceInfo\\":{\\"id\\":\\"2042802\\"');
    expect(IPAD_AIR).toContain("649.99");
  });

  it("prices the barcode of the item priceInfo prices, and no sibling's", () => {
    const p = parseProductPage(IPAD_AIR);
    expect(p?.barcode).toBe("195950823578");
    expect(p?.barcodePrices).toEqual([
      { barcode: "195950823578", priceCents: 64999 },
      { barcode: "195950824032", priceCents: null },
      { barcode: "195950823806", priceCents: null },
      { barcode: "195950824261", priceCents: null },
    ]);
  });

  it("🔴 keeps `priceCents` null: it answers for every barcode, and the siblings are unpriced", () => {
    expect(parseProductPage(IPAD_AIR)?.priceCents).toBeNull();
    // A read job carries no barcode to pick with: still unreadable.
    expect(readListingPage(IPAD_AIR).kind).toBe("unreadable-offer");
  });

  it("🔴 the MacBook Neo page: the matched item 2046718 is unpriced, its priced sibling 2046716 never lends it a price", () => {
    expect(MACBOOK_NEO).toContain('\\"priceInfo\\":{\\"id\\":\\"2046716\\"');
    const p = parseProductPage(MACBOOK_NEO);
    // 2046716 states only Costco's own 49999… number, so publishes no barcode.
    expect(p?.barcode).toBe("195950851809");
    expect(p?.barcodePrices).toEqual([
      { barcode: "195950851809", priceCents: null },
      { barcode: "195950853681", priceCents: null },
    ]);
    expect(p?.priceCents).toBeNull();
  });

  it("SYNTHETIC: a JSON-LD offer naming a sibling's sku prices that sibling", () => {
    const p = parseProductPage(
      page(
        {
          productData: {
            id: "9",
            childCatalogData: [
              item("111", "036000291452"),
              item("112", "036000291469"),
            ],
          },
          priceInfo: priced("111", 10),
        },
        {
          "@type": "Product",
          offers: [
            { "@type": "Offer", sku: "111", price: 10 },
            { "@type": "Offer", sku: "112", price: 12 },
          ],
        },
      ),
    );
    expect(p?.barcodePrices).toEqual([
      { barcode: "036000291452", priceCents: 1000 },
      { barcode: "036000291469", priceCents: 1200 },
    ]);
  });

  it("🔴 SYNTHETIC: a barcode two items carry is unpriced unless both show one price", () => {
    // 112 carries 111's UPC and the page does not price it: the barcode
    // could be either item, so it has no price of its own.
    const p = parseProductPage(
      page({
        productData: {
          id: "9",
          childCatalogData: [
            item("111", "036000291452"),
            item("112", "036000291452"),
          ],
        },
        priceInfo: priced("111", 10),
      }),
    );
    expect(p?.barcodePrices).toEqual([
      { barcode: "036000291452", priceCents: null },
    ]);
  });

  it("🔴 SYNTHETIC: a JSON-LD price is never credited to priceInfo's item when the JSON-LD names another sku", () => {
    // priceInfo's own price nets to nothing (10 - 10), so the page's price
    // falls back to the JSON-LD offer — which is item 112's, not 111's.
    const p = parseProductPage(
      page(
        {
          productData: {
            id: "9",
            childCatalogData: [
              item("111", "036000291452"),
              item("112", "036000291469"),
            ],
          },
          priceInfo: {
            id: "111",
            displayPrice: { onlinePrice: 10, aggregatedDiscountAmt: 10 },
          },
        },
        { "@type": "Product", sku: "112", offers: { price: 12 } },
      ),
    );
    // A single offer object names no sku of its own, so 112 is not priced
    // by the offer-by-sku path either.
    expect(p?.barcodePrices).toEqual([
      { barcode: "036000291452", priceCents: null },
      { barcode: "036000291469", priceCents: null },
    ]);
  });

  it("CONTROL: a JSON-LD price is credited to priceInfo's item when the JSON-LD names it, or no sku", () => {
    for (const sku of ["111", undefined]) {
      const p = parseProductPage(
        page(
          {
            productData: {
              id: "9",
              childCatalogData: [
                item("111", "036000291452"),
                item("112", "036000291469"),
              ],
            },
            priceInfo: {
              id: "111",
              displayPrice: { onlinePrice: 10, aggregatedDiscountAmt: 10 },
            },
          },
          { "@type": "Product", sku, offers: { price: 12 } },
        ),
      );
      expect(p?.barcodePrices, String(sku)).toEqual([
        { barcode: "036000291452", priceCents: 1200 },
        { barcode: "036000291469", priceCents: null },
      ]);
    }
  });

  it("🔴 SYNTHETIC: member-only or in-cart-only, no barcode is priced", () => {
    for (const flag of [
      { isMembershipReqd: true },
      { dispPriceInCartOnly: 1 },
    ]) {
      const p = parseProductPage(
        page({
          productData: {
            id: "9",
            childCatalogData: [
              item("111", "036000291452", flag),
              item("112", "036000291469"),
            ],
          },
          priceInfo: priced("111", 10),
        }),
      );
      expect(p?.barcode).toBe("036000291452");
      expect(p?.priceCents).toBeNull();
      expect(
        (p?.barcodePrices ?? []).filter((b) => b.priceCents !== null),
      ).toEqual([]);
    }
  });

  it("🔴 the member-only gold bar prices no barcode", () => {
    const p = parseProductPage(GOLD_BAR);
    expect(
      (p?.barcodePrices ?? []).filter((b) => b.priceCents !== null),
    ).toEqual([]);
  });

  it("a page whose one price answers for every barcode states none per barcode", () => {
    // `priceCents` already says it: nothing per barcode to add.
    expect(parseProductPage(SL900)?.barcodePrices).toBeUndefined();
    expect(parseProductPage(AIRPODS)?.barcodePrices).toBeUndefined();
  });
});

describe("Costco's own numbers", () => {
  it("are `4` and one of the page's item numbers, or a 49999… value", () => {
    expect(isCostcoInternalUpc("4000001814005", ["1814005"])).toBe(true);
    // 🔴 The form the investigation's rule missed, on a real Logitech page.
    expect(isCostcoInternalUpc("4000002037132", ["2037132"])).toBe(true);
    expect(isCostcoInternalUpc("499995717503", [])).toBe(true);
  });

  it("never swallow a real barcode", () => {
    expect(isCostcoInternalUpc("649532935468", ["1705111"])).toBe(false);
    // A real German EAN-13 starts 400: not Costco's unless it spells an item.
    expect(isCostcoInternalUpc("4006381333931", ["1705111"])).toBe(false);
    expect(isCostcoInternalUpc("5099206088719", ["2037132"])).toBe(false);
  });

  it("🔴 on a page stating no item numbers, a 4000001… or 4000002… value is Costco's own (review finding 13)", () => {
    // With no item to spell, the form alone says it: Costco's `4` and an
    // item number, zero-padded — absent, never a barcode that disagrees.
    expect(isCostcoInternalUpc("4000001939040", [])).toBe(true);
    expect(isCostcoInternalUpc("4000002037132", [])).toBe(true);
  });

  it("CONTROL: a real 400… EAN-13 is still a barcode, item numbers or none", () => {
    expect(isCostcoInternalUpc("4006381333931", [])).toBe(false);
    expect(isCostcoInternalUpc("4005808817603", [])).toBe(false);
    expect(isCostcoInternalUpc("4000003123456", [])).toBe(false);
    // Twelve digits is not that form.
    expect(isCostcoInternalUpc("400000193904", [])).toBe(false);
  });

  it("🔴 a parent-only page's 4000001… UPC is never published as its barcode", () => {
    // SYNTHETIC: a product with no child items, whose only UPC is internal.
    const p = parseProductPage(
      page({
        productData: { id: "4000999999", upc: "4000001939040" },
        priceInfo: priced("4000999999", 19.99),
      }),
    );
    expect(p).not.toBeNull();
    expect(p?.barcode).toBeNull();
    expect(p?.additionalBarcodes).toEqual([]);
  });
});

describe("readListingPage", () => {
  it("reads the page's product id, barcode and price", () => {
    expect(readListingPage(SL900)).toEqual({
      kind: "page",
      page: {
        pageItemId: "4000193283",
        barcode: "649532936564",
        additionalBarcodes: [],
        priceCents: 6997,
        inStock: null,
        category: null,
      },
    });
  });

  it("🔴 a member-only price is the page's answer: a page with no price, not a failure", () => {
    const r = readListingPage(GOLD_BAR);
    expect(r.kind).toBe("page");
    expect(r.kind === "page" ? r.page.priceCents : 0).toBeNull();
  });

  it("refuses a shell and a search as not a product page", () => {
    expect(readListingPage(SHELL).kind).toBe("not-a-product-page");
    expect(readListingPage(SEARCH).kind).toBe("not-a-product-page");
    expect(readListingPage("<html></html>").kind).toBe("not-a-product-page");
  });

  it("🔴 SYNTHETIC: several items at different prices is an unreadable offer", () => {
    const body = page(
      {
        productData: {
          id: "9",
          childCatalogData: [
            item("111", "036000291452"),
            item("112", "036000291469"),
          ],
        },
        priceInfo: priced("111", 10),
      },
      {
        "@type": "Product",
        offers: [
          { "@type": "Offer", sku: "111", price: 10 },
          { "@type": "Offer", sku: "112", price: 12 },
        ],
      },
    );
    expect(readListingPage(body).kind).toBe("unreadable-offer");
    expect(parseProductPage(body)?.priceCents).toBeNull();
  });

  it("SYNTHETIC: several items whose other prices are not stated is unreadable too", () => {
    const body = page({
      productData: {
        id: "9",
        childCatalogData: [
          item("111", "036000291452"),
          item("112", "036000291469"),
        ],
      },
      priceInfo: priced("111", 10),
    });
    expect(readListingPage(body).kind).toBe("unreadable-offer");
  });

  it("SYNTHETIC: several items all at one price show that price", () => {
    const body = page(
      {
        productData: {
          id: "9",
          childCatalogData: [
            item("111", "036000291452"),
            item("112", "036000291469"),
          ],
        },
        priceInfo: priced("111", 10),
      },
      {
        "@type": "Product",
        offers: [
          { "@type": "Offer", sku: "111", price: 10 },
          { "@type": "Offer", sku: "112", price: 10 },
        ],
      },
    );
    const r = readListingPage(body);
    expect(r.kind === "page" ? r.page.priceCents : null).toBe(1000);
    expect(parseProductPage(body)?.priceCents).toBe(1000);
  });

  it("SYNTHETIC: a product page with no price anywhere is an unreadable offer", () => {
    const body = page({
      productData: { id: "9", childCatalogData: [item("111", "036000291452")] },
    });
    expect(readListingPage(body).kind).toBe("unreadable-offer");
  });
});

describe("the product index", () => {
  it("names only the /p/-/ product sitemaps the index lists", () => {
    expect(INDEX.length).toBe(1547);
    expect(parseSitemapIndex(INDEX)).toEqual([
      "https://www.costco.com/sitemap_lw_p_mod_001.xml",
    ]);
    expect(SITEMAP_INDEX).toBe("https://www.costco.com/sitemap_lw_index.xml");
  });

  it("🔴 a body that is not a sitemap index or a sitemap is refused", () => {
    expect(parseSitemapIndex(EXCERPT)).toBeNull();
    expect(parseSitemapIndex(SL900)).toBeNull();
    expect(parseSitemap(INDEX)).toBeNull();
    expect(parseSitemap(SL900)).toBeNull();
  });

  it("reads each product's id, url and name", () => {
    const entries = parseSitemap(EXCERPT) ?? [];
    expect(entries).toHaveLength(40);
    expect(entries.find((e) => e.itemId === "4000193283")).toEqual({
      itemId: "4000193283",
      url: "https://www.costco.com/p/-/cyberpower-900va450w-simulated-sine-wave-slim-ups-battery-backup-with-surge-protection/4000193283",
      name: "cyberpower 900va450w simulated sine wave slim ups battery backup with surge protection",
    });
  });

  it("holds the whole catalogue, above its least", () => {
    const entries = parseSitemap(FULL) ?? [];
    expect(entries).toHaveLength(18_180);
    expect(entries.length).toBeGreaterThanOrEqual(
      COSTCO_PRODUCT_INDEX.minEntries,
    );
    expect(COSTCO_PRODUCT_INDEX.minListBytes).toBeLessThan(INDEX.length);
  });
});

describe("candidates from the index", () => {
  const entries: readonly ProductIndexEntry[] = parseSitemap(FULL) ?? [];
  const find = (brand: string | null, productName: string, parts = []) =>
    indexCandidates(entries, { brand, partNumbers: parts, productName });

  it("🔴 finds AirPods, whose name has no 'apple', first — and sets no brand on it", () => {
    const c = find(
      "Apple",
      "Apple AirPods 4 Active Noise Cancelling True Wireless Bluetooth Earbuds - White",
    );
    expect(c[0]?.itemId).toBe("4000308504");
    expect(c[0]?.brand).toBeNull();
    expect(c[0]?.url).toBe(
      "https://www.costco.com/p/-/airpods-4-with-active-noise-cancellation/4000308504",
    );
    // Apple's own names lead with the brand, and carry it.
    const apple = c.filter((x) => x.title.startsWith("apple "));
    expect(apple.length).toBeGreaterThan(0);
    expect(apple.every((x) => x.brand === "Apple")).toBe(true);
  });

  it("leads with the brand, and shares a word of what the product is", () => {
    const c = find(
      "CyberPower Systems",
      "CyberPower Systems AVR Series UPS (CP1200AVR); 1200 VA, 720 W, 120 V; 10 Outlets; GreenPower UPS; Automatic Voltage",
    );
    expect(c.map((x) => x.itemId)).toEqual(["4000091462", "4000193283"]);
    expect(c.every((x) => x.brand === "CyberPower Systems")).toBe(true);
    // CyberPowerPC is another company, never a candidate.
    expect(c.some((x) => x.title.startsWith("cyberpowerpc"))).toBe(false);
  });

  it("🔴 a brand's product of another kind is not a candidate", () => {
    // Kensington's one Costco product is a wine cabinet; Logitech's has no
    // speaker, and a colour word ("black") is not what a product is.
    expect(
      find("Kensington", "Kensington Orbit Trackball with Scroll Ring"),
    ).toEqual([]);
    expect(
      find("Logitech", "Logitech Z623 2.1 Channel Computer Speakers - Black"),
    ).toEqual([]);
  });

  it("🔴 another brand's product sharing words is not a candidate", () => {
    // The H390 headset and AirPods share "noise cancellation"; Bose's
    // earbuds share AirPods' words. A name that leads with neither the brand
    // nor a product line of the item's own name is never one.
    const h390 = find(
      "Logitech",
      "Logitech H390 ClearChat Comfort USB Headset - Black; Noise Cancellation Microphone; Inline Volume; Mute Controls",
    );
    expect(h390.map((x) => x.itemId)).toEqual(["4000447843"]);
    const airpods = find(
      "Apple",
      "Apple AirPods 4 Active Noise Cancelling True Wireless Bluetooth Earbuds - White",
    );
    expect(airpods.some((x) => x.title.startsWith("bose"))).toBe(false);
    expect(airpods.some((x) => x.title.startsWith("true "))).toBe(false);
  });

  it("puts a name that spells the part number first", () => {
    const fake: ProductIndexEntry[] = [
      { itemId: "1", url: "u1", name: "logitech mx keyboard and mouse combo" },
      {
        itemId: "2",
        url: "u2",
        name: "logitech m310 wireless mouse 910 001675",
      },
    ];
    expect(
      indexCandidates(fake, {
        brand: "Logitech",
        partNumbers: ["910-001675"],
        productName: "Logitech M310 Wireless Laser Mouse - Silver",
      }).map((x) => x.itemId),
    ).toEqual(["2", "1"]);
  });

  it("states what the index says and nothing more", () => {
    for (const c of find(
      "Logitech",
      "Logitech M310 Wireless Laser Mouse - Silver",
    )) {
      expect(c).toMatchObject({
        model: null,
        priceCents: null,
        inStock: null,
        isFirstParty: true,
        sellerName: "Costco",
        imageUrl: null,
      });
    }
  });

  it("with neither a brand nor a name, finds nothing", () => {
    expect(find(null, "")).toEqual([]);
  });
});

/**
 * The proven pairs of the Global Organization demo (the investigation's
 * `demo-matches.json`): the Micro Center row's brand, name and part number,
 * and the Costco url its barcode proved. Ten of the fifteen are in the full
 * sitemap fixture; the other five Costco has since dropped from its sitemap.
 */
const COSTCO = "https://www.costco.com/p/-/";
const PROVEN: readonly {
  sku: string;
  brand: string;
  name: string;
  part: string;
  url: string;
  /** Whether the proven url ranks FIRST, not merely within three. */
  first: boolean;
}[] = [
  {
    sku: "001339",
    brand: "Apple",
    name: "iPad Air 11-inch, 128GB Wi-Fi (M4 chip) Built For Apple Intelligence, Space Gray",
    part: "MH304LL/A",
    url: `${COSTCO}ipad-air-11-inch-128gb-wi-fi-m4-chip-built-for-apple-intelligence/4000444349`,
    first: true,
  },
  {
    sku: "001420",
    brand: "Apple",
    name: "iPad Air 13-inch, 128GB Wi-Fi (M4 chip) Built For Apple Intelligence, Space Gray",
    part: "MH5N4LL/A",
    url: `${COSTCO}ipad-air-13-inch-128gb-wi-fi-m4-chip-built-for-apple-intelligence/4000444330`,
    first: true,
  },
  {
    sku: "001479",
    brand: "Apple",
    name: "iPad Air 13-inch, 256GB Wi-Fi (M4 chip) Built For Apple Intelligence, Space Gray",
    part: "MH5U4LL/A",
    url: `${COSTCO}ipad-air-13-inch-256gb-wi-fi-m4-chip-built-for-apple-intelligence/4000444398`,
    first: true,
  },
  {
    sku: "001370",
    brand: "Apple",
    name: "iPad Air 11-inch, 256GB Wi-Fi (M4 chip) Built For Apple Intelligence, Space Gray",
    part: "MH354LL/A",
    url: `${COSTCO}ipad-air-11-inch-256gb-wi-fi-m4-chip-built-for-apple-intelligence/4000444378`,
    first: true,
  },
  {
    sku: "941617",
    brand: "Apple",
    name: "iPad Pro 11-inch, 256GB Wi-Fi (M5 chip) Built For Apple Intelligence, Space Black",
    part: "MDWK4LL/A",
    url: `${COSTCO}ipad-pro-11-inch-256gb-wi-fi-m5-chip-built-for-apple-intelligence/4000285636`,
    first: true,
  },
  {
    sku: "941641",
    brand: "Apple",
    name: "iPad Pro 13-inch, 256GB Wi-Fi (M5 chip) Built For Apple Intelligence, Space Black",
    part: "MDYJ4LL/A",
    url: `${COSTCO}ipad-pro-13-inch-256gb-wi-fi-m5-chip-built-for-apple-intelligence/4000366725`,
    first: true,
  },
  {
    sku: "002030",
    brand: "Apple",
    name: "MacBook Air Laptop (13-inch) - Apple M5 Chip, Built for Apple Intelligence, 10-core CPU, 8-core GPU, 16GB Memory, 512GB SSD Storage, Midnight.",
    part: "MDHE4LL/A",
    url: `${COSTCO}macbook-air-laptop-13-inch-with-apple-m5-chip-built-for-apple-intelligence/4000444336`,
    first: true,
  },
  {
    sku: "002303",
    brand: "Apple",
    name: "MacBook Air Laptop (15-inch) - Apple M5 chip, Built for Apple Intelligence, 10-core CPU, 10-core GPU, 16GB Memory, 512GB SSD Storage, Midnight.",
    part: "MDVH4LL/A",
    url: `${COSTCO}macbook-air-laptop-15-inch-with-apple-m5-chip-built-for-apple-intelligence/4000444232`,
    first: true,
  },
  {
    sku: "013466",
    brand: "Apple",
    name: "Apple Airpods Max 2, Midnight",
    part: "MHWK4AM/A",
    url: `${COSTCO}apple-airpods-max-2/4000444301`,
    first: true,
  },
  {
    sku: "009746",
    brand: "Samsung",
    name: "Samsung Galaxy Buds4 Pro True Wireless Earbuds, Black",
    part: "SM-R640NZKAXAR",
    url: `${COSTCO}samsung-galaxy-buds4-pro-true-wireless-earbuds/4201049488`,
    first: true,
  },
];

describe("🔴 a product Costco names by its line, not its brand, is found", () => {
  const entries: readonly ProductIndexEntry[] = parseSitemap(FULL) ?? [];
  const rank = (r: (typeof PROVEN)[number]): number =>
    indexCandidates(entries, {
      brand: r.brand,
      partNumbers: [r.part],
      productName: r.name,
    }).findIndex((c) => c.url === r.url);

  it.each(PROVEN)(
    "demo row $sku: its proven page is within the first three candidates",
    (r) => {
      const at = rank(r);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(3);
    },
  );

  it("every proven row ranks FIRST: the size the client states puts the exact product ahead", () => {
    for (const r of PROVEN.filter((p) => p.first)) {
      expect({ sku: r.sku, at: rank(r) }).toEqual({ sku: r.sku, at: 0 });
    }
  });

  it("lists each url once", () => {
    for (const r of PROVEN) {
      const urls = indexCandidates(entries, {
        brand: r.brand,
        partNumbers: [r.part],
        productName: r.name,
      }).map((c) => c.url);
      expect(new Set(urls).size).toBe(urls.length);
    }
    const twice: ProductIndexEntry[] = [
      { itemId: "1", url: "u1", name: "ipad air 11 inch 128gb" },
      { itemId: "1", url: "u1", name: "ipad air 11 inch 128gb" },
    ];
    expect(
      indexCandidates(twice, {
        brand: "Apple",
        partNumbers: [],
        productName: "iPad Air 11-inch 128GB",
      }),
    ).toHaveLength(1);
  });

  it("🔴 'true' is not a product line: AirPods' 'True Wireless' admits no true-led name", () => {
    const c = indexCandidates(entries, {
      brand: "Apple",
      partNumbers: [],
      productName:
        "Apple AirPods 4 Active Noise Cancelling True Wireless Bluetooth Earbuds - White",
    });
    expect(c.some((x) => x.title.startsWith("true "))).toBe(false);
    expect(c.some((x) => x.title.startsWith("memory "))).toBe(false);
  });

  it("🔴 'memory' is not a product line: a name containing it makes no memory-led name a candidate", () => {
    // 'memory' is in 171 names and leads 1 of them; it is a feature, not a line.
    for (const productName of [
      "Acme Memory Foam Mattress Topper, Queen",
      "Acme Laptop 16GB Memory 512GB SSD",
    ]) {
      const c = indexCandidates(entries, {
        brand: "Acme",
        partNumbers: [],
        productName,
      });
      expect(c.some((x) => x.title.startsWith("memory "))).toBe(false);
    }
    // And a synthetic index where "memory" is distinctive (55 of 6,000
    // names, under the 1-in-100 line) yet rarely leads (5 of its 55): the
    // lead share alone keeps it from being a line, whatever the client says.
    const fake: ProductIndexEntry[] = Array.from({ length: 5945 }, (_, i) => ({
      itemId: `f${i}`,
      url: `uf${i}`,
      name: `filler item ${i}`,
    }));
    for (let i = 0; i < 5; i++) {
      fake.push({
        itemId: `m${i}`,
        url: `um${i}`,
        name: `memory foam pillow ${i}`,
      });
    }
    for (let i = 0; i < 50; i++) {
      fake.push({
        itemId: `w${i}`,
        url: `uw${i}`,
        name: `gel pad with memory ${i}`,
      });
    }
    expect(
      indexCandidates(fake, {
        brand: "Acme",
        partNumbers: [],
        productName: "Acme Memory Foam Pillow",
      }),
    ).toEqual([]);
  });
});

/**
 * Rows the rule on master found and an earlier version of this change lost
 * (rank 0-based on master, measured on the full fixture), and size spellings
 * a client writes that Costco's slugs spell differently.
 */
describe("🔴 the product-line change loses nothing master found, and reads sizes as clients write them", () => {
  const entries: readonly ProductIndexEntry[] = parseSitemap(FULL) ?? [];
  const at = (
    brand: string,
    productName: string,
    id: string,
    partNumbers: string[] = [],
  ): number =>
    indexCandidates(entries, { brand, partNumbers, productName }).findIndex(
      (c) => c.itemId === id,
    );

  it("a line the old rule found (uses in at most 1 name in 1,000) is still one, anywhere in the client's name", () => {
    // Master ranked these at 1, 1 and 6 (0-based): none may be worse.
    expect(
      at(
        "Samsung",
        'Samsung Galaxy Book4 Edge 14" Copilot+ PC Laptop Snapdragon X Elite 16GB 512GB SSD',
        "4201013672",
      ),
    ).toBeLessThanOrEqual(1);
    // "TP-Link": the brand is two words; "archer" leads Costco's name.
    expect(
      at(
        "TP-Link",
        "TP-Link Archer BE9500 Tri-Band WiFi 7 Router",
        "4000342316",
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      at("Epson", "Epson EcoTank Pro ET-5880", "4000433738"),
    ).toBeLessThanOrEqual(6);
  });

  it('reads a display size written 34" — the LG monitor ranks as on master (at most second, behind the 34 class entry)', () => {
    expect(
      at(
        "LG",
        'LG 34" UltraWide WQHD 144Hz HDR10 Curved Computer Monitor',
        "4201029370",
      ),
    ).toBeLessThanOrEqual(1);
  });

  it.each([
    ['Apple 11" iPad Air M4 128GB Wi-Fi', "4000444349"],
    ["Apple iPad Air (M4) 11in 128GB", "4000444349"],
    ['Apple MacBook Air 13.6" Laptop M5 chip 16GB 512GB SSD', "4000444336"],
    ["Apple iPad 11-inch 128GB Wi-Fi (A16 chip)", "4000285678"],
  ])("%s: its page is among the first three", (productName, id) => {
    const rank = at("Apple", productName, id);
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(3);
  });

  it("an iPad mini written 8.3-inch finds Costco's 83-inch mini, which master never listed", () => {
    // Costco sells it at 64GB and 256GB, not the 128GB asked for: the right
    // display size at another capacity is a conflict, so it follows the
    // entries that conflict with nothing, yet is found (master: absent).
    for (const id of ["100806381", "100806296"]) {
      const rank = at(
        "Apple",
        "Apple iPad mini 8.3-inch 128GB Wi-Fi (A17 Pro)",
        id,
      );
      expect(rank).toBeGreaterThanOrEqual(0);
      expect(rank).toBeLessThan(10);
    }
  });

  it("a size kind the client did not state is neutral, never a demotion", () => {
    // No capacity stated: the 128GB and 256GB iPad Air 11-inch both stay among
    // the first three, whatever their capacity.
    const c = indexCandidates(entries, {
      brand: "Apple",
      partNumbers: [],
      productName: 'Apple 11" iPad Air M4 Wi-Fi',
    });
    const top = c.slice(0, 3).map((x) => x.itemId);
    expect(top).toContain("4000444349");
    expect(top).toContain("4000444378");
  });

  it('ranks a 65 class entry first for a 65" Class U8000H', () => {
    const c = indexCandidates(entries, {
      brand: "Samsung",
      partNumbers: [],
      productName: 'Samsung 65" Class U8000H',
    });
    expect(c[0]?.itemId).toBe("4201040398");
  });
});
