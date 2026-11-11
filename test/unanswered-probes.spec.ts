import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { costcoAdapter, SITEMAP_INDEX } from "../src/adapters/costco.js";
import { neweggAdapter } from "../src/adapters/newegg.js";
import type {
  ParsedCandidate,
  ParsedProduct,
  RetailerAdapter,
} from "../src/adapters/types.js";
import { ReplayFetcher, type Corpus } from "../src/fetcher/replay.js";
import {
  FetchFailed,
  NotInCorpus,
  type Fetcher,
  type FetchResult,
} from "../src/fetcher/types.js";
import {
  DEFAULT_OPTIONS,
  resolveItem,
  type Resolution,
} from "../src/resolve.js";
import investigation from "./fixtures/costco-investigation-20.json" with { type: "json" };
import measured from "./fixtures/measured-run-53.json" with { type: "json" };
import baseline from "./fixtures/newegg-53-outcomes-before-unanswered-probes.json" with { type: "json" };

/**
 * 🔴 **Jody's rule: a failed or refused read is never "not carried".**
 *
 * A product page that could not be fetched, or whose body was not a product
 * page, answered nothing about the listing. Before this, such a probe was
 * skipped without being counted, so an item whose every probe failed could
 * end `not-found` with `failure: null` — which the gateway files as
 * `not_carried`, "the competitor genuinely does not stock this", on the
 * strength of pages nobody read.
 *
 * Every adapter, Newegg and Amazon included: the rule is about what a miss
 * rests on, not about any one retailer.
 */

const dir = (rel: string): string =>
  fileURLToPath(new URL(rel, import.meta.url));
const gunzip = (rel: string): string =>
  gunzipSync(readFileSync(dir(rel))).toString("utf8");

const PRODUCT_SITEMAP = "https://www.costco.com/sitemap_lw_p_mod_001.xml";
const CATALOGUE = "https://catalogue.test/item/{sku}";
const airpods = investigation.airpods;

/**
 * Costco's real index, the AirPods row's identity, and every Costco product
 * page answered by `productPage` — a body, or `undefined` for a failed fetch.
 */
class CostcoIndexFetcher implements Fetcher {
  liveRequestCount = 0;
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  readonly asked: string[] = [];
  private readonly bodies: Record<string, string> = {
    [SITEMAP_INDEX]: gunzip("./raw/costco-sitemap-index.xml.gz"),
    [PRODUCT_SITEMAP]: gunzip("./raw/costco-sitemap-p-mod-full.xml.gz"),
    [CATALOGUE.replace("{sku}", airpods.microCenterSku)]:
      `<script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        sku: airpods.microCenterSku,
        mpn: airpods.mpn,
        brand: { "@type": "Brand", name: airpods.brand },
      })}</script>`,
  };
  constructor(private readonly productPage: () => string | undefined) {}
  fetch(url: string): Promise<FetchResult> {
    this.asked.push(url);
    const body = url.startsWith("https://www.costco.com/p/-/")
      ? this.productPage()
      : this.bodies[url];
    if (body === undefined) {
      return Promise.reject(new FetchFailed(url, undefined, 502, 3));
    }
    return Promise.resolve({ url, body, cached: true, attempts: 0 });
  }
}

const airpodsRequest = {
  barcode: airpods.upc,
  clientSku: airpods.microCenterSku,
  productName: airpods.productName,
};
const COSTCO_OPTIONS = {
  ...DEFAULT_OPTIONS,
  clientCatalogueUrlTemplate: CATALOGUE,
};

describe("🔴 Costco: the AirPods row with no product page read", () => {
  it("every product page failing to fetch is a failure, never a clean miss", async () => {
    const fetcher = new CostcoIndexFetcher(() => undefined);
    const r = await resolveItem(
      airpodsRequest,
      costcoAdapter,
      fetcher,
      COSTCO_OPTIONS,
    );
    expect(r.probes).toBe(3);
    expect(r.probesUnanswered).toBe(3);
    expect(r.outcome).toBe("not-found");
    expect(r.failure).not.toBeNull();
    expect(r.failure).toContain("3 of 3 product pages could not be read");
  });

  it("every product page coming back as Costco's empty product shell is a failure too", async () => {
    const shell = gunzip("./raw/costco-pdp-shell-no-slug.html.gz");
    const fetcher = new CostcoIndexFetcher(() => shell);
    const r = await resolveItem(
      airpodsRequest,
      costcoAdapter,
      fetcher,
      COSTCO_OPTIONS,
    );
    expect(r.probesUnanswered).toBe(3);
    expect(r.outcome).toBe("not-found");
    expect(r.failure).toContain("3 of 3 product pages could not be read");
  });

  it("CONTROL: with its product pages read, the row verifies with no failure", async () => {
    const page = gunzip("./raw/costco-pdp-airpods-4-anc.html.gz");
    const fetcher = new CostcoIndexFetcher(() => page);
    const r = await resolveItem(
      airpodsRequest,
      costcoAdapter,
      fetcher,
      COSTCO_OPTIONS,
    );
    expect(r.outcome).toBe("verified");
    expect(r.failure).toBeNull();
    expect(r.probesUnanswered).toBe(0);
  });
});

