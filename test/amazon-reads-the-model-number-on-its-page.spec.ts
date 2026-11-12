import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { amazonAdapter, parseProductPage } from "../src/adapters/amazon.js";
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
import {
  isPreOwned,
  looksLikePartNumber,
  normalisePageModel,
  pageModelNames,
} from "../src/ranking.js";
import { DEFAULT_OPTIONS, resolveItem } from "../src/resolve.js";
import manifest from "./raw/manifest.json" with { type: "json" };

/**
 * 🔴 **An Amazon listing whose page states the client's model number goes to
 * a person, not "not carried".**
 *
 * Amazon's search cards never state a model, so an Amazon candidate had
 * part-number evidence only when its title happened to spell the part number.
 * The resolver already opens the top listings' pages, and Amazon's page
 * states `Item model number` — but nothing read it, so an item whose pages
 * publish no barcode (every Apple listing) was filed `not-found`: 17 of the
 * Global Organization demo list's Amazon rows in production (2026-11-12).
 *
 * The page's stated model is part-number evidence for the listing whose page
 * said it. It never verifies — only an agreeing barcode does — and a page
 * whose barcode disagrees, or whose model is another product's, is never
 * proposed.
 *
 * The replay is two real pages captured on 2026-11-12 with two requests: the
 * search `Apple MH304LL/A`, whose first result is the iPad Air `B0GQVPX1PJ`,
 * and that listing's page. Every other listing's page was never captured, so
 * it is served here as a fetch that failed, which is exactly what the run
 * would make of it.
 */

const dir = (rel: string): string =>
  fileURLToPath(new URL(rel, import.meta.url));
const raw = (name: string): string =>
  gunzipSync(readFileSync(dir(`./raw/${name}.html.gz`))).toString("utf8");

const SEARCH_IPAD = raw("amazon-search-apple-mh304lla");
const PAGE_IPAD = raw("amazon-pdp-ipad-air-model-no-barcode");
const SEARCH_GSKILL = raw("amazon-search-results");
const PAGE_GSKILL = raw("amazon-pdp-gtin-labelled");

const IPAD = {
  barcode: "195950823578",
  clientSku: "001339",
  partNumber: "MH304LL/A",
  brand: "Apple",
} as const;
const IPAD_ASIN = "B0GQVPX1PJ";
const IPAD_URL = `https://www.amazon.com/dp/${IPAD_ASIN}`;

/** The model row exactly as the captured page carries it. */
const MODEL_ROW_VALUE = "&lrm;MH304LL/A";
/** A detail row in the page's own table markup. */
const detailRow = (label: string, value: string): string =>
  `<tr><th class="prodDetSectionEntry"> ${label} </th>` +
  `<td class="prodDetAttrValue"> ${value} </td></tr>`;
/** The iPad page with one more row in its details table. */
const withRow = (label: string, value: string): string =>
  PAGE_IPAD.replace("<table>", `<table>${detailRow(label, value)}`);

/** Serves the pages given by url; every other url is a fetch that failed. */
class Replay implements Fetcher {
  liveRequestCount = 0;
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  readonly asked: string[] = [];
  constructor(
    private readonly bodies: Readonly<Record<string, string>>,
    /** A body for every search not in `bodies`, or none. */
    private readonly anySearch: string | null = null,
  ) {}
  fetch(url: string): Promise<FetchResult> {
    this.asked.push(url);
    this.liveRequestCount++;
    const body =
      this.bodies[url] ??
      (url.startsWith("https://www.amazon.com/s?") ? this.anySearch : null);
    if (body === null || body === undefined) {
      return Promise.reject(new FetchFailed(url, undefined, null, 1));
    }
    return Promise.resolve({ url, body, cached: false, attempts: 1 });
  }
}

const OPTIONS = { ...DEFAULT_OPTIONS, clientCatalogueUrlTemplate: null };

