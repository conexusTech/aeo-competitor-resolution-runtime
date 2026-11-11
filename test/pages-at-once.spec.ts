import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { amazonAdapter } from "../src/adapters/amazon.js";
import { neweggAdapter } from "../src/adapters/newegg.js";
import {
  MAX_PAGES_AT_ONCE,
  pagesAtOnce,
  type ListingReader,
  type RetailerAdapter,
} from "../src/adapters/types.js";
import type { Fetcher, FetchResult } from "../src/fetcher/types.js";
import {
  GatewayClient,
  parseJob,
  parseReadJob,
  type ReadJob,
  type ReportOutcome,
} from "../src/gateway/client.js";
import type { DispatchPayload } from "../src/queue/task-record.js";
import { runDispatchedJob } from "../src/queue-run.js";
import { runReadJob, type ReadRunPort } from "../src/read-run.js";
import { GatewayReporter } from "../src/reporting/reporter.js";
import { RUN_DEFAULTS, runList } from "../src/run.js";

/**
 * A competitor is never read more pages at once than its own limit.
 *
 * 🔑 **The limit is the registry's, carried by the job; the adapter's is the
 * fallback for a gateway that predates it; and neither may exceed
 * `MAX_PAGES_AT_ONCE`** (the lead, 2026-11-10, after Jody's rule of two to
 * four parallel fetches). Every check below counts fetches actually in flight
 * at once, because a worker count read back from a log line proves only that
 * a number was printed.
 */

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Holds every fetch open for a few milliseconds and records the most that were
 * open together.
 *
 * ⚠️ **The hold is what makes this able to fail.** Without a suspension point
 * each worker's fetch would finish before the next began, and every limit
 * would measure as 1.
 */
class GatedFetcher implements Fetcher {
  liveRequestCount = 0;
  /** Every request this double serves is one page delivered. */
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  inFlight = 0;
  most = 0;
  constructor(private readonly body: string = "<html>nothing</html>") {}
  async fetch(url: string): Promise<FetchResult> {
    this.inFlight++;
    this.most = Math.max(this.most, this.inFlight);
    try {
      await sleep(3);
      this.liveRequestCount++;
      return { url, body: this.body, cached: false, attempts: 1 };
    } finally {
      this.inFlight--;
    }
  }
}

/** A retailer that answers every search with an empty results page. */
function retailer(limit: number): RetailerAdapter {
  return {
    slug: "fake",
    querySupport: {
      maxNumericQueryDigits: null,
      barcodeIsSearchable: false,
      partNumberNeedsBrand: false,
    },
    pacing: { pagesAtOnce: limit },
    fetchProfile: { country: null, timeoutMs: null },
    maxProbes: null,
    productIndex: null,
    hosts: ["r.test"],
    buildSearchUrl: (q) => `https://r.test/s?q=${encodeURIComponent(q)}`,
    parseSearchResults: () => [],
    parseProductPage: () => ({
      barcode: null,
      additionalBarcodes: [],
      priceCents: null,
      inStock: null,
      title: null,
      sellerName: null,
      isFirstParty: null,
      unverifiableReason: null,
      category: null,
    }),
  };
}

function reader(limit: number): ListingReader {
  return {
    slug: "fake",
    hosts: ["r.test"],
    pacing: { pagesAtOnce: limit },
    fetchProfile: { country: null, timeoutMs: null },
    readListingPage: () => ({
      kind: "page",
      page: {
        pageItemId: null,
        barcode: null,
        additionalBarcodes: [],
        priceCents: 100,
        inStock: true,
        category: null,
      },
    }),
  };
}

const items = (n: number): { barcode: string; clientSku: string }[] =>
  Array.from({ length: n }, (_, i) => ({
    barcode: `81234801054${i % 10}${Math.floor(i / 10)}`,
    clientSku: `SKU-${i}`,
  }));

