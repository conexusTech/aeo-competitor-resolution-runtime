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

describe("the listing whose page states the part number is the one proposed (SYNTHETIC retailer)", () => {
  const card = (itemId: string, title: string): ParsedCandidate => ({
    itemId,
    url: `https://r.test/p/${itemId}`,
    model: null,
    title,
    brand: "Acme",
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
  const run = async (pages: Readonly<Record<string, ParsedProduct>>) => {
    // Ranked first: its title spells the part number. Second: nothing does.
    const listings = [
      card("A", "Acme case for the AC-1000X widget"),
      card("B", "Acme widget"),
    ];
    const adapter: RetailerAdapter = {
      slug: "fake",
      querySupport: {
        maxNumericQueryDigits: null,
        barcodeIsSearchable: false,
        partNumberNeedsBrand: false,
      },
      pacing: { pagesAtOnce: 1 },
      fetchProfile: { country: null, timeoutMs: null },
      maxProbes: 3,
      productIndex: null,
      hosts: ["r.test"],
      buildSearchUrl: (q) => `https://r.test/s?q=${encodeURIComponent(q)}`,
      parseSearchResults: () => listings,
      parseProductPage: (html) => pages[html] ?? null,
    };
    const bodies: Record<string, string> = {};
    for (const l of listings) bodies[l.url] = l.url;
    const fetcher: Fetcher = {
      liveRequestCount: 0,
      pagesDelivered: 0,
      fetch: (url) =>
        Promise.resolve({
          url,
          body: bodies[url] ?? "search",
          cached: false,
          attempts: 1,
        }),
    };
    return resolveItem(
      {
        barcode: "012345678905",
        clientSku: "1",
        partNumber: "AC-1000X",
        brand: "Acme",
      },
      adapter,
      fetcher,
      OPTIONS,
    );
  };

  it("🔴 proposes the page that states AC-1000X over a better-ranked page that states another model", async () => {
    const r = await run({
      "https://r.test/p/A": page("CASE-77"),
      "https://r.test/p/B": page("AC-1000X"),
    });
    expect(r.outcome).toBe("unverifiable");
    expect(r.match?.itemId).toBe("B");
    expect(r.match?.model).toBe("AC-1000X");
  });

  it("CONTROL: with no page stating a model, the best page without a barcode is proposed, as before", async () => {
    const r = await run({
      "https://r.test/p/A": page(null),
      "https://r.test/p/B": page(null),
    });
    expect(r.outcome).toBe("unverifiable");
    expect(r.match?.itemId).toBe("A");
    expect(r.match?.model).toBeNull();
  });
});
