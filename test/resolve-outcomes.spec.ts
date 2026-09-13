import { describe, expect, it } from "vitest";

import type {
  ParsedCandidate,
  ParsedProduct,
  RetailerAdapter,
} from "../src/adapters/types.js";
import type { Fetcher, FetchResult } from "../src/fetcher/types.js";
import { FetchFailed } from "../src/fetcher/types.js";
import {
  DEFAULT_OPTIONS,
  createProbeMemory,
  resolveItem,
} from "../src/resolve.js";
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
  imageUrl: null,
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
        additionalBarcodes: [],
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
          additionalBarcodes: [],
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

  /**
   * 🔴 A field holding MORE THAN ONE barcode, which is a measured case rather
   * than a defensive one: a real product page publishes
   * `812348010548 191120055664` in a single cell and the client's value was
   * the first of the two. Nothing here covered the second.
   *
   * ⚠️ Getting this wrong is not merely a lost pairing. The raw field cores to
   * nothing (24 digits, outside every GTIN width), so it arrives as a barcode
   * that DISAGREES — an `unconfirmed`, reported to a reviewer as a
   * contradiction the retailer never stated.
   */
  it("verified — the agreeing barcode is the SECOND value in the field", async () => {
    const adapter = fakeAdapter(
      { SEARCH: [candidate()] },
      {
        PDP: {
          barcode: "191120055664",
          additionalBarcodes: ["812348010548"],
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
    // 🔑 The evidence names the value that AGREED, not the field's first
    // token — otherwise a reviewer reads a barcode that did not match.
    expect(resolution.match?.retailerBarcode).toBe("812348010548");
  });

  /**
   * The CONTROL for the check above: the same shape, with a value that agrees
   * with nothing. Without it, a resolver that simply verified whenever any
   * barcode was present would satisfy the test above perfectly.
   */
  it("not verified — several barcodes published and none of them agrees", async () => {
    const adapter = fakeAdapter(
      { SEARCH: [candidate()] },
      {
        PDP: {
          barcode: "191120055664",
          additionalBarcodes: ["099999999999"],
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
    expect(resolution.outcome).not.toBe("verified");
  });

  it("🔴 unverifiable — a listing found, no barcode published", async () => {
    // The outcome the handover had no name for. 91 of 255 real product pages
    // land here, and calling it "probable" claims a match that was never
    // proven either way.
    const adapter = fakeAdapter(
      { SEARCH: [candidate()] },
      {
        PDP: {
          barcode: null,
          additionalBarcodes: [],
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
          additionalBarcodes: [],
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
        A: {
          barcode: null,
          additionalBarcodes: [],
          priceCents: 1,
          inStock: true,
          title: null,
        },
        B: {
          barcode: "099999999999",
          additionalBarcodes: [],
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
          additionalBarcodes: [],
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
      imageUrl: null,
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

/**
 * What one probe teaches the rest of the run.
 *
 * ── 🔴 The run this exists because of ──────────────────────────────────
 *
 * A live Amazon run on 2026-09-13 filed item `744334` (client barcode
 * `097855066237`) as a proposal against a listing that publishes no barcode.
 * The listing that would have PROVEN it — publishing exactly `097855066237` —
 * was fetched **in the same run**, as a runner-up on a different item, and its
 * barcode was read and thrown away.
 *
 * 🔴 **The mechanism is a tiebreak that is a no-op on this retailer.** Amazon
 * states no model and no first-party flag at search stage, so every
 * model-based weight is unreachable and `probeOrder`'s only tiebreak
 * (`isFirstParty === true` first) never fires. 80 candidates collapse onto a
 * handful of identical scores, the probe budget is 8, and a stable sort leaves
 * the order Amazon happened to return. Every alternative on that item says so
 * in as many words: *"lost a tie on discovery order"*.
 *
 * 🔑 **The fix is not a better guess at the order.** It is that a barcode this
 * run has already read is EVIDENCE, and evidence outranks a budget. A listing
 * only ever wins here by publishing a barcode that agrees with the client's,
 * which is the same thing a probe would have proved — so the memory can
 * promote an agreement and can never invent one.
 *
 * ⚠️ Deliberately NOT a title heuristic. The PO's own recon records that
 * guessing a model from a trailing `(MODEL)` in an Amazon title produced their
 * two worst false positives — a DaySpring calendar and a Ridgid pipe cutter,
 * each winning on a numeric coincidence. This adapter states `model: null` for
 * that reason and this change does not reverse it.
 */
describe("a barcode read once is known for the rest of the run", () => {
  /** A pool where the top-ranked listing publishes nothing. */
  const twoCandidates = () => {
    const chosen = candidate({
      itemId: "NO-BARCODE",
      url: "https://retailer.test/p/NO-BARCODE",
      title: "Kingwin CF-08LB 80mm Fan",
    });
    const verifier = candidate({
      itemId: "PUBLISHES-IT",
      url: "https://retailer.test/p/PUBLISHES-IT",
      title: "Kingwin CF-08LB 80mm Fan",
    });
    const adapter = fakeAdapter(
      { [serpBody]: [], "search-body": [chosen, verifier] },
      {
        "no-barcode-body": {
          barcode: null,
          additionalBarcodes: [],
          priceCents: 899,
          inStock: true,
          title: "Kingwin CF-08LB 80mm Fan",
        },
      },
    );
    const fetcher = new MapFetcher({
      [SERP]: serpBody,
      [SEARCH]: "search-body",
      "https://retailer.test/p/NO-BARCODE": "no-barcode-body",
    });
    return { adapter, fetcher };
  };

  it("verifies from a barcode an earlier item's probe read, spending nothing", async () => {
    const { adapter, fetcher } = twoCandidates();
    const memory = createProbeMemory();
    memory.remember("PUBLISHES-IT", ["812348010548"]);

    const result = await resolveItem(
      { barcode: "812348010548", clientSku: "SKU-1" },
      adapter,
      fetcher,
      DEFAULT_OPTIONS,
      memory,
    );

    expect(result.outcome).toBe("verified");
    expect(result.match?.itemId).toBe("PUBLISHES-IT");
    expect(result.match?.retailerBarcode).toBe("812348010548");
    // 🔑 The point of the change: no page was fetched to learn this.
    expect(result.probes).toBe(0);
  });

  it("without the memory the same pool cannot verify — the CONTROL", async () => {
    // Without this, the check above would pass just as happily if the pool
    // had always verified and the memory did nothing at all.
    const { adapter, fetcher } = twoCandidates();
    const result = await resolveItem(
      { barcode: "812348010548", clientSku: "SKU-1" },
      adapter,
      fetcher,
      DEFAULT_OPTIONS,
    );
    expect(result.outcome).not.toBe("verified");
  });

  it("a remembered barcode that DISAGREES verifies nothing", async () => {
    // 🔴 The memory may only ever promote an agreement. A listing remembered
    // as publishing someone else's barcode is not this item's product, and
    // treating a remembered value as a match would turn one item's evidence
    // into another item's false pairing — the worst output this makes.
    const { adapter, fetcher } = twoCandidates();
    const memory = createProbeMemory();
    memory.remember("PUBLISHES-IT", ["999999999999"]);
    const result = await resolveItem(
      { barcode: "812348010548", clientSku: "SKU-1" },
      adapter,
      fetcher,
      DEFAULT_OPTIONS,
      memory,
    );
    expect(result.outcome).not.toBe("verified");
  });

  it("does not reach for a listing this item never found", async () => {
    // ⚠️ Bounds the change: the memory is consulted for candidates in THIS
    // item's own pool, never used to conjure one from another item's search.
    const { adapter, fetcher } = twoCandidates();
    const memory = createProbeMemory();
    memory.remember("SOME-OTHER-LISTING", ["812348010548"]);
    const result = await resolveItem(
      { barcode: "812348010548", clientSku: "SKU-1" },
      adapter,
      fetcher,
      DEFAULT_OPTIONS,
      memory,
    );
    expect(result.match?.itemId).not.toBe("SOME-OTHER-LISTING");
    expect(result.outcome).not.toBe("verified");
  });

  /**
   * 🔴 **The check that actually earns the pre-scan's scope, and the first
   * version of this file did not have it.** A mutation limiting the pre-scan
   * to `maxProbes` — which is precisely the defect being fixed — left the
   * suite GREEN, because the pool above holds two candidates against a budget
   * of eight and a slice of it changes nothing. The check read as though it
   * covered the budget and could not see it.
   *
   * Here the verifying listing is the TENTH of ten, against a budget of three,
   * which is the shape of the real case: 80 candidates, 8 probes, and the one
   * that publishes the client's barcode outside the window.
   */
  it("reaches a remembered listing ranked far below the probe budget", async () => {
    const pool = Array.from({ length: 10 }, (_, i) =>
      candidate({
        itemId: `ITEM-${i}`,
        url: `https://retailer.test/p/ITEM-${i}`,
        title: "Kingwin CF-08LB 80mm Fan",
      }),
    );
    const adapter = fakeAdapter({ [serpBody]: [], "search-body": pool }, {});
    // Nothing is fetchable, so a probe can learn nothing: the ONLY route to
    // a verified outcome here is the memory.
    const fetcher = new MapFetcher({
      [SERP]: serpBody,
      [SEARCH]: "search-body",
    });
    const memory = createProbeMemory();
    memory.remember("ITEM-9", ["812348010548"]);

    const result = await resolveItem(
      { barcode: "812348010548", clientSku: "SKU-1" },
      adapter,
      fetcher,
      { ...DEFAULT_OPTIONS, maxProbes: 3 },
      memory,
    );

    expect(result.outcome).toBe("verified");
    expect(result.match?.itemId).toBe("ITEM-9");
  });

  it("still finds one INSIDE the budget — the CONTROL", async () => {
    // Without this, a pre-scan that searched only the tail would pass above.
    const pool = Array.from({ length: 10 }, (_, i) =>
      candidate({
        itemId: `ITEM-${i}`,
        url: `https://retailer.test/p/ITEM-${i}`,
        title: "Kingwin CF-08LB 80mm Fan",
      }),
    );
    const adapter = fakeAdapter({ [serpBody]: [], "search-body": pool }, {});
    const fetcher = new MapFetcher({
      [SERP]: serpBody,
      [SEARCH]: "search-body",
    });
    const memory = createProbeMemory();
    memory.remember("ITEM-0", ["812348010548"]);

    const result = await resolveItem(
      { barcode: "812348010548", clientSku: "SKU-1" },
      adapter,
      fetcher,
      { ...DEFAULT_OPTIONS, maxProbes: 3 },
      memory,
    );
    expect(result.match?.itemId).toBe("ITEM-0");
  });

  it("fills itself from its own probes, so the SECOND item is the one that gains", async () => {
    // 🔑 The observed case end to end: item one probes the listing and reads
    // its barcode; item two shares the pool and verifies for free.
    const shared = candidate({
      itemId: "SHARED",
      url: "https://retailer.test/p/SHARED",
      title: "Kingwin CF-08LB 80mm Fan",
    });
    const adapter = fakeAdapter(
      { [serpBody]: [], "search-body": [shared] },
      {
        "shared-body": {
          barcode: "812348010548",
          additionalBarcodes: [],
          priceCents: 899,
          inStock: true,
          title: "Kingwin CF-08LB 80mm Fan",
        },
      },
    );
    const fetcher = new MapFetcher({
      [SERP]: serpBody,
      [SEARCH]: "search-body",
      "https://retailer.test/p/SHARED": "shared-body",
    });
    const memory = createProbeMemory();

    const first = await resolveItem(
      { barcode: "812348010548", clientSku: "SKU-1" },
      adapter,
      fetcher,
      DEFAULT_OPTIONS,
      memory,
    );
    expect(first.outcome).toBe("verified");
    expect(first.probes).toBe(1);

    const second = await resolveItem(
      { barcode: "812348010548", clientSku: "SKU-2" },
      adapter,
      fetcher,
      DEFAULT_OPTIONS,
      memory,
    );
    expect(second.outcome).toBe("verified");
    // The probe was paid for once and answered twice.
    expect(second.probes).toBe(0);
  });
});
