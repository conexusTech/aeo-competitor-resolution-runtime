import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  bhAdapter,
  DISCONTINUED_NO_UPC,
  noBarcodeReason,
} from "../src/adapters/bh.js";
import type { RetailerAdapter } from "../src/adapters/types.js";
import { ReplayFetcher, type Corpus } from "../src/fetcher/replay.js";
import {
  NotInCorpus,
  type Fetcher,
  type FetchProfile,
  type FetchResult,
} from "../src/fetcher/types.js";
import { manufacturerItemRef } from "../src/identity/from-barcode.js";
import {
  DEFAULT_OPTIONS,
  resolveItem,
  type Resolution,
} from "../src/resolve.js";
import investigation from "./fixtures/bh-investigation-20.json" with { type: "json" };

/**
 * **B&H's exit criterion, offline**: the investigation's 20 rows reproduce at
 * least its 8 verified pairings, row by row, and its 3 discontinued listings
 * come out for a person to judge.
 *
 * Replayed from a committed corpus of 52 real B&H pages — every search the
 * investigation asked for each row and the product page of every listing it
 * probed — distilled by `scripts/distil-bh.mjs` and proven to parse
 * identically to the raw captures. No network and no spend.
 *
 * ── 🔑 Where the item's identity comes from ─────────────────────────────
 *
 * The runtime asks B&H the barcode first, so for the 8 rows B&H lists under
 * their barcode nothing is bought to identify the item: two pages, both
 * captured.
 *
 * For the other 12 the pipeline must know the item's part number and brand to
 * search by them. The investigation read both off Micro Center's own product
 * pages — but those publish them as page data, not as the `schema.org/Product`
 * node that is the only client-catalogue format this runtime reads. So this
 * replay serves the investigation's own part number and brand for each row as
 * exactly that node, at a catalogue url of its own: **the identity the
 * investigation had, in the format the runtime reads**, and nothing else. It
 * is synthetic and says so; every B&H page is real.
 *
 * ⚠️ **Production does not run with a client catalogue** today: it identifies
 * an item from a search engine's results. The launch corpus holds those pages
 * for these 20 barcodes, and they name other part numbers for several rows
 * (`SABRENT-20-INTERNAL-` and brand "Quote" for the Sabrent reader), so a
 * production run would ask B&H searches this corpus does not hold. That is a
 * fact about identity, measured elsewhere, not about B&H.
 *
 * ── The one named reason a row stops short ──────────────────────────────
 *
 * After the investigation's searches, the runtime also asks the barcode's
 * manufacturer item reference with the brand (`Kingwin 01054`), which the
 * investigation never asked and so was never captured. A row that stops there
 * — having asked exactly the investigation's searches before it, every one
 * answered with no candidate — carries that reason. Any other disagreement
 * fails. No verification can hide behind it: all three are rows the
 * investigation found B&H does not carry.
 */

const CORPUS = (): Corpus =>
  JSON.parse(
    gunzipSync(
      readFileSync(
        fileURLToPath(new URL("./corpus/bh-20.json.gz", import.meta.url)),
      ),
    ).toString("utf8"),
  ) as Corpus;

interface InvestigatedRow {
  readonly upc: string;
  readonly microCenterSku: string;
  readonly mpn: string;
  readonly brand: string;
  readonly status: string;
  readonly queries: readonly string[];
  readonly probed: readonly string[];
  readonly bhSkuNo: string | null;
  readonly bhPriceCents: number | null;
  readonly bhStock: string | null;
  readonly pdpUpcs: readonly string[] | null;
}

const rows: readonly InvestigatedRow[] = investigation.rows;

/** Why a row may stop short of its outcome. The only one. */
const ITEM_REF_NOT_CAPTURED =
  "after the investigation's own searches, all answered with no candidate, " +
  "the runtime asks the barcode's item reference with the brand, which the " +
  "investigation never asked";

/** The identity the investigation had, as the node the runtime reads. */
const CATALOGUE = "https://catalogue.test/item/{sku}";
const catalogueUrl = (row: InvestigatedRow): string =>
  CATALOGUE.replace("{sku}", row.microCenterSku);
const catalogueCorpus = (): Corpus => ({
  entries: rows.map((row) => ({
    url: catalogueUrl(row),
    body: `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      sku: row.microCenterSku,
      mpn: row.mpn,
      brand: { "@type": "Brand", name: row.brand },
    })}</script>`,
  })),
});

/** B&H's stock status as the runtime states it. */
const STOCK: Readonly<Record<string, boolean | null>> = {
  IN_STOCK: true,
  DYNAMIC: null,
  NO_LONGER_AVAILABLE: false,
};

