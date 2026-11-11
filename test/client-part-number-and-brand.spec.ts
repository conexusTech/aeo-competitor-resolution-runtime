import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { costcoAdapter } from "../src/adapters/costco.js";
import type {
  ParsedCandidate,
  ParsedProduct,
  ProductIndexQuery,
  QuerySupport,
  RetailerAdapter,
} from "../src/adapters/types.js";
import { ReplayFetcher } from "../src/fetcher/replay.js";
import {
  FetchFailed,
  NotInCorpus,
  type Fetcher,
  type FetchProfile,
  type FetchResult,
} from "../src/fetcher/types.js";
import { CAPTURE_DISABLED } from "../src/capture/types.js";
import {
  MAX_BRAND_LENGTH,
  MAX_PART_NUMBER_LENGTH,
  parseJob,
  type ResolutionJob,
} from "../src/gateway/client.js";
import { runDispatchedJob } from "../src/queue-run.js";
import { RUN_DEFAULTS } from "../src/run.js";
import { readJobEnvelope } from "../src/job-file.js";
import {
  DEFAULT_OPTIONS,
  resolveItem,
  type ResolveRequest,
} from "../src/resolve.js";
import { costcoCorpus } from "./replay-drivers.js";

/**
 * 🔴 **The client's own part number and brand, which the runtime never used.**
 *
 * A live Best Buy run on 2026-11-10 (20 Micro Center rows, image
 * `local-748c11c`) searched Kensington K72337US — barcode `085896723370` — as
 * the barcode, then `Kensington KMW72337`: an identity the runtime guessed,
 * while Micro Center's list states the part number outright, and the
 * investigation verified the item on Best Buy listing 10117379 by searching
 * exactly that.
 *
 * The gateway sends `partNumber` and `brand` beside `productName`. Each is
 * optional and nullable, because an older gateway sends neither — and with
 * both absent a run must be what it was, which `replays-unchanged.spec.ts`
 * holds field for field on all four committed replays.
 */

const KENSINGTON_UPC = "085896723370";
const ALLSOP_UPC = "035286295383";
const LOGITECH_M310_UPC = "097855067876";
const SEARCH_ENGINE = (barcode: string): string =>
  DEFAULT_OPTIONS.searchEngineUrlTemplate.replace(
    "{query}",
    encodeURIComponent(barcode),
  );

const card = (over: Partial<ParsedCandidate> = {}): ParsedCandidate => ({
  itemId: "A",
  url: "https://r.test/p/A",
  model: null,
  title: "A listing",
  brand: null,
  priceCents: 1299,
  inStock: true,
  isFirstParty: true,
  sellerName: "Retailer",
  imageUrl: null,
  partialMatch: false,
  ...over,
});

const product = (barcode: string | null): ParsedProduct => ({
  barcode,
  additionalBarcodes: [],
  priceCents: null,
  inStock: null,
  title: null,
  sellerName: null,
  isFirstParty: null,
  unverifiableReason: null,
  category: null,
});

/** A search-engine page whose result titles say `titles`. */
const serp = (titles: readonly string[], body = ""): string =>
  `<html><body>${titles.map((t) => `<h3>${t}</h3>`).join("")}<p>${body}</p></body></html>`;

/** Serves pages by url; anything else is a fetch that failed. */
class Pages implements Fetcher {
  liveRequestCount = 0;
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  readonly asked: string[] = [];
  constructor(private readonly byUrl: Readonly<Record<string, string>>) {}
  fetch(url: string): Promise<FetchResult> {
    this.asked.push(url);
    this.liveRequestCount++;
    const body = this.byUrl[url];
    if (body === undefined) {
      return Promise.reject(new FetchFailed(url, undefined, null, 1));
    }
    return Promise.resolve({ url, body, cached: false, attempts: 1 });
  }
}

const searchUrl = (q: string): string =>
  `https://r.test/s?q=${encodeURIComponent(q)}`;

