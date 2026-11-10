import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  bhAdapter,
  DISCONTINUED_NO_UPC,
  parseSearchResults as bhSearch,
} from "../src/adapters/bh.js";
import type {
  ParsedCandidate,
  RetailerAdapter,
} from "../src/adapters/types.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchResult,
} from "../src/fetcher/types.js";
import {
  BARCODE_STAGE_PROBES,
  DEFAULT_OPTIONS,
  resolveItem,
} from "../src/resolve.js";

/**
 * 🔴 **The barcode stage has its own allowance, and never spends the item's.**
 *
 * The barcode search runs first, and its probes used to count against the
 * item's whole `maxProbes`. A barcode query a retailer answers with
 * look-alikes (B&H's `PARTIAL_SEARCH`) spent all of them, so the part-number
 * search after it found the real listing and could not open it — and B&H's
 * discontinued Z623, which Jody's rule sends to a person, never reached one.
 *
 * Now the barcode stage opens at most `BARCODE_STAGE_PROBES` listings, outside
 * `maxProbes`, and never one the retailer itself marked as a partial or
 * look-alike answer.
 */

const raw = (name: string): string =>
  gunzipSync(
    readFileSync(fileURLToPath(new URL(`./raw/${name}.gz`, import.meta.url))),
  ).toString("utf8");

const Z623 = {
  upc: "097855066466",
  sku: "SKU-Z623",
  mpn: "980-000402",
  brand: "Logitech",
};
const CATALOGUE = "https://catalogue.test/item/{sku}";
const Z623_PAGE =
  "https://www.bhphotovideo.com/c/product/736288-REG/Logitech_980_000402_Z623_THX_Certified_2_1_Speaker.html";
const PARTIAL = raw("bh-search-partial-nonsense.html");
const MFR = raw("bh-search-mfr-z623.html");

class BhFetcher implements Fetcher {
  liveRequestCount = 0;
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  readonly asked: string[] = [];
  private readonly bodies: Record<string, string> = {
    // 🔑 B&H's real answer to a part number it matched nothing of: a
    // PARTIAL_SEARCH page of 28 look-alikes, served for the barcode.
    [bhAdapter.buildSearchUrl("097855066466")]: PARTIAL,
    [bhAdapter.buildSearchUrl(Z623.mpn)]: MFR,
    [CATALOGUE.replace("{sku}", Z623.sku)]:
      `<script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        sku: Z623.sku,
        mpn: Z623.mpn,
        brand: { "@type": "Brand", name: Z623.brand },
      })}</script>`,
    [Z623_PAGE]: raw("bh-pdp-z623-discontinued.html"),
  };
  fetch(url: string): Promise<FetchResult> {
    this.asked.push(url);
    const body = this.bodies[url];
    if (body === undefined)
      return Promise.reject(new FetchFailed(url, undefined, 502, 3));
    return Promise.resolve({ url, body, cached: true, attempts: 0 });
  }
}

describe("🔴 B&H: a barcode answered with look-alikes, then the MFR # finding a discontinued item", () => {
  it("the fixtures are what they say", () => {
    const partial = bhSearch(PARTIAL) ?? [];
    expect(partial.length).toBeGreaterThanOrEqual(3);
    expect(partial.every((c) => c.partialMatch)).toBe(true);
    const exact = bhSearch(MFR) ?? [];
    expect(exact.some((c) => c.url === Z623_PAGE)).toBe(true);
    expect(exact.every((c) => !c.partialMatch)).toBe(true);
  });

  it("goes to a person as unverifiable, with the discontinued reason", async () => {
    const fetcher = new BhFetcher();
    const r = await resolveItem(
      { barcode: Z623.upc, clientSku: Z623.sku },
      bhAdapter,
      fetcher,
      { ...DEFAULT_OPTIONS, clientCatalogueUrlTemplate: CATALOGUE },
    );
    expect(r.outcome).toBe("unverifiable");
    expect(r.match?.url).toBe(Z623_PAGE);
    expect(r.match?.unverifiableReason).toBe(DISCONTINUED_NO_UPC);
    // No look-alike from the barcode search was opened.
    const opened = fetcher.asked.filter((u) => u.includes("/c/product/"));
    expect(opened).toEqual([Z623_PAGE]);
  });
});

// ── The allowance, on a scripted retailer ───────────────────────────────

const listing = (
  itemId: string,
  over: Partial<ParsedCandidate> = {},
): ParsedCandidate => ({
  itemId,
  url: `https://r.test/p/${itemId}`,
  model: "CF-08LB",
  title: "Kingwin CF-08LB 80mm Fan",
  brand: "Kingwin",
  priceCents: 899,
  inStock: true,
  isFirstParty: true,
  sellerName: null,
  imageUrl: null,
  partialMatch: false,
  ...over,
});

