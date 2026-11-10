import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  bhAdapter,
  DISCONTINUED_NO_UPC,
  extractPreloadedData,
  noBarcodeReason,
  parseProductPage,
  parseSearchResults,
  readListingPage,
} from "../src/adapters/bh.js";
import { canQuery, type ParsedCandidate } from "../src/adapters/types.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchResult,
} from "../src/fetcher/types.js";
import { barcodeQuery } from "../src/query-plan.js";
import { DEFAULT_OPTIONS, resolveItem } from "../src/resolve.js";

/**
 * The B&H adapter, against the investigation's real pages (R10 fixtures,
 * distilled and proven parse-identical to the raw captures).
 *
 * 🔑 **Resolution is checked end to end where it matters**, through
 * `resolveItem` with a fetcher serving those pages, because the claims that
 * decide what a customer is told — verified, a miss, a failure, a listing for
 * a person to judge — are claims about the pipeline and the adapter together.
 *
 * ⚠️ **Three pages here are synthetic, each derived from a real one and said
 * so where it is built**: B&H was never seen stating two UPCs for one item, a
 * MAP item's product page was never captured (MAP was seen on search cards
 * only), and no captured search lists a kit. Each is the real page with one
 * field changed, so it can say nothing the real one could not.
 */

const raw = (name: string): string =>
  gunzipSync(
    readFileSync(
      fileURLToPath(new URL(`./raw/${name}.html.gz`, import.meta.url)),
    ),
  ).toString("utf8");

const SEARCH_UPC_M310 = raw("bh-search-upc-m310");
const SEARCH_TEXT_M310 = raw("bh-search-text-m310");
const NO_RESULTS = raw("bh-search-no-results-cf-08lb");
const PARTIAL = raw("bh-search-partial-nonsense");
const OTHER_BRAND_29538 = raw("bh-search-other-brand-29538");
const MFR_Z623 = raw("bh-search-mfr-z623");
const PDP_M310 = raw("bh-pdp-m310");
const PDP_Z623 = raw("bh-pdp-z623-discontinued");
const PDP_REPLACEMENT = raw("bh-pdp-replacement");
const PDP_KIT = raw("bh-pdp-kit-components");
const PDP_BK350 = raw("bh-pdp-bk350-special-order");

const M310_UPC = "097855066237";
const M310_URL =
  "https://www.bhphotovideo.com/c/product/731610-REG/Logitech_910_001675_M310_Wireless_Mouse.html";
const Z623_UPC = "097855066466";
const Z623_URL =
  "https://www.bhphotovideo.com/c/product/736288-REG/Logitech_980_000402_Z623_THX_Certified_2_1_Speaker.html";
const KIT_URL =
  "https://www.bhphotovideo.com/c/product/1882239-REG/logitech_g_pro_2_lightspeed_wireless.html";
/** The kit's mouse — a component, stated on the kit's page. */
const KIT_MOUSE_UPC = "097855195760";
const C2G_URL =
  "https://www.bhphotovideo.com/c/product/1421339-REG/c2g_29538_100_displayport_active_optical.html";

/** A page B&H's edge could answer with in place of the app — no state. */
const REFUSAL =
  "<html><head><title>Access Denied</title></head><body></body></html>";

const searchUrl = (q: string): string => bhAdapter.buildSearchUrl(q);

