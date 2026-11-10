import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ParsedCandidate,
  ProductIndex,
  ProductIndexEntry,
  RetailerAdapter,
} from "../src/adapters/types.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchProfile,
  type FetchResult,
} from "../src/fetcher/types.js";
import { createIndexCache } from "../src/product-index.js";
import { DEFAULT_OPTIONS, resolveItem } from "../src/resolve.js";
import { RUN_DEFAULTS, runList } from "../src/run.js";

/**
 * A retailer that cannot be searched is looked up in its product index, and
 * the index is read ONCE per run.
 *
 * 🔑 **The counts are of fetches actually made**, through a fetcher that
 * holds each one open, so twenty items at four workers really do ask at the
 * same moment — a single-flight that only works one item at a time is not
 * one.
 */

const LIST = "https://r.test/index.xml";
const FILE_A = "https://r.test/products-1.xml";
const FILE_B = "https://r.test/products-2.xml";
const CATALOGUE = "https://cat.test/item/{sku}";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** `file <url>` lines, padded past the list's minimum. */
const listBody = (files: readonly string[]): string =>
  `${files.map((f) => `file ${f}`).join("\n")}\n${"#".repeat(200)}`;

/** `product <id> <name words>` lines. */
const fileBody = (products: readonly [string, string][]): string =>
  products.map(([id, name]) => `product ${id} ${name}`).join("\n");

const FAKE_INDEX: ProductIndex = {
  urls: [LIST],
  minListBytes: 100,
  parseListing: (body) => {
    const files = [...body.matchAll(/^file (\S+)$/gm)].map((m) => m[1] ?? "");
    return files.length === 0 ? null : files;
  },
  minEntries: 4,
  parse: (body) => {
    const entries: ProductIndexEntry[] = [];
    for (const m of body.matchAll(/^product (\d+) (.+)$/gm)) {
      const itemId = m[1] ?? "";
      entries.push({
        itemId,
        url: `https://r.test/p/${itemId}`,
        name: m[2] ?? "",
      });
    }
    return entries.length === 0 ? null : entries;
  },
  candidates: (entries, query) => {
    const brand = (query.brand ?? "").toLowerCase();
    const named = (e: ProductIndexEntry): boolean =>
      query.partNumbers.some((p) => e.name.includes(p.toLowerCase()));
    return entries
      .filter((e) => brand !== "" && e.name.startsWith(brand))
      .sort((a, b) => Number(named(b)) - Number(named(a)))
      .map((e): ParsedCandidate => ({
        itemId: e.itemId,
        url: e.url,
        model: null,
        title: e.name,
        brand: query.brand,
        priceCents: null,
        inStock: null,
        isFirstParty: true,
        sellerName: "R",
        imageUrl: null,
        partialMatch: false,
      }));
  },
};

let searches = 0;
const indexed: RetailerAdapter = {
  slug: "indexed",
  querySupport: {
    maxNumericQueryDigits: null,
    barcodeIsSearchable: false,
    partNumberNeedsBrand: false,
  },
  pacing: { pagesAtOnce: 4 },
  fetchProfile: { country: "us", timeoutMs: 1000 },
  maxProbes: 3,
  productIndex: FAKE_INDEX,
  buildSearchUrl: (q) => `https://r.test/s?q=${encodeURIComponent(q)}`,
  parseSearchResults: () => {
    searches++;
    return null;
  },
  parseProductPage: (html) => {
    const upc = /UPC (\d+)/.exec(html)?.[1];
    return upc === undefined
      ? null
      : {
          barcode: upc,
          additionalBarcodes: [],
          priceCents: 999,
          inStock: null,
          title: null,
          sellerName: "R",
          unverifiableReason: null,
        };
  },
};

const catalogue = (sku: string, brand: string): string =>
  `<script type="application/ld+json">${JSON.stringify({
    "@type": "Product",
    sku,
    mpn: `PN-${sku}`,
    brand: { "@type": "Brand", name: brand },
  })}</script>`;

/**
 * Serves a site from a map, holding each fetch open, and counts every url.
 *
 * `fail` names urls that answer with a `FetchFailed` the first N times.
 */
