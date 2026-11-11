import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type {
  ParsedCandidate,
  ParsedProduct,
  QuerySupport,
  RetailerAdapter,
} from "../src/adapters/types.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchResult,
} from "../src/fetcher/types.js";
import {
  DEFAULT_OPTIONS,
  resolveItem,
  type Resolution,
} from "../src/resolve.js";
import { RUN_DEFAULTS, runList } from "../src/run.js";

/**
 * 🔴 **An unread page is never proposed as "unconfirmed".**
 *
 * A live Best Buy run on 2026-11-10 (image `local-748c11c`, Bright Data
 * delivering 67 of 107 requests) sent two items to review with
 * `competitorBarcode: null`. Kensington's best listing, 10117379 — the one
 * the investigation verified — was never read; Trendnet TPE-S44 was proposed
 * as listing 12607730, a TPE-TG83, never read either. A reviewer is told the
 * barcode disagrees about a page nobody looked at.
 *
 * ── The rule ────────────────────────────────────────────────────────────
 *
 * When nothing verifies and nothing read publishes no barcode:
 *
 * 1. The best-ranked listing whose page was not read gets one more read,
 *    within what is left of the item's probes.
 * 2. Read now, it settles as any read does: an agreeing barcode verifies, an
 *    empty one is `unverifiable`, a disagreeing one is `unconfirmed` on it.
 * 3. **Read, the best listing is the proposal**, as it always was.
 * 4. **Still unread on a first attempt, the item is a failure** — "the best
 *    candidate's page could not be read" — whatever else was read. Retry
 *    first (the lead, 2026-11-11): the run retries it after the rest of the
 *    list, so the best listing gets its second read.
 * 5. **Still unread on that last attempt**, a LOWER listing is proposed
 *    instead only when its own page was read (so its disagreement is a fact)
 *    and it clears, on its own evidence, the same floor the best had to —
 *    part-number evidence and the reporting score. A reviewer is then shown a
 *    barcode that really disagrees, beside the unread best among the
 *    alternatives. With none qualifying it stays a failure, which the
 *    gateway files as an error: never review, never not carried.
 */

const TRENDNET_UPC = "710931505061";

