import { describe, expect, it } from "vitest";

import type {
  ParsedCandidate,
  ParsedProduct,
  QuerySupport,
  RetailerAdapter,
} from "../src/adapters/types.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchResult,
} from "../src/fetcher/types.js";
import { planQueries } from "../src/query-plan.js";
import { brandAgrees, namesThePartNumber } from "../src/ranking.js";
import {
  createProbeMemory,
  DEFAULT_OPTIONS,
  resolveItem,
} from "../src/resolve.js";

/**
 * Where a part number names a product only with its brand
 * (`QuerySupport.partNumberNeedsBrand`).
 *
 * 🔴 **Measured at B&H**: the MFR # of four rows the investigation found B&H
 * does not carry each belonged to another brand's item there — Allsop's
 * 29538 wrist rest is a C2G DisplayPort cable's MFR #. An equal part number
 * alone would spend a probe on the cable, find its barcode disagrees, and
 * propose it for review as `unconfirmed`: a cable offered for a wrist rest.
 *
 * Every check is run with the switch on and with it off, because the second
 * half of the rule is that nothing changes where it is off.
 */

const support = (partNumberNeedsBrand: boolean): QuerySupport => ({
  maxNumericQueryDigits: null,
  barcodeIsSearchable: false,
  partNumberNeedsBrand,
});

const card = (over: Partial<ParsedCandidate> = {}): ParsedCandidate => ({
  itemId: "A",
  url: "https://r.test/p/A",
  model: "29538",
  title: "Allsop Ergoprene Gel Wrist Rest",
  brand: "Allsop",
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

const ALLSOP_UPC = "035286295383";
const C2G_CABLE = card({
  itemId: "C2G",
  url: "https://r.test/p/C2G",
  title: "C2G 100' DisplayPort Active Optical Cable (AOC) - Plenum CMP-Rated",
  brand: "C2G",
});

const CATALOGUE = "https://client.test/p/{sku}";
const catalogue = (mpn: string, brand: string): string =>
  `<script type="application/ld+json">${JSON.stringify({
    "@type": "Product",
    sku: "SKU-1",
    mpn,
    brand: { "@type": "Brand", name: brand },
  })}</script>`;

/** Serves pages by url; anything else is a fetch that failed. */
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
      return Promise.reject(new FetchFailed(url, undefined, null, 1));
    }
    return Promise.resolve({ url, body, cached: false, attempts: 1 });
  }
}

