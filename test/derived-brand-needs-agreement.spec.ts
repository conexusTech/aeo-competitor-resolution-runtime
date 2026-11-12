import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type {
  ParsedCandidate,
  ParsedProduct,
  QuerySupport,
  RetailerAdapter,
} from "../src/adapters/types.js";
import type { Corpus } from "../src/fetcher/replay.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchResult,
} from "../src/fetcher/types.js";
import {
  identityFromSearchResults,
  inferBrand,
  resultTitles,
} from "../src/identity/from-search-results.js";
import { DEFAULT_OPTIONS, resolveItem } from "../src/resolve.js";

/**
 * 🔴 **A brand derived from a search engine's page has to be one the titles
 * agree on.**
 *
 * Measured in September on the first real Amazon run: item `772269`, whose
 * barcode search led with "WIRELESS MOUSE M310/PEACOCK BLUE", was given the
 * brand `WIRELESS` — the first word of the first title — and every query then
 * searched for a manufacturer that does not exist: `WIRELESS M310`,
 * `WIRELESS 06787`. A row with no brand of its own reaches this on every item,
 * and Micro Center's full catalogue export carries no brand at all.
 *
 * The rule: the first title's leading word, only when another DISTINCT title
 * leads with the same word (case and punctuation aside), and never a word the
 * committed search pages show leading titles without being a manufacturer.
 * Otherwise `null` — an honest nothing the plan searches without.
 */

const M310_UPC = "097855067876";
const SEARCH_ENGINE = (barcode: string): string =>
  DEFAULT_OPTIONS.searchEngineUrlTemplate.replace(
    "{query}",
    encodeURIComponent(barcode),
  );

const serp = (titles: readonly string[], body = ""): string =>
  `<html><body>${titles.map((t) => `<h3>${t}</h3>`).join("")}<p>${body}</p></body></html>`;

describe("inferBrand needs the titles to agree", () => {
  it("🔴 'WIRELESS MOUSE M310/…' alone yields no brand", () => {
    expect(inferBrand(["WIRELESS MOUSE M310/PEACOCK BLUE"])).toBeNull();
  });

  it("🔴 nor when a second title also leads with 'Wireless': it is not a manufacturer", () => {
    expect(
      inferBrand([
        "WIRELESS MOUSE M310/PEACOCK BLUE",
        "Wireless Mouse M310 - Peacock Blue",
        "Logitech M310 Wireless Mouse",
      ]),
    ).toBeNull();
  });

  it("two titles leading with 'Logitech' yield 'Logitech' — the CONTROL", () => {
    expect(
      inferBrand([
        "Logitech M310 Wireless Mouse",
        "Logitech M310 Peacock Blue",
      ]),
    ).toBe("Logitech");
  });

  it("agrees across case and punctuation, and answers as the first title spells it", () => {
    expect(
      inferBrand(["Logitech M310 Wireless Mouse", "LOGITECH, M310 Peacock"]),
    ).toBe("Logitech");
    expect(inferBrand(["logitech® M310", "Logitech M310 Mouse"])).toBe(
      "logitech",
    );
  });

  it("one title only yields null", () => {
    expect(inferBrand(["Allsop Accutrack Slimline Mousepad"])).toBeNull();
  });

  it("🔴 the same listing duplicated does not count as two titles", () => {
    expect(
      inferBrand([
        "Tuniq TX-4 High Performance Thermal Compound",
        "Tuniq TX-4 High Performance Thermal Compound",
        "Tuniq TX-4 High Performance Thermal Compound",
        "Sealed Genuine Thermaltake TG-30 Premium CPU/GPU ...",
      ]),
    ).toBeNull();
  });

  it("does not take a later title's word when the first title's does not agree", () => {
    // A brand is only ever the first title's leading word; agreement elsewhere
    // does not promote a different one.
    expect(
      inferBrand([
        "On-ear Headphones 1 Pk - KOSS",
        "Koss KEB6IK Earbud",
        "Koss KEB6iK Enhanced Stereo",
      ]),
    ).toBeNull();
  });
});

const corpusPath = fileURLToPath(
  new URL("./corpus/launch-retailer-53.json.gz", import.meta.url),
);
const searchPages = (): Map<string, string> => {
  const corpus = JSON.parse(
    gunzipSync(readFileSync(corpusPath)).toString("utf8"),
  ) as Corpus;
  const pages = new Map<string, string>();
  for (const entry of corpus.entries) {
    const m = /^https:\/\/www\.google\.com\/search\?q=%22(\d+)%22$/.exec(
      entry.url,
    );
    if (m?.[1] !== undefined && entry.body !== null)
      pages.set(m[1], entry.body);
  }
  return pages;
};

