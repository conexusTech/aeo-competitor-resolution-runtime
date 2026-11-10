import { describe, expect, it } from "vitest";

import type {
  ParsedCandidate,
  QuerySupport,
  RetailerAdapter,
} from "../src/adapters/types.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchResult,
} from "../src/fetcher/types.js";
import {
  barcodeQuery,
  MAX_QUERY_ATTEMPTS,
  planQueries,
  type QueryPlanInput,
} from "../src/query-plan.js";
import { DEFAULT_OPTIONS, resolveItem } from "../src/resolve.js";

/**
 * A competitor that answers a barcode search is asked the barcode first.
 *
 * 🔑 **Read from configuration (`barcodeIsSearchable`), never from a name.**
 * Where it is true the barcode query leads the plan and runs before anything
 * is bought to identify the item, so a hit costs a search and a probe and no
 * identity page. Where it is false, every plan is what it always was — which
 * the 53-row replay and the query-plan spec also hold, unchanged.
 */

const SEARCHABLE: QuerySupport = {
  maxNumericQueryDigits: null,
  barcodeIsSearchable: true,
};
const NOT_SEARCHABLE: QuerySupport = {
  maxNumericQueryDigits: null,
  barcodeIsSearchable: false,
};

describe("barcodeQuery", () => {
  it("pads the core to 12 digits", () => {
    expect(barcodeQuery("812348010548", SEARCHABLE)).toBe("812348010548");
    expect(barcodeQuery("0812348010548", SEARCHABLE)).toBe("812348010548");
    // A GTIN-14 of a UPC-A comes back as the UPC-A.
    expect(barcodeQuery("00097855114693", SEARCHABLE)).toBe("097855114693");
    expect(barcodeQuery("97855114693", SEARCHABLE)).toBe("097855114693");
  });

  it("pads to 13 when the core is longer than 12", () => {
    expect(barcodeQuery("4006381333931", SEARCHABLE)).toBe("4006381333931");
    expect(barcodeQuery("04006381333931", SEARCHABLE)).toBe("4006381333931");
  });

  it("is null for a value that is not a barcode", () => {
    expect(barcodeQuery("SQR-WKIT-R2", SEARCHABLE)).toBeNull();
    expect(barcodeQuery("", SEARCHABLE)).toBeNull();
  });

  it("is null where the retailer cannot search a barcode", () => {
    expect(barcodeQuery("812348010548", NOT_SEARCHABLE)).toBeNull();
  });
});

describe("planQueries with the switch", () => {
  const inputs: QueryPlanInput[] = [
    {
      barcode: "035286301848",
      brand: "Allsop",
      partNumbers: ["30184"],
      phrase: "Allsop Mousepad",
      productName: null,
    },
    {
      barcode: "813810010431",
      brand: "SteelSeries",
      partNumbers: ["63005", "QCK-MINI", "QCK-MINI-2", "QCK-HEAVY"],
      phrase: "SteelSeries QcK",
      productName: "QcK Mini",
    },
    {
      barcode: "4006381333931",
      brand: null,
      partNumbers: [],
      phrase: null,
      productName: "Stabilo Boss",
    },
    {
      barcode: "not-a-barcode",
      brand: "Kensington",
      partNumbers: ["K72337WW"],
      phrase: null,
      productName: null,
    },
  ];

  it("🔑 true puts the barcode first, then the plan it always had", () => {
    for (const input of inputs) {
      const without = planQueries(input, NOT_SEARCHABLE);
      const withIt = planQueries(input, SEARCHABLE);
      const first = barcodeQuery(input.barcode, SEARCHABLE);
      if (first === null) {
        expect(withIt).toEqual(without);
        continue;
      }
      expect(withIt[0]).toBe(first);
      expect(withIt).toEqual(
        [first, ...without.filter((q) => q !== first)].slice(
          0,
          MAX_QUERY_ATTEMPTS,
        ),
      );
    }
  });

  it("🔴 false never asks the barcode", () => {
    for (const input of inputs) {
      const plan = planQueries(input, NOT_SEARCHABLE);
      const core = barcodeQuery(input.barcode, SEARCHABLE);
      if (core !== null) expect(plan).not.toContain(core);
    }
  });
});

// ── Resolution ──────────────────────────────────────────────────────────

const BARCODE = "812348010548";
const SEARCH = (q: string): string =>
  `https://r.test/s?q=${encodeURIComponent(q)}`;
const SERP = `<h3>Kingwin CF-08LB Fan</h3><h3>Kingwin CF-08LB 80mm</h3><p>CF-08LB CF-08LB</p>`;

