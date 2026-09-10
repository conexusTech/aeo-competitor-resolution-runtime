import { describe, expect, it } from "vitest";

import type {
  ParsedCandidate,
  ParsedProduct,
  RetailerAdapter,
} from "../src/adapters/types.js";
import type { Fetcher, FetchResult } from "../src/fetcher/types.js";
import { FetchFailed } from "../src/fetcher/types.js";
import { DEFAULT_OPTIONS, resolveItem } from "../src/resolve.js";
import {
  MIN_EVIDENCE_TO_REPORT,
  probeOrder,
  rankCandidates,
  hasPartNumberEvidence,
  scoreCandidate,
  WEIGHTS,
} from "../src/ranking.js";

/**
 * The outcome branches, driven directly.
 *
 * The 53-row replay proves the pipeline against real pages, but it can only
 * exercise the outcomes those pages happen to produce. These drive each branch
 * deliberately — particularly `unverifiable`, which is the whole reason this
 * runtime has four outcomes rather than the handover's three.
 */

const candidate = (over: Partial<ParsedCandidate> = {}): ParsedCandidate => ({
  itemId: "ITEM-1",
  url: "https://retailer.test/p/ITEM-1",
  model: "CF-08LB",
  title: "Kingwin CF-08LB 80mm Fan",
  brand: "Kingwin",
  priceCents: 899,
  inStock: true,
  isFirstParty: true,
  sellerName: null,
  ...over,
});

/** A retailer whose pages are whatever the test says they are. */
function fakeAdapter(
  searchResults: Record<string, ParsedCandidate[]>,
  products: Record<string, ParsedProduct>,
): RetailerAdapter {
  return {
    slug: "fake",
    querySupport: { maxNumericQueryDigits: 9, barcodeIsSearchable: false },
    buildSearchUrl: (q) => `https://retailer.test/s?q=${encodeURIComponent(q)}`,
    parseSearchResults: (html) => searchResults[html] ?? [],
    parseProductPage: (html) =>
      products[html] ?? {
        barcode: null,
        priceCents: null,
        inStock: null,
        title: null,
      },
  };
}

/** Serves a body per url; anything else is a fetch failure. */
class MapFetcher implements Fetcher {
  liveRequestCount = 0;
  constructor(private readonly bodies: Record<string, string>) {}
  fetch(url: string): Promise<FetchResult> {
    const body = this.bodies[url];
    if (body === undefined) return Promise.reject(new FetchFailed(url));
    this.liveRequestCount++;
    return Promise.resolve({ url, body, cached: false });
  }
}

const SERP = "https://www.google.com/search?q=%22812348010548%22";
const serpBody = `<h3>Kingwin CF-08LB Fan</h3><h3>Kingwin CF-08LB 80mm</h3><p>CF-08LB CF-08LB</p>`;
const SEARCH = "https://retailer.test/s?q=Kingwin%20CF-08LB";