/** Resolve the client's iPad row against Amazon, its page being `page`. */
async function resolveIpad(page: string) {
  const fetcher = new Replay({
    [amazonAdapter.buildSearchUrl("Apple MH304LL/A")]: SEARCH_IPAD,
    [IPAD_URL]: page,
  });
  const r = await resolveItem(IPAD, amazonAdapter, fetcher, OPTIONS);
  return { r, fetcher };
}

describe("the committed fixtures", () => {
  it("are listed in the manifest", () => {
    const names = manifest.fixtures.map((f) => f.name);
    expect(names).toContain("amazon-search-apple-mh304lla");
    expect(names).toContain("amazon-pdp-ipad-air-model-no-barcode");
  });

  /** The list `scripts/distil-category.mjs` refuses to emit past. */
  const SESSION_MARKERS: readonly RegExp[] = [
    /session-id|session-token|ubid-main|csrf/i,
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/,
    /x-forwarded-for/i,
    /brd-customer|hl_[0-9a-f]{6,}|brightdata/i,
    /cookie/i,
  ];

  it("🔴 carry no session value", () => {
    for (const [name, body] of [
      ["search", SEARCH_IPAD],
      ["page", PAGE_IPAD],
    ] as const) {
      const leaks = SESSION_MARKERS.filter((m) => m.test(body)).map(String);
      expect([name, leaks]).toEqual([name, []]);
    }
  });

  it("the search's first listing is the iPad Air, whose card states no model", () => {
    const cards = amazonAdapter.parseSearchResults(SEARCH_IPAD);
    expect(cards?.length).toBe(16);
    expect(cards?.[0]?.itemId).toBe(IPAD_ASIN);
    expect(cards?.[0]?.model).toBeNull();
    // Not spelled in the title either: the card alone has no evidence.
    expect(cards?.[0]?.title).not.toContain("MH304LL");
  });
});

describe("Amazon's product page states the model", () => {
  it("reads `Item model number` off the iPad Air's page, which publishes no barcode", () => {
    const page = parseProductPage(PAGE_IPAD);
    expect(PAGE_IPAD).toContain(MODEL_ROW_VALUE);
    expect(page.model).toBe("MH304LL/A");
    expect(page.barcode).toBeNull();
    expect(page.additionalBarcodes).toEqual([]);
  });

  it("reads `Mfr Part Number` off the committed G.SKILL page, beside its barcode", () => {
    const page = parseProductPage(PAGE_GSKILL);
    expect(page.model).toBe("F5-6000J3636F16GX2-FX5");
    expect(page.barcode).toBe("04713294232687");
  });

  it("prefers the manufacturer's part number to a model number that differs (SYNTHETIC)", () => {
    const page = parseProductPage(
      `<table>${detailRow("Model Number", "FLARE-X5")}` +
        `${detailRow("Mfr Part Number", "F5-6000J3636F16GX2-FX5")}</table>`,
    );
    expect(page.model).toBe("F5-6000J3636F16GX2-FX5");
  });

  it("CONTROL: a `Model Name` is not a model number (SYNTHETIC)", () => {
    const page = parseProductPage(
      `<table>${detailRow("Model Name", "Flare X5 Series")}</table>`,
    );
    expect(page.model ?? null).toBeNull();
  });

  it("CONTROL: a page with no details table states no model", () => {
    expect(parseProductPage(SEARCH_IPAD).model ?? null).toBeNull();
  });
});

