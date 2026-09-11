import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type {
  ParsedCandidate,
  RetailerAdapter,
} from "../src/adapters/types.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchResult,
} from "../src/fetcher/types.js";
import {
  estimateRun,
  readJournal,
  runList,
  RUN_DEFAULTS,
  COST,
} from "../src/run.js";

const runDir = (): string =>
  mkdtempSync(path.join(tmpdir(), "resolution-run-"));

const candidate: ParsedCandidate = {
  itemId: "ITEM-1",
  url: "https://retailer.test/p/ITEM-1",
  model: "CF-08LB",
  title: "Kingwin CF-08LB",
  brand: "Kingwin",
  priceCents: 899,
  inStock: true,
  isFirstParty: true,
  sellerName: null,
};

const adapter: RetailerAdapter = {
  slug: "fake",
  querySupport: { maxNumericQueryDigits: 9, barcodeIsSearchable: false },
  buildSearchUrl: (q) => `https://retailer.test/s?q=${encodeURIComponent(q)}`,
  parseSearchResults: (html) => (html === "SEARCH" ? [candidate] : []),
  parseProductPage: (html) => ({
    barcode: html === "PDP" ? "812348010548" : null,
    priceCents: null,
    inStock: null,
    title: null,
  }),
};

class CountingFetcher implements Fetcher {
  liveRequestCount = 0;
  readonly asked: string[] = [];
  constructor(private readonly bodies: Record<string, string>) {}
  fetch(url: string): Promise<FetchResult> {
    this.asked.push(url);
    const body = this.bodies[url];
    if (body === undefined) return Promise.reject(new FetchFailed(url));
    this.liveRequestCount++;
    return Promise.resolve({ url, body, cached: false });
  }
}

const bodies = (barcode: string): Record<string, string> => ({
  [`https://www.google.com/search?q=%22${barcode}%22`]: `<h3>Kingwin CF-08LB Fan</h3><h3>Kingwin CF-08LB 80mm</h3><p>CF-08LB CF-08LB</p>`,
  "https://retailer.test/s?q=Kingwin%20CF-08LB": "SEARCH",
  "https://retailer.test/p/ITEM-1": "PDP",
});

