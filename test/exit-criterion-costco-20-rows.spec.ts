import { gunzipSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  COSTCO_PRODUCT_INDEX,
  costcoAdapter,
  indexCandidates,
  SITEMAP_INDEX,
} from "../src/adapters/costco.js";
import type { RetailerAdapter } from "../src/adapters/types.js";
import { ReplayFetcher, type Corpus } from "../src/fetcher/replay.js";
import {
  NotInCorpus,
  type Fetcher,
  type FetchProfile,
  type FetchResult,
} from "../src/fetcher/types.js";
import { createIndexCache, type IndexCache } from "../src/product-index.js";
import {
  DEFAULT_OPTIONS,
  resolveItem,
  type Resolution,
  type ResolveRequest,
} from "../src/resolve.js";
import { RUN_DEFAULTS, runList } from "../src/run.js";
import investigation from "./fixtures/costco-investigation-20.json" with { type: "json" };

/**
 * **Costco's exit criterion, offline**: the investigation's 20 rows all come
 * out not found — each looked up in Costco's product index by its brand, with
 * no failure — as the investigation found them; and the one pairing it proved,
 * Micro Center's AirPods 4 with ANC, verifies by its UPC at $99.97.
 *
 * Replayed from Costco's real sitemap index and its whole product sitemap
 * (18,180 products, `test/raw/costco-sitemap-*`) and the seven product pages
 * those lookups probe (`test/corpus/costco-20.json.gz`), every one distilled
 * by `scripts/distil-costco.mjs` and proven to parse as the raw capture did.
 * No network and no spend.
 *
 * ── 🔑 Where the item's identity comes from ─────────────────────────────
 *
 * Costco is never searched, so an item is found by its brand and its name.
 * The investigation read both off Micro Center's own product pages; this
 * replay serves its part number and brand as the `schema.org/Product` node
 * the runtime reads, at a catalogue url of its own — as the B&H replay does,
 * synthetic and saying so — and the item's name as the gateway sends it, the
 * Micro Center page's own title. Every Costco page is real.
 *
 * ── The one named reason a row differs ──────────────────────────────────
 *
 * The investigation chose which same-brand products to read by Micro
 * Center's CATEGORY words, which a run does not have; the runtime chooses by
 * the product's own name. For one row they differ — see `CATEGORY_WORDS`.
 * Any other disagreement fails.
 */

const dir = (rel: string): string =>
  fileURLToPath(new URL(rel, import.meta.url));
const gunzip = (rel: string): string =>
  gunzipSync(readFileSync(dir(rel))).toString("utf8");

const PRODUCT_SITEMAP = "https://www.costco.com/sitemap_lw_p_mod_001.xml";

const costcoCorpus = (): Corpus => {
  const pages = JSON.parse(gunzip("./corpus/costco-20.json.gz")) as Corpus;
  return {
    entries: [
      { url: SITEMAP_INDEX, body: gunzip("./raw/costco-sitemap-index.xml.gz") },
      {
        url: PRODUCT_SITEMAP,
        body: gunzip("./raw/costco-sitemap-p-mod-full.xml.gz"),
      },
      ...pages.entries,
    ],
  };
};

interface InvestigatedRow {
  readonly upc: string;
  readonly microCenterSku: string;
  readonly mpn: string;
  readonly brand: string;
  readonly productName: string;
  readonly status: string;
  readonly probed: readonly string[];
  readonly reason: string;
}

const rows: readonly InvestigatedRow[] = investigation.rows;
const airpods = investigation.airpods;

/**
 * Why a row may read fewer Costco pages than the investigation did. The only
 * one.
 */
const CATEGORY_WORDS =
  "the investigation chose same-brand products by Micro Center's category " +
  "words, which a run does not have; the runtime chooses by the product's " +
  "own name, which shares a word with fewer of them";