// ── Every adapter: a searched retailer, with a fake page set ────────────

const candidate = (over: Partial<ParsedCandidate> = {}): ParsedCandidate => ({
  itemId: "ITEM-1",
  url: "https://retailer.test/p/ITEM-1",
  model: null,
  title: "Something Else Entirely",
  brand: null,
  priceCents: 899,
  inStock: true,
  isFirstParty: true,
  sellerName: null,
  imageUrl: null,
  partialMatch: false,
  ...over,
});

const product = (over: Partial<ParsedProduct> = {}): ParsedProduct => ({
  barcode: "000000000000",
  additionalBarcodes: [],
  priceCents: null,
  inStock: null,
  title: null,
  sellerName: null,
  isFirstParty: null,
  unverifiableReason: null,
  category: null,
  ...over,
});

/** A searched retailer whose one search answers `found`. */
function searchedAdapter(
  found: readonly ParsedCandidate[],
  page: (html: string) => ParsedProduct | null,
): RetailerAdapter {
  return {
    slug: "fake",
    querySupport: {
      maxNumericQueryDigits: null,
      barcodeIsSearchable: false,
      partNumberNeedsBrand: false,
    },
    pacing: { pagesAtOnce: 3 },
    fetchProfile: { country: null, timeoutMs: null },
    maxProbes: null,
    productIndex: null,
    hosts: ["retailer.test"],
    buildSearchUrl: (q) => `https://retailer.test/s?q=${encodeURIComponent(q)}`,
    parseSearchResults: (html) => (html === "SEARCH" ? [...found] : null),
    parseProductPage: page,
  };
}

/** Answers searches with `SEARCH`, identity with a part number, and product pages per `pages`. */
class PagesFetcher implements Fetcher {
  liveRequestCount = 0;
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  constructor(private readonly pages: Record<string, string | undefined>) {}
  fetch(url: string): Promise<FetchResult> {
    let body: string | undefined;
    if (url.startsWith("https://retailer.test/s?")) body = "SEARCH";
    else if (url.startsWith("https://www.google.com/"))
      body = `<h3>Acme ZX-100 Widget</h3><h3>Acme ZX-100</h3><p>ZX-100 ZX-100</p>`;
    else body = this.pages[url];
    if (body === undefined)
      return Promise.reject(new FetchFailed(url, undefined, null, 1));
    this.liveRequestCount++;
    return Promise.resolve({ url, body, cached: false, attempts: 1 });
  }
}

const REQUEST = { barcode: "812348010548", clientSku: "SKU-1" };

describe("🔴 a searched retailer: a miss with an unread product page is a failure", () => {
  const found = [
    candidate({ itemId: "A", url: "https://retailer.test/p/A" }),
    candidate({ itemId: "B", url: "https://retailer.test/p/B" }),
  ];

  it("one of two product pages failing to fetch: not found, with the count", async () => {
    const adapter = searchedAdapter(found, (html) =>
      html === "PAGE-B" ? product() : null,
    );
    const r = await resolveItem(
      REQUEST,
      adapter,
      new PagesFetcher({ "https://retailer.test/p/B": "PAGE-B" }),
    );
    expect(r.probes).toBe(2);
    expect(r.probesUnanswered).toBe(1);
    expect(r.outcome).toBe("not-found");
    expect(r.failure).toContain("1 of 2 product pages could not be read");
  });

  it("a product page that is not one counts as unread", async () => {
    const adapter = searchedAdapter(found, (html) =>
      html === "PAGE-B" ? product() : null,
    );
    const r = await resolveItem(
      REQUEST,
      adapter,
      new PagesFetcher({
        "https://retailer.test/p/A": "ROBOT CHECK",
        "https://retailer.test/p/B": "PAGE-B",
      }),
    );
    expect(r.probesUnanswered).toBe(1);
    expect(r.outcome).toBe("not-found");
    expect(r.failure).toContain("1 of 2 product pages could not be read");
  });

  it("CONTROL: every product page read, a weak miss stays a clean miss", async () => {
    const adapter = searchedAdapter(found, () => product());
    const r = await resolveItem(
      REQUEST,
      adapter,
      new PagesFetcher({
        "https://retailer.test/p/A": "PAGE-A",
        "https://retailer.test/p/B": "PAGE-B",
      }),
    );
    expect(r.probes).toBe(2);
    expect(r.probesUnanswered).toBe(0);
    expect(r.outcome).toBe("not-found");
    expect(r.failure).toBeNull();
  });
});

