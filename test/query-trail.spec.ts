import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  DEFAULT_OPTIONS,
  reportedQueries,
  resolveItem,
  type Resolution,
} from "../src/resolve.js";
import { RUN_DEFAULTS, runList } from "../src/run.js";
import {
  MAX_QUERY_ATTEMPTS_REPORTED,
  MAX_QUERY_LENGTH,
} from "../src/wire-limits.js";
import { recordPath, REPLAYS, type ReplayedRow } from "./replay-drivers.js";

/**
 * 🔴 **The evidence panel's query trail says how many candidates each query
 * returned, and the number is true.**
 *
 * Until this change the runtime never sent a trail: the gateway made one up
 * from `queriesTried` with a count of 0 on every entry, and Match Review
 * printed "no results" beside the very query that found the proposed listing.
 *
 * 🔑 **Two answers that must never be confused.** `0` is a results page the
 * retailer served that listed nothing — a fact about the retailer. `null` is
 * a search nothing answered: the fetch failed, or the page was a block or a
 * robot check rather than a results page. It says nothing about the retailer,
 * and printing "no results" for it is the lie this change removes.
 */

const NAME = "MAG X870E TOMAHAWK MAX WF";
const SPELLED_OUT = "MSI MAG X870E TOMAHAWK MAX WIFI";
/** An EAN-13 too long for a UPC-A: it derives no item reference to search. */
const BARCODE = "4006381333931";

const SEARCH_PREFIX = "https://retailer.test/s?q=";
const searchUrl = (q: string): string =>
  `${SEARCH_PREFIX}${encodeURIComponent(q)}`;

const listing = (n: number, host = "retailer.test"): ParsedCandidate => ({
  itemId: `N82E${n}`,
  url: `https://${host}/p/N82E${n}`,
  model: null,
  title: `MSI MAG X870E TOMAHAWK MAX WIFI AM5 ATX Motherboard ${n}`,
  brand: "MSI",
  priceCents: 29999,
  inStock: true,
  isFirstParty: true,
  sellerName: null,
  imageUrl: null,
  partialMatch: false,
});
const listings = (count: number): ParsedCandidate[] =>
  Array.from({ length: count }, (_, i) => listing(i + 1));

/**
 * How each search answers: candidates, `null` for not a results page, a
 * failed fetch, or a parser that throws (the pipeline cannot complete).
 */
type Answer = ParsedCandidate[] | null | "fails" | "throws";

/**
 * A retailer whose every search answers an empty results page unless the
 * test says otherwise. The search page's body is the query itself, so the
 * parser knows which one it is reading. `answers` may be swapped between
 * attempts, which is how a retry is made to answer differently.
 */
const retailer = (initial: Record<string, Answer>) => {
  let answers = initial;
  const adapter: RetailerAdapter = {
    slug: "fake",
    querySupport: {
      maxNumericQueryDigits: 9,
      barcodeIsSearchable: false,
      partNumberNeedsBrand: false,
    },
    pacing: { pagesAtOnce: 1 },
    fetchProfile: { country: null, timeoutMs: null },
    maxProbes: null,
    productIndex: null,
    hosts: ["retailer.test"],
    buildSearchUrl: searchUrl,
    parseSearchResults: (body) => {
      const answer = answers[body];
      if (answer === "throws") throw new Error(`parser broke on ${body}`);
      return answer === undefined || answer === "fails" ? [] : answer;
    },
    parseProductPage: () => null,
  };
  const fetcher: Fetcher = {
    liveRequestCount: 0,
    pagesDelivered: 0,
    fetch(url: string): Promise<FetchResult> {
      if (url.startsWith(SEARCH_PREFIX)) {
        const query = decodeURIComponent(url.slice(SEARCH_PREFIX.length));
        if (answers[query] === "fails")
          return Promise.reject(new FetchFailed(url, undefined, 502, 3));
        return Promise.resolve({
          url,
          body: query,
          cached: false,
          attempts: 1,
        });
      }
      return Promise.reject(new FetchFailed(url, undefined, 502, 3));
    },
  };
  return {
    adapter,
    fetcher,
    answer: (next: Record<string, Answer>) => {
      answers = next;
    },
  };
};

const request = {
  barcode: BARCODE,
  clientSku: "SKU-1",
  brand: "MSI",
  partNumber: null,
  productName: NAME,
};

const resolve = (r: ReturnType<typeof retailer>) =>
  resolveItem(request, r.adapter, r.fetcher, DEFAULT_OPTIONS);

/** The trail and `queriesTried` describe the same attempts, in one order. */
const expectInStep = (resolution: Resolution): void => {
  expect(resolution.queryTrail.map((entry) => entry.query)).toEqual(
    resolution.queriesTried,
  );
};

describe("🔴 each query carries the number of listings its results page returned", () => {
  it("a two-query resolution sends [{q1, 0}, {q2, 7}]", async () => {
    const r = retailer({ [NAME]: [], [SPELLED_OUT]: listings(7) });
    const result = await resolve(r);
    expect(result.queryTrail).toEqual([
      { query: NAME, candidateCount: 0 },
      { query: SPELLED_OUT, candidateCount: 7 },
    ]);
    expectInStep(result);
  });

  it("the spelled-out fallback, when asked, appears after the name with its own count", async () => {
    const r = retailer({ [NAME]: [], [SPELLED_OUT]: listings(3) });
    const result = await resolve(r);
    expect(result.queryTrail).toEqual([
      { query: NAME, candidateCount: 0 },
      { query: SPELLED_OUT, candidateCount: 3 },
    ]);
  });

  it("the spelled-out fallback, when NOT asked, has no entry", async () => {
    const r = retailer({ [NAME]: listings(2) });
    const result = await resolve(r);
    expect(result.queryTrail).toEqual([{ query: NAME, candidateCount: 2 }]);
  });

  it("🔑 counts what the retailer answered: a listing off its own hosts is counted, though never admitted", async () => {
    // The count is the page's, not the pool's. The panel asks what each
    // query RETURNED; which of those the runtime then trusted is a later step.
    const r = retailer({
      [NAME]: [listing(1), listing(2), listing(3, "elsewhere.test")],
    });
    const result = await resolve(r);
    expect(result.queryTrail).toEqual([{ query: NAME, candidateCount: 3 }]);
    expect(result.candidatesSeen).toBe(3);
  });
});