/**
 * Every manufacturer behind the committed search pages, by the first word of
 * its name — the word a title leads with. Read off the pages by hand on
 * 2026-11-12: Case Logic, Cooler Master, Dot Line and Night Owl lead their
 * titles with a word that is ordinary English, and are still the maker.
 */
const MANUFACTURERS = new Set([
  "allsop",
  "apc",
  "buffalo",
  "case",
  "cooler",
  "cyberpower",
  "dot",
  "fujifilm",
  "imak",
  "intellinet",
  "kensington",
  "kingwin",
  "logitech",
  "netgear",
  "night",
  "primochill",
  "sandisk",
  "steelseries",
  "thrustmaster",
  "trendnet",
]);

describe("on the committed search-engine pages", () => {
  const pages = searchPages();
  const brandOf = (barcode: string): string | null =>
    inferBrand(resultTitles(pages.get(barcode) ?? ""));

  it("reads all 68 of them", () => {
    expect(pages.size).toBe(68);
  });

  it("🔴 never derives a brand the manufacturer does not have", () => {
    const invented = [...pages.entries()]
      .map(([barcode, html]) => [barcode, inferBrand(resultTitles(html))])
      .filter(
        ([, brand]) => brand != null && !MANUFACTURERS.has(brand.toLowerCase()),
      );
    expect(invented).toEqual([]);
  });

  it.each([
    ["663296413697", "Control", "'Control System - Thrustmaster …'"],
    ["649833101234", "Le", "'Le Petit Mouse …' (IMAK)"],
    ["855597003985", "Transceptor", "'Transceptor de vídeo …' (Avue)"],
    ["021299187203", "On-ear", "one title only, the rest lead 'Koss'"],
    [
      "812348012993",
      "Powered",
      "two copies of one listing, the rest 'Kingwin'",
    ],
    ["188218000453", "Quote", "one title only, the rest lead 'Sabrent'"],
  ])("%s, once given '%s' from %s, gets none", (barcode) => {
    expect(pages.has(barcode)).toBe(true);
    expect(brandOf(barcode)).toBeNull();
  });

  it.each([
    [M310_UPC, "Logitech"],
    ["085854213196", "Case"],
    ["731304016298", "APC"],
  ])("%s still gets %s — the CONTROL", (barcode, brand) => {
    expect(brandOf(barcode)).toBe(brand);
  });
});

// --- through the pipeline -------------------------------------------------

const card = (over: Partial<ParsedCandidate> = {}): ParsedCandidate => ({
  itemId: "A",
  url: "https://r.test/p/A",
  model: null,
  title: "A listing",
  brand: null,
  priceCents: 1299,
  inStock: true,
  isFirstParty: true,
  sellerName: "Retailer",
  imageUrl: null,
  partialMatch: false,
  ...over,
});

const product = (barcode: string | null): ParsedProduct => ({
  barcode,
  additionalBarcodes: [],
  priceCents: null,
  inStock: null,
  title: null,
  sellerName: null,
  isFirstParty: null,
  unverifiableReason: null,
  category: null,
});

/** Serves pages by url; anything else is a fetch that failed. */
class Pages implements Fetcher {
  liveRequestCount = 0;
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  constructor(private readonly byUrl: (url: string) => string | undefined) {}
  fetch(url: string): Promise<FetchResult> {
    this.liveRequestCount++;
    const body = this.byUrl(url);
    if (body === undefined) {
      return Promise.reject(new FetchFailed(url, undefined, null, 1));
    }
    return Promise.resolve({ url, body, cached: false, attempts: 1 });
  }
}

const searchUrl = (q: string): string =>
  `https://r.test/s?q=${encodeURIComponent(q)}`;

/** A retailer answering `results[query]`; every other query finds nothing. */
function retailer(
  querySupport: QuerySupport,
  results: Readonly<Record<string, readonly ParsedCandidate[]>>,
  pages: Readonly<Record<string, ParsedProduct>>,
  extra: Readonly<Record<string, string>>,
): { adapter: RetailerAdapter; fetcher: Pages } {
  const adapter: RetailerAdapter = {
    slug: "fake",
    querySupport,
    pacing: { pagesAtOnce: 3 },
    fetchProfile: { country: null, timeoutMs: null },
    maxProbes: 3,
    productIndex: null,
    hosts: ["r.test"],
    buildSearchUrl: searchUrl,
    parseSearchResults: (html) => [
      ...(results[html.replace(/^search:/, "")] ?? []),
    ],
    parseProductPage: (html) => pages[html.replace(/^page:/, "")] ?? null,
  };
  const fetcher = new Pages((url) => {
    if (url in extra) return extra[url];
    if (url in pages) return `page:${url}`;
    const q = /^https:\/\/r\.test\/s\?q=(.*)$/.exec(url)?.[1];
    return q === undefined ? undefined : `search:${decodeURIComponent(q)}`;
  });
  return { adapter, fetcher };
}