const card = (over: Partial<ParsedCandidate> = {}): ParsedCandidate => ({
  itemId: "A",
  url: "https://r.test/p/A",
  model: null,
  title: "A listing",
  brand: "TRENDnet",
  priceCents: 4999,
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

/** The listing that is the item. */
const BEST = card({
  itemId: "BEST",
  url: "https://r.test/p/BEST",
  model: "TPE-S44",
  title: "TRENDnet 8-Port 10/100 PoE Switch TPE-S44",
});
/** A sibling naming the part number: part-number evidence, ranked lower. */
const SIBLING = card({
  itemId: "SIB",
  url: "https://r.test/p/SIB",
  model: "TPE-S44-EU",
  title: "TRENDnet TPE-S44 Switch, EU plug",
  isFirstParty: false,
  inStock: false,
});
/** The live run's TPE-TG83: the brand, and no part-number evidence at all. */
const TG83 = card({
  itemId: "12607730",
  url: "https://r.test/p/12607730",
  model: "TPE-TG83",
  title: "TRENDnet 8-Port Gigabit PoE+ Switch",
});

/** A page that answers nothing: a failed fetch. */
const FAIL = Symbol("fail");
type Answer = string | typeof FAIL;

/**
 * Serves each url's answers in turn, the last one repeating. A search url
 * with no script finds nothing.
 */
class Scripted implements Fetcher {
  liveRequestCount = 0;
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  readonly asked: string[] = [];
  private readonly served = new Map<string, number>();
  constructor(private readonly script: Readonly<Record<string, Answer[]>>) {}
  fetch(url: string): Promise<FetchResult> {
    this.asked.push(url);
    this.liveRequestCount++;
    const answers = this.script[url];
    if (answers === undefined) {
      const q = /^https:\/\/r\.test\/s\?q=(.*)$/.exec(url)?.[1];
      if (q === undefined) {
        return Promise.reject(new FetchFailed(url, undefined, null, 1));
      }
      return Promise.resolve({
        url,
        body: `search:${decodeURIComponent(q)}`,
        cached: false,
        attempts: 1,
      });
    }
    const n = this.served.get(url) ?? 0;
    this.served.set(url, n + 1);
    const answer = answers[Math.min(n, answers.length - 1)];
    if (answer === FAIL || answer === undefined) {
      return Promise.reject(new FetchFailed(url, undefined, null, 1));
    }
    return Promise.resolve({ url, body: answer, cached: false, attempts: 1 });
  }
  timesAsked(url: string): number {
    return this.asked.filter((u) => u === url).length;
  }
}

const searchUrl = (q: string): string =>
  `https://r.test/s?q=${encodeURIComponent(q)}`;

function retailer(
  querySupport: QuerySupport,
  results: Readonly<Record<string, readonly ParsedCandidate[]>>,
  pages: Readonly<Record<string, ParsedProduct>>,
  maxProbes: number,
): RetailerAdapter {
  return {
    slug: "fake",
    querySupport,
    pacing: { pagesAtOnce: 1 },
    fetchProfile: { country: null, timeoutMs: null },
    maxProbes,
    productIndex: null,
    hosts: ["r.test"],
    buildSearchUrl: searchUrl,
    parseSearchResults: (html) => [
      ...(results[html.replace(/^search:/, "")] ?? []),
    ],
    // A page whose body is `notaproduct` parses to nothing — a robot check.
    parseProductPage: (html) =>
      html === "notaproduct"
        ? null
        : (pages[html.replace(/^page:/, "")] ?? null),
  };
}

const SEARCH: QuerySupport = {
  maxNumericQueryDigits: null,
  barcodeIsSearchable: false,
  partNumberNeedsBrand: false,
};
const BARCODE_FIRST: QuerySupport = { ...SEARCH, barcodeIsSearchable: true };

const OPTIONS = { ...DEFAULT_OPTIONS, clientCatalogueUrlTemplate: null };
const REQUEST = {
  barcode: TRENDNET_UPC,
  clientSku: "842641",
  partNumber: "TPE-S44",
  brand: "TRENDnet",
};
const QUERY = "TRENDnet TPE-S44";
const page = (url: string): string => `page:${url}`;

/** The pages every case below can read, each disagreeing with the client. */
const DISAGREEING = {
  [BEST.url]: product("710931999999"),
  [SIBLING.url]: product("710931888888"),
  [TG83.url]: product("710931603927"),
};

describe("the best candidate's page was read", () => {
  it("CONTROL: its barcode disagrees → unconfirmed on it, as before", async () => {
    const adapter = retailer(SEARCH, { [QUERY]: [BEST, TG83] }, DISAGREEING, 3);
    const fetcher = new Scripted({
      [BEST.url]: [page(BEST.url)],
      [TG83.url]: [page(TG83.url)],
    });
    const r = await resolveItem(REQUEST, adapter, fetcher, OPTIONS);
    expect(r.outcome).toBe("unconfirmed");
    expect(r.match?.itemId).toBe("BEST");
    expect(r.failure).toBeNull();
    expect(fetcher.timesAsked(BEST.url)).toBe(1);
  });
});

describe("the best candidate's page was never read", () => {
  it("🔴 is a failure — never proposed — when no read listing clears the floor", async () => {
    // The live TPE-S44 case: the best unread, the TPE-TG83 read and
    // disagreeing, with no part-number evidence of its own.
    const adapter = retailer(SEARCH, { [QUERY]: [BEST, TG83] }, DISAGREEING, 3);
    const fetcher = new Scripted({
      [BEST.url]: [FAIL],
      [TG83.url]: [page(TG83.url)],
    });
    const r = await resolveItem(REQUEST, adapter, fetcher, OPTIONS);
    expect(r.outcome).toBe("not-found");
    expect(r.match).toBeNull();
    expect(r.alternatives).toEqual([]);
    expect(r.failure).toMatch(/^the best candidate's page could not be read/);
    // Tried once more within the budget, and still nothing.
    expect(fetcher.timesAsked(BEST.url)).toBe(2);
    expect(r.probesUnanswered).toBe(2);
  });

  it("🔴 is a failure for a page that parsed to nothing, as for one that failed", async () => {
    const adapter = retailer(SEARCH, { [QUERY]: [BEST] }, DISAGREEING, 3);
    const fetcher = new Scripted({ [BEST.url]: ["notaproduct"] });
    const r = await resolveItem(REQUEST, adapter, fetcher, OPTIONS);
    expect(r.outcome).toBe("not-found");
    expect(r.match).toBeNull();
    expect(r.failure).toMatch(/^the best candidate's page could not be read/);
  });

  const withSibling = (
    siblingRead: boolean,
  ): {
    adapter: RetailerAdapter;
    fetcher: Scripted;
  } => ({
    adapter: retailer(
      SEARCH,
      { [QUERY]: [BEST, SIBLING, TG83] },
      DISAGREEING,
      3,
    ),
    fetcher: new Scripted({
      [BEST.url]: [FAIL],
      [SIBLING.url]: [siblingRead ? page(SIBLING.url) : FAIL],
      [TG83.url]: [page(TG83.url)],
    }),
  });

  it("🔴 on a first attempt is a failure, even with a read lower listing that qualifies", async () => {
    // Retry first: the best listing deserves its read, and the failure is
    // what sends the item to the run's after-run retry.
    const { adapter, fetcher } = withSibling(true);
    const r = await resolveItem(REQUEST, adapter, fetcher, OPTIONS);
    expect(r.outcome).toBe("not-found");
    expect(r.match).toBeNull();
    expect(r.failure).toMatch(
      /^the best candidate's page could not be read, so the item is left for the run's retry/,
    );
  });

  it("on the last attempt, a lower listing read and naming the part number is proposed", async () => {
    const { adapter, fetcher } = withSibling(true);
    const r = await resolveItem(
      REQUEST,
      adapter,
      fetcher,
      OPTIONS,
      undefined,
      undefined,
      true,
    );
    expect(r.outcome).toBe("unconfirmed");
    // The sibling's page was read: its disagreement is a fact, and it names
    // the part number. The TPE-TG83 was read too, and does not.
    expect(r.match?.itemId).toBe("SIB");
    expect(r.failure).toBeNull();
    // The unread best is still there for a reviewer to choose instead.
    expect(r.alternatives.map((a) => a.itemId)).toContain("BEST");
  });

  it("CONTROL: on the last attempt the same sibling, UNREAD, is not proposed", async () => {
    const { adapter, fetcher } = withSibling(false);
    const r = await resolveItem(
      REQUEST,
      adapter,
      fetcher,
      OPTIONS,
      undefined,
      undefined,
      true,
    );
    expect(r.outcome).toBe("not-found");
    expect(r.failure).toMatch(
      /^the best candidate's page could not be read, and no listing that was read clears the evidence floor/,
    );
  });

  it("CONTROL: on the last attempt, the best read now settles as it always did", async () => {
    const adapter = retailer(
      SEARCH,
      { [QUERY]: [BEST, SIBLING, TG83] },
      DISAGREEING,
      3,
    );
    const fetcher = new Scripted({
      [BEST.url]: [page(BEST.url)],
      [SIBLING.url]: [page(SIBLING.url)],
      [TG83.url]: [page(TG83.url)],
    });
    const r = await resolveItem(
      REQUEST,
      adapter,
      fetcher,
      OPTIONS,
      undefined,
      undefined,
      true,
    );
    expect(r.outcome).toBe("unconfirmed");
    expect(r.match?.itemId).toBe("BEST");
  });

  it("is read once more within the budget, and settles on what it says", async () => {
    const adapter = retailer(
      SEARCH,
      { [QUERY]: [BEST, TG83] },
      { ...DISAGREEING, [BEST.url]: product(TRENDNET_UPC) },
      3,
    );
    const fetcher = new Scripted({
      [BEST.url]: [FAIL, page(BEST.url)],
      [TG83.url]: [page(TG83.url)],
    });
    const r = await resolveItem(REQUEST, adapter, fetcher, OPTIONS);
    expect(r.outcome).toBe("verified");
    expect(r.match?.itemId).toBe("BEST");
    expect(r.match?.retailerBarcode).toBe(TRENDNET_UPC);
    expect(r.probes).toBe(3);
  });

  it("is not read again past the item's probes, and is still a failure", async () => {
    const adapter = retailer(SEARCH, { [QUERY]: [BEST, TG83] }, DISAGREEING, 1);
    const fetcher = new Scripted({ [BEST.url]: [FAIL, page(BEST.url)] });
    const r = await resolveItem(REQUEST, adapter, fetcher, OPTIONS);
    expect(fetcher.timesAsked(BEST.url)).toBe(1);
    expect(r.outcome).toBe("not-found");
    expect(r.failure).toMatch(/^the best candidate's page could not be read/);
  });

  it("🔴 the live Kensington shape: unread at the barcode stage, read on the second try", async () => {
    // The barcode stage opened the listing and the read failed; the part
    // number then found the same listing. Before this, the loop reused the
    // failed read and proposed the listing as unconfirmed, unread.
    const kensington = card({
      itemId: "10117379",
      url: "https://r.test/p/10117379",
      model: "K72337US",
      title: "Kensington Pro Fit Wired Mouse",
      brand: "Kensington",
    });
    const adapter = retailer(
      BARCODE_FIRST,
      {
        "085896723370": [kensington],
        "Kensington K72337US": [kensington],
      },
      { [kensington.url]: product("085896723370") },
      3,
    );
    const fetcher = new Scripted({
      [kensington.url]: [FAIL, page(kensington.url)],
    });
    const r = await resolveItem(
      {
        barcode: "085896723370",
        clientSku: "540062",
        partNumber: "K72337US",
        brand: "Kensington",
      },
      adapter,
      fetcher,
      OPTIONS,
    );
    expect(r.outcome).toBe("verified");
    expect(r.match?.itemId).toBe("10117379");
  });
});

describe("a run retries the failure after the rest of its list", () => {
  const runOnce = async (
    adapter: RetailerAdapter,
    fetcher: Scripted,
  ): Promise<readonly Resolution[]> => {
    const dir = await mkdtemp(path.join(tmpdir(), "resolution-unread-"));
    try {
      return await runList([REQUEST], adapter, fetcher, {
        ...RUN_DEFAULTS,
        ...OPTIONS,
        runDir: dir,
        concurrency: 1,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it("🔴 the best never answering: the retry proposes the read sibling", async () => {
    const adapter = retailer(
      SEARCH,
      { [QUERY]: [BEST, SIBLING, TG83] },
      DISAGREEING,
      3,
    );
    const fetcher = new Scripted({
      [BEST.url]: [FAIL],
      [SIBLING.url]: [page(SIBLING.url)],
      [TG83.url]: [page(TG83.url)],
    });
    const [r] = await runOnce(adapter, fetcher);
    expect(r?.outcome).toBe("unconfirmed");
    expect(r?.match?.itemId).toBe("SIB");
    expect(r?.failure).toBeNull();
    // Once on each pass: the three listings spend the item's three probes,
    // so neither pass has one left to read the best a second time — the
    // after-run retry is the read it gets.
    expect(fetcher.timesAsked(BEST.url)).toBe(2);
  });

  it("the best answering in the retry: the retry settles on it", async () => {
    const adapter = retailer(
      SEARCH,
      { [QUERY]: [BEST, SIBLING, TG83] },
      DISAGREEING,
      3,
    );
    const fetcher = new Scripted({
      [BEST.url]: [FAIL, page(BEST.url)],
      [SIBLING.url]: [page(SIBLING.url)],
      [TG83.url]: [page(TG83.url)],
    });
    const [r] = await runOnce(adapter, fetcher);
    // The first pass's read failed; the retry's answered and disagrees.
    expect(fetcher.timesAsked(BEST.url)).toBe(2);
    expect(r?.outcome).toBe("unconfirmed");
    expect(r?.match?.itemId).toBe("BEST");
  });

  it("🔴 the unread best goes to the after-run retry, and the retry can verify it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "resolution-unread-"));
    try {
      const adapter = retailer(
        SEARCH,
        { [QUERY]: [BEST] },
        { [BEST.url]: product(TRENDNET_UPC) },
        3,
      );
      // Unread on both of the first pass's attempts; read in the retry.
      const fetcher = new Scripted({
        [BEST.url]: [FAIL, FAIL, page(BEST.url)],
      });
      const results = await runList([REQUEST], adapter, fetcher, {
        ...RUN_DEFAULTS,
        ...OPTIONS,
        runDir: dir,
        concurrency: 1,
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.outcome).toBe("verified");
      expect(results[0]?.failure).toBeNull();
      expect(fetcher.timesAsked(BEST.url)).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 🔴 **An `unconfirmed` match carries the barcode its read page published.**
 *
 * `unconfirmed` means the listing's page was READ and its published barcode
 * disagrees, so that barcode is the evidence a reviewer is shown. A local
 * Best Buy run on 2026-11-11 sent three such rows to the gateway with
 * `retailerBarcode: null`, which the gateway's review note describes as a
 * page that could not be read — and the portal's "theirs" column was blank.
 * `unverifiable` is the opposite case: its page published no barcode, so
 * its evidence carries none.
 */
describe("the evidence's retailer barcode", () => {
  it("🔴 an unconfirmed best carries the barcode its page published", async () => {
    const adapter = retailer(SEARCH, { [QUERY]: [BEST, TG83] }, DISAGREEING, 3);
    const fetcher = new Scripted({
      [BEST.url]: [page(BEST.url)],
      [TG83.url]: [page(TG83.url)],
    });
    const r = await resolveItem(REQUEST, adapter, fetcher, OPTIONS);
    expect(r.outcome).toBe("unconfirmed");
    expect(r.match?.itemId).toBe("BEST");
    expect(r.match?.retailerBarcode).toBe("710931999999");
  });

  it("🔴 the primary value, where the page published several", async () => {
    const adapter = retailer(
      SEARCH,
      { [QUERY]: [BEST] },
      {
        [BEST.url]: {
          ...product("710931999999"),
          additionalBarcodes: ["710931777777"],
        },
      },
      3,
    );
    const fetcher = new Scripted({ [BEST.url]: [page(BEST.url)] });
    const r = await resolveItem(REQUEST, adapter, fetcher, OPTIONS);
    expect(r.outcome).toBe("unconfirmed");
    expect(r.match?.retailerBarcode).toBe("710931999999");
  });

  it("🔴 a lower listing proposed on the last attempt carries ITS barcode", async () => {
    const adapter = retailer(
      SEARCH,
      { [QUERY]: [BEST, SIBLING, TG83] },
      DISAGREEING,
      3,
    );
    const fetcher = new Scripted({
      [BEST.url]: [FAIL],
      [SIBLING.url]: [page(SIBLING.url)],
      [TG83.url]: [page(TG83.url)],
    });
    const r = await resolveItem(
      REQUEST,
      adapter,
      fetcher,
      OPTIONS,
      undefined,
      undefined,
      true,
    );
    expect(r.outcome).toBe("unconfirmed");
    expect(r.match?.itemId).toBe("SIB");
    // The sibling's own published value — not the unread best's, not the
    // TPE-TG83's.
    expect(r.match?.retailerBarcode).toBe("710931888888");
  });

  it("CONTROL: an unverifiable carries none, because its page published none", async () => {
    const adapter = retailer(
      SEARCH,
      { [QUERY]: [BEST, TG83] },
      { ...DISAGREEING, [BEST.url]: product(null) },
      3,
    );
    const fetcher = new Scripted({
      [BEST.url]: [page(BEST.url)],
      [TG83.url]: [page(TG83.url)],
    });
    const r = await resolveItem(REQUEST, adapter, fetcher, OPTIONS);
    expect(r.outcome).toBe("unverifiable");
    expect(r.match?.itemId).toBe("BEST");
    expect(r.match?.retailerBarcode).toBeNull();
  });
});