const candidatesOn = (html: string): ParsedCandidate[] => {
  const parsed = parseSearchResults(html);
  if (parsed === null) throw new Error("expected a results page, got null");
  return parsed;
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const child = (v: unknown, key: string): Json => {
  const inner = isObj(v) ? v[key] : undefined;
  if (!isObj(inner)) throw new Error(`no ${key}`);
  return inner;
};
const list = (v: unknown, key: string): unknown[] => {
  const inner = isObj(v) ? v[key] : undefined;
  if (!Array.isArray(inner)) throw new Error(`no ${key}[]`);
  return inner;
};

const encode = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** The same page, its preloaded state passed through `change`. */
function withState(html: string, change: (state: Json) => void): string {
  const state = extractPreloadedData(html);
  if (state === null) throw new Error("no preloaded state");
  change(state);
  return html.replace(
    /(class="bh-preloaded-data"\s+data-data=")[^"]*"/,
    (_whole, head: string) => `${head}${encode(JSON.stringify(state))}"`,
  );
}

/** A product page's own item, inside its state. */
function itemOf(state: Json): Json {
  const entries = child(
    child(child(state, "ServerStateStore"), "state"),
    "entries",
  );
  for (const entry of Object.values(entries)) {
    const first = list(entry, "data")[0];
    if (isObj(first)) return first;
  }
  throw new Error("no item");
}

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
  constructor(private readonly byUrl: Readonly<Record<string, string>>) {}
  fetch(url: string): Promise<FetchResult> {
    this.asked.push(url);
    this.liveRequestCount++;
    const body = this.byUrl[url];
    if (body === undefined) {
      return Promise.reject(new FetchFailed(url, 502, null, 1));
    }
    return Promise.resolve({ url, body, cached: false, attempts: 1 });
  }
}

/**
 * The client's own catalogue page, publishing its part number and brand as
 * structured data — a double for the client, not a B&H page.
 */
const CATALOGUE = "https://client.test/p/{sku}";
const CATALOGUE_URL = "https://client.test/p/SKU-1";
const catalogue = (mpn: string, brand: string): string =>
  `<script type="application/ld+json">${JSON.stringify({
    "@type": "Product",
    sku: "SKU-1",
    mpn,
    brand: { "@type": "Brand", name: brand },
  })}</script>`;
const WITH_CATALOGUE = {
  ...DEFAULT_OPTIONS,
  clientCatalogueUrlTemplate: CATALOGUE,
};

describe("the configuration", () => {
  it("asks the barcode first, and no digit cap refuses it", () => {
    expect(bhAdapter.querySupport).toEqual({
      maxNumericQueryDigits: null,
      barcodeIsSearchable: true,
      partNumberNeedsBrand: true,
    });
    const query = barcodeQuery(M310_UPC, bhAdapter.querySupport);
    expect(query).toBe(M310_UPC);
    expect(canQuery(bhAdapter.querySupport, query ?? "")).toBe(true);
  });

  it("reads 4 pages at once, from the us, waits 150 s an attempt, probes 3", () => {
    expect(bhAdapter.pacing).toEqual({ pagesAtOnce: 4 });
    expect(bhAdapter.fetchProfile).toEqual({
      country: "us",
      timeoutMs: 150_000,
    });
    expect(bhAdapter.maxProbes).toBe(3);
  });

  it("searches the website, and reads only its own host", () => {
    expect(searchUrl("Allsop 29538")).toBe(
      "https://www.bhphotovideo.com/c/search?q=Allsop%2029538",
    );
    expect(bhAdapter.hosts).toEqual(["www.bhphotovideo.com"]);
  });
});