describe("🔴 a search nothing answered is null, never 0", () => {
  it("a failed fetch", async () => {
    const r = retailer({ [NAME]: "fails" });
    const result = await resolve(r);
    expect(result.queryTrail).toEqual([{ query: NAME, candidateCount: null }]);
    expectInStep(result);
  });

  it("a page that was not a results page", async () => {
    const r = retailer({ [NAME]: null });
    const result = await resolve(r);
    expect(result.queryTrail).toEqual([{ query: NAME, candidateCount: null }]);
    expectInStep(result);
  });
});

describe("🔴 held to the gateway's limits, the trail and queriesTried alike", () => {
  it("the limits are the gateway's own", () => {
    // `aeo-backend` `insights-run-event.dto.ts`: `MAX_QUERY_TRAIL_PER_RESOLUTION`
    // bounds both lists, and `ResolutionQueryAttemptDto.query` is `@MaxLength(500)`.
    expect(MAX_QUERY_ATTEMPTS_REPORTED).toBe(50);
    expect(MAX_QUERY_LENGTH).toBe(500);
  });

  it("a query past 500 characters is recorded at 500 on both lists, its count kept", async () => {
    const long = `MSI ${"y".repeat(10_000)}`;
    const r = retailer({ [long]: listings(4) });
    const result = await resolveItem(
      { ...request, productName: long },
      r.adapter,
      r.fetcher,
      DEFAULT_OPTIONS,
    );
    expect(result.queryTrail).toHaveLength(1);
    expect(result.queryTrail[0]?.query).toHaveLength(MAX_QUERY_LENGTH);
    expect(result.queryTrail[0]?.candidateCount).toBe(4);
    expectInStep(result);
  });

  it("at most 50 entries on each list, the first 50 in order, each with its own count", () => {
    const tried = Array.from({ length: 60 }, (_, i) => `q${i}`);
    const answeredWith = new Map(tried.map((q, i) => [q, i] as const));
    answeredWith.delete("q7");
    const reported = reportedQueries(tried, answeredWith);
    expect(reported.queriesTried).toEqual(tried.slice(0, 50));
    expect(reported.queryTrail).toHaveLength(50);
    expect(reported.queryTrail.map((e) => e.query)).toEqual(
      reported.queriesTried,
    );
    expect(reported.queryTrail[6]).toEqual({ query: "q6", candidateCount: 6 });
    expect(reported.queryTrail[7]).toEqual({
      query: "q7",
      candidateCount: null,
    });
  });
});

describe("🔴 every path that files a resolution sends a trail in step with queriesTried", () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(path.join(os.tmpdir(), "query-trail-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const run = (r: ReturnType<typeof retailer>, onFirstPassDone?: () => void) =>
    runList([request], r.adapter, r.fetcher, {
      ...RUN_DEFAULTS,
      ...DEFAULT_OPTIONS,
      concurrency: 1,
      runDir,
      onHeldBack: onFirstPassDone,
    });

  it("a pipeline that threw sends an empty trail beside its empty queriesTried", async () => {
    const r = retailer({ [NAME]: "throws" });
    const [result] = await run(r);
    expect(result?.failure).toMatch(/parser broke/);
    expect(result?.queriesTried).toEqual([]);
    expect(result?.queryTrail).toEqual([]);
  });

  it("an item retried after the run carries the trail of the attempt it files", async () => {
    // The first attempt's only search is not answered, so the miss is a
    // failure and the item is held back; the retry is answered.
    const r = retailer({ [NAME]: "fails" });
    const [result] = await run(r, () => r.answer({ [NAME]: listings(5) }));
    expect(result?.queryTrail).toEqual([{ query: NAME, candidateCount: 5 }]);
    if (result !== undefined) expectInStep(result);
  });

  it.each(REPLAYS)(
    "every row of the %s replay record: same queries, same order, a count or null",
    (name) => {
      const rows = JSON.parse(
        readFileSync(recordPath(name), "utf8"),
      ) as ReplayedRow[];
      const resolved = rows.flatMap((row) =>
        row.kind === "resolved" ? [row.resolution] : [],
      );
      expect(resolved.length).toBeGreaterThan(0);
      for (const resolution of resolved) {
        expectInStep(resolution);
        for (const { candidateCount } of resolution.queryTrail) {
          if (candidateCount !== null) {
            expect(Number.isInteger(candidateCount)).toBe(true);
            expect(candidateCount).toBeGreaterThanOrEqual(0);
          }
        }
        // 🔑 The counts are the same answers `candidatesSeen` sums, query by
        // query — so on real pages the trail adds up to what the run saw.
        const summed = resolution.queryTrail.reduce(
          (sum, e) => sum + (e.candidateCount ?? 0),
          0,
        );
        expect(summed, resolution.clientSku).toBe(resolution.candidatesSeen);
      }
    },
  );
});