class Site implements Fetcher {
  liveRequestCount = 0;
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  readonly counts = new Map<string, number>();
  readonly profiles = new Map<string, FetchProfile | undefined>();
  constructor(
    private readonly pages: Record<string, string>,
    private readonly fail: Map<string, number> = new Map(),
  ) {}
  count(url: string): number {
    return this.counts.get(url) ?? 0;
  }
  async fetch(url: string, profile?: FetchProfile): Promise<FetchResult> {
    this.counts.set(url, this.count(url) + 1);
    this.profiles.set(url, profile);
    await sleep(3);
    const failing = this.fail.get(url) ?? 0;
    if (failing > 0) {
      this.fail.set(url, failing - 1);
      throw new FetchFailed(url, new Error("refused"), 502, 1);
    }
    const body = this.pages[url];
    if (body === undefined)
      throw new FetchFailed(url, new Error("404"), 404, 1);
    this.liveRequestCount++;
    return { url, body, cached: false, attempts: 1 };
  }
}

/** Twenty items of brand Acme; item `i` is product `100 + i`, which states its UPC. */
const ITEMS = Array.from({ length: 20 }, (_, i) => ({
  barcode: `0360002914${String(i).padStart(2, "0")}`,
  clientSku: `SKU${i}`,
}));

function site(
  overrides: Record<string, string> = {},
  fail?: Map<string, number>,
): Site {
  const pages: Record<string, string> = {
    [LIST]: listBody([FILE_A, FILE_B]),
    [FILE_A]: fileBody(
      ITEMS.slice(0, 10).map((_, i) => [`${100 + i}`, `acme thing pn-sku${i}`]),
    ),
    [FILE_B]: fileBody(
      ITEMS.slice(10).map((_, i) => [
        `${110 + i}`,
        `acme thing pn-sku${10 + i}`,
      ]),
    ),
  };
  ITEMS.forEach((item, i) => {
    pages[CATALOGUE.replace("{sku}", item.clientSku)] = catalogue(
      item.clientSku,
      "Acme",
    );
    pages[`https://r.test/p/${100 + i}`] = `<p>UPC ${item.barcode}</p>`;
  });
  return new Site({ ...pages, ...overrides }, fail);
}

/** Item `i`, which exists: the list is twenty long. */
const item = (i: number): (typeof ITEMS)[number] => {
  const found = ITEMS[i];
  if (found === undefined) throw new Error(`no item ${i}`);
  return found;
};

const OPTIONS = { ...DEFAULT_OPTIONS, clientCatalogueUrlTemplate: CATALOGUE };

let runDir: string;
beforeEach(async () => {
  searches = 0;
  runDir = await mkdtemp(path.join(os.tmpdir(), "product-index-"));
});
afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

const run = (fetcher: Fetcher) =>
  runList(ITEMS, indexed, fetcher, {
    ...RUN_DEFAULTS,
    ...OPTIONS,
    concurrency: 4,
    runDir,
  });

describe("a product index is read once per run", () => {
  it("🔴 20 items at 4 workers make exactly 1 fetch of each of its files", async () => {
    const s = site();
    const results = await run(s);

    expect(s.count(LIST)).toBe(1);
    expect(s.count(FILE_A)).toBe(1);
    expect(s.count(FILE_B)).toBe(1);
    expect(results).toHaveLength(20);
    expect(results.every((r) => r.outcome === "verified")).toBe(true);
    expect(results.every((r) => r.failure === null)).toBe(true);
  });

  it("reads the list first, with its own minimum size, and the competitor's profile", async () => {
    const s = site();
    await run(s);
    expect(s.profiles.get(LIST)).toEqual({
      country: "us",
      timeoutMs: 1000,
      minBodyBytes: 100,
    });
    // A product file is a page like any other: the fetcher's own minimum.
    expect(s.profiles.get(FILE_A)).toEqual({ country: "us", timeoutMs: 1000 });
  });

  it("🔴 charges the read to one item only, so the run's spend is counted once", async () => {
    const s = site();
    const results = await run(s);
    const total = results.reduce((sum, r) => sum + r.requests, 0);
    expect(total).toBe(s.liveRequestCount);
  });

  it("records the lookup as `index:<brand>` and never searches", async () => {
    const s = site();
    const results = await run(s);
    for (const r of results) expect(r.queriesTried).toEqual(["index:Acme"]);
    expect(searches).toBe(0);
    for (const url of s.counts.keys()) expect(url).not.toContain("/s?q=");
  });
});