/**
 * A retailer whose search answers `results[query]` (every other query with
 * no results), and whose product pages are `pages[url]`.
 */
function retailer(
  querySupport: QuerySupport,
  results: Readonly<Record<string, readonly ParsedCandidate[]>>,
  pages: Readonly<Record<string, ParsedProduct>>,
  extra: Readonly<Record<string, string>> = {},
  maxProbes = 3,
): { adapter: RetailerAdapter; fetcher: Pages } {
  const byUrl: Record<string, string> = { ...extra };
  for (const url of Object.keys(pages)) byUrl[url] = `page:${url}`;
  const adapter: RetailerAdapter = {
    slug: "fake",
    querySupport,
    pacing: { pagesAtOnce: 3 },
    fetchProfile: { country: null, timeoutMs: null },
    maxProbes,
    productIndex: null,
    hosts: ["r.test"],
    buildSearchUrl: searchUrl,
    parseSearchResults: (html) => [
      ...(results[html.replace(/^search:/, "")] ?? []),
    ],
    parseProductPage: (html) => pages[html.replace(/^page:/, "")] ?? null,
  };
  // Every search is answered: a query not in `results` finds nothing.
  const fetcher = new Pages(
    new Proxy(byUrl, {
      get: (target, key: string) => {
        if (key in target) return target[key];
        const q = /^https:\/\/r\.test\/s\?q=(.*)$/.exec(key)?.[1];
        return q === undefined ? undefined : `search:${decodeURIComponent(q)}`;
      },
    }),
  );
  return { adapter, fetcher };
}

/** Best Buy's shape: the barcode is asked first; no brand rule. */
const BARCODE_FIRST: QuerySupport = {
  maxNumericQueryDigits: null,
  barcodeIsSearchable: true,
  partNumberNeedsBrand: false,
};
/** B&H's shape: the barcode first, and a part number names a product only with its brand. */
const NEEDS_BRAND: QuerySupport = {
  maxNumericQueryDigits: null,
  barcodeIsSearchable: true,
  partNumberNeedsBrand: true,
};

const OPTIONS = { ...DEFAULT_OPTIONS, clientCatalogueUrlTemplate: null };

