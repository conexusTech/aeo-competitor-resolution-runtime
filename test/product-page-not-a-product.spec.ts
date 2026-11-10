import { describe, expect, it } from "vitest";

import { amazonAdapter } from "../src/adapters/amazon.js";
import { neweggAdapter } from "../src/adapters/newegg.js";
import type {
  ParsedCandidate,
  ParsedProduct,
  RetailerAdapter,
} from "../src/adapters/types.js";
import type { Fetcher, FetchResult } from "../src/fetcher/types.js";
import {
  createProbeMemory,
  DEFAULT_OPTIONS,
  resolveItem,
} from "../src/resolve.js";

/**
 * A product page that is not one is not a listing without a barcode; and each
 * competitor may set its own probe ceiling.
 *
 * 🔴 **`parseProductPage` returning `null` is an unanswered probe.** A product
 * shell, a replacement page or a page with no product payload says nothing
 * about the listing. Read as "publishes no barcode", it would make the item
 * `unverifiable` — "this cannot be proven here" — on the strength of a page
 * that was never the product's.
 */

const BARCODE = "812348010548";

const candidate = (id: string): ParsedCandidate => ({
  itemId: id,
  url: `https://r.test/p/${id}`,
  model: "CF-08LB",
  title: "Kingwin CF-08LB 80mm Fan",
  brand: "Kingwin",
  priceCents: 899,
  inStock: true,
  isFirstParty: true,
  sellerName: null,
  imageUrl: null,
});

const NO_BARCODE: ParsedProduct = {
  barcode: null,
  additionalBarcodes: [],
  priceCents: null,
  inStock: null,
  title: null,
  sellerName: null,
};

function retailer(
  ids: readonly string[],
  page: (html: string) => ParsedProduct | null,
  maxProbes: number | null = null,
): RetailerAdapter {
  return {
    slug: "fake",
    querySupport: { maxNumericQueryDigits: null, barcodeIsSearchable: false },
    pacing: { pagesAtOnce: 3 },
    fetchProfile: { country: null, timeoutMs: null },
    maxProbes,
    buildSearchUrl: (q) => `https://r.test/s?q=${encodeURIComponent(q)}`,
    parseSearchResults: () => ids.map(candidate),
    parseProductPage: page,
  };
}

/** Answers every url: a SERP for the search engine, a page for the rest. */
class AnyPage implements Fetcher {
  liveRequestCount = 0;
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  readonly asked: string[] = [];
  fetch(url: string): Promise<FetchResult> {
    this.asked.push(url);
    this.liveRequestCount++;
    const body = url.includes("google.com")
      ? `<h3>Kingwin CF-08LB Fan</h3><h3>Kingwin CF-08LB 80mm</h3><p>CF-08LB CF-08LB</p>`
      : `PAGE ${url}`;
    return Promise.resolve({ url, body, cached: false, attempts: 1 });
  }
}

const request = { barcode: BARCODE, clientSku: "SKU-1" };
const probesOf = (asked: readonly string[]): string[] =>
  asked.filter((u) => u.startsWith("https://r.test/p/"));

describe("a product page that is not one", () => {
  it("🔴 is not a listing that publishes no barcode", async () => {
    const r = await resolveItem(
      request,
      retailer(["A"], () => null),
      new AnyPage(),
    );
    expect(r.probes).toBe(1);
    expect(r.outcome).not.toBe("unverifiable");
    expect(r.outcome).toBe("unconfirmed");
  });

  it("CONTROL: a real page publishing no barcode IS unverifiable", async () => {
    const r = await resolveItem(
      request,
      retailer(["A"], () => NO_BARCODE),
      new AnyPage(),
    );
    expect(r.outcome).toBe("unverifiable");
  });

  it("is recorded as nothing learned, never as an absent barcode", async () => {
    // A is not a product page; B is, and verifies. A then shows as a
    // runner-up nobody got an answer from, not as one with no barcode.
    const r = await resolveItem(
      request,
      retailer(["A", "B"], (html) =>
        html.endsWith("/p/A") ? null : { ...NO_BARCODE, barcode: BARCODE },
      ),
      new AnyPage(),
    );
    expect(r.outcome).toBe("verified");
    expect(r.match?.itemId).toBe("B");
    const a = r.alternatives.find((alt) => alt.itemId === "A");
    expect(a?.barcodeState).toBe("unprobed");
    expect(a?.retailerBarcode).toBeNull();
  });

  it("teaches the run's memory nothing", async () => {
    const memory = createProbeMemory();
    await resolveItem(
      request,
      retailer(["A"], () => null),
      new AnyPage(),
      DEFAULT_OPTIONS,
      memory,
    );
    expect(memory.get("A")).toBeUndefined();
  });

  it("still spends the probe it cost", async () => {
    const fetcher = new AnyPage();
    const r = await resolveItem(
      request,
      retailer(["A", "B", "C"], () => null),
      fetcher,
      { ...DEFAULT_OPTIONS, maxProbes: 2 },
    );
    expect(r.probes).toBe(2);
    expect(probesOf(fetcher.asked)).toHaveLength(2);
  });
});

describe("a competitor's own probe ceiling", () => {
  const six = ["A", "B", "C", "D", "E", "F"];

  it("caps the probes at the adapter's figure", async () => {
    const fetcher = new AnyPage();
    const r = await resolveItem(
      request,
      retailer(six, () => ({ ...NO_BARCODE, barcode: "036000291452" }), 3),
      fetcher,
    );
    expect(r.probes).toBe(3);
    expect(probesOf(fetcher.asked)).toHaveLength(3);
  });

  it("CONTROL: null means the run's default", async () => {
    const fetcher = new AnyPage();
    const r = await resolveItem(
      request,
      retailer(six, () => ({ ...NO_BARCODE, barcode: "036000291452" }), null),
      fetcher,
      { ...DEFAULT_OPTIONS, maxProbes: 5 },
    );
    expect(r.probes).toBe(5);
  });

  it("is null for Newegg and Amazon, so the run default of 8 still applies", () => {
    expect(neweggAdapter.maxProbes).toBeNull();
    expect(amazonAdapter.maxProbes).toBeNull();
    expect(DEFAULT_OPTIONS.maxProbes).toBe(8);
  });
});
