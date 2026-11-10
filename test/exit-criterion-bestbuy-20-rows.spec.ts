import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { bestbuyAdapter } from "../src/adapters/bestbuy.js";
import { ReplayFetcher, type Corpus } from "../src/fetcher/replay.js";
import {
  NotInCorpus,
  type Fetcher,
  type FetchProfile,
  type FetchResult,
} from "../src/fetcher/types.js";
import {
  DEFAULT_OPTIONS,
  resolveItem,
  type Resolution,
} from "../src/resolve.js";
import investigation from "./fixtures/bestbuy-investigation-20.json" with { type: "json" };

/**
 * **Best Buy's exit criterion, offline**: the investigation's 20 rows
 * reproduce at least its 11 verified pairings, row by row.
 *
 * Replayed from a committed corpus of 31 real Best Buy pages — every row's
 * barcode search and the product page of every listing those searches
 * returned — distilled by `scripts/distil-bestbuy.mjs` and proven to parse
 * identically to the raw captures. No network and no spend.
 *
 * ── 🔑 What the corpus can and cannot replay ───────────────────────────
 *
 * The runtime asks Best Buy the barcode first, so for the 11 rows Best Buy
 * lists under their barcode the whole resolution is two pages, both captured.
 *
 * For the other 9, Best Buy answers the barcode with nothing and the pipeline
 * goes on to find out what the item is, so it can search by part number. The
 * investigation knew that from Micro Center's own product pages, whose page
 * data names the part number — but those pages publish no `schema.org/Product`
 * node, which is the only client-catalogue format this runtime reads, so a run
 * here asks the search engine instead, and no search-engine page for these
 * barcodes was ever captured. Those rows are therefore replayed exactly as far
 * as the barcode search, which must be answered with nothing, and must then
 * ask for the identity lookup and nothing else. That is the named reason they
 * stop short; any other disagreement fails.
 *
 * ⚠️ No verification can hide behind that: the investigation's part-number
 * route verified none of the 9.
 */

const CORPUS = (): Corpus =>
  JSON.parse(
    gunzipSync(
      readFileSync(
        fileURLToPath(new URL("./corpus/bestbuy-20.json.gz", import.meta.url)),
      ),
    ).toString("utf8"),
  ) as Corpus;

interface InvestigatedRow {
  readonly upc: string;
  readonly microCenterSku: string;
  readonly mpn: string;
  readonly status: string;
  readonly upcSearch: { readonly numFound: number | null };
  readonly bestbuySku: string | null;
  readonly bestbuySeller: string | null;
  readonly bestbuyPriceCents: number | null;
  readonly pdpUpcs: readonly string[] | null;
}

const rows: readonly InvestigatedRow[] = investigation.rows;

/** Why a row is not replayed past its barcode search. */
const IDENTITY_NOT_CAPTURED =
  "Best Buy answered the barcode with nothing; the identity lookup that " +
  "would give a part number to search by was never captured";

/** Records what the pipeline asked for, in order, around the replay. */
class Watched implements Fetcher {
  readonly asked: string[] = [];
  constructor(private readonly inner: ReplayFetcher) {}
  get liveRequestCount(): number {
    return this.inner.liveRequestCount;
  }
  get pagesDelivered(): number {
    return this.inner.pagesDelivered;
  }
  fetch(url: string, profile?: FetchProfile): Promise<FetchResult> {
    this.asked.push(url);
    return this.inner.fetch(url, profile);
  }
}

type Replayed =
  | {
      readonly kind: "resolved";
      readonly resolution: Resolution;
      readonly asked: readonly string[];
    }
  | {
      readonly kind: "stopped";
      readonly missing: string;
      readonly asked: readonly string[];
    };

describe("the investigation's ground truth", () => {
  it("is 20 rows, 11 verified by UPC", () => {
    expect(rows).toHaveLength(20);
    expect(investigation.split).toEqual({
      "upc-verified": 11,
      "mpn-exact-unverified": 2,
      "not-found": 7,
    });
  });
});

