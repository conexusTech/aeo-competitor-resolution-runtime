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

/**
 * An item nobody managed to look up.
 *
 * 🔴 **Every check here fails against the code as it shipped.** When identity
 * yields nothing searchable, `planQueries` returns `[]` and `resolveItem`
 * returned a clean `not-found` with `failure: null` — which the gateway maps to
 * item state `not_carried`, defined in its own constants as "the competitor
 * GENUINELY does not stock the item, which is real assortment information".
 *
 * A live queue run on 2026-09-11 filed 3 of 10 items that way, each noted "0
 * candidate(s) across 0 query attempt(s)". The run's own words admitted nobody
 * looked while the state it filed told the customer the retailer does not carry
 * the item.
 *
 * 🔑 `runList` already refused this on the THROWING route, with a comment
 * saying so: "never as a clean miss, which would report 'this retailer does not
 * carry it' for an item nobody managed to look up." These are that rule applied
 * to the route that does not throw.
 */
describe("an item that was never searched", () => {
  /** A retailer that cannot be asked for a barcode, so identity is required. */
  const needsIdentity = (): RetailerAdapter => ({
    ...fakeAdapter({}, {}),
    querySupport: { maxNumericQueryDigits: 9, barcodeIsSearchable: false },
  });

  it("reports a failure rather than a clean miss when nothing is derivable", async () => {
    // The search-engine lookup answers, and what it answers yields no part
    // number, no brand and no phrase. So there is genuinely nothing to ask the
    // retailer for — a fact about the ITEM, but still not a fact about the
    // retailer's assortment.
    const resolution = await resolveItem(
      { barcode: "099999999999", clientSku: "NO-ID" },
      needsIdentity(),
      new MapFetcher({
        ["https://www.google.com/search?q=%22099999999999%22"]:
          "<p>nothing useful here at all</p>",
      }),
      DEFAULT_OPTIONS,
    );

    expect(resolution.queriesTried).toEqual([]);
    // 🔑 The gateway writes `error` when a resolution carries a failure and
    // `not_carried` when it does not. This field is the whole difference
    // between "we could not look" and "they do not stock it".
    expect(resolution.failure).not.toBeNull();
    expect(resolution.failure).toContain("no search was attempted");
    expect(resolution.failure).toContain("no searchable identity");
  });

  it("says so DIFFERENTLY when a source could not be fetched", async () => {
    // 🔴 The more serious case: `tryFetch` swallows `FetchFailed`, so a proxy
    // outage during identity looked exactly like an item with nothing
    // derivable — and reached the customer as assortment information. The two
    // need different words because one is ours to retry and one is not.
    const resolution = await resolveItem(
      { barcode: "099999999999", clientSku: "NO-ID" },
      needsIdentity(),
      // An empty map: every url is a `FetchFailed`.
      new MapFetcher({}),
      DEFAULT_OPTIONS,
    );

    expect(resolution.failure).not.toBeNull();
    expect(resolution.failure).toContain("could not be fetched");
    // Not the other reason. A retryable outage must not read as a list the
    // customer has to go and fix.
    expect(resolution.failure).not.toContain("no searchable identity");
  });

  it("still reports a searched-and-found-nothing item as a clean miss", async () => {
    // ⚠️ The control, and the point of the change. `not_carried` is REAL
    // assortment information and this must not stop producing it — a fix that
    // turned every miss into an error would destroy the signal the product
    // sells.
    const adapter = fakeAdapter({ EMPTY: [] }, {});
    const resolution = await resolveItem(
      { barcode: "812348010548", clientSku: "531814" },
      adapter,
      new MapFetcher({
        [SERP]: serpBody,
        ["https://retailer.test/s?q=Kingwin%20CF-08LB"]: "EMPTY",
        ["https://retailer.test/s?q=CF-08LB"]: "EMPTY",
      }),
      DEFAULT_OPTIONS,
    );

    expect(resolution.outcome).toBe("not-found");
    expect(resolution.queriesTried.length).toBeGreaterThan(0);
    // No failure: the run looked, and the retailer does not carry it. THIS is
    // what `not_carried` is for.
    expect(resolution.failure).toBeNull();
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