describe("an index that cannot be read is a failure, never a miss", () => {
  it("🔴 a failed fetch of the list fails every item, with the reason", async () => {
    const s = site({}, new Map([[LIST, 99]]));
    const results = await run(s);

    expect(results).toHaveLength(20);
    for (const r of results) {
      expect(r.outcome).toBe("not-found");
      expect(r.failure).toMatch(/product index could not be read/);
      expect(r.failure).toContain(LIST);
      expect(r.queriesTried).toEqual(["index:Acme"]);
      expect(r.probes).toBe(0);
    }
    // One read for the whole first pass, one more for the retry: never one per item.
    expect(s.count(LIST)).toBe(2);
  });

  it("🔴 a failed product file fails every item too", async () => {
    const s = site({}, new Map([[FILE_B, 99]]));
    const results = await run(s);
    for (const r of results) {
      expect(r.failure).toMatch(/product index could not be read/);
      expect(r.failure).toContain(FILE_B);
    }
  });

  it("🔴 a list shorter than its minimum is refused", async () => {
    const s = site({ [LIST]: `file ${FILE_A}` });
    const results = await run(s);
    for (const r of results) {
      expect(r.outcome).toBe("not-found");
      expect(r.failure).toMatch(/too short to be the index's list/);
    }
  });

  it("🔴 an index holding fewer than its least products is refused", async () => {
    const s = site({
      [LIST]: listBody([FILE_A]),
      [FILE_A]: fileBody([
        ["100", "acme thing 0"],
        ["101", "acme thing 1"],
      ]),
    });
    const results = await run(s);
    for (const r of results) {
      expect(r.outcome).toBe("not-found");
      expect(r.failure).toMatch(/2 products, fewer than the 4/);
    }
  });

  it("🔴 a body that is no list, or no product file, is refused", async () => {
    const noList = await run(site({ [LIST]: "#".repeat(300) }));
    for (const r of noList) expect(r.failure).toMatch(/is not a list/);
    await rm(runDir, { recursive: true, force: true });
    const noFile = await run(site({ [FILE_A]: "<html>maintenance</html>" }));
    for (const r of noFile) expect(r.failure).toMatch(/is not a product file/);
  });
});

describe("the retry after the run reads the index once more", () => {
  it("🔴 a failure is dropped before the second pass, which refetches once and resolves", async () => {
    // The first read fails; the second pass's first item reads it again.
    const s = site({}, new Map([[LIST, 1]]));
    const results = await run(s);

    expect(s.count(LIST)).toBe(2);
    expect(s.count(FILE_A)).toBe(1);
    expect(results.every((r) => r.outcome === "verified")).toBe(true);
    expect(results.every((r) => r.failure === null)).toBe(true);
  });

  it("a cache keeps a failure until told to forget it", async () => {
    const s = site({}, new Map([[LIST, 1]]));
    const cache = createIndexCache(FAKE_INDEX, indexed.fetchProfile);
    expect((await cache.read(s)).kind).toBe("failed");
    expect((await cache.read(s)).kind).toBe("failed");
    expect(s.count(LIST)).toBe(1);
    cache.forgetFailure();
    expect((await cache.read(s)).kind).toBe("read");
    cache.forgetFailure(); // a read that worked is kept
    await cache.read(s);
    expect(s.count(LIST)).toBe(2);
  });
});

describe("resolving one item from the index", () => {
  it("probes and verifies a candidate exactly as a search's", async () => {
    const s = site();
    const r = await resolveItem(item(3), indexed, s, OPTIONS);
    expect(r.outcome).toBe("verified");
    expect(r.match?.itemId).toBe("103");
    expect(r.match?.priceCents).toBe(999);
    expect(r.candidatesSeen).toBe(20);
    expect(searches).toBe(0);
  });

  it("an item whose brand the index does not carry is a clean miss", async () => {
    const s = site({
      [CATALOGUE.replace("{sku}", "SKU0")]: catalogue("SKU0", "Other"),
    });
    const r = await resolveItem(item(0), indexed, s, OPTIONS);
    expect(r.outcome).toBe("not-found");
    expect(r.failure).toBeNull();
    expect(r.queriesTried).toEqual(["index:Other"]);
    expect(r.probes).toBe(0);
  });

  it("🔴 an item with no brand and no name cannot be looked up, and says so", async () => {
    const s = site({ [CATALOGUE.replace("{sku}", "SKU0")]: "<html></html>" });
    const r = await resolveItem(item(0), indexed, s, {
      ...OPTIONS,
      searchEngineUrlTemplate: "https://engine.test/?q={query}",
    });
    expect(r.outcome).toBe("not-found");
    expect(r.failure).not.toBeNull();
    expect(s.count(LIST)).toBe(0);
  });

  it("looks an item up by its name when its brand is unknown", async () => {
    const s = site({ [CATALOGUE.replace("{sku}", "SKU0")]: "<html></html>" });
    const r = await resolveItem(
      { ...item(0), productName: "Acme Thing 0" },
      indexed,
      s,
      { ...OPTIONS, searchEngineUrlTemplate: "https://engine.test/?q={query}" },
    );
    expect(r.queriesTried).toEqual(["index:Acme Thing 0"]);
  });
});