const NO_BARCODE_SEARCH: QuerySupport = {
  maxNumericQueryDigits: null,
  barcodeIsSearchable: false,
  partNumberNeedsBrand: false,
};
const NEEDS_BRAND: QuerySupport = {
  maxNumericQueryDigits: null,
  barcodeIsSearchable: true,
  partNumberNeedsBrand: true,
};
const OPTIONS = { ...DEFAULT_OPTIONS, clientCatalogueUrlTemplate: null };

/** The September case: the search page leads with a generic word. */
const WIRELESS_SERP = serp([
  "WIRELESS MOUSE M310/PEACOCK BLUE",
  "Wireless Mouse M310 - Peacock Blue",
  "M310 Wireless Mouse Peacock Blue",
]);

describe("a brandless row whose search page leads with a generic word", () => {
  const m310 = card({
    itemId: "M310",
    url: "https://r.test/p/M310",
    model: "M310",
    title: "Logitech M310 Wireless Mouse",
    brand: "Logitech",
  });
  const setup = (support: QuerySupport) =>
    retailer(
      support,
      { M310: [m310], "Logitech M310": [m310] },
      { [m310.url]: product(M310_UPC) },
      { [SEARCH_ENGINE(M310_UPC)]: WIRELESS_SERP },
    );

  it("derives no brand from it", () => {
    const got = identityFromSearchResults({
      barcode: M310_UPC,
      clientSku: "772269",
      document: WIRELESS_SERP,
    });
    expect(got?.brand).toBeNull();
    // The rest of what the page says is still read.
    expect(got?.partNumberCandidates).toContain("M310");
  });

  it("🔴 plans no query prefixed with an invented brand", async () => {
    const { adapter, fetcher } = setup(NO_BARCODE_SEARCH);
    const r = await resolveItem(
      { barcode: M310_UPC, clientSku: "772269" },
      adapter,
      fetcher,
      OPTIONS,
    );
    expect(r.identity?.brand ?? null).toBeNull();
    expect(r.queriesTried.length).toBeGreaterThan(0);
    for (const q of r.queriesTried) expect(q).not.toMatch(/^wireless\b/i);
    // The bare part number is still asked, and still finds it.
    expect(r.queriesTried).toContain("M310");
    expect(r.outcome).toBe("verified");
  });

  it("where a part number needs its brand, runs on a null one without failing", async () => {
    const { adapter, fetcher } = setup(NEEDS_BRAND);
    const r = await resolveItem(
      { barcode: M310_UPC, clientSku: "772269" },
      adapter,
      fetcher,
      OPTIONS,
    );
    expect(r.identity?.brand ?? null).toBeNull();
    for (const q of r.queriesTried) expect(q).not.toMatch(/^wireless\b/i);
    expect(r.queriesTried).toContain("M310");
    expect(r.failure).toBeNull();
  });

  it("🔑 a brand the client uploaded is untouched, and still leads the plan", async () => {
    const { adapter, fetcher } = setup(NO_BARCODE_SEARCH);
    const r = await resolveItem(
      { barcode: M310_UPC, clientSku: "772269", brand: "Logitech" },
      adapter,
      fetcher,
      OPTIONS,
    );
    expect(r.identity?.brand).toBe("Logitech");
    expect(r.queriesTried[0]).toBe("Logitech M310");
    for (const q of r.queriesTried) expect(q).not.toMatch(/^wireless\b/i);
    expect(r.outcome).toBe("verified");
  });

  it("🔑 and outranks a brand the titles DO agree on", async () => {
    // With the generic word gone, the override needs a page whose titles
    // agree on some other word to show it still wins.
    const agreed = serp([
      "Peacock M310 Wireless Mouse",
      "Peacock M310 Mouse - Blue",
      "M310 Wireless Mouse Peacock Blue",
    ]);
    const derived = identityFromSearchResults({
      barcode: M310_UPC,
      clientSku: "772269",
      document: agreed,
    });
    expect(derived?.brand).toBe("Peacock"); // the CONTROL

    const { adapter, fetcher } = retailer(
      NO_BARCODE_SEARCH,
      { M310: [m310], "Logitech M310": [m310] },
      { [m310.url]: product(M310_UPC) },
      { [SEARCH_ENGINE(M310_UPC)]: agreed },
    );
    const r = await resolveItem(
      { barcode: M310_UPC, clientSku: "772269", brand: "Logitech" },
      adapter,
      fetcher,
      OPTIONS,
    );
    expect(r.identity?.brand).toBe("Logitech");
    expect(r.queriesTried[0]).toBe("Logitech M310");
    for (const q of r.queriesTried) expect(q).not.toMatch(/^peacock\b/i);
  });
});