describe("Apple MH304LL/A on Amazon: its page states the model and no barcode", () => {
  it("🔴 is proposed to a person as `unverifiable`, never filed not carried", async () => {
    const { r } = await resolveIpad(PAGE_IPAD);
    expect(r.queriesTried[0]).toBe("Apple MH304LL/A");
    expect(r.outcome).toBe("unverifiable");
    expect(r.match?.itemId).toBe(IPAD_ASIN);
    // Nothing on the page agreed, because it published nothing to compare.
    expect(r.match?.retailerBarcode).toBeNull();
    // The reviewer sees why: the model the page stated.
    expect(r.match?.model).toBe("MH304LL/A");
    expect(r.failure).toBeNull();
    expect(r.alternatives.map((a) => a.itemId)).not.toContain(IPAD_ASIN);
  });

  it("🔴 buys nothing more than a run whose page states no model", async () => {
    const stated = await resolveIpad(PAGE_IPAD);
    // The same page with its model row taken out: what every run read before.
    const noModel = PAGE_IPAD.replace(
      /<tr><th class="prodDetSectionEntry"> Item model number <\/th><td class="prodDetAttrValue">[^<]*<\/td><\/tr>/,
      "",
    );
    // Not vacuous: the control really lost its model row.
    expect(PAGE_IPAD).toContain("Item model number");
    expect(noModel).not.toContain("Item model number");
    const control = await resolveIpad(noModel);
    expect(control.r.outcome).toBe("not-found");
    expect(stated.fetcher.asked).toEqual(control.fetcher.asked);
    expect(stated.r.requests).toBe(control.r.requests);
    expect(stated.r.probes).toBe(control.r.probes);
    expect(stated.r.probes).toBeLessThanOrEqual(DEFAULT_OPTIONS.maxProbes);
  });

  it("CONTROL: a page whose barcode agrees verifies, as it always did", async () => {
    const { r } = await resolveIpad(withRow("UPC", IPAD.barcode));
    expect(r.outcome).toBe("verified");
    expect(r.match?.itemId).toBe(IPAD_ASIN);
    expect(r.match?.retailerBarcode).toBe(IPAD.barcode);
  });

  it("CONTROL: a page whose barcode disagrees is never proposed, whatever its model says", async () => {
    // Another colour's UPC: the Costco iPad page states it beside this one.
    const { r } = await resolveIpad(withRow("UPC", "195950824032"));
    expect(r.outcome).toBe("not-found");
    expect(r.match).toBeNull();
  });

  it("CONTROL: a page stating another product's model is never proposed", async () => {
    const { r } = await resolveIpad(
      PAGE_IPAD.replace(MODEL_ROW_VALUE, "&lrm;MH334LL/A"),
    );
    expect(r.outcome).toBe("not-found");
    expect(r.match).toBeNull();
  });

  it("CONTROL: a model sharing only a prefix with the client's is another product's (SYNTHETIC value)", async () => {
    // A manufacturer numbers a family with a shared prefix; sharing it is not
    // naming the client's part number.
    const { r } = await resolveIpad(
      PAGE_IPAD.replace(MODEL_ROW_VALUE, "&lrm;MH304LL/B"),
    );
    expect(r.outcome).toBe("not-found");
    expect(r.match).toBeNull();
  });
});

describe("CONTROL: the committed G.SKILL page still verifies by its barcode", () => {
  it("verifies B0BFGB2D2Z by the barcode its page publishes", async () => {
    const fetcher = new Replay(
      { "https://www.amazon.com/dp/B0BFGB2D2Z": PAGE_GSKILL },
      SEARCH_GSKILL,
    );
    const r = await resolveItem(
      {
        barcode: "4713294232687",
        clientSku: "1",
        partNumber: "F5-6000J3636F16GX2-FX5",
        brand: "G.SKILL",
      },
      amazonAdapter,
      fetcher,
      OPTIONS,
    );
    expect(r.outcome).toBe("verified");
    expect(r.match?.itemId).toBe("B0BFGB2D2Z");
    expect(r.match?.retailerBarcode).toBe("04713294232687");
  });
});