/** The 53-row corpus, with every Newegg product page failing to fetch. */
class ProductPagesFail implements Fetcher {
  constructor(private readonly inner: Fetcher) {}
  get liveRequestCount(): number {
    return this.inner.liveRequestCount;
  }
  get pagesDelivered(): number {
    return this.inner.pagesDelivered;
  }
  fetch(url: string): Promise<FetchResult> {
    const isProductPage =
      url.startsWith("https://www.newegg.com/") && !url.includes("/p/pl?");
    return isProductPage
      ? Promise.reject(new FetchFailed(url, undefined, 502, 3))
      : this.inner.fetch(url);
  }
}

describe("🔴 Newegg's real adapter, every product page failing", () => {
  it("no row that probed anything ends a clean miss", async () => {
    const corpus = JSON.parse(
      gunzip("./corpus/launch-retailer-53.json.gz"),
    ) as Corpus;
    const fetcher = new ProductPagesFail(new ReplayFetcher(corpus));
    let probedMisses = 0;
    for (const row of measured.rows as { barcode: string }[]) {
      let r: Resolution;
      try {
        r = await resolveItem(
          { barcode: row.barcode, clientSku: "" },
          neweggAdapter,
          fetcher,
          { ...DEFAULT_OPTIONS, clientCatalogueUrlTemplate: null },
        );
      } catch (error) {
        if (error instanceof NotInCorpus) continue;
        throw error;
      }
      expect(r.probesUnanswered, row.barcode).toBe(r.probes);
      if (r.outcome !== "not-found" || r.probes === 0) continue;
      probedMisses++;
      expect(r.failure, row.barcode).toContain(
        `${r.probes} of ${r.probes} product pages could not be read`,
      );
    }
    // Not vacuous: real rows reach this.
    expect(probedMisses).toBeGreaterThan(5);
  }, 120_000);
});

// ── The 53 real Newegg rows: unchanged wherever every probe answered ────

interface Before {
  readonly barcode: string;
  readonly outcome: Resolution["outcome"] | null;
  readonly failure: string | null;
  readonly probes: number | null;
  readonly matchItemId: string | null;
}

describe("🔴 the 53-row Newegg replay", () => {
  const before = baseline as readonly Before[];
  const after = new Map<string, Resolution | null>();

  beforeAll(async () => {
    const corpus = JSON.parse(
      gunzip("./corpus/launch-retailer-53.json.gz"),
    ) as Corpus;
    const fetcher = new ReplayFetcher(corpus);
    for (const row of measured.rows as { barcode: string }[]) {
      try {
        after.set(
          row.barcode,
          await resolveItem(
            { barcode: row.barcode, clientSku: "" },
            neweggAdapter,
            fetcher,
            { ...DEFAULT_OPTIONS, clientCatalogueUrlTemplate: null },
          ),
        );
      } catch (error) {
        if (!(error instanceof NotInCorpus)) throw error;
        after.set(row.barcode, null);
      }
    }
  }, 120_000);

  it("is compared against every row's outcome from before the rule", () => {
    expect(before).toHaveLength(53);
    expect(before.filter((b) => b.outcome !== null).length).toBeGreaterThan(30);
  });

  it("🔴 every row whose probes all answered has exactly the outcome, failure and listing it had", () => {
    let compared = 0;
    for (const b of before) {
      const r = after.get(b.barcode);
      if (b.outcome === null) {
        expect(r, b.barcode).toBeNull();
        continue;
      }
      expect(r, b.barcode).not.toBeNull();
      if (r === null || r === undefined || r.probesUnanswered > 0) continue;
      compared++;
      expect(
        {
          outcome: r.outcome,
          failure: r.failure,
          probes: r.probes,
          matchItemId: r.match?.itemId ?? null,
        },
        b.barcode,
      ).toEqual({
        outcome: b.outcome,
        failure: b.failure,
        probes: b.probes,
        matchItemId: b.matchItemId,
      });
    }
    expect(compared).toBeGreaterThan(30);
  });

  it("🔴 a row with an unread product page never ends a clean miss", () => {
    for (const r of after.values()) {
      if (r === null || r.probesUnanswered === 0) continue;
      if (r.outcome === "not-found") expect(r.failure).not.toBeNull();
    }
  });
});