/** The identity the investigation had, as the node the runtime reads. */
const CATALOGUE = "https://catalogue.test/item/{sku}";
const catalogueUrl = (sku: string): string => CATALOGUE.replace("{sku}", sku);
const catalogueCorpus = (): Corpus => ({
  entries: [...rows, airpods].map((row) => ({
    url: catalogueUrl(row.microCenterSku),
    body: `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      sku: row.microCenterSku,
      mpn: row.mpn,
      brand: { "@type": "Brand", name: row.brand },
    })}</script>`,
  })),
});

const request = (row: {
  upc: string;
  microCenterSku: string;
  productName: string;
}): ResolveRequest => ({
  barcode: row.upc,
  clientSku: row.microCenterSku,
  productName: row.productName,
});

const OPTIONS = { ...DEFAULT_OPTIONS, clientCatalogueUrlTemplate: CATALOGUE };

/** Routes catalogue pages to one replay and Costco's to the other, and records. */
class Watched implements Fetcher {
  readonly asked: string[] = [];
  constructor(
    private readonly costco: ReplayFetcher,
    private readonly catalogue: ReplayFetcher,
  ) {}
  get liveRequestCount(): number {
    return this.costco.liveRequestCount + this.catalogue.liveRequestCount;
  }
  get pagesDelivered(): number {
    return this.costco.pagesDelivered + this.catalogue.pagesDelivered;
  }
  fetch(url: string, profile?: FetchProfile): Promise<FetchResult> {
    this.asked.push(url);
    const host = new URL(url).hostname;
    return (host === "catalogue.test" ? this.catalogue : this.costco).fetch(
      url,
      profile,
    );
  }
}

type Replayed =
  | {
      readonly kind: "resolved";
      readonly resolution: Resolution;
      readonly asked: readonly string[];
    }
  | { readonly kind: "stopped"; readonly missing: string };

interface Replay {
  readonly byRow: Map<string, Replayed>;
  readonly costco: ReplayFetcher;
  readonly catalogue: ReplayFetcher;
}

/** Every row and the AirPods row, one at a time, over one run's index. */
async function replay(adapter: RetailerAdapter): Promise<Replay> {
  const costco = new ReplayFetcher(costcoCorpus());
  const catalogue = new ReplayFetcher(catalogueCorpus());
  const index: IndexCache | undefined =
    adapter.productIndex === null
      ? undefined
      : createIndexCache(adapter.productIndex, adapter.fetchProfile);
  const byRow = new Map<string, Replayed>();
  for (const row of [...rows, airpods]) {
    const fetcher = new Watched(costco, catalogue);
    try {
      const resolution = await resolveItem(
        request(row),
        adapter,
        fetcher,
        OPTIONS,
        undefined,
        index,
      );
      byRow.set(row.upc, {
        kind: "resolved",
        resolution,
        asked: fetcher.asked,
      });
    } catch (error) {
      if (!(error instanceof NotInCorpus)) throw error;
      byRow.set(row.upc, { kind: "stopped", missing: error.url });
    }
  }
  return { byRow, costco, catalogue };
}

/** The Costco product ids a row's replay read. */
const probedIds = (asked: readonly string[]): string[] =>
  asked
    .map((url) => /\/p\/-\/[^/]+\/(\d+)$/.exec(url)?.[1])
    .filter((id): id is string => id !== undefined);

/** The named reason a row reads fewer pages, or `null` where it carries none. */
function namedReason(
  row: InvestigatedRow,
  read: readonly string[],
): string | null {
  const fewer =
    read.length < row.probed.length &&
    read.every((id) => row.probed.includes(id));
  // Every page the investigation read and this replay did not states
  // another product's UPC, as the investigation recorded.
  const skipped = row.probed.filter((id) => !read.includes(id));
  const allOthers = skipped.every(
    (id) =>
      row.reason.includes(id) && !row.reason.includes(`${id} model ${row.mpn}`),
  );
  return fewer && allOthers ? CATEGORY_WORDS : null;
}