describe("Amazon's renewed listing is never proposed on its page's word", () => {
  const RENEWED_ASIN = "B0H7LNKQ37";
  const RENEWED_URL = `https://www.amazon.com/dp/${RENEWED_ASIN}`;

  it("the committed search carries it as a renewed card", () => {
    const renewed = amazonAdapter
      .parseSearchResults(SEARCH_IPAD)
      ?.find((c) => c.itemId === RENEWED_ASIN);
    expect(renewed?.title).toMatch(/\(Renewed\)$/);
  });

  it("🔴 a renewed listing whose page states MH304LL/A and no barcode is not proposed", async () => {
    // Only the renewed listing's page is had; the new one's is not.
    const fetcher = new Replay({
      [amazonAdapter.buildSearchUrl("Apple MH304LL/A")]: SEARCH_IPAD,
      [RENEWED_URL]: PAGE_IPAD,
    });
    const r = await resolveItem(IPAD, amazonAdapter, fetcher, OPTIONS);
    // Not vacuous: its page was read.
    expect(fetcher.asked).toContain(RENEWED_URL);
    expect(r.outcome).toBe("not-found");
    expect(r.match).toBeNull();
  });

  it("CONTROL: with both pages had, the new listing is the one proposed", async () => {
    const fetcher = new Replay({
      [amazonAdapter.buildSearchUrl("Apple MH304LL/A")]: SEARCH_IPAD,
      [RENEWED_URL]: PAGE_IPAD,
      [IPAD_URL]: PAGE_IPAD,
    });
    const r = await resolveItem(IPAD, amazonAdapter, fetcher, OPTIONS);
    expect(r.outcome).toBe("unverifiable");
    expect(r.match?.itemId).toBe(IPAD_ASIN);
  });
});

describe("pageModelNames: when a page's model states the client's part number", () => {
  it("names it exactly, whatever the case, spacing or bidi marks", () => {
    expect(pageModelNames("MH304LL/A", ["MH304LL/A"])).toBe("exact");
    expect(pageModelNames("  mh304ll/a ‎", ["MH304LL/A"])).toBe("exact");
    expect(pageModelNames("&lrm;MH304LL/A", ["MH304LL/A"])).toBe("exact");
  });

  it("names it by its regional stem: another region's suffix, or none", () => {
    expect(pageModelNames("K72337WW", ["K72337US"])).toBe("stem");
    expect(pageModelNames("K72337", ["K72337US"])).toBe("stem");
  });

  it("names it inside a longer model only as a whole token", () => {
    expect(pageModelNames("MH304LL/A (Wi-Fi)", ["MH304LL/A"])).toBe("token");
    expect(pageModelNames("MH304LL/A-CASE", ["MH304LL/A"])).toBeNull();
    expect(pageModelNames("XMH304LL/A", ["MH304LL/A"])).toBeNull();
  });

  it("🔴 never by a model the part number merely CONTAINS", () => {
    expect(pageModelNames("1", ["SM-S931UZKAXAA"])).toBeNull();
    expect(pageModelNames("A", ["MH304LL/A"])).toBeNull();
    // Samsung encodes the colour in the suffix: the family is not the item.
    expect(pageModelNames("SM-X520", ["SM-X520NZAAXAR"])).toBeNull();
    expect(pageModelNames("MH304LL", ["MH304LL/A"])).toBeNull();
  });

  it("🔴 never by digits it shares with the barcode, nor by a shared prefix", () => {
    expect(pageModelNames("XZ-8237", ["MH304LL/A"])).toBeNull();
    expect(pageModelNames("MH304LL/B", ["MH304LL/A"])).toBeNull();
  });

  it("🔴 never as a token among OTHER part numbers: a page listing the models it fits", () => {
    // A screen protector's page lists every iPad Air it fits.
    expect(
      pageModelNames("MH304LL/A, MH334LL/A, MH314LL/A", ["MH304LL/A"]),
    ).toBeNull();
    expect(pageModelNames("MH304LL/A / MH334LL/A", ["MH304LL/A"])).toBeNull();
    // CONTROL: words beside it are not another part number.
    expect(pageModelNames("MH304LL/A (Wi-Fi)", ["MH304LL/A"])).toBe("token");
  });

  it("normalises a page's model as it compares it: no bidi mark survives", () => {
    expect(normalisePageModel("\u200e mh304ll/a &lrm;")).toBe("MH304LL/A");
  });

  it("CONTROL: a model too short to be one names nothing, even when equal", () => {
    expect(pageModelNames("A1", ["A1"])).toBeNull();
  });

  it("tells a part number from a description, and a pre-owned title", () => {
    expect(looksLikePartNumber("CASE-77")).toBe(true);
    expect(looksLikePartNumber("910-005488")).toBe(true);
    expect(looksLikePartNumber("iPad Air 11 (M4)")).toBe(false);
    expect(looksLikePartNumber("Flare")).toBe(false);
    for (const title of [
      "iPad Air 2026 (11-inch, Wi-Fi, 128GB) - Space Gray (Renewed)",
      "Apple iPad Air Refurbished",
      "iPad Air Pre-Owned",
      "iPad Air (Used - Like New)",
    ]) {
      expect([title, isPreOwned(title)]).toEqual([title, true]);
    }
    expect(isPreOwned("iPad Air 11-inch (M4) 128GB")).toBe(false);
  });
});