/** A retailer whose search answers `results[query]`, and pages `pages[url]`. */
function retailer(
  partNumberNeedsBrand: boolean,
  results: Readonly<Record<string, readonly ParsedCandidate[]>>,
  pages: Readonly<Record<string, ParsedProduct>>,
): { adapter: RetailerAdapter; fetcher: Pages } {
  const searchUrl = (q: string): string =>
    `https://r.test/s?q=${encodeURIComponent(q)}`;
  const byUrl: Record<string, string> = {
    "https://client.test/p/SKU-1": catalogue("29538", "Allsop"),
  };
  for (const query of Object.keys(results)) {
    byUrl[searchUrl(query)] = `search:${query}`;
  }
  for (const url of Object.keys(pages)) byUrl[url] = `page:${url}`;
  const adapter: RetailerAdapter = {
    slug: "fake",
    querySupport: support(partNumberNeedsBrand),
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
  return { adapter, fetcher: new Pages(byUrl) };
}

const OPTIONS = { ...DEFAULT_OPTIONS, clientCatalogueUrlTemplate: CATALOGUE };

describe("brandAgrees", () => {
  it("compares first words, as the two sides spell one brand differently", () => {
    expect(brandAgrees("IMAK Products", card({ brand: "IMAK" }))).toBe(true);
    expect(
      brandAgrees("CyberPower Systems", card({ brand: "CyberPower" })),
    ).toBe(true);
    expect(brandAgrees("Logitech", card({ brand: "Logitech G" }))).toBe(true);
    expect(brandAgrees("Allsop", C2G_CABLE)).toBe(false);
  });

  it("reads the title's first word where the listing states no brand", () => {
    expect(brandAgrees("Allsop", card({ brand: null }))).toBe(true);
    expect(brandAgrees("Allsop", { ...C2G_CABLE, brand: null })).toBe(false);
  });

  it("agrees when the item's brand is unknown — nothing refutes it", () => {
    expect(brandAgrees(null, C2G_CABLE)).toBe(true);
  });
});

describe("namesThePartNumber", () => {
  const input = (candidate: ParsedCandidate, partNumbers: string[]) => ({
    candidate,
    partNumbers,
    brand: null,
    barcode: "097855066466",
    queryTokens: [],
  });

  it("is an equal, contained or containing model, a regional stem, or the text", () => {
    expect(
      namesThePartNumber(input(card({ model: "980-000402" }), ["980-000402"])),
    ).toBe(true);
    expect(
      namesThePartNumber(input(card({ model: "SOT63005" }), ["63005"])),
    ).toBe(true);
    expect(
      namesThePartNumber(input(card({ model: "K72337US" }), ["K72337WW"])),
    ).toBe(true);
    expect(
      namesThePartNumber(
        input(card({ model: null, title: "Logitech Z623 980-000402" }), [
          "980-000402",
        ]),
      ),
    ).toBe(true);
  });

  it("🔴 is NOT a shared prefix alone: a manufacturer numbers a family that way", () => {
    // Logitech's Z313 and Z625 beside the Z623 at B&H, all `980-00…`.
    expect(
      namesThePartNumber(input(card({ model: "980-000382" }), ["980-000402"])),
    ).toBe(false);
    expect(
      namesThePartNumber(input(card({ model: "980-001258" }), ["980-000402"])),
    ).toBe(false);
  });
});

describe("planQueries, where a part number needs the brand", () => {
  const input = {
    barcode: ALLSOP_UPC,
    brand: "Allsop",
    partNumbers: ["29538"],
    phrase: null,
    productName: null,
    clientPartNumber: null,
  };

  it("asks the bare part number before the brand-scoped one", () => {
    expect(planQueries(input, support(true))).toEqual([
      "29538",
      "Allsop 29538",
    ]);
  });

  it("CONTROL: everywhere else the brand-scoped one is still first", () => {
    expect(planQueries(input, support(false))).toEqual([
      "Allsop 29538",
      "29538",
    ]);
  });
});

describe("resolveItem, where a part number needs the brand", () => {
  const results = { "29538": [C2G_CABLE], "Allsop 29538": [] };
  const pages = { [C2G_CABLE.url]: product("757120295381") };

  it("🔴 never probes or proposes another brand's item with the same part number", async () => {
    const { adapter, fetcher } = retailer(true, results, pages);
    const resolution = await resolveItem(
      { barcode: ALLSOP_UPC, clientSku: "SKU-1" },
      adapter,
      fetcher,
      OPTIONS,
    );
    expect(resolution.outcome).toBe("not-found");
    expect(resolution.failure).toBeNull();
    expect(resolution.match).toBeNull();
    expect(resolution.probes).toBe(0);
    expect(fetcher.asked).not.toContain(C2G_CABLE.url);
    // The cable was found, so it was not a search nobody answered — and the
    // brand-scoped search was still asked, the cable being no answer.
    expect(resolution.candidatesSeen).toBe(1);
    expect(resolution.queriesTried).toEqual(["29538", "Allsop 29538"]);
  });

  it("CONTROL: with the switch off, the same cable is probed and proposed", async () => {
    const { adapter, fetcher } = retailer(false, results, pages);
    const resolution = await resolveItem(
      { barcode: ALLSOP_UPC, clientSku: "SKU-1" },
      adapter,
      fetcher,
      OPTIONS,
    );
    expect(fetcher.asked).toContain(C2G_CABLE.url);
    expect(resolution.outcome).toBe("unconfirmed");
    expect(resolution.match?.itemId).toBe("C2G");
  });

  it("still finds the item's own listing among other brands'", async () => {
    const wristRest = card({ itemId: "WR", url: "https://r.test/p/WR" });
    const { adapter, fetcher } = retailer(
      true,
      { "29538": [C2G_CABLE, wristRest] },
      { [wristRest.url]: product(ALLSOP_UPC) },
    );
    const resolution = await resolveItem(
      { barcode: ALLSOP_UPC, clientSku: "SKU-1" },
      adapter,
      fetcher,
      OPTIONS,
    );
    expect(resolution.outcome).toBe("verified");
    expect(resolution.match?.itemId).toBe("WR");
    expect(resolution.probes).toBe(1);
    // The MFR # and the brand both agreed, so the search stopped there.
    expect(resolution.queriesTried).toEqual(["29538"]);
  });

  it("keeps a barcode this run already read, whatever the brand reads as", async () => {
    // A listing whose brand this build mis-read, but whose published barcode
    // an earlier item's probe read and found equal to this item's.
    const misread = { ...card({ brand: "Ergoprene" }), itemId: "MR" };
    const memory = createProbeMemory();
    memory.remember("MR", [ALLSOP_UPC]);
    const { adapter, fetcher } = retailer(true, { "29538": [misread] }, {});
    const resolution = await resolveItem(
      { barcode: ALLSOP_UPC, clientSku: "SKU-1" },
      adapter,
      fetcher,
      OPTIONS,
      memory,
    );
    expect(resolution.outcome).toBe("verified");
    expect(resolution.match?.itemId).toBe("MR");
    expect(resolution.probes).toBe(0);
  });
});

describe("where the item's brand is unknown (review finding 12, documented in the B&H adapter)", () => {
  it("another brand's listing under the same part number goes to a person — never verified", async () => {
    const { adapter } = retailer(
      true,
      { "29538": [C2G_CABLE] },
      { [C2G_CABLE.url]: product("757120295381") },
    );
    // The catalogue states the MFR # and no brand.
    const noBrand = new Pages({
      "https://client.test/p/SKU-1": `<script type="application/ld+json">${JSON.stringify(
        { "@type": "Product", sku: "SKU-1", mpn: "29538" },
      )}</script>`,
      "https://r.test/s?q=29538": "search:29538",
      [C2G_CABLE.url]: `page:${C2G_CABLE.url}`,
    });
    const r = await resolveItem(
      { barcode: ALLSOP_UPC, clientSku: "SKU-1" },
      adapter,
      noBrand,
      OPTIONS,
    );
    expect(r.identity?.brand ?? null).toBeNull();
    // Probed: nothing about the item's brand refutes the cable.
    expect(noBrand.asked).toContain(C2G_CABLE.url);
    // Its barcode disagrees: a proposal for a person, never a verification.
    expect(r.outcome).toBe("unconfirmed");
    expect(r.match?.itemId).toBe("C2G");
    // The cable's own published barcode, which is the disagreement.
    expect(r.match?.retailerBarcode).toBe("757120295381");
  });
});