/** How a row's replay disagrees with the investigation, or `null`. */
function disagreement(
  row: InvestigatedRow,
  r: Replayed | undefined,
): string | null {
  if (r === undefined) return "not replayed";
  if (r.kind === "stopped") return `stopped on ${r.missing}`;
  const res = r.resolution;
  const same = (a: unknown, b: unknown, what: string): string | null =>
    JSON.stringify(a) === JSON.stringify(b)
      ? null
      : `${what}: ${JSON.stringify(a)}, investigated ${JSON.stringify(b)}`;
  const read = probedIds(r.asked);
  const sameProbes =
    JSON.stringify([...read].sort()) === JSON.stringify([...row.probed].sort());
  const checks: (string | null)[] = [
    same(row.status, "not-carried", "investigated status"),
    same(res.outcome, "not-found", "outcome"),
    same(res.failure, null, "failure"),
    same(res.match, null, "listing"),
    same(res.queriesTried, [`index:${row.brand}`], "lookup"),
    same(res.probes, read.length, "probes counted"),
    sameProbes || namedReason(row, read) !== null
      ? null
      : `pages read: ${JSON.stringify(read)}, investigated ${JSON.stringify(row.probed)}`,
    // Never searched.
    r.asked.some((url) => url.includes("/s?keyword="))
      ? "searched Costco"
      : null,
  ];
  const found = checks.filter((c): c is string => c !== null);
  return found.length === 0 ? null : found.join("; ");
}

describe("the investigation's ground truth", () => {
  it("is 20 rows, every one not carried, plus the AirPods pairing", () => {
    expect(rows).toHaveLength(20);
    expect(investigation.split).toEqual({ "not-carried": 20 });
    expect(airpods).toMatchObject({
      upc: "195949689604",
      microCenterSku: "757427",
      costcoProductId: "4000308504",
      costcoPriceCents: 9997,
      priceVisibility: "shown",
    });
    expect(airpods.costcoUpcs).toContain("195949689604");
  });
});