describe("pagesAtOnce", () => {
  it("takes the job's figure over the adapter's", () => {
    expect(pagesAtOnce(4, { pagesAtOnce: 3 })).toBe(4);
    expect(pagesAtOnce(2, { pagesAtOnce: 3 })).toBe(2);
  });

  it("falls back to the adapter's when the job says nothing", () => {
    expect(pagesAtOnce(null, { pagesAtOnce: 3 })).toBe(3);
  });

  it("🔴 never exceeds the ceiling, whoever asks", () => {
    expect(MAX_PAGES_AT_ONCE).toBe(4);
    expect(pagesAtOnce(12, { pagesAtOnce: 3 })).toBe(4);
    expect(pagesAtOnce(null, { pagesAtOnce: 14 })).toBe(4);
  });

  it("never falls below one", () => {
    expect(pagesAtOnce(null, { pagesAtOnce: 0 })).toBe(1);
  });

  it("is 3 for Newegg and Amazon, as before the registry carried it", () => {
    expect(neweggAdapter.pacing.pagesAtOnce).toBe(3);
    expect(amazonAdapter.pacing.pagesAtOnce).toBe(3);
  });
});

describe("the job's pagesAtOnce on the wire", () => {
  const job = (extra: Record<string, unknown>): Record<string, unknown> => ({
    retailerSlug: "newegg",
    items: [{ barcode: "812348010548", clientSku: "S" }],
    ...extra,
  });
  const readJob = (
    extra: Record<string, unknown>,
  ): Record<string, unknown> => ({
    retailerSlug: "newegg",
    listings: [{ itemId: "A", url: "https://www.newegg.com/p/A" }],
    ...extra,
  });

  it("is null when an older gateway sends none", () => {
    expect(parseJob(job({}), "r").pagesAtOnce).toBeNull();
    expect(parseJob(job({ pagesAtOnce: null }), "r").pagesAtOnce).toBeNull();
    expect(parseReadJob(readJob({}), "r").pagesAtOnce).toBeNull();
  });

  it("carries the registry's figure, above the ceiling included", () => {
    // Clamped where it is used, not refused here: 12 is a legitimate registry
    // value this build declines to honour in full.
    expect(parseJob(job({ pagesAtOnce: 12 }), "r").pagesAtOnce).toBe(12);
    expect(parseReadJob(readJob({ pagesAtOnce: 4 }), "r").pagesAtOnce).toBe(4);
  });

  it("refuses a figure that is two builds disagreeing", () => {
    for (const bad of [0, -1, 2.5, "4", true]) {
      expect(() => parseJob(job({ pagesAtOnce: bad }), "r")).toThrow(
        /pagesAtOnce/,
      );
      expect(() => parseReadJob(readJob({ pagesAtOnce: bad }), "r")).toThrow(
        /pagesAtOnce/,
      );
    }
  });
});

describe("a resolution run is never read more pages at once than its limit", () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(path.join(os.tmpdir(), "pages-at-once-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  for (const limit of [3, 4]) {
    it(`holds ${limit} pages in flight for an adapter whose limit is ${limit}`, async () => {
      const fetcher = new GatedFetcher();
      const results = await runList(items(12), retailer(limit), fetcher, {
        ...RUN_DEFAULTS,
        runDir,
      });
      expect(results).toHaveLength(12);
      expect(fetcher.most).toBe(limit);
    });
  }

  /** The gateway, answered in-process: the job on GET, 200 on every event. */
  function gatewayAnswering(jobBody: Record<string, unknown>): GatewayClient {
    const http: typeof globalThis.fetch = (_input, init) =>
      Promise.resolve(
        init?.method === "POST"
          ? new Response("{}", { status: 200 })
          : new Response(JSON.stringify(jobBody), { status: 200 }),
      );
    return new GatewayClient(
      { baseUrl: "https://gw.test", user: "u", password: "p" },
      { runId: "run-1", tenantId: "t", organizationId: "o" },
      { fetch: http, sleep: () => Promise.resolve(), log: () => {} },
    );
  }

  const dispatch: DispatchPayload = {
    resolutionRunId: "run-1",
    tenantId: "t",
    organizationId: "o",
    watchlistId: "w",
    retailerSlug: "fake",
    itemsTotal: null,
  };

  async function dispatched(
    jobPagesAtOnce: number | undefined,
    adapterLimit: number,
  ): Promise<number> {
    // A run directory of its own: a second run in the same one would resume
    // from the first one's journal and fetch nothing.
    const dir = await mkdtemp(path.join(runDir, "run-"));
    const fetcher = new GatedFetcher();
    const client = gatewayAnswering({
      retailerSlug: "fake",
      items: items(12),
      ...(jobPagesAtOnce === undefined ? {} : { pagesAtOnce: jobPagesAtOnce }),
    });
    await runDispatchedJob({
      dispatch,
      client,
      reporter: new GatewayReporter(client, { runDir: dir, log: () => {} }),
      adapterFor: () => retailer(adapterLimit),
      fetcher,
      runList,
      baseOptions: { ...RUN_DEFAULTS, runDir: dir },
      log: () => {},
    });
    return fetcher.most;
  }

  it("🔑 the job's figure wins over the adapter's", async () => {
    expect(await dispatched(4, 3)).toBe(4);
    expect(await dispatched(3, 4)).toBe(3);
  });

  it("CONTROL: with no figure from the job, the adapter's applies", async () => {
    expect(await dispatched(undefined, 3)).toBe(3);
  });

  it("🔴 a job asking for 12 runs at 4", async () => {
    expect(await dispatched(12, 3)).toBe(4);
  });
});