/** `RESULTS a,b` lists those ids, `PARTIAL a,b` lists them as look-alikes. */
const scripted = (maxProbes: number | null): RetailerAdapter => ({
  slug: "fake",
  querySupport: {
    maxNumericQueryDigits: null,
    barcodeIsSearchable: true,
    partNumberNeedsBrand: false,
  },
  pacing: { pagesAtOnce: 3 },
  fetchProfile: { country: null, timeoutMs: null },
  maxProbes,
  productIndex: null,
  hosts: ["r.test"],
  buildSearchUrl: (q) => `https://r.test/s?q=${encodeURIComponent(q)}`,
  parseSearchResults: (html) => {
    const [kind, ids] = html.split(" ");
    if (ids === undefined) return null;
    // 🔑 What the barcode search found names no part number, so the
    // part-number search's listings rank above the ones it left unopened.
    return ids.split(",").map((id) =>
      listing(
        id,
        id.startsWith("b")
          ? {
              partialMatch: kind === "PARTIAL",
              model: null,
              brand: null,
              title: `Another Fan ${id}`,
            }
          : { partialMatch: kind === "PARTIAL" },
      ),
    );
  },
  parseProductPage: (html) => ({
    barcode: html.startsWith("UPC ") ? html.slice(4) : null,
    additionalBarcodes: [],
    priceCents: null,
    inStock: null,
    title: null,
    sellerName: null,
    isFirstParty: null,
    unverifiableReason: null,
  }),
});

const BARCODE = "812348010548";
const CLIENT = "https://client.test/p/{sku}";
const CLIENT_PAGE = `<script type="application/ld+json">${JSON.stringify({
  "@type": "Product",
  sku: "SKU-1",
  mpn: "CF-08LB",
  brand: { "@type": "Brand", name: "Kingwin" },
})}</script>`;

class Scripted implements Fetcher {
  liveRequestCount = 0;
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  readonly asked: string[] = [];
  constructor(private readonly bodies: Record<string, string>) {}
  fetch(url: string): Promise<FetchResult> {
    this.asked.push(url);
    const body = this.bodies[url];
    if (body === undefined)
      return Promise.reject(new FetchFailed(url, undefined, null, 1));
    this.liveRequestCount++;
    return Promise.resolve({ url, body, cached: false, attempts: 1 });
  }
}

const search = (q: string): string =>
  `https://r.test/s?q=${encodeURIComponent(q)}`;
const page = (id: string): string => `https://r.test/p/${id}`;

describe("the barcode stage's own allowance", () => {
  it("is two probes", () => {
    expect(BARCODE_STAGE_PROBES).toBe(2);
  });

  it("🔴 opens at most two of the barcode's results, and leaves the item its whole budget", async () => {
    const fetcher = new Scripted({
      [search(BARCODE)]: "RESULTS b1,b2,b3,b4",
      [CLIENT.replace("{sku}", "SKU-1")]: CLIENT_PAGE,
      [search("Kingwin CF-08LB")]: "RESULTS p1,p2,p3",
      [page("b1")]: "UPC 000000000017",
      [page("b2")]: "UPC 000000000024",
      [page("b3")]: "UPC 000000000031",
      [page("b4")]: "UPC 000000000048",
      [page("p1")]: "UPC 000000000055",
      [page("p2")]: "UPC 000000000062",
      [page("p3")]: `UPC ${BARCODE}`,
    });
    const r = await resolveItem(
      { barcode: BARCODE, clientSku: "SKU-1" },
      scripted(3),
      fetcher,
      { ...DEFAULT_OPTIONS, clientCatalogueUrlTemplate: CLIENT },
    );
    // Two in the barcode stage, then the item's three: the third verifies.
    expect(r.outcome).toBe("verified");
    expect(r.match?.itemId).toBe("p3");
    const opened = fetcher.asked.filter((u) =>
      u.startsWith("https://r.test/p/"),
    );
    expect(opened.slice(0, 2)).toEqual([page("b1"), page("b2")]);
    expect(opened).not.toContain(page("b3"));
    expect(opened).not.toContain(page("b4"));
    expect(r.probes).toBe(2 + 3);
  });

  it("🔴 never opens a result the retailer marked as a look-alike of the barcode", async () => {
    const fetcher = new Scripted({
      [search(BARCODE)]: "PARTIAL b1,b2,b3",
      [CLIENT.replace("{sku}", "SKU-1")]: CLIENT_PAGE,
      [search("Kingwin CF-08LB")]: "RESULTS p1",
      [page("p1")]: `UPC ${BARCODE}`,
    });
    const r = await resolveItem(
      { barcode: BARCODE, clientSku: "SKU-1" },
      scripted(3),
      fetcher,
      { ...DEFAULT_OPTIONS, clientCatalogueUrlTemplate: CLIENT },
    );
    const opened = fetcher.asked.filter((u) =>
      u.startsWith("https://r.test/p/"),
    );
    expect(opened[0]).toBe(page("p1"));
    expect(r.outcome).toBe("verified");
    expect(r.match?.itemId).toBe("p1");
  });

  it("CONTROL: a barcode hit still verifies in the barcode stage, before identity", async () => {
    const fetcher = new Scripted({
      [search(BARCODE)]: "RESULTS b1,b2",
      [page("b1")]: "UPC 000000000017",
      [page("b2")]: `UPC ${BARCODE}`,
    });
    const r = await resolveItem(
      { barcode: BARCODE, clientSku: "SKU-1" },
      scripted(3),
      fetcher,
      { ...DEFAULT_OPTIONS, clientCatalogueUrlTemplate: CLIENT },
    );
    expect(r.outcome).toBe("verified");
    expect(r.match?.itemId).toBe("b2");
    expect(fetcher.asked).not.toContain(CLIENT.replace("{sku}", "SKU-1"));
  });
});