describe("resolveItem outcomes", () => {
  it("verified — the retailer's barcode agrees, even zero-padded", async () => {
    const adapter = fakeAdapter(
      { SEARCH: [candidate()] },
      // 🔑 The retailer pads to 14. A byte comparison would call this a
      // mismatch; 18% of real proven pairings look like this.
      {
        PDP: {
          barcode: "00812348010548",
          priceCents: 899,
          inStock: true,
          title: null,
        },
      },
    );
    const resolution = await resolveItem(
      { barcode: "812348010548", clientSku: "531814" },
      adapter,
      new MapFetcher({
        [SERP]: serpBody,
        [SEARCH]: "SEARCH",
        "https://retailer.test/p/ITEM-1": "PDP",
      }),
      DEFAULT_OPTIONS,
    );
    expect(resolution.outcome).toBe("verified");
    expect(resolution.match?.retailerBarcode).toBe("00812348010548");
  });

  it("🔴 unverifiable — a listing found, no barcode published", async () => {
    // The outcome the handover had no name for. 91 of 255 real product pages
    // land here, and calling it "probable" claims a match that was never
    // proven either way.
    const adapter = fakeAdapter(
      { SEARCH: [candidate()] },
      { PDP: { barcode: null, priceCents: 899, inStock: true, title: null } },
    );
    const resolution = await resolveItem(
      { barcode: "812348010548", clientSku: "531814" },
      adapter,
      new MapFetcher({
        [SERP]: serpBody,
        [SEARCH]: "SEARCH",
        "https://retailer.test/p/ITEM-1": "PDP",
      }),
      DEFAULT_OPTIONS,
    );
    expect(resolution.outcome).toBe("unverifiable");
    expect(resolution.match).not.toBeNull();
    expect(resolution.match?.retailerBarcode).toBeNull();
  });

  it("unconfirmed — a barcode published, and it disagrees", async () => {
    const adapter = fakeAdapter(
      { SEARCH: [candidate()] },
      {
        PDP: {
          barcode: "099999999999",
          priceCents: 899,
          inStock: true,
          title: null,
        },
      },
    );
    const resolution = await resolveItem(
      { barcode: "812348010548", clientSku: "531814" },
      adapter,
      new MapFetcher({
        [SERP]: serpBody,
        [SEARCH]: "SEARCH",
        "https://retailer.test/p/ITEM-1": "PDP",
      }),
      DEFAULT_OPTIONS,
    );
    expect(resolution.outcome).toBe("unconfirmed");
    expect(resolution.match?.retailerBarcode).toBeNull();
  });

  it("🔴 unverifiable beats unconfirmed when both are available", async () => {
    // Order matters: an item the retailer cannot prove either way must not be
    // downgraded to "probably this" because some later candidate disagreed.
    const adapter = fakeAdapter(
      {
        SEARCH: [
          candidate({ itemId: "A", url: "https://retailer.test/p/A" }),
          candidate({ itemId: "B", url: "https://retailer.test/p/B" }),
        ],
      },
      {
        A: { barcode: null, priceCents: 1, inStock: true, title: null },
        B: {
          barcode: "099999999999",
          priceCents: 1,
          inStock: true,
          title: null,
        },
      },
    );
    const resolution = await resolveItem(
      { barcode: "812348010548", clientSku: "531814" },
      adapter,
      new MapFetcher({
        [SERP]: serpBody,
        [SEARCH]: "SEARCH",
        "https://retailer.test/p/A": "A",
        "https://retailer.test/p/B": "B",
      }),
      DEFAULT_OPTIONS,
    );
    expect(resolution.outcome).toBe("unverifiable");
  });

  it("not-found — a candidate with no part-number evidence is reported as nothing", async () => {
    // 🔴 The guard that stopped a $3,727 server being reported as the match for
    // a $13 accessory. Reporting nothing beats reporting something wrong.
    const weak = candidate({
      model: null,
      brand: null,
      title: "Unrelated Server Chassis",
      isFirstParty: false,
      sellerName: "SomeSeller",
      inStock: false,
    });
    const adapter = fakeAdapter({ SEARCH: [weak] }, {});
    const resolution = await resolveItem(
      { barcode: "812348010548", clientSku: "531814" },
      adapter,
      new MapFetcher({
        [SERP]: `<h3>something</h3><h3>else</h3>`,
        [SEARCH]: "SEARCH",
      }),
      DEFAULT_OPTIONS,
    );
    expect(resolution.outcome).toBe("not-found");
    expect(resolution.match).toBeNull();
  });

  it("not-found — nothing to ask means no requests wasted", async () => {
    const adapter = fakeAdapter({}, {});
    const fetcher = new MapFetcher({});
    const resolution = await resolveItem(
      { barcode: "SQR-WKIT-R2", clientSku: "1" },
      adapter,
      fetcher,
      DEFAULT_OPTIONS,
    );
    expect(resolution.outcome).toBe("not-found");
    expect(resolution.queriesTried).toEqual([]);
  });

  it("caps probes at the configured ceiling", async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      candidate({ itemId: `I${i}`, url: `https://retailer.test/p/I${i}` }),
    );
    const bodies: Record<string, string> = {
      [SERP]: serpBody,
      [SEARCH]: "SEARCH",
    };
    for (const c of many) bodies[c.url] = "MISS";
    const adapter = fakeAdapter(
      { SEARCH: many },
      {
        MISS: {
          barcode: "099999999999",
          priceCents: null,
          inStock: null,
          title: null,
        },
      },
    );
    const resolution = await resolveItem(
      { barcode: "812348010548", clientSku: "531814" },
      adapter,
      new MapFetcher(bodies),
      { ...DEFAULT_OPTIONS, maxProbes: 3 },
    );
    expect(resolution.probes).toBe(3);
  });
});