describe("parseSearchResults", () => {
  it("reads a barcode search's one listing: MFR #, brand, price, stock, seller", () => {
    const [m310, ...rest] = candidatesOn(SEARCH_UPC_M310);
    expect(rest).toEqual([]);
    expect(m310).toEqual({
      itemId: "731610",
      url: M310_URL,
      model: "910-001675",
      title: "Logitech M310 Wireless Mouse (Silver)",
      brand: "Logitech",
      priceCents: 2299,
      inStock: true,
      isFirstParty: true,
      sellerName: "B&H Photo",
      imageUrl:
        "https://static.bhphoto.com/images/images345x345/1519230103_731610.jpg",
    });
  });

  it("🔴 reads stock from the status, never the message that contradicts it", () => {
    // The M310's card says IN_STOCK — and "Temporarily Out of Stock".
    const state = extractPreloadedData(SEARCH_UPC_M310);
    const card = list(
      child(
        child(child(child(state, "ListingStore"), "state"), "response"),
        "data",
      ),
      "items",
    )[0];
    expect(child(card, "stockInfo")).toEqual({
      status: "IN_STOCK",
      statusMessage: "Temporarily Out of Stock",
    });
    expect(candidatesOn(SEARCH_UPC_M310)[0]?.inStock).toBe(true);
  });

  it("names the brand from the card, which has no brand field", () => {
    const brands = candidatesOn(MFR_Z623).map((c) => c.brand);
    expect(brands).toContain("Logitech");
    expect(brands).toContain("Logitech G");
    expect(brands).toContain("Cyber Acoustics");
    expect(candidatesOn(OTHER_BRAND_29538)[0]?.brand).toBe("C2G");
  });

  it("a text search lists every match, each with its MFR #", () => {
    const found = candidatesOn(SEARCH_TEXT_M310);
    expect(found).toHaveLength(4);
    expect(found[0]?.itemId).toBe("731610");
    expect(found.every((c) => c.model !== null)).toBe(true);
  });

  it("🔴 an explicit no-results page is [] — answered, with nothing on it", () => {
    expect(parseSearchResults(NO_RESULTS)).toEqual([]);
  });

  it("🔴 a body that is not a results page is null, never []", () => {
    expect(parseSearchResults("")).toBeNull();
    expect(parseSearchResults(REFUSAL)).toBeNull();
    expect(parseSearchResults(PDP_M310)).toBeNull();
    expect(parseSearchResults(PDP_REPLACEMENT)).toBeNull();
  });

  it("keeps a partial match's look-alikes for the pipeline to judge", () => {
    expect(candidatesOn(PARTIAL)).toHaveLength(28);
  });

  it("🔴 a MAP card's withheld price is null — never 0", () => {
    const found = candidatesOn(PARTIAL);
    const withheld = found.filter((c) => c.priceCents === null);
    expect(withheld).toHaveLength(22);
    // B&H flags each as MAP and sends no price for it at all.
    const items = list(
      child(
        child(
          child(child(extractPreloadedData(PARTIAL), "ListingStore"), "state"),
          "response",
        ),
        "data",
      ),
      "items",
    ).filter((item) => child(item, "priceInfo")["isMapItem"] === true);
    expect(items).toHaveLength(22);
    expect(
      items.every((item) => child(item, "priceInfo")["price"] === null),
    ).toBe(true);
  });

  it("🔴 a card whose fields moved is null, not an empty answer", () => {
    const moved = withState(SEARCH_UPC_M310, (state) => {
      const data = child(
        child(child(child(state, "ListingStore"), "state"), "response"),
        "data",
      );
      for (const item of list(data, "items")) {
        if (isObj(item)) delete item["core"];
      }
    });
    expect(parseSearchResults(moved)).toBeNull();
  });
});