describe("the job carries the client's part number and brand", () => {
  const withItems = (items: unknown[]): unknown => ({
    retailerSlug: "bestbuy",
    items,
    capture: null,
  });

  it("reads both from the gateway's job, trimmed of nothing and typed", () => {
    const job = parseJob(
      withItems([
        {
          barcode: KENSINGTON_UPC,
          clientSku: "540062",
          productName: "Kensington Pro Fit Mouse",
          partNumber: "K72337US",
          brand: "Kensington",
        },
      ]),
      "run-1",
    );
    expect(job.items[0]?.partNumber).toBe("K72337US");
    expect(job.items[0]?.brand).toBe("Kensington");
  });

  it("reads them ABSENT or null as not supplied, so an older gateway still runs", () => {
    const job = parseJob(
      withItems([
        { barcode: KENSINGTON_UPC, clientSku: "540062" },
        {
          barcode: KENSINGTON_UPC,
          clientSku: "540063",
          partNumber: null,
          brand: null,
        },
      ]),
      "run-1",
    );
    for (const item of job.items) {
      expect(item.partNumber).toBeNull();
      expect(item.brand).toBeNull();
    }
  });

  it("refuses one that is not a string: two builds disagreeing", () => {
    expect(() =>
      parseJob(
        withItems([
          { barcode: KENSINGTON_UPC, clientSku: "1", partNumber: 72337 },
        ]),
        "run-1",
      ),
    ).toThrow(/non-string 'partNumber'/);
    expect(() =>
      parseJob(
        withItems([{ barcode: KENSINGTON_UPC, clientSku: "1", brand: {} }]),
        "run-1",
      ),
    ).toThrow(/non-string 'brand'/);
  });

  it("refuses one past the gateway's own limit: 128 for a part number, 160 for a brand", () => {
    const item = (over: Record<string, unknown>) =>
      withItems([{ barcode: KENSINGTON_UPC, clientSku: "1", ...over }]);
    expect(() =>
      parseJob(item({ partNumber: "P".repeat(MAX_PART_NUMBER_LENGTH) }), "r"),
    ).not.toThrow();
    expect(() =>
      parseJob(
        item({ partNumber: "P".repeat(MAX_PART_NUMBER_LENGTH + 1) }),
        "r",
      ),
    ).toThrow(/'partNumber' longer than 128/);
    expect(() =>
      parseJob(item({ brand: "B".repeat(MAX_BRAND_LENGTH) }), "r"),
    ).not.toThrow();
    expect(() =>
      parseJob(item({ brand: "B".repeat(MAX_BRAND_LENGTH + 1) }), "r"),
    ).toThrow(/'brand' longer than 160/);
  });

  it("🔴 hands both to the run: the queue's mapping is where productName was once lost", async () => {
    let seen: readonly ResolveRequest[] = [];
    const job: ResolutionJob = {
      runId: "run-1",
      retailerSlug: "bestbuy",
      itemsTotal: 2,
      items: [
        {
          barcode: KENSINGTON_UPC,
          clientSku: "540062",
          productName: null,
          partNumber: "K72337US",
          brand: "Kensington",
          capture: false,
        },
        {
          barcode: ALLSOP_UPC,
          clientSku: "1",
          productName: null,
          partNumber: null,
          brand: null,
          capture: false,
        },
      ],
      capture: CAPTURE_DISABLED,
      pagesAtOnce: null,
      stopTakingItemsAfterSec: null,
      legId: null,
    };
    await runDispatchedJob({
      dispatch: {
        resolutionRunId: "run-1",
        tenantId: "t",
        organizationId: "o",
        watchlistId: "w",
        retailerSlug: "bestbuy",
        itemsTotal: 2,
      },
      client: { fetchJob: () => Promise.resolve(job) } as never,
      reporter: {
        load: () => Promise.resolve(),
        acknowledgedCount: 0,
        isRunGone: false,
        reportCompleted: () => Promise.resolve(),
        reportError: () => Promise.resolve(),
        flush: () => Promise.resolve(),
      } as never,
      adapterFor: () => costcoAdapter,
      fetcher: {
        fetch: () => Promise.reject(new Error("not exercised")),
        liveRequestCount: 0,
        pagesDelivered: 0,
      },
      runList: (items) => {
        seen = items;
        return Promise.resolve([]);
      },
      baseOptions: { ...RUN_DEFAULTS, runDir: tmpdir() },
      log: () => {},
    });
    expect(seen.map((i) => [i.partNumber, i.brand])).toEqual([
      ["K72337US", "Kensington"],
      [null, null],
    ]);
  });

  it("reads both from a job file, and refuses a wrong type there too", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "resolution-pn-"));
    try {
      const file = path.join(dir, "job.json");
      await writeFile(
        file,
        JSON.stringify({
          retailerSlug: "bestbuy",
          items: [
            {
              barcode: KENSINGTON_UPC,
              clientSku: "540062",
              partNumber: "K72337US",
              brand: "Kensington",
            },
            { barcode: ALLSOP_UPC, clientSku: "1" },
          ],
        }),
        "utf8",
      );
      const envelope = await readJobEnvelope(file);
      expect(envelope.items[0]?.partNumber).toBe("K72337US");
      expect(envelope.items[0]?.brand).toBe("Kensington");
      // Absent stays absent: the request is what an older file always made.
      expect(envelope.items[1]).toEqual({
        barcode: ALLSOP_UPC,
        clientSku: "1",
      });

      await writeFile(
        file,
        JSON.stringify({
          retailerSlug: "bestbuy",
          items: [{ barcode: ALLSOP_UPC, clientSku: "1", brand: 7 }],
        }),
        "utf8",
      );
      await expect(readJobEnvelope(file)).rejects.toThrow(/non-string 'brand'/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Kensington K72337US: the client's part number is asked first", () => {
  const listing = card({
    itemId: "10117379",
    url: "https://r.test/p/10117379",
    model: "K72337US",
    title: "Kensington Pro Fit Wired Mouse",
    brand: "Kensington",
  });
  const setup = () =>
    retailer(
      BARCODE_FIRST,
      { "Kensington K72337US": [listing], K72337US: [listing] },
      { [listing.url]: product(KENSINGTON_UPC) },
      {
        // What the live run guessed from, and what a run without the client's
        // part number still guesses from.
        [SEARCH_ENGINE(KENSINGTON_UPC)]: serp(
          [
            "Kensington KMW72337 Pro Fit Mouse",
            "Kensington KMW72337 Wired",
            "Kensington KMW72337",
          ],
          "KMW72337 KMW72337",
        ),
      },
    );

  it("🔴 queries K72337US right after the barcode, before any derived form", async () => {
    const { adapter, fetcher } = setup();
    const r = await resolveItem(
      {
        barcode: KENSINGTON_UPC,
        clientSku: "540062",
        partNumber: "K72337US",
        brand: "Kensington",
      },
      adapter,
      fetcher,
      OPTIONS,
    );
    expect(r.queriesTried[0]).toBe(KENSINGTON_UPC);
    expect(r.queriesTried[1]).toBe("Kensington K72337US");
    expect(r.outcome).toBe("verified");
    expect(r.match?.itemId).toBe("10117379");
    // Nothing derived was asked before it — and with a part number in hand,
    // the search engine was never bought to guess one.
    expect(r.queriesTried.join("|")).not.toMatch(/KMW72337|Kensington 72337/);
    expect(fetcher.asked).not.toContain(SEARCH_ENGINE(KENSINGTON_UPC));
  });

  it("carries provenance 'client', outranking the barcode's derived 72337", async () => {
    const { adapter, fetcher } = setup();
    const r = await resolveItem(
      {
        barcode: KENSINGTON_UPC,
        clientSku: "540062",
        partNumber: "K72337US",
        brand: "Kensington",
      },
      adapter,
      fetcher,
      OPTIONS,
    );
    expect(r.identity).toEqual({
      partNumber: "K72337US",
      brand: "Kensington",
      title: null,
      provenance: "client",
      corroboratedBy: [],
    });
  });

  it("still asks the derived forms, after the client's, where the client's finds nothing", async () => {
    const { adapter, fetcher } = retailer(BARCODE_FIRST, {}, {});
    const r = await resolveItem(
      {
        barcode: KENSINGTON_UPC,
        clientSku: "540062",
        partNumber: "K72337US",
        brand: "Kensington",
      },
      adapter,
      fetcher,
      OPTIONS,
    );
    const client = r.queriesTried.indexOf("Kensington K72337US");
    const derived = r.queriesTried.indexOf("Kensington 72337");
    expect(client).toBe(1);
    expect(derived).toBeGreaterThan(client);
  });

  it("CONTROL: without it, the run guesses KMW72337 exactly as the live run did", async () => {
    const { adapter, fetcher } = setup();
    const r = await resolveItem(
      { barcode: KENSINGTON_UPC, clientSku: "540062" },
      adapter,
      fetcher,
      OPTIONS,
    );
    expect(r.queriesTried.slice(0, 2)).toEqual([
      KENSINGTON_UPC,
      "Kensington KMW72337",
    ]);
    // The live run's identity, exactly: Kensington, "72337", barcode-derived.
    expect(r.identity?.provenance).toBe("barcode-derived");
    expect(r.identity?.partNumber).toBe("72337");
    expect(r.identity?.brand).toBe("Kensington");
  });
});

describe("772269: the client's brand overrides a derived 'WIRELESS'", () => {
  // The roadmap's `insights-derived-identity-invents-a-brand`: the identity
  // was read off a title reading `WIRELESS MOUSE M310/PEACOCK BLUE`, so every
  // brand-scoped query searched for a brand that does not exist.
  const titles = [
    "WIRELESS MOUSE M310/PEACOCK BLUE",
    "WIRELESS MOUSE M310 Logitech",
    "M310 Wireless Mouse",
  ];
  const engine = {
    [SEARCH_ENGINE(LOGITECH_M310_UPC)]: serp(titles, "M310 M310"),
  };
  const NO_BARCODE: QuerySupport = {
    ...BARCODE_FIRST,
    barcodeIsSearchable: false,
  };

  it("CONTROL: with no client brand, the derived identity is 'WIRELESS'", async () => {
    const { adapter, fetcher } = retailer(NO_BARCODE, {}, {}, engine);
    const r = await resolveItem(
      { barcode: LOGITECH_M310_UPC, clientSku: "772269" },
      adapter,
      fetcher,
      OPTIONS,
    );
    expect(r.identity?.brand).toBe("WIRELESS");
    expect(r.queriesTried).toContain("WIRELESS M310");
    expect(r.queriesTried).toContain("WIRELESS 06787");
  });

  it("🔴 the client's brand is the item's brand, and no query is scoped to 'WIRELESS'", async () => {
    const { adapter, fetcher } = retailer(NO_BARCODE, {}, {}, engine);
    const r = await resolveItem(
      { barcode: LOGITECH_M310_UPC, clientSku: "772269", brand: "Logitech" },
      adapter,
      fetcher,
      OPTIONS,
    );
    expect(r.identity?.brand).toBe("Logitech");
    expect(r.queriesTried).toContain("Logitech M310");
    // Neither the part number nor the barcode's item reference is asked under
    // the invented brand. (The phrase read off the titles, "WIRELESS MOUSE",
    // is still asked last: it is the titles' words, not a brand.)
    expect(r.queriesTried).not.toContain("WIRELESS M310");
    expect(r.queriesTried).not.toContain("WIRELESS 06787");
    expect(r.queriesTried).toContain("Logitech 06787");
  });

  it("a disagreeing catalogue brand never replaces the client's either", async () => {
    const CATALOGUE = "https://client.test/p/{sku}";
    const { adapter, fetcher } = retailer(
      NO_BARCODE,
      {},
      {},
      {
        "https://client.test/p/772269": `<script type="application/ld+json">${JSON.stringify(
          {
            "@type": "Product",
            sku: "772269",
            mpn: "910-001917",
            brand: { "@type": "Brand", name: "WIRELESS" },
          },
        )}</script>`,
      },
    );
    const r = await resolveItem(
      { barcode: LOGITECH_M310_UPC, clientSku: "772269", brand: "Logitech" },
      adapter,
      fetcher,
      { ...OPTIONS, clientCatalogueUrlTemplate: CATALOGUE },
    );
    expect(r.identity?.brand).toBe("Logitech");
    expect(r.identity?.partNumber).toBe("910-001917");
    expect(r.queriesTried[0]).toBe("Logitech 910-001917");
  });
});

describe("B&H: the client's brand is the brand a part number needs", () => {
  // Allsop's 29538 wrist rest shares its MFR # with C2G cables at B&H. With
  // no brand known, every one of them is a candidate and three probes go on
  // cables; with the client's brand, only the wrist rest is.
  const cable = (n: number): ParsedCandidate =>
    card({
      itemId: `C2G-${n}`,
      url: `https://r.test/p/C2G-${n}`,
      model: "29538",
      title: `C2G DisplayPort Cable ${n}`,
      brand: "C2G",
    });
  const wristRest = card({
    itemId: "WR",
    url: "https://r.test/p/WR",
    model: "29538",
    title: "Allsop Ergoprene Gel Wrist Rest",
    brand: "Allsop",
  });
  const setup = () =>
    retailer(
      NEEDS_BRAND,
      { "29538": [cable(1), cable(2), cable(3), wristRest] },
      {
        [cable(1).url]: product("757120295381"),
        [cable(2).url]: product("757120295382"),
        [cable(3).url]: product("757120295383"),
        [wristRest.url]: product(ALLSOP_UPC),
      },
    );

  it("🔴 finds the wrist rest, probing no cable", async () => {
    const { adapter, fetcher } = setup();
    const r = await resolveItem(
      {
        barcode: ALLSOP_UPC,
        clientSku: "1",
        partNumber: "29538",
        brand: "Allsop",
      },
      adapter,
      fetcher,
      OPTIONS,
    );
    expect(r.outcome).toBe("verified");
    expect(r.match?.itemId).toBe("WR");
    expect(r.probes).toBe(1);
    expect(fetcher.asked.filter((u) => u.includes("C2G"))).toEqual([]);
  });

  it("CONTROL: with the part number and no brand, the probes go on cables", async () => {
    const { adapter, fetcher } = setup();
    const r = await resolveItem(
      { barcode: ALLSOP_UPC, clientSku: "1", partNumber: "29538" },
      adapter,
      fetcher,
      OPTIONS,
    );
    expect(r.outcome).not.toBe("verified");
    expect(fetcher.asked).not.toContain(wristRest.url);
  });
});

describe("Costco: the product index is looked up by the client's brand", () => {
  const AIRPODS = {
    barcode: "195949689604",
    clientSku: "757427",
    productName:
      "Apple AirPods 4 Active Noise Cancelling True Wireless Bluetooth Earbuds - White",
  };

  /** The real Costco corpus; the search engine, never captured, fails. */
  class CostcoPages implements Fetcher {
    private readonly replay = new ReplayFetcher(costcoCorpus());
    readonly liveRequestCount = 0;
    readonly pagesDelivered = 0;
    async fetch(url: string, profile?: FetchProfile): Promise<FetchResult> {
      try {
        return await this.replay.fetch(url, profile);
      } catch (error) {
        if (error instanceof NotInCorpus) {
          throw new FetchFailed(url, undefined, null, 1);
        }
        throw error;
      }
    }
  }

  const spied = (): {
    adapter: RetailerAdapter;
    queries: ProductIndexQuery[];
  } => {
    const index = costcoAdapter.productIndex;
    if (index === null) throw new Error("Costco has no index");
    const queries: ProductIndexQuery[] = [];
    return {
      queries,
      adapter: {
        ...costcoAdapter,
        productIndex: {
          ...index,
          candidates: (entries, query) => {
            queries.push(query);
            return index.candidates(entries, query);
          },
        },
      },
    };
  };

  it("🔴 the index is asked by the client's brand and part number, and the AirPods verify", async () => {
    const { adapter, queries } = spied();
    const r = await resolveItem(
      { ...AIRPODS, partNumber: "MXP93LL/A", brand: "Apple" },
      adapter,
      new CostcoPages(),
      OPTIONS,
    );
    expect(queries).toHaveLength(1);
    expect(queries[0]?.brand).toBe("Apple");
    expect(queries[0]?.partNumbers[0]).toBe("MXP93LL/A");
    expect(r.queriesTried).toContain("index:Apple");
    expect(r.outcome).toBe("verified");
    expect(r.failure).toBeNull();
  });

  it("CONTROL: without them, the identity cannot be fetched and no brand reaches the index", async () => {
    const { adapter, queries } = spied();
    const r = await resolveItem(AIRPODS, adapter, new CostcoPages(), OPTIONS);
    expect(queries[0]?.brand ?? null).toBeNull();
    expect(r.queriesTried).not.toContain("index:Apple");
  });
});