describe("a read run is never read more pages at once than its limit", () => {
  class Port implements ReadRunPort {
    constructor(private readonly job: ReadJob) {}
    fetchJob(): Promise<ReadJob> {
      return Promise.resolve(this.job);
    }
    reportReadings(): Promise<ReportOutcome> {
      return Promise.resolve({ kind: "applied" });
    }
    reportCompleted(): Promise<ReportOutcome> {
      return Promise.resolve({ kind: "applied" });
    }
    reportError(): Promise<ReportOutcome> {
      return Promise.resolve({ kind: "applied" });
    }
  }

  async function read(
    jobPagesAtOnce: number | null,
    readerLimit: number,
  ): Promise<number> {
    const fetcher = new GatedFetcher();
    await runReadJob({
      client: new Port({
        readRunId: "read-1",
        retailerSlug: "fake",
        listings: Array.from({ length: 12 }, (_, i) => ({
          itemId: `L${i}`,
          url: `https://r.test/p/L${i}`,
        })),
        pagesAtOnce: jobPagesAtOnce,
      }),
      readerFor: () => reader(readerLimit),
      fetcher,
      log: () => {},
    });
    return fetcher.most;
  }

  it("holds the reader's own limit when the job says nothing", async () => {
    expect(await read(null, 3)).toBe(3);
    expect(await read(null, 4)).toBe(4);
  });

  it("🔑 the job's figure wins over the reader's", async () => {
    expect(await read(4, 3)).toBe(4);
    expect(await read(3, 4)).toBe(3);
  });

  it("🔴 a job asking for 12 reads at 4", async () => {
    expect(await read(12, 3)).toBe(4);
  });
});

describe("no source line compares a slug", () => {
  it("names no retailer outside its own adapter and the slug map", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const root = path.resolve(import.meta.dirname, "../src");
    const files = (await readdir(root, { recursive: true }))
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => !f.startsWith(`adapters${path.sep}`));
    const offending: string[] = [];
    for (const file of files) {
      const text = await readFile(path.join(root, file), "utf8");
      for (const [n, line] of text.split("\n").entries()) {
        // A comparison against a slug, either way round, or a retailer named
        // as a string literal.
        // ⚠️ A `typeof` test is a type check on the field, not a retailer.
        const compares =
          (!/typeof/.test(line) &&
            /[sS]lug\s*[!=]==?\s*["'`][^"'`]+["'`]/.test(line)) ||
          /["'`][^"'`]+["'`]\s*[!=]==?\s*\w*[sS]lug\b/.test(line);
        const names = /["'`](newegg|amazon|bestbuy|bh|costco)["'`]/.test(line);
        if (compares || names) offending.push(`${file}:${n + 1}`);
      }
    }
    expect(offending).toEqual([]);
  });
});