describe("parseProductPage", () => {
  it("reads the UPC from every place the page states it, once", () => {
    expect(parseProductPage(PDP_M310)).toEqual({
      barcode: M310_UPC,
      additionalBarcodes: [],
      priceCents: 2299,
      inStock: true,
      title: "Logitech M310 Wireless Mouse (Silver)",
      sellerName: "B&H Photo",
    });
  });

  it("publishes every UPC it states for its own item (SYNTHETIC: a second value)", () => {
    // Derived from the M310's real page by adding a second UPC to its own
    // overview entry; B&H was never seen stating two.
    const two = withState(PDP_M310, (state) => {
      const entry = list(child(itemOf(state), "overview"), "items")[0];
      if (isObj(entry)) entry["upc"] = `${M310_UPC} 097855066244`;
    });
    const product = parseProductPage(two);
    expect(product?.barcode).toBe(M310_UPC);
    expect(product?.additionalBarcodes).toEqual(["097855066244"]);
  });

  it("🔴 a kit's components' UPCs are never the kit's", () => {
    // A real kit: every UPC on its page belongs to a component's own item.
    const product = parseProductPage(PDP_KIT);
    expect(product?.barcode).toBeNull();
    expect(product?.additionalBarcodes).toEqual([]);
    expect(PDP_KIT).toContain(`UPC: ${KIT_MOUSE_UPC}`);
  });

  it("🔴 a discontinued item has no current price and, here, no UPC", () => {
    expect(parseProductPage(PDP_Z623)).toEqual({
      barcode: null,
      additionalBarcodes: [],
      // Its state still holds $99.99: not a price anybody can pay.
      priceCents: null,
      inStock: false,
      title: "Logitech Z623 THX-Certified 2.1 Speaker System",
      sellerName: "B&H Photo",
    });
    expect(
      child(itemOf(extractPreloadedData(PDP_Z623) ?? {}), "priceInfo")["price"],
    ).toBe(99.99);
  });

  it("says why a discontinued listing publishes no barcode", () => {
    expect(noBarcodeReason(PDP_Z623)).toBe(DISCONTINUED_NO_UPC);
    expect(DISCONTINUED_NO_UPC).toBe("discontinued at B&H, no UPC published");
    // Nothing to say where a barcode is published, or the page is not one.
    expect(noBarcodeReason(PDP_M310)).toBeNull();
    expect(noBarcodeReason(PDP_KIT)).toBeNull();
    expect(noBarcodeReason(PDP_REPLACEMENT)).toBeNull();
  });

  it("🔴 a MAP item's price is null (SYNTHETIC: the M310's page, MAP)", () => {
    // Derived from the M310's real page with B&H's MAP flags as its MAP
    // cards carry them; a MAP product page was never captured.
    const map = withState(PDP_M310, (state) => {
      const price = child(itemOf(state), "priceInfo");
      price["isMapItem"] = true;
      price["showPrice"] = false;
    });
    expect(parseProductPage(map)?.priceCents).toBeNull();
    expect(parseProductPage(map)?.inStock).toBe(true);
  });

  it("reads stock from the status: special order is unknown", () => {
    expect(parseProductPage(PDP_BK350)?.inStock).toBeNull();
    expect(parseProductPage(PDP_BK350)?.priceCents).toBe(12899);
  });

  it("🔴 a replacement page or a page with no payload is null — not a product page", () => {
    expect(parseProductPage(PDP_REPLACEMENT)).toBeNull();
    expect(parseProductPage("")).toBeNull();
    expect(parseProductPage(REFUSAL)).toBeNull();
    expect(parseProductPage(SEARCH_UPC_M310)).toBeNull();
  });
});

describe("readListingPage", () => {
  it("reads its page: the listing, its UPC, price and stock", () => {
    expect(readListingPage(PDP_M310)).toEqual({
      kind: "page",
      page: {
        pageItemId: "731610",
        barcode: M310_UPC,
        additionalBarcodes: [],
        priceCents: 2299,
        inStock: true,
      },
    });
  });

  it("🔴 a MAP price is a page with no price, not an unreadable offer", () => {
    const map = withState(PDP_M310, (state) => {
      const price = child(itemOf(state), "priceInfo");
      price["isMapItem"] = true;
      price["showPrice"] = false;
    });
    const reading = readListingPage(map);
    expect(reading.kind).toBe("page");
    if (reading.kind !== "page") return;
    expect(reading.page.priceCents).toBeNull();
    expect(reading.page.inStock).toBe(true);
  });

  it("a discontinued listing is a page: no price, not in stock, an empty UPC field", () => {
    expect(readListingPage(PDP_Z623)).toEqual({
      kind: "page",
      page: {
        pageItemId: "736288",
        barcode: "",
        additionalBarcodes: [],
        priceCents: null,
        inStock: false,
      },
    });
  });

  it("CONTROL: a price B&H shows and this build cannot read is unreadable", () => {
    const moved = withState(PDP_M310, (state) => {
      child(itemOf(state), "priceInfo")["price"] = "22.99";
    });
    expect(readListingPage(moved).kind).toBe("unreadable-offer");
  });

  it("refuses what is not a product page", () => {
    expect(readListingPage(PDP_REPLACEMENT).kind).toBe("not-a-product-page");
    expect(readListingPage(REFUSAL).kind).toBe("not-a-product-page");
    expect(readListingPage(SEARCH_UPC_M310).kind).toBe("not-a-product-page");
  });
});