const listing = (itemId: string, model: string | null): ParsedCandidate => ({
  itemId,
  url: `https://r.test/p/${itemId}`,
  model,
  title: `Kingwin ${model ?? ""} 80mm Fan`,
  brand: "Kingwin",
  priceCents: 899,
  inStock: true,
  isFirstParty: true,
  sellerName: null,
  imageUrl: null,
});

/**
 * A retailer scripted by body: `RESULTS a,b` is a results page listing those
 * ids, `NOTHING` an empty one, `BLOCK` not a results page; `UPC n` a product
 * page publishing `n`, `NOUPC` one publishing none.
 */
function retailer(support: QuerySupport): RetailerAdapter {
  return {
    slug: "fake",
    querySupport: support,
    pacing: { pagesAtOnce: 3 },
    fetchProfile: { country: null, timeoutMs: null },
    maxProbes: null,
    buildSearchUrl: SEARCH,
    parseSearchResults: (html) => {
      if (html === "NOTHING") return [];
      if (!html.startsWith("RESULTS ")) return null;
      return html
        .slice(8)
        .split(",")
        .map((id) => listing(id, "CF-08LB"));
    },
    parseProductPage: (html) => ({
      barcode: html.startsWith("UPC ") ? html.slice(4) : null,
      additionalBarcodes: [],
      priceCents: null,
      inStock: null,
      title: null,
    }),
  };
}

/** Serves scripted bodies; a url with no body is a failed fetch. */
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

const OPTIONS = {
  ...DEFAULT_OPTIONS,
  clientCatalogueUrlTemplate: "https://client.test/p/{sku}",
};
const request = { barcode: BARCODE, clientSku: "SKU-1" };
const identityPages = (asked: readonly string[]): string[] =>
  asked.filter(
    (u) => u.startsWith("https://client.test/") || u.includes("google.com"),
  );