describe("which listing a page's model proposes (SYNTHETIC retailer)", () => {
  const card = (
    itemId: string,
    title: string,
    brand = "Acme",
  ): ParsedCandidate => ({
    itemId,
    url: `https://r.test/p/${itemId}`,
    model: null,
    title,
    brand,
    priceCents: 1000,
    inStock: true,
    isFirstParty: null,
    sellerName: null,
    imageUrl: null,
    partialMatch: false,
  });
  const page = (model: string | null): ParsedProduct => ({
    barcode: null,
    additionalBarcodes: [],
    priceCents: null,
    inStock: null,
    title: null,
    sellerName: null,
    isFirstParty: null,
    unverifiableReason: null,
    category: null,
    model,
  });
  /** Resolve one item over `listings`, in that order, whose pages say `models`. */
  const run = async (
    listings: readonly ParsedCandidate[],
    models: Readonly<Record<string, string | null>>,
    item: { barcode: string; partNumber: string; brand: string },
  ) => {
    const adapter: RetailerAdapter = {
      slug: "fake",
      querySupport: {
        maxNumericQueryDigits: null,
        barcodeIsSearchable: false,
        partNumberNeedsBrand: false,
      },
      pacing: { pagesAtOnce: 1 },
      fetchProfile: { country: null, timeoutMs: null },
      maxProbes: 8,
      productIndex: null,
      hosts: ["r.test"],
      buildSearchUrl: (q) => `https://r.test/s?q=${encodeURIComponent(q)}`,
      parseSearchResults: () => [...listings],
      parseProductPage: (html) =>
        html in models ? page(models[html] ?? null) : null,
    };
    const fetcher: Fetcher = {
      liveRequestCount: 0,
      pagesDelivered: 0,
      fetch: (url) =>
        Promise.resolve({
          url,
          body: url.startsWith("https://r.test/p/")
            ? url.slice("https://r.test/p/".length)
            : "search",
          cached: false,
          attempts: 1,
        }),
    };
    return resolveItem({ clientSku: "1", ...item }, adapter, fetcher, OPTIONS);
  };
  const APPLE = {
    barcode: IPAD.barcode,
    partNumber: "MH304LL/A",
    brand: "Apple",
  };

  it("🔴 a junk or family model proposes nothing: `1`, `A`, `SM-X520`", async () => {
    const samsung = { barcode: "887276789012", brand: "Samsung" };
    for (const [model, partNumber, title] of [
      ["1", "SM-S931UZKAXAA", "Samsung phone case clear"],
      ["A", "MH304LL/A", "Tablet stand"],
      ["SM-X520", "SM-X520NZAAXAR", "Samsung Galaxy Tab S10 FE 256GB Silver"],
    ] as const) {
      const r = await run(
        [card("X", title, "Samsung")],
        { X: model },
        {
          ...samsung,
          partNumber,
        },
      );
      expect([model, r.outcome, r.match]).toEqual([model, "not-found", null]);
    }
  });

  it("🔴 the real listing stating MH304LL/A beats an accessory listed first stating MH304LL/A-CASE", async () => {
    const r = await run(
      [
        card("ACC", "Case for iPad Air 11", "Apple"),
        card("REAL", "iPad Air 11-inch (M4) 128GB", "Apple"),
      ],
      { ACC: "MH304LL/A-CASE", REAL: "MH304LL/A" },
      APPLE,
    );
    expect(r.outcome).toBe("unverifiable");
    expect(r.match?.itemId).toBe("REAL");
  });

  it("🔴 an exact model beats a better-ranked page naming it only as a token", async () => {
    const r = await run(
      [
        card("BUNDLE", "iPad Air 11 bundle", "Apple"),
        card("REAL", "iPad Air 11-inch (M4) 128GB", "Apple"),
      ],
      { BUNDLE: "MH304LL/A (bundle)", REAL: "MH304LL/A" },
      APPLE,
    );
    expect(r.match?.itemId).toBe("REAL");
    expect(r.match?.model).toBe("MH304LL/A");
  });

  it("CONTROL: at equal strength the better-ranked page is proposed", async () => {
    const r = await run(
      [
        card("FIRST", "iPad Air 11-inch (M4) 128GB", "Apple"),
        card("SECOND", "iPad Air 11-inch (M4) 128GB Space Gray", "Apple"),
      ],
      { FIRST: "MH304LL/A", SECOND: "MH304LL/A" },
      APPLE,
    );
    expect(r.match?.itemId).toBe("FIRST");
  });

  it("🔴 a listing whose TITLE spells MH304LL/A stays proposed over a lower case page stating it", async () => {
    for (const realModel of [null, "iPad Air 11 (M4)"]) {
      const r = await run(
        [
          card("REAL", "Apple iPad Air 11 MH304LL/A Space Gray", "Apple"),
          card("CASE", "Case for iPad Air", "ProCase"),
        ],
        { REAL: realModel, CASE: "MH304LL/A" },
        APPLE,
      );
      expect([realModel, r.outcome, r.match?.itemId]).toEqual([
        realModel,
        "unverifiable",
        "REAL",
      ]);
    }
  });

  it("the page stating the part number beats a better-ranked page stating ANOTHER part number", async () => {
    const r = await run(
      [
        card("A", "Acme case for the AC-1000X widget"),
        card("B", "Acme widget"),
      ],
      { A: "CASE-77", B: "AC-1000X" },
      { barcode: "012345678905", partNumber: "AC-1000X", brand: "Acme" },
    );
    expect(r.outcome).toBe("unverifiable");
    expect(r.match?.itemId).toBe("B");
    expect(r.match?.model).toBe("AC-1000X");
  });

  it("🔴 a screen protector whose page lists MH304LL/A among other models is not proposed", async () => {
    const r = await run(
      [card("GUARD", "Screen protector for iPad Air", "ProCase")],
      { GUARD: "MH304LL/A, MH334LL/A, MH314LL/A" },
      APPLE,
    );
    expect(r.outcome).toBe("not-found");
    expect(r.match).toBeNull();
  });

  it("🔴 a renewed listing whose title spells MH304LL/A does not keep its place over a new one whose page states it", async () => {
    const r = await run(
      [
        card("RENEWED", "Apple iPad Air 11 MH304LL/A (Renewed)", "Apple"),
        card("NEW", "iPad Air 11-inch (M4) 128GB", "Apple"),
      ],
      { RENEWED: null, NEW: "MH304LL/A" },
      APPLE,
    );
    expect(r.outcome).toBe("unverifiable");
    expect(r.match?.itemId).toBe("NEW");
  });

  it("the evidence carries the page's model as it was compared, not as the page spelled it", async () => {
    const r = await run(
      [card("REAL", "iPad Air 11-inch (M4) 128GB", "Apple")],
      { REAL: "\u200e mh304ll/a " },
      APPLE,
    );
    expect(r.outcome).toBe("unverifiable");
    expect(r.match?.model).toBe("MH304LL/A");
  });

  it("CONTROL: with no page stating a model, the best page without a barcode is proposed, as before", async () => {
    const r = await run(
      [
        card("A", "Acme case for the AC-1000X widget"),
        card("B", "Acme widget"),
      ],
      { A: null, B: null },
      { barcode: "012345678905", partNumber: "AC-1000X", brand: "Acme" },
    );
    expect(r.outcome).toBe("unverifiable");
    expect(r.match?.itemId).toBe("A");
    expect(r.match?.model).toBeNull();
  });
});