describe("resolving at B&H", () => {
  it("🔴 verifies the M310 on 097855066237: one search, one page, no identity bought", async () => {
    const fetcher = new Pages({
      [searchUrl(M310_UPC)]: SEARCH_UPC_M310,
      [M310_URL]: PDP_M310,
    });
    const resolution = await resolveItem(
      { barcode: M310_UPC, clientSku: "SKU-1" },
      bhAdapter,
      fetcher,
      WITH_CATALOGUE,
    );
    expect(resolution.outcome).toBe("verified");
    expect(resolution.failure).toBeNull();
    expect(resolution.identity).toBeNull();
    expect(resolution.queriesTried).toEqual([M310_UPC]);
    expect(resolution.match).toMatchObject({
      itemId: "731610",
      retailerBarcode: M310_UPC,
      priceCents: 2299,
      inStock: true,
      isFirstParty: true,
      sellerName: "B&H Photo",
    });
    expect(fetcher.asked).toEqual([searchUrl(M310_UPC), M310_URL]);
  });

  it("verifies on any of several UPCs the page states (SYNTHETIC: a second value)", async () => {
    const second = "097855066244";
    const two = withState(PDP_M310, (state) => {
      const entry = list(child(itemOf(state), "overview"), "items")[0];
      if (isObj(entry)) entry["upc"] = `${M310_UPC} ${second}`;
    });
    const resolution = await resolveItem(
      { barcode: second, clientSku: "SKU-1" },
      bhAdapter,
      new Pages({ [searchUrl(second)]: SEARCH_UPC_M310, [M310_URL]: two }),
      WITH_CATALOGUE,
    );
    expect(resolution.outcome).toBe("verified");
    expect(resolution.match?.retailerBarcode).toBe(second);
  });

  it("🔴 a UPC equal only to a kit component's is never verified (SYNTHETIC search)", async () => {
    // The kit's own real item, listed as the one result of a search for its
    // mouse's UPC — no captured search lists the kit.
    const kitCard = itemOf(extractPreloadedData(PDP_KIT) ?? {});
    const kitSearch = withState(SEARCH_UPC_M310, (state) => {
      const data = child(
        child(child(child(state, "ListingStore"), "state"), "response"),
        "data",
      );
      data["items"] = [kitCard];
    });
    expect(candidatesOn(kitSearch).map((c) => c.url)).toEqual([KIT_URL]);
    const fetcher = new Pages({
      [searchUrl(KIT_MOUSE_UPC)]: kitSearch,
      [KIT_URL]: PDP_KIT,
    });
    const resolution = await resolveItem(
      { barcode: KIT_MOUSE_UPC, clientSku: "SKU-1" },
      bhAdapter,
      fetcher,
      DEFAULT_OPTIONS,
    );
    expect(fetcher.asked).toContain(KIT_URL);
    expect(resolution.outcome).not.toBe("verified");
    expect(resolution.match?.retailerBarcode ?? null).toBeNull();
  });

  it("🔴 a refused search is a failure, never a miss", async () => {
    for (const refused of [REFUSAL, undefined]) {
      const pages: Record<string, string> = {
        [CATALOGUE_URL]: catalogue("CF-08LB", "Kingwin"),
      };
      // `undefined`: the vendor's own 502, a fetch that failed.
      for (const q of ["812348010548", "CF-08LB", "Kingwin CF-08LB"]) {
        if (refused !== undefined) pages[searchUrl(q)] = refused;
      }
      const resolution = await resolveItem(
        { barcode: "812348010548", clientSku: "SKU-1" },
        bhAdapter,
        new Pages(pages),
        WITH_CATALOGUE,
      );
      expect(resolution.outcome).toBe("not-found");
      expect(resolution.failure).toMatch(/went unanswered/);
      expect(
        resolution.searchesUnfetched + resolution.searchesNotResultsPage,
      ).toBe(resolution.queriesTried.length);
    }
  });

  it("🔴 search-no-results-cf-08lb is a miss: every search answered, nothing carried", async () => {
    const pages: Record<string, string> = {
      [CATALOGUE_URL]: catalogue("CF-08LB", "Kingwin"),
    };
    const asked = [
      "812348010548",
      "CF-08LB",
      "Kingwin CF-08LB",
      "Kingwin 01054",
    ];
    for (const q of asked) pages[searchUrl(q)] = NO_RESULTS;
    const resolution = await resolveItem(
      { barcode: "812348010548", clientSku: "SKU-1" },
      bhAdapter,
      new Pages(pages),
      WITH_CATALOGUE,
    );
    expect(resolution.outcome).toBe("not-found");
    expect(resolution.failure).toBeNull();
    expect(resolution.queriesTried).toEqual(asked);
  });

  it("🔴 another brand's item under the same bare part number is not a candidate", async () => {
    // Allsop's 29538 wrist rest: B&H lists a C2G cable with MFR # 29538.
    const fetcher = new Pages({
      [CATALOGUE_URL]: catalogue("29538", "Allsop"),
      [searchUrl("035286295383")]: NO_RESULTS,
      [searchUrl("29538")]: OTHER_BRAND_29538,
      [searchUrl("Allsop 29538")]: NO_RESULTS,
    });
    const resolution = await resolveItem(
      { barcode: "035286295383", clientSku: "SKU-1" },
      bhAdapter,
      fetcher,
      WITH_CATALOGUE,
    );
    expect(resolution.outcome).toBe("not-found");
    expect(resolution.failure).toBeNull();
    expect(resolution.match).toBeNull();
    expect(resolution.probes).toBe(0);
    expect(fetcher.asked).not.toContain(C2G_URL);
    // As the investigation asked them: the bare MFR # first, then the brand.
    expect(resolution.queriesTried).toEqual([
      "035286295383",
      "29538",
      "Allsop 29538",
    ]);
  });

  it("🔴 the discontinued Z623 is unverifiable, for a person, with its reason", async () => {
    const fetcher = new Pages({
      [CATALOGUE_URL]: catalogue("980-000402", "Logitech"),
      [searchUrl(Z623_UPC)]: NO_RESULTS,
      [searchUrl("980-000402")]: MFR_Z623,
      [Z623_URL]: PDP_Z623,
    });
    const resolution = await resolveItem(
      { barcode: Z623_UPC, clientSku: "SKU-1" },
      bhAdapter,
      fetcher,
      WITH_CATALOGUE,
    );
    // Never verified, and never a miss the gateway files as not carried.
    expect(resolution.outcome).toBe("unverifiable");
    expect(resolution.failure).toBeNull();
    expect(resolution.match).toMatchObject({
      itemId: "736288",
      model: "980-000402",
      brand: "Logitech",
      retailerBarcode: null,
      priceCents: null,
      inStock: false,
    });
    expect(noBarcodeReason(PDP_Z623)).toBe(DISCONTINUED_NO_UPC);
    // One probe: the Z313, Z625 and Z533 share Logitech's 980-00 prefix and
    // are not the item, so none of their pages is bought.
    expect(resolution.probes).toBe(1);
    expect(fetcher.asked).toEqual([
      searchUrl(Z623_UPC),
      CATALOGUE_URL,
      searchUrl("980-000402"),
      Z623_URL,
    ]);
  });

  it("🔴 a replacement page is a probe nobody answered, not a listing without a barcode", async () => {
    const fetcher = new Pages({
      [searchUrl(M310_UPC)]: SEARCH_UPC_M310,
      [M310_URL]: PDP_REPLACEMENT,
    });
    const resolution = await resolveItem(
      { barcode: M310_UPC, clientSku: "SKU-1" },
      bhAdapter,
      fetcher,
      WITH_CATALOGUE,
    );
    expect(resolution.outcome).not.toBe("unverifiable");
    expect(resolution.outcome).not.toBe("verified");
  });
});