describe("ranking", () => {
  it("scores an exact part-number match above a text mention", () => {
    const base = {
      partNumbers: ["CF-08LB"],
      brand: "Kingwin",
      barcode: "812348010548",
      queryTokens: [],
    };
    const exact = scoreCandidate({ ...base, candidate: candidate() });
    const mention = scoreCandidate({
      ...base,
      candidate: candidate({
        model: "OTHER",
        title: "mentions CF-08LB somewhere",
      }),
    });
    expect(exact).toBeGreaterThan(mention);
  });

  it("🔴 ranks a first-party listing above a marketplace one at equal evidence", () => {
    // Because a marketplace listing publishes the SELLER's barcode, so a
    // first-party mismatch is meaningful and a marketplace one is not.
    const own = candidate({
      itemId: "OWN",
      isFirstParty: true,
      sellerName: null,
    });
    const market = candidate({
      itemId: "MKT",
      isFirstParty: false,
      sellerName: "SomeSeller",
    });
    const ranked = probeOrder(
      rankCandidates([market, own], {
        partNumbers: ["CF-08LB"],
        brand: "Kingwin",
        barcode: "812348010548",
        queryTokens: [],
      }),
    );
    expect(ranked[0]?.candidate.itemId).toBe("OWN");
  });

  it("gives nothing for an unknown first-party status rather than assuming", () => {
    const unknown = scoreCandidate({
      candidate: candidate({ isFirstParty: null, inStock: false }),
      partNumbers: [],
      brand: null,
      barcode: "812348010548",
      queryTokens: [],
    });
    const own = scoreCandidate({
      candidate: candidate({ isFirstParty: true, inStock: false }),
      partNumbers: [],
      brand: null,
      barcode: "812348010548",
      queryTokens: [],
    });
    expect(own - unknown).toBe(WEIGHTS.firstParty);
  });

  it("is deterministic on ties", () => {
    const a = candidate({ itemId: "A" });
    const b = candidate({ itemId: "B" });
    const input = {
      partNumbers: [],
      brand: null,
      barcode: "812348010548",
      queryTokens: [],
    };
    expect(
      rankCandidates([a, b], input).map((r) => r.candidate.itemId),
    ).toEqual(["A", "B"]);
    expect(
      rankCandidates([b, a], input).map((r) => r.candidate.itemId),
    ).toEqual(["B", "A"]);
  });

  it("keeps the reporting floor above what a brand match alone can earn", () => {
    // The floor must not be reachable without part-number-level evidence,
    // or the guard it exists to be stops guarding.
    // 🔴 The floor is REACHABLE without part-number evidence with these
    // inherited weights — 6 + 3 + 1 is exactly 10 — which is why the pipeline
    // requires `hasPartNumberEvidence` as well as the score. This asserts the
    // arithmetic that makes the second condition necessary, so nobody deletes
    // it believing the number is sufficient.
    expect(WEIGHTS.brandMatch + WEIGHTS.firstParty + WEIGHTS.inStock).toBe(
      MIN_EVIDENCE_TO_REPORT,
    );
    expect(
      hasPartNumberEvidence({
        candidate: candidate({ model: null, title: "nothing relevant" }),
        partNumbers: ["CF-08LB"],
        brand: "Kingwin",
        barcode: "812348010548",
        queryTokens: [],
      }),
    ).toBe(false);
  });
});
