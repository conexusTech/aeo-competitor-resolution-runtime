/**
 * The four committed replays, driven exactly as their exit-criterion specs
 * drive them, with every resolution and every url asked recorded in full.
 *
 * 🔑 **Why a second driver beside the exit-criterion specs.** Those specs
 * assert outcomes against an investigation — the right check for whether a
 * retailer works, and too coarse to say a change altered NOTHING. A query
 * reordered, a probe spent differently, or an alternative's reason reworded
 * all pass an outcome comparison. `replays-unchanged.spec.ts` compares what
 * this returns, field for field, against a record taken before the change.
 *
 * ⚠️ Each driver mirrors its spec's request shape — barcode and client SKU,
 * plus the client's product name for Costco — and its options. Nothing here
 * sends a part number or a brand, which is the point: with both absent, a run
 * must be what it was.
 */

import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { bestbuyAdapter } from "../src/adapters/bestbuy.js";
import { bhAdapter } from "../src/adapters/bh.js";
import { costcoAdapter, SITEMAP_INDEX } from "../src/adapters/costco.js";
import { neweggAdapter } from "../src/adapters/newegg.js";
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
  type ResolveOptions,
  type ResolveRequest,
} from "../src/resolve.js";
import bestbuy from "./fixtures/bestbuy-investigation-20.json" with { type: "json" };
import bh from "./fixtures/bh-investigation-20.json" with { type: "json" };
import costco from "./fixtures/costco-investigation-20.json" with { type: "json" };
import measured from "./fixtures/measured-run-53.json" with { type: "json" };

/** One row of a replay, as recorded. */
export type ReplayedRow =
  | {
      readonly barcode: string;
      readonly kind: "resolved";
      readonly resolution: Resolution;
      readonly asked: readonly string[];
    }
  | {
      readonly barcode: string;
      readonly kind: "stopped";
      readonly missing: string;
      readonly asked: readonly string[];
    };

export const REPLAYS = [
  "newegg-53",
  "bestbuy-20",
  "bh-20",
  "costco-20",
] as const;
export type ReplayName = (typeof REPLAYS)[number];

const gunzip = (rel: string): string =>
  gunzipSync(
    readFileSync(fileURLToPath(new URL(rel, import.meta.url))),
  ).toString("utf8");
const corpus = (rel: string): Corpus => JSON.parse(gunzip(rel)) as Corpus;

/** Routes the synthetic catalogue host to its own replay, and records. */
class Watched implements Fetcher {
  readonly asked: string[] = [];
  constructor(
    private readonly retailer: ReplayFetcher,
    private readonly catalogue: ReplayFetcher | null = null,
  ) {}
  get liveRequestCount(): number {
    return 0;
  }
  get pagesDelivered(): number {
    return 0;
  }
  fetch(url: string, profile?: FetchProfile): Promise<FetchResult> {
    this.asked.push(url);
    const host = new URL(url).hostname;
    const target =
      host === "catalogue.test" && this.catalogue !== null
        ? this.catalogue
        : this.retailer;
    return target.fetch(url, profile);
  }
}

/** The investigation's identity, as the `schema.org/Product` node it reads. */
const CATALOGUE = "https://catalogue.test/item/{sku}";
const catalogueCorpus = (
  rows: readonly { microCenterSku: string; mpn: string; brand: string }[],
): Corpus => ({
  entries: rows.map((row) => ({
    url: CATALOGUE.replace("{sku}", row.microCenterSku),
    body: `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      sku: row.microCenterSku,
      mpn: row.mpn,
      brand: { "@type": "Brand", name: row.brand },
    })}</script>`,
  })),
});

async function drive(
  requests: readonly ResolveRequest[],
  adapter: RetailerAdapter,
  retailer: ReplayFetcher,
  catalogue: ReplayFetcher | null,
  options: ResolveOptions,
  index?: IndexCache,
): Promise<ReplayedRow[]> {
  const out: ReplayedRow[] = [];
  for (const request of requests) {
    const fetcher = new Watched(retailer, catalogue);
    try {
      const resolution = await resolveItem(
        request,
        adapter,
        fetcher,
        options,
        undefined,
        index,
      );
      out.push({
        barcode: request.barcode,
        kind: "resolved",
        resolution,
        asked: fetcher.asked,
      });
    } catch (error) {
      if (!(error instanceof NotInCorpus)) throw error;
      out.push({
        barcode: request.barcode,
        kind: "stopped",
        missing: error.url,
        asked: fetcher.asked,
      });
    }
  }
  return out;
}

/** One replay, every row, in its fixture's order. */
export async function replay(name: ReplayName): Promise<ReplayedRow[]> {
  const noCatalogue = { ...DEFAULT_OPTIONS, clientCatalogueUrlTemplate: null };
  const withCatalogue = {
    ...DEFAULT_OPTIONS,
    clientCatalogueUrlTemplate: CATALOGUE,
  };
  switch (name) {
    case "newegg-53": {
      const rows = measured.rows as unknown as readonly { barcode: string }[];
      return drive(
        rows.map((r) => ({ barcode: r.barcode, clientSku: "" })),
        neweggAdapter,
        new ReplayFetcher(corpus("./corpus/launch-retailer-53.json.gz")),
        null,
        noCatalogue,
      );
    }
    case "bestbuy-20":
      return drive(
        bestbuy.rows.map((r) => ({
          barcode: r.upc,
          clientSku: r.microCenterSku,
        })),
        bestbuyAdapter,
        new ReplayFetcher(corpus("./corpus/bestbuy-20.json.gz")),
        null,
        noCatalogue,
      );
    case "bh-20":
      return drive(
        bh.rows.map((r) => ({ barcode: r.upc, clientSku: r.microCenterSku })),
        bhAdapter,
        new ReplayFetcher(corpus("./corpus/bh-20.json.gz")),
        new ReplayFetcher(catalogueCorpus(bh.rows)),
        withCatalogue,
      );
    case "costco-20": {
      const rows = [...costco.rows, costco.airpods];
      const retailer = new ReplayFetcher(costcoCorpus());
      const productIndex = costcoAdapter.productIndex;
      if (productIndex === null) throw new Error("Costco has no index");
      return drive(
        rows.map((r) => ({
          barcode: r.upc,
          clientSku: r.microCenterSku,
          productName: r.productName,
        })),
        costcoAdapter,
        retailer,
        new ReplayFetcher(catalogueCorpus(rows)),
        withCatalogue,
        createIndexCache(productIndex, costcoAdapter.fetchProfile),
      );
    }
  }
}

/** Costco's real sitemap index, its product sitemap and the probed pages. */
export function costcoCorpus(): Corpus {
  const pages = corpus("./corpus/costco-20.json.gz");
  return {
    entries: [
      { url: SITEMAP_INDEX, body: gunzip("./raw/costco-sitemap-index.xml.gz") },
      {
        url: "https://www.costco.com/sitemap_lw_p_mod_001.xml",
        body: gunzip("./raw/costco-sitemap-p-mod-full.xml.gz"),
      },
      ...pages.entries,
    ],
  };
}

/** Where a replay's record lives. */
export const recordPath = (name: ReplayName): string =>
  fileURLToPath(
    new URL(`./fixtures/replay-records/${name}.json`, import.meta.url),
  );