describe("resolveItem asks the barcode first", () => {
  it("🔑 a hit fetches no identity page", async () => {
    const fetcher = new Scripted({
      [SEARCH(BARCODE)]: "RESULTS B",
      "https://r.test/p/B": `UPC ${BARCODE}`,
    });
    const r = await resolveItem(
      request,
      retailer(SEARCHABLE),
      fetcher,
      OPTIONS,
    );

    expect(r.outcome).toBe("verified");
    expect(r.match?.itemId).toBe("B");
    expect(identityPages(fetcher.asked)).toEqual([]);
    expect(fetcher.asked).toEqual([SEARCH(BARCODE), "https://r.test/p/B"]);
    expect(r.queriesTried).toEqual([BARCODE]);
    expect(r.requests).toBe(2);
    expect(r.probes).toBe(1);
    // Nothing was bought to establish what the item is.
    expect(r.identity).toBeNull();
  });

  it("CONTROL: with the switch off, the barcode is never asked and identity is bought", async () => {
    const fetcher = new Scripted({
      "https://client.test/p/SKU-1": "<html></html>",
      [`https://www.google.com/search?q=%22${BARCODE}%22`]: SERP,
      [SEARCH("Kingwin CF-08LB")]: "RESULTS B",
      "https://r.test/p/B": `UPC ${BARCODE}`,
    });
    const r = await resolveItem(
      request,
      retailer(NOT_SEARCHABLE),
      fetcher,
      OPTIONS,
    );
    expect(r.outcome).toBe("verified");
    expect(fetcher.asked).not.toContain(SEARCH(BARCODE));
    expect(identityPages(fetcher.asked)).toHaveLength(2);
  });

  it("a 0-result answer is an answered search, and the miss is clean", async () => {
    const fetcher = new Scripted({
      [SEARCH(BARCODE)]: "NOTHING",
      "https://client.test/p/SKU-1": "<html></html>",
      [`https://www.google.com/search?q=%22${BARCODE}%22`]: SERP,
      [SEARCH("Kingwin CF-08LB")]: "NOTHING",
      [SEARCH("CF-08LB")]: "NOTHING",
      [SEARCH("Kingwin CF-08")]: "NOTHING",
      [SEARCH("CF-08")]: "NOTHING",
      [SEARCH("Kingwin 01054")]: "NOTHING",
    });
    const r = await resolveItem(
      request,
      retailer(SEARCHABLE),
      fetcher,
      OPTIONS,
    );

    expect(r.outcome).toBe("not-found");
    expect(r.searchesUnfetched).toBe(0);
    expect(r.searchesNotResultsPage).toBe(0);
    expect(r.failure).toBeNull();
    // Asked first, and exactly once.
    expect(r.queriesTried[0]).toBe(BARCODE);
    expect(fetcher.asked.filter((u) => u === SEARCH(BARCODE))).toHaveLength(1);
  });

  it("🔴 a refused barcode search is unanswered, so the miss is not clean", async () => {
    // The barcode search has no body: a fetch that failed. Every later search
    // answers empty — a miss resting on a search nobody answered.
    const fetcher = new Scripted({
      "https://client.test/p/SKU-1": "<html></html>",
      [`https://www.google.com/search?q=%22${BARCODE}%22`]: SERP,
      [SEARCH("Kingwin CF-08LB")]: "NOTHING",
      [SEARCH("CF-08LB")]: "NOTHING",
      [SEARCH("Kingwin CF-08")]: "NOTHING",
      [SEARCH("CF-08")]: "NOTHING",
      [SEARCH("Kingwin 01054")]: "NOTHING",
    });
    const r = await resolveItem(
      request,
      retailer(SEARCHABLE),
      fetcher,
      OPTIONS,
    );

    expect(r.outcome).toBe("not-found");
    expect(r.searchesUnfetched).toBe(1);
    expect(r.failure).not.toBeNull();
    expect(fetcher.asked.filter((u) => u === SEARCH(BARCODE))).toHaveLength(1);
  });

  it("a page that is not a results page is unanswered too", async () => {
    const fetcher = new Scripted({
      [SEARCH(BARCODE)]: "BLOCK",
      "https://client.test/p/SKU-1": "<html></html>",
      [`https://www.google.com/search?q=%22${BARCODE}%22`]: SERP,
      [SEARCH("Kingwin CF-08LB")]: "NOTHING",
      [SEARCH("CF-08LB")]: "NOTHING",
      [SEARCH("Kingwin CF-08")]: "NOTHING",
      [SEARCH("CF-08")]: "NOTHING",
      [SEARCH("Kingwin 01054")]: "NOTHING",
    });
    const r = await resolveItem(
      request,
      retailer(SEARCHABLE),
      fetcher,
      OPTIONS,
    );
    expect(r.searchesNotResultsPage).toBe(1);
    expect(r.failure).not.toBeNull();
  });

  it("🔑 a miss carries its pool and probes into the normal path, buying nothing twice", async () => {
    // The barcode search finds A, whose page publishes a different barcode.
    // After identity, a search finds A again and B, which verifies.
    const fetcher = new Scripted({
      [SEARCH(BARCODE)]: "RESULTS A",
      "https://r.test/p/A": "UPC 036000291452",
      "https://client.test/p/SKU-1": "<html></html>",
      [`https://www.google.com/search?q=%22${BARCODE}%22`]: SERP,
      [SEARCH("Kingwin CF-08LB")]: "RESULTS A,B",
      "https://r.test/p/B": `UPC ${BARCODE}`,
    });
    const r = await resolveItem(
      request,
      retailer(SEARCHABLE),
      fetcher,
      OPTIONS,
    );

    expect(r.outcome).toBe("verified");
    expect(r.match?.itemId).toBe("B");
    expect(
      fetcher.asked.filter((u) => u === "https://r.test/p/A"),
    ).toHaveLength(1);
    expect(fetcher.asked.filter((u) => u === SEARCH(BARCODE))).toHaveLength(1);
    // A's probe counts once, from the barcode stage; B's once.
    expect(r.probes).toBe(2);
    // A, opened in the barcode stage, is recorded as what it published.
    const a = r.alternatives.find((alt) => alt.itemId === "A");
    expect(a?.retailerBarcode).toBe("036000291452");
  });

  it("the barcode stage spends from the item's one probe budget", async () => {
    const fetcher = new Scripted({
      [SEARCH(BARCODE)]: "RESULTS B,C,D",
      "https://r.test/p/B": "UPC 036000291452",
      "https://r.test/p/C": "UPC 036000291452",
      "https://r.test/p/D": "UPC 036000291452",
      "https://client.test/p/SKU-1": "<html></html>",
      [`https://www.google.com/search?q=%22${BARCODE}%22`]: SERP,
      [SEARCH("Kingwin CF-08LB")]: "RESULTS E",
      "https://r.test/p/E": "UPC 036000291452",
    });
    const r = await resolveItem(request, retailer(SEARCHABLE), fetcher, {
      ...OPTIONS,
      maxProbes: 3,
    });
    expect(r.probes).toBe(3);
    expect(fetcher.asked).not.toContain("https://r.test/p/E");
  });
});