describe("20 Costco rows and the AirPods row, replayed offline", () => {
  let run: Replay;

  beforeAll(async () => {
    run = await replay(costcoAdapter);
  });

  for (const row of rows) {
    it(`🔴 ${row.upc} (${row.brand} ${row.mpn}): not found, looked up by brand, as investigated`, () => {
      expect(disagreement(row, run.byRow.get(row.upc))).toBeNull();
    });
  }

  it("🔴 0 failures: every miss is a lookup the index answered", () => {
    for (const row of rows) {
      const r = run.byRow.get(row.upc);
      expect(r?.kind, row.upc).toBe("resolved");
      if (r?.kind === "resolved") expect(r.resolution.failure).toBeNull();
    }
  });

  it(`reads fewer pages only for the named reason — ${CATEGORY_WORDS}`, () => {
    const differing = rows.filter((row) => {
      const r = run.byRow.get(row.upc);
      if (r?.kind !== "resolved") return false;
      const read = probedIds(r.asked);
      return (
        JSON.stringify([...read].sort()) !==
        JSON.stringify([...row.probed].sort())
      );
    });
    expect(differing.map((row) => `${row.brand} ${row.mpn}`)).toEqual([
      "CyberPower Systems CP1200AVR",
    ]);
    for (const row of differing) {
      const r = run.byRow.get(row.upc);
      if (r?.kind !== "resolved") continue;
      expect(namedReason(row, probedIds(r.asked))).toBe(CATEGORY_WORDS);
      // The battery backup the investigation also read is not a candidate:
      // "battery backup" is in Micro Center's category, not the name.
      expect(probedIds(r.asked).sort()).toEqual(["4000091462", "4000193283"]);
    }
  });

  it("🔴 verifies the AirPods at $99.97 by its UPC, stock unknown, sold by Costco", () => {
    const r = run.byRow.get(airpods.upc);
    expect(r?.kind).toBe("resolved");
    if (r?.kind !== "resolved") return;
    expect(r.resolution.outcome).toBe("verified");
    expect(r.resolution.failure).toBeNull();
    expect(r.resolution.queriesTried).toEqual(["index:Apple"]);
    expect(r.resolution.probes).toBe(1);
    expect(r.resolution.match).toMatchObject({
      itemId: "4000308504",
      url: "https://www.costco.com/p/-/airpods-4-with-active-noise-cancellation/4000308504",
      retailerBarcode: "195949689604",
      priceCents: 9997,
      inStock: null,
      sellerName: "Costco",
      isFirstParty: true,
      // Its name has no "apple": the brand is never read into it.
      brand: null,
      unverifiableReason: null,
    });
  });

  it("never claims verified without a barcode that agrees", () => {
    for (const r of run.byRow.values()) {
      if (r.kind !== "resolved" || r.resolution.outcome !== "verified")
        continue;
      expect(r.resolution.match?.retailerBarcode?.replace(/^0+/, "")).toBe(
        r.resolution.barcode.replace(/^0+/, ""),
      );
    }
  });

  it("reads the index once for every row, and uses every page of the corpus", () => {
    expect(run.byRow.size).toBe(21);
    const indexReads = [...run.byRow.values()].flatMap((r) =>
      r.kind === "resolved"
        ? r.asked.filter((u) => u === SITEMAP_INDEX || u === PRODUCT_SITEMAP)
        : [],
    );
    expect(indexReads).toEqual([SITEMAP_INDEX, PRODUCT_SITEMAP]);
    expect(run.costco.entryCount).toBe(9);
    expect(run.costco.unusedEntryCount).toBe(0);
    expect(run.catalogue.unusedEntryCount).toBe(0);
  });

  it("never searches Costco", () => {
    for (const r of run.byRow.values()) {
      if (r.kind !== "resolved") continue;
      expect(r.asked.some((u) => u.includes("/s?keyword="))).toBe(false);
    }
  });

  it("spends nothing", () => {
    expect(run.costco.liveRequestCount).toBe(0);
    expect(run.catalogue.liveRequestCount).toBe(0);
  });
});

describe("as one run at four pages at once", () => {
  it("🔴 reads the product index once, and gives every row its outcome", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "costco-20-"));
    try {
      const fetcher = new Watched(
        new ReplayFetcher(costcoCorpus()),
        new ReplayFetcher(catalogueCorpus()),
      );
      const results = await runList(
        [...rows, airpods].map(request),
        costcoAdapter,
        fetcher,
        { ...RUN_DEFAULTS, ...OPTIONS, concurrency: 4, runDir },
      );
      expect(fetcher.asked.filter((u) => u === SITEMAP_INDEX)).toHaveLength(1);
      expect(fetcher.asked.filter((u) => u === PRODUCT_SITEMAP)).toHaveLength(
        1,
      );
      expect(results.map((r) => r.outcome)).toEqual([
        ...rows.map(() => "not-found"),
        "verified",
      ]);
      expect(results.every((r) => r.failure === null)).toBe(true);
      expect(fetcher.liveRequestCount).toBe(0);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

describe("CONTROL: with candidates only from names that lead with the brand", () => {
  it("🔴 the AirPods row is never found, so the product-line rule is what finds it", async () => {
    const brandOnly: RetailerAdapter = {
      ...costcoAdapter,
      productIndex: {
        ...COSTCO_PRODUCT_INDEX,
        candidates: (entries, query) =>
          indexCandidates(entries, query).filter((c) => c.brand !== null),
      },
    };
    const off = await replay(brandOnly);
    const r = off.byRow.get(airpods.upc);
    const verified =
      r?.kind === "resolved" && r.resolution.outcome === "verified";
    expect(verified).toBe(false);
  });
});