describe("20 Best Buy rows, replayed offline", () => {
  const replayed = new Map<string, Replayed>();
  let replay: ReplayFetcher;

  beforeAll(async () => {
    replay = new ReplayFetcher(CORPUS());
    for (const row of rows) {
      // One watcher per row, so each row's requests are its own.
      const fetcher = new Watched(replay);
      try {
        const resolution = await resolveItem(
          { barcode: row.upc, clientSku: row.microCenterSku },
          bestbuyAdapter,
          fetcher,
          // As production runs today: no client-catalogue template.
          { ...DEFAULT_OPTIONS, clientCatalogueUrlTemplate: null },
        );
        replayed.set(row.upc, {
          kind: "resolved",
          resolution,
          asked: fetcher.asked,
        });
      } catch (error) {
        if (!(error instanceof NotInCorpus)) throw error;
        replayed.set(row.upc, {
          kind: "stopped",
          missing: error.url,
          asked: fetcher.asked,
        });
      }
    }
  });

  const verifiedRows = rows.filter((r) => r.status === "upc-verified");
  const otherRows = rows.filter((r) => r.status !== "upc-verified");

  it("🔴 verifies at least 11, as the investigation did", () => {
    const verified = [...replayed.values()].filter(
      (r) => r.kind === "resolved" && r.resolution.outcome === "verified",
    );
    console.log(
      `Best Buy 20 rows: verified ${verified.length} vs the investigation's ${verifiedRows.length}`,
    );
    expect(verified.length).toBeGreaterThanOrEqual(11);
  });

  for (const row of verifiedRows) {
    it(`🔴 ${row.upc} (${row.mpn}): verified on SKU ${row.bestbuySku ?? "?"}, as investigated`, () => {
      const r = replayed.get(row.upc);
      expect(r?.kind).toBe("resolved");
      if (r?.kind !== "resolved") return;
      const { resolution } = r;
      expect(resolution.outcome).toBe("verified");
      expect(resolution.failure).toBeNull();
      expect(resolution.match?.itemId).toBe(row.bestbuySku);
      expect(resolution.match?.retailerBarcode).toBe(row.pdpUpcs?.[0]);
      expect(resolution.match?.priceCents).toBe(row.bestbuyPriceCents);
      expect(resolution.match?.isFirstParty).toBe(row.bestbuySeller === "1P");
      // A marketplace pairing is named by its seller, from its own page.
      expect(resolution.match?.sellerName).not.toBeNull();
      // The barcode found it and proved it: one search, one product page,
      // and nothing bought to identify the item.
      expect(resolution.queriesTried).toEqual([row.upc]);
      expect(resolution.probes).toBe(1);
      expect(resolution.identity).toBeNull();
      expect(r.asked).toEqual([
        bestbuyAdapter.buildSearchUrl(row.upc),
        resolution.match?.url,
      ]);
    });
  }

  for (const row of otherRows) {
    it(`${row.upc} (${row.mpn}): investigated ${row.status} — ${IDENTITY_NOT_CAPTURED}`, () => {
      // The investigation's barcode search found nothing, and so does ours.
      expect(row.upcSearch.numFound).toBe(0);
      const r = replayed.get(row.upc);
      expect(r?.kind, `${row.upc} disagrees without a named reason`).toBe(
        "stopped",
      );
      if (r?.kind !== "stopped") return;
      // The barcode was asked first and answered; the next request — and the
      // only other one — is the identity lookup, for this barcode.
      expect(r.asked).toHaveLength(2);
      expect(r.asked[0]).toBe(bestbuyAdapter.buildSearchUrl(row.upc));
      expect(r.missing).toBe(r.asked[1]);
      const lookup = new URL(r.missing);
      expect(lookup.hostname).toBe("www.google.com");
      expect(lookup.searchParams.get("q")).toBe(`"${row.upc}"`);
    });
  }

  it("never claims verified without a barcode that agrees", () => {
    for (const r of replayed.values()) {
      if (r.kind !== "resolved" || r.resolution.outcome !== "verified")
        continue;
      const barcode = r.resolution.match?.retailerBarcode ?? "";
      expect(barcode.replace(/^0+/, "")).toBe(
        r.resolution.barcode.replace(/^0+/, ""),
      );
    }
  });

  it("serves every row, and uses every page of the corpus", () => {
    expect(replayed.size).toBe(20);
    expect(replay.entryCount).toBe(31);
    expect(replay.unusedEntryCount).toBe(0);
  });

  it("spends nothing", () => {
    expect(replay.liveRequestCount).toBe(0);
  });
});