/** Routes catalogue pages to one replay and B&H's to the other, and records. */
class Watched implements Fetcher {
  readonly asked: string[] = [];
  constructor(
    private readonly bh: ReplayFetcher,
    private readonly catalogue: ReplayFetcher,
  ) {}
  get liveRequestCount(): number {
    return this.bh.liveRequestCount + this.catalogue.liveRequestCount;
  }
  get pagesDelivered(): number {
    return this.bh.pagesDelivered + this.catalogue.pagesDelivered;
  }
  fetch(url: string, profile?: FetchProfile): Promise<FetchResult> {
    this.asked.push(url);
    const host = new URL(url).hostname;
    return (host === "catalogue.test" ? this.catalogue : this.bh).fetch(
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
  | {
      readonly kind: "stopped";
      readonly missing: string;
      readonly asked: readonly string[];
    };

interface Replay {
  readonly byRow: Map<string, Replayed>;
  readonly bh: ReplayFetcher;
  readonly catalogue: ReplayFetcher;
}

async function replay(adapter: RetailerAdapter): Promise<Replay> {
  const bh = new ReplayFetcher(CORPUS());
  const catalogue = new ReplayFetcher(catalogueCorpus());
  const byRow = new Map<string, Replayed>();
  for (const row of rows) {
    // One watcher per row, so each row's requests are its own.
    const fetcher = new Watched(bh, catalogue);
    try {
      const resolution = await resolveItem(
        { barcode: row.upc, clientSku: row.microCenterSku },
        adapter,
        fetcher,
        { ...DEFAULT_OPTIONS, clientCatalogueUrlTemplate: CATALOGUE },
      );
      byRow.set(row.upc, {
        kind: "resolved",
        resolution,
        asked: fetcher.asked,
      });
    } catch (error) {
      if (!(error instanceof NotInCorpus)) throw error;
      byRow.set(row.upc, {
        kind: "stopped",
        missing: error.url,
        asked: fetcher.asked,
      });
    }
  }
  return { byRow, bh, catalogue };
}

const search = (q: string): string => bhAdapter.buildSearchUrl(q);

/** The body the corpus holds for a url. */
const bodyAt = (url: string): string => {
  const entry = CORPUS().entries.find((e) => e.url === url);
  if (entry === undefined) throw new Error(`not in the corpus: ${url}`);
  return entry.body;
};

/**
 * How a row's replay disagrees with the investigation, or `null` where it
 * agrees — or stops for the one named reason, which `namedReason` reports.
 */
function disagreement(
  row: InvestigatedRow,
  r: Replayed | undefined,
): string | null {
  if (r === undefined) return "not replayed";
  const same = (a: unknown, b: unknown, what: string): string | null =>
    JSON.stringify(a) === JSON.stringify(b)
      ? null
      : `${what}: ${JSON.stringify(a)}, investigated ${JSON.stringify(b)}`;

  if (r.kind === "stopped") {
    return namedReason(row, r) === null
      ? `stopped on ${r.missing}, for no named reason`
      : null;
  }
  const { resolution: res } = r;
  const checks: (string | null)[] = [
    same(res.failure, null, "failure"),
    same(res.queriesTried, row.queries, "queries"),
    same(res.probes, row.probed.length, "probes"),
  ];
  if (row.status === "upc-verified") {
    checks.push(
      same(res.outcome, "verified", "outcome"),
      same(res.match?.itemId, row.bhSkuNo, "listing"),
      same(res.match?.retailerBarcode, row.pdpUpcs?.[0], "barcode"),
      same(res.match?.priceCents, row.bhPriceCents, "price"),
      same(res.match?.inStock, STOCK[row.bhStock ?? ""], "stock"),
      same(res.match?.sellerName, "B&H Photo", "seller"),
      same(res.match?.unverifiableReason, null, "unverifiable reason"),
      // Nothing bought to identify the item: one search, one product page.
      same(res.identity, null, "identity"),
      same(r.asked, [search(row.upc), res.match?.url], "pages asked"),
    );
  } else if (row.status === "mpn-exact-discontinued") {
    const url = res.match?.url;
    checks.push(
      same(res.outcome, "unverifiable", "outcome"),
      same(res.match?.itemId, row.bhSkuNo, "listing"),
      same(res.match?.retailerBarcode, null, "barcode"),
      same(res.match?.priceCents, null, "price"),
      same(res.match?.inStock, false, "stock"),
      same(
        url === undefined ? null : noBarcodeReason(bodyAt(url)),
        DISCONTINUED_NO_UPC,
        "reason",
      ),
      // 🔑 And the reason reaches the wire, on the evidence the reviewer reads.
      same(res.match?.unverifiableReason, DISCONTINUED_NO_UPC, "reason sent"),
    );
  } else {
    checks.push(
      same(res.outcome, "not-found", "outcome"),
      same(res.match, null, "listing"),
    );
  }
  const found = checks.filter((c): c is string => c !== null);
  return found.length === 0 ? null : found.join("; ");
}

/** The named reason a stopped row carries, or `null` when it carries none. */
function namedReason(
  row: InvestigatedRow,
  r: Extract<Replayed, { kind: "stopped" }>,
): string | null {
  const itemRef = manufacturerItemRef(row.upc);
  if (itemRef === null || row.status !== "not-found") return null;
  const query = `${row.brand} ${itemRef}`;
  if (row.queries.includes(query) || r.missing !== search(query)) return null;
  // Exactly the investigation's searches before it, with the identity lookup
  // after the barcode, and nothing else.
  const [first, ...rest] = row.queries.map(search);
  const expected = [first, catalogueUrl(row), ...rest, r.missing];
  return JSON.stringify(r.asked) === JSON.stringify(expected)
    ? ITEM_REF_NOT_CAPTURED
    : null;
}

describe("the investigation's ground truth", () => {
  it("is 20 rows: 8 verified by UPC, 3 discontinued, 9 not found", () => {
    expect(rows).toHaveLength(20);
    expect(investigation.split).toEqual({
      "mpn-exact-discontinued": 3,
      "not-found": 9,
      "upc-verified": 8,
    });
  });
});

describe("20 B&H rows, replayed offline", () => {
  let run: Replay;

  beforeAll(async () => {
    run = await replay(bhAdapter);
  });

  it("🔴 verifies at least 8, as the investigation did", () => {
    const verified = [...run.byRow.values()].filter(
      (r) => r.kind === "resolved" && r.resolution.outcome === "verified",
    );
    console.log(
      `B&H 20 rows: verified ${verified.length} vs the investigation's 8`,
    );
    expect(verified.length).toBeGreaterThanOrEqual(8);
  });

  for (const row of rows) {
    it(`🔴 ${row.upc} (${row.brand} ${row.mpn}): ${row.status}, as investigated`, () => {
      expect(disagreement(row, run.byRow.get(row.upc))).toBeNull();
    });
  }

  it(`stops short only for the named reason — ${ITEM_REF_NOT_CAPTURED}`, () => {
    const stopped = rows.filter(
      (row) => run.byRow.get(row.upc)?.kind === "stopped",
    );
    for (const row of stopped) {
      const r = run.byRow.get(row.upc);
      if (r?.kind !== "stopped") continue;
      expect(namedReason(row, r), row.upc).toBe(ITEM_REF_NOT_CAPTURED);
      // Never a row the investigation verified or found discontinued.
      expect(row.status).toBe("not-found");
    }
    expect(stopped.map((row) => `${row.brand} ${row.mpn}`)).toEqual([
      "SteelSeries 63005",
      "Kingwin CF-08LB",
      "Kingwin CF-012LB",
    ]);
  });

  it("🔴 the 3 discontinued listings go to a person, with the reason", () => {
    const discontinued = rows.filter(
      (r) => r.status === "mpn-exact-discontinued",
    );
    expect(discontinued.map((r) => r.mpn)).toEqual([
      "CRW-UINB",
      "K72337US",
      "980-000402",
    ]);
    for (const row of discontinued) {
      const r = run.byRow.get(row.upc);
      expect(r?.kind).toBe("resolved");
      if (r?.kind !== "resolved") continue;
      // Never verified, and never the miss the gateway files as not carried.
      expect(r.resolution.outcome).toBe("unverifiable");
      expect(r.resolution.failure).toBeNull();
      const url = r.resolution.match?.url ?? "";
      expect(noBarcodeReason(bodyAt(url))).toBe(
        "discontinued at B&H, no UPC published",
      );
      expect(r.resolution.match?.unverifiableReason).toBe(
        "discontinued at B&H, no UPC published",
      );
    }
  });

  it("never claims verified without a barcode that agrees", () => {
    for (const r of run.byRow.values()) {
      if (r.kind !== "resolved" || r.resolution.outcome !== "verified")
        continue;
      const barcode = r.resolution.match?.retailerBarcode ?? "";
      expect(barcode.replace(/^0+/, "")).toBe(
        r.resolution.barcode.replace(/^0+/, ""),
      );
    }
  });

  it("serves every row, and uses every page of the corpus", () => {
    expect(run.byRow.size).toBe(20);
    expect(run.bh.entryCount).toBe(52);
    expect(run.bh.unusedEntryCount).toBe(0);
    // The 8 rows the barcode found needed no identity at all.
    expect(run.catalogue.unusedEntryCount).toBe(8);
  });

  it("spends nothing", () => {
    expect(run.bh.liveRequestCount).toBe(0);
    expect(run.catalogue.liveRequestCount).toBe(0);
  });
});

describe("CONTROL: with barcode search switched off", () => {
  it("🔴 the same replay reproduces none of the investigation's rows", async () => {
    const off = await replay({
      ...bhAdapter,
      querySupport: { ...bhAdapter.querySupport, barcodeIsSearchable: false },
    });
    const disagreeing = rows.filter(
      (row) => disagreement(row, off.byRow.get(row.upc)) !== null,
    );
    expect(disagreeing).toHaveLength(20);
    const verified = [...off.byRow.values()].filter(
      (r) => r.kind === "resolved" && r.resolution.outcome === "verified",
    );
    expect(verified).toHaveLength(0);
  });
});