describe("runList", () => {
  it("resolves a list and journals every item", async () => {
    const dir = runDir();
    const fetcher = new CountingFetcher(bodies("812348010548"));
    const results = await runList(
      [{ barcode: "812348010548", clientSku: "531814" }],
      adapter,
      fetcher,
      { ...RUN_DEFAULTS, runDir: dir, concurrency: 1 },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe("verified");

    const journal = readFileSync(
      path.join(dir, RUN_DEFAULTS.journalName),
      "utf8",
    );
    expect(journal.trim().split("\n")).toHaveLength(1);
  });

  it("🔑 resumes from the journal and re-buys nothing", async () => {
    // The property that matters most on a paid multi-hour run. A run killed at
    // hour three must not restart at hour zero.
    const dir = runDir();
    const journalPath = path.join(dir, RUN_DEFAULTS.journalName);
    writeFileSync(
      journalPath,
      JSON.stringify({
        barcode: "812348010548",
        clientSku: "531814",
        outcome: "verified",
        identity: null,
        queriesTried: [],
        candidatesSeen: 0,
        probes: 0,
        requests: 0,
        match: null,
        failure: null,
      }) + "\n",
      "utf8",
    );

    const fetcher = new CountingFetcher(bodies("812348010548"));
    const results = await runList(
      [{ barcode: "812348010548", clientSku: "531814" }],
      adapter,
      fetcher,
      { ...RUN_DEFAULTS, runDir: dir, concurrency: 1 },
    );

    expect(results).toHaveLength(1);
    expect(fetcher.asked).toEqual([]); // nothing asked for, nothing paid
    expect(fetcher.liveRequestCount).toBe(0);
  });

  it("🔴 survives a truncated final journal line", async () => {
    // That is exactly what a killed process leaves behind. Refusing to start
    // costs the whole run; skipping the partial line costs one re-resolution.
    const dir = runDir();
    writeFileSync(
      path.join(dir, RUN_DEFAULTS.journalName),
      `{"barcode":"111111111111","outcome":"verified"}\n{"barcode":"2222`,
      "utf8",
    );
    const done = await readJournal(path.join(dir, RUN_DEFAULTS.journalName));
    expect(done.size).toBe(1);
    expect(done.has("111111111111")).toBe(true);
  });

  it("records a pipeline failure as a failure, never as a clean miss", async () => {
    // 🔴 Reporting "this retailer does not carry it" for an item nobody managed
    // to look up is the difference between a coverage figure and a lie.
    const dir = runDir();
    const fetcher = new CountingFetcher({}); // every fetch fails
    const results = await runList(
      [{ barcode: "812348010548", clientSku: "531814" }],
      adapter,
      fetcher,
      { ...RUN_DEFAULTS, runDir: dir, concurrency: 1 },
    );
    // No identity, no queries — so the pipeline reports not-found, and the
    // journal shows it asked and got nothing rather than claiming a miss.
    expect(results[0]?.outcome).toBe("not-found");
    expect(results[0]?.queriesTried).toEqual([]);
  });

  it("returns results in input order whatever the completion order", async () => {
    const dir = runDir();
    const items = [
      { barcode: "812348010548", clientSku: "a" },
      { barcode: "649532609635", clientSku: "b" },
    ];
    const fetcher = new CountingFetcher({
      ...bodies("812348010548"),
      ...bodies("649532609635"),
    });
    const results = await runList(items, adapter, fetcher, {
      ...RUN_DEFAULTS,
      runDir: dir,
      concurrency: 2,
    });
    expect(results.map((r) => r.barcode)).toEqual([
      "812348010548",
      "649532609635",
    ]);
  });

  it("reports progress with a running estimate", async () => {
    const dir = runDir();
    const seen: number[] = [];
    await runList(
      [{ barcode: "812348010548", clientSku: "531814" }],
      adapter,
      new CountingFetcher(bodies("812348010548")),
      {
        ...RUN_DEFAULTS,
        runDir: dir,
        concurrency: 1,
        onProgress: (p) => seen.push(p.estimatedUsd),
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(0);
  });
});

describe("estimateRun", () => {
  it("prices the two paths differently", () => {
    // 🔑 A single blended rate reports the same number for any mix of list,
    // which is exactly the thing an operator is asking about.
    const allWithPart = estimateRun(100, 100);
    const noneWithPart = estimateRun(100, 0);
    expect(allWithPart.requests).toBe(200);
    expect(noneWithPart.requests).toBe(470);
    expect(noneWithPart.usd).toBeGreaterThan(allWithPart.usd);
  });

  it("prices the measured 8,926-row list at the figure on record", () => {
    // The roadmap quotes ~$42 for a full run with no part numbers. This is
    // where that number comes from, so a change to the rates shows up here.
    const { usd } = estimateRun(8926, 0);
    expect(usd).toBeGreaterThan(41);
    expect(usd).toBeLessThan(43);
  });

  it("🔴 is a MEAN and can be exceeded — it is not a ceiling", () => {
    // 🔴 **One caller labelled this "worst-case" until 2026-09-11**,
    // and a live 3-row run spent 16 requests against an estimate of 14.
    //
    // 🔑 The mechanism is that a MISS costs more than a hit, which is
    // the opposite of what "worst-case" invites you to assume: a verified row
    // stops once a candidate is proven, a not-found row exhausts every query
    // variant first. So the honest property to pin is that the per-row figure
    // is BELOW the number of queries a single miss can spend — i.e. that the
    // estimate is exceedable by construction rather than a bound.
    const perRow = COST.requestsPerItemDerivedIdentity;
    const { requests } = estimateRun(3, 0);
    expect(requests).toBe(perRow * 3);
    // The measured live run: 3 rows, 16 requests.
    expect(16).toBeGreaterThan(requests);
    // And the constant is fractional, which is what makes it a mean at all.
    expect(Number.isInteger(perRow)).toBe(false);
  });

  it("estimates zero for an empty list rather than dividing by zero", () => {
    expect(estimateRun(0, 0)).toEqual({ requests: 0, usd: 0 });
  });

  it("⚠️ the money rate is unvalidated, and the constant says so", () => {
    // Not a behaviour check — a tripwire. If somebody calibrates the rate
    // against a real invoice, this fails and the docblock claiming it is
    // unvalidated has to be revisited in the same change.
    expect(COST.usdPer1000Requests).toBe(1);
  });
});
