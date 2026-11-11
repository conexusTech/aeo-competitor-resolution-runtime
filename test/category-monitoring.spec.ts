import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { bhAdapter } from "../src/adapters/bh.js";
import { neweggAdapter } from "../src/adapters/newegg.js";
import type {
  CategoryReader,
  CategoryReading,
  ListingReader,
} from "../src/adapters/types.js";
import {
  MAX_CATEGORY_PAGES_PER_JOB,
  MAX_WALK_PAGES,
  type CategoryReport,
} from "../src/category-walk.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchResult,
} from "../src/fetcher/types.js";
import {
  MAX_CATEGORIES_PER_JOB,
  ReadRunClient,
  parseReadJob,
  type ReadCategory,
  type ReadJob,
  type ReportOutcome,
} from "../src/gateway/client.js";
import {
  READ_PACING,
  runReadJob,
  type ListingReading,
  type ReadRunDeps,
  type ReadRunPort,
  type ReadRunResult,
} from "../src/read-run.js";
import { SHUTDOWN, StopSwitch } from "../src/stop-signal.js";
import { neweggBody, rewriteBhCategoryPage } from "./category-bodies.js";
import { FakeClock, settle } from "./fake-clock.js";

/**
 * A monitoring day reads a category whole where the gateway planned it, and
 * every price says which kind of page it came from
 * (`insights-monitor-by-category-where-cheaper`, the runtime half).
 *
 * 🔑 **The rule under test is the fallback.** A watched listing is priced
 * from its card only when its walk is whole and its card shows a price; in
 * every other case it is read from its own page in the same container, the
 * same day — and never twice.
 *
 * The category pages here are SYNTHETIC — a JSON body a test reader parses —
 * because no real walk of more than four pages has been captured; the
 * fetcher, the job, the gateway port and the run are the real ones. One check
 * reads B&H's real Mice & Touchpads page 1 through the B&H reader.
 */

// ── A synthetic competitor ───────────────────────────────────────────────

const HOST = "r.test";
const CAT = (slug: string): string => `https://${HOST}/c/${slug}`;
const PDP = (id: string): string => `https://${HOST}/p/${id}`;

/** The breadcrumb every synthetic product page names. */
const SWITCHES = { id: "c-1", name: "Switches", url: CAT("switches") };

type Card = readonly [itemId: string, priceCents: number | null];

/** Page `n` of a category, as the synthetic reader reads it. */
const catPage = (
  n: number,
  cards: readonly Card[],
  total: number | null = null,
  lastPage: number | null = null,
): string =>
  JSON.stringify({
    page: n,
    products: cards.map(([itemId, priceCents]) => ({
      itemId,
      priceCents,
      inStock: priceCents === null ? null : true,
    })),
    total,
    lastPage,
  });

const CATEGORY_READER: CategoryReader = {
  pageUrl: (url, n) =>
    url.startsWith(`https://${HOST}/c/`) && Number.isInteger(n) && n >= 1
      ? n === 1
        ? url
        : `${url}?page=${n}`
      : null,
  readCategoryPage: (html, n) => {
    if (html === "END") return { kind: "end", detail: "no such page" };
    try {
      const parsed = JSON.parse(html) as {
        page: number;
        products: {
          itemId: string;
          priceCents: number | null;
          inStock: boolean | null;
        }[];
        total: number | null;
        lastPage: number | null;
      };
      if (parsed.page !== n) {
        return { kind: "not-a-category-page", detail: "another page" };
      }
      return {
        kind: "page",
        page: {
          products: parsed.products,
          total: parsed.total,
          lastPage: parsed.lastPage,
        },
      };
    } catch {
      return { kind: "not-a-category-page", detail: "not a category page" };
    }
  },
};

/** A product page body: its id and its price. */
const pdp = (id: string, priceCents: number): string =>
  `PDP|${id}|${priceCents}`;

const reader = (
  categoryReader: CategoryReader | null = CATEGORY_READER,
): ListingReader & CategoryReading => ({
  slug: "fake",
  hosts: [HOST],
  pacing: { pagesAtOnce: 4 },
  fetchProfile: { country: "us", timeoutMs: 1_000 },
  readListingPage: (html) => {
    const [kind, id, price] = html.split("|");
    if (kind !== "PDP" || id === undefined || price === undefined) {
      return { kind: "not-a-product-page", detail: "not a product page" };
    }
    return {
      kind: "page",
      page: {
        pageItemId: id,
        barcode: "812348010548",
        additionalBarcodes: [],
        priceCents: Number(price),
        inStock: true,
        category: SWITCHES,
      },
    };
  },
  categoryReader,
});

// ── A fetcher that answers from a map and counts what is open at once ────

/** A body, a status the vendor relayed, or an empty 200 (a throttle). */
type Answer =
  string | { readonly status: number } | { readonly throttled: true };

const THROTTLED: Answer = { throttled: true };

class MapFetcher implements Fetcher {
  liveRequestCount = 0;
  get pagesDelivered(): number {
    return this.delivered;
  }
  private delivered = 0;
  readonly calls: string[] = [];
  inFlight = 0;
  most = 0;
  private ms = Date.parse("2026-11-12T06:00:00.000Z");

  constructor(
    private readonly answers: ReadonlyMap<string, Answer>,
    /** Hold each fetch open this long, in real ms, so overlaps are real. */
    private readonly holdMs = 0,
  ) {}

  async fetch(url: string): Promise<FetchResult> {
    this.calls.push(url);
    this.inFlight++;
    this.most = Math.max(this.most, this.inFlight);
    try {
      if (this.holdMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.holdMs));
      } else {
        await Promise.resolve();
      }
      this.liveRequestCount++;
      this.ms += 1_000;
      const answer = this.answers.get(url);
      if (
        answer !== undefined &&
        typeof answer !== "string" &&
        "throttled" in answer
      ) {
        throw new FetchFailed(url, new Error("status=200 bytes=0"), 200, 1);
      }
      if (answer === undefined || typeof answer !== "string") {
        const status =
          answer !== undefined && "status" in answer ? answer.status : 403;
        throw new FetchFailed(url, new Error(`status=${status}`), status, 1);
      }
      this.delivered++;
      return {
        url,
        body: answer,
        cached: false,
        attempts: 1,
        fetchedAt: new Date(this.ms),
      };
    } finally {
      this.inFlight--;
    }
  }
}

// ── The gateway's read callback, recorded in order ───────────────────────

interface Event {
  readonly type: "readings" | "categories" | "completed" | "error";
  readonly readings: readonly ListingReading[];
  readonly categories: readonly CategoryReport[];
  readonly message: string | null;
}

class Port implements ReadRunPort {
  readonly events: Event[] = [];
  answerCategories: ReportOutcome = { kind: "applied" };
  constructor(private readonly job: ReadJob) {}
  fetchJob(): Promise<ReadJob> {
    return Promise.resolve(this.job);
  }
  reportReadings(readings: readonly ListingReading[]): Promise<ReportOutcome> {
    this.events.push({
      type: "readings",
      readings: [...readings],
      categories: [],
      message: null,
    });
    return Promise.resolve({ kind: "applied" });
  }
  reportCategories(
    categories: readonly CategoryReport[],
  ): Promise<ReportOutcome> {
    this.events.push({
      type: "categories",
      readings: [],
      categories: [...categories],
      message: null,
    });
    return Promise.resolve(this.answerCategories);
  }
  reportCompleted(): Promise<ReportOutcome> {
    this.events.push({
      type: "completed",
      readings: [],
      categories: [],
      message: null,
    });
    return Promise.resolve({ kind: "applied" });
  }
  reportError(message: string): Promise<ReportOutcome> {
    this.events.push({ type: "error", readings: [], categories: [], message });
    return Promise.resolve({ kind: "applied" });
  }
  get readings(): ListingReading[] {
    return this.events.flatMap((e) => [...e.readings]);
  }
  get categories(): CategoryReport[] {
    return this.events.flatMap((e) => [...e.categories]);
  }
  get types(): string[] {
    return this.events.map((e) => e.type);
  }
}

const READ_RUN_ID = "55555555-5555-4555-8555-555555555555";
const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const watched = (...ids: string[]) =>
  ids.map((itemId, i) => ({
    listingId: uuid(1000 + itemId.charCodeAt(0) * 10 + i),
    itemId,
    url: PDP(itemId),
  }));

const category = (
  over: Partial<ReadCategory> & Pick<ReadCategory, "listings">,
): ReadCategory => ({
  categoryId: uuid(1),
  url: CAT("switches"),
  kind: "walk",
  lastPage: null,
  ...over,
});

const job = (
  categories: readonly ReadCategory[] | undefined,
  listings: readonly { itemId: string; url: string }[] = [],
  pagesAtOnce: number | null = 2,
): ReadJob => ({
  readRunId: READ_RUN_ID,
  retailerSlug: "fake",
  listings,
  pagesAtOnce,
  ...(categories === undefined ? {} : { categories }),
});

async function run(
  theJob: ReadJob,
  answers: ReadonlyMap<string, Answer>,
  over: Partial<ReadRunDeps> & { holdMs?: number } = {},
): Promise<{
  port: Port;
  fetcher: MapFetcher;
  result: ReadRunResult;
  sleeps: number[];
}> {
  const port = new Port(theJob);
  const fetcher = new MapFetcher(answers, over.holdMs ?? 0);
  const sleeps: number[] = [];
  const result = await runReadJob({
    client: port,
    readerFor: () => reader(),
    fetcher,
    log: () => undefined,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...over,
  });
  return { port, fetcher, result, sleeps };
}

/** Every product page in the tests answers with its own id at 5000 cents. */
const productPages = (...ids: string[]): [string, Answer][] =>
  ids.map((id) => [PDP(id), pdp(id, 5000)]);

const byItem = (readings: readonly ListingReading[]) =>
  Object.fromEntries(readings.map((r) => [r.itemId, r]));

// ════════════════════════════════════════════════════════════════════════

describe("a walk prices watched listings from their cards", () => {
  it("🔑 prices each watched listing from its card and buys no product page", async () => {
    const answers = new Map<string, Answer>([
      [
        CAT("switches"),
        catPage(
          1,
          [
            ["A", 1299],
            ["B", 2599],
            ["C", 100],
          ],
          6,
          2,
        ),
      ],
      [
        `${CAT("switches")}?page=2`,
        catPage(
          2,
          [
            ["D", 899],
            ["E", 1],
            ["F", 2],
          ],
          6,
          2,
        ),
      ],
    ]);
    const { port, fetcher, result } = await run(
      job([category({ lastPage: 2, listings: watched("A", "D") })]),
      answers,
    );

    expect(fetcher.calls).toEqual([
      CAT("switches"),
      `${CAT("switches")}?page=2`,
    ]);
    expect(port.readings).toEqual([
      {
        itemId: "A",
        pageItemId: "A",
        readAt: "2026-11-12T06:00:01.000Z",
        pageFound: true,
        barcode: null,
        additionalBarcodes: [],
        priceCents: 1299,
        inStock: true,
        failure: null,
        priceSource: "category_page",
        category: null,
      },
      {
        itemId: "D",
        pageItemId: "D",
        // When ITS page arrived, not when the walk ended.
        readAt: "2026-11-12T06:00:02.000Z",
        pageFound: true,
        barcode: null,
        additionalBarcodes: [],
        priceCents: 899,
        inStock: true,
        failure: null,
        priceSource: "category_page",
        category: null,
      },
    ]);
    const report: CategoryReport = {
      categoryId: uuid(1),
      kind: "walk",
      status: "valid",
      pagesRead: 2,
      productsSeen: 6,
      watchedFound: 2,
      total: 6,
      lastPage: 2,
      error: null,
    };
    expect(port.categories).toEqual([report]);
    expect(result.categories).toEqual([report]);
    // Readings, then the categories, then the end — and nothing after it.
    expect(port.types).toEqual(["readings", "categories", "completed"]);
  });

  it("🔴 reads an unpriced or missing card's listing from its own page, the same day", async () => {
    const answers = new Map<string, Answer>([
      [
        CAT("switches"),
        catPage(
          1,
          [
            ["A", 1299],
            ["B", null],
            ["C", 100],
          ],
          3,
          1,
        ),
      ],
      ...productPages("B", "Z"),
    ]);
    const { port, fetcher } = await run(
      job([category({ listings: watched("A", "B", "Z") })]),
      answers,
    );

    expect([...fetcher.calls].sort()).toEqual(
      [CAT("switches"), PDP("B"), PDP("Z")].sort(),
    );
    const got = byItem(port.readings);
    expect(port.readings).toHaveLength(3);
    expect(got["A"]).toMatchObject({
      priceSource: "category_page",
      priceCents: 1299,
    });
    // 🔴 A card with no price is never a price of 0, and never "no price".
    for (const id of ["B", "Z"]) {
      expect(got[id]).toMatchObject({
        priceSource: "product_page",
        priceCents: 5000,
        pageFound: true,
        barcode: "812348010548",
        category: SWITCHES,
      });
    }
    expect(port.categories[0]).toMatchObject({
      status: "valid",
      watchedFound: 2,
      productsSeen: 3,
    });
  });

  it("CONTROL: the same card twice prices its listing once", async () => {
    // A product shifting pages under a walk appears on two of them.
    const answers = new Map<string, Answer>([
      [
        CAT("switches"),
        catPage(
          1,
          [
            ["A", 1299],
            ["B", 2],
          ],
          3,
          2,
        ),
      ],
      [
        `${CAT("switches")}?page=2`,
        catPage(
          2,
          [
            ["A", 1399],
            ["C", 3],
          ],
          3,
          2,
        ),
      ],
    ]);
    const { port, fetcher } = await run(
      job([category({ listings: watched("A") })]),
      answers,
    );
    expect(port.readings).toHaveLength(1);
    expect(port.readings[0]?.priceCents).toBe(1299);
    expect(fetcher.calls).not.toContain(PDP("A"));
  });
});

describe("a walk that cannot be trusted prices nothing", () => {
  it("🔴 a page that is not a category page mid-walk sends every watched listing to its own page", async () => {
    const answers = new Map<string, Answer>([
      [
        CAT("switches"),
        catPage(
          1,
          [
            ["A", 1299],
            ["B", 2],
          ],
          6,
          3,
        ),
      ],
      [`${CAT("switches")}?page=2`, "<html>Are you a human?</html>"],
      [
        `${CAT("switches")}?page=3`,
        catPage(
          3,
          [
            ["D", 899],
            ["E", 1],
          ],
          6,
          3,
        ),
      ],
      ...productPages("A", "D"),
    ]);
    const { port, fetcher } = await run(
      job([category({ lastPage: 3, listings: watched("A", "D") })]),
      answers,
    );

    // The walk stops at the bad page: page 3 is never bought.
    expect(fetcher.calls).not.toContain(`${CAT("switches")}?page=3`);
    expect(fetcher.calls).toContain(PDP("A"));
    expect(fetcher.calls).toContain(PDP("D"));
    // A's card was seen and priced, and still is not used.
    expect(port.readings.map((r) => [r.itemId, r.priceSource]).sort()).toEqual([
      ["A", "product_page"],
      ["D", "product_page"],
    ]);
    expect(port.categories).toHaveLength(1);
    expect(port.categories[0]).toMatchObject({
      status: "failed",
      pagesRead: 1,
      watchedFound: 1,
      total: 6,
      lastPage: 3,
    });
    expect(port.categories[0]?.error).toMatch(
      /^page 2 .*not a page of the category/,
    );
  });

  it("🔴 a page that could not be had fails the walk, and its listings are read from their own pages", async () => {
    const answers = new Map<string, Answer>([
      [CAT("switches"), catPage(1, [["A", 1299]], 2, 2)],
      [`${CAT("switches")}?page=2`, { status: 503 }],
      ...productPages("A"),
    ]);
    const { port } = await run(
      job([category({ listings: watched("A") })]),
      answers,
    );
    expect(port.readings).toEqual([
      expect.objectContaining({ itemId: "A", priceSource: "product_page" }),
    ]);
    expect(port.categories[0]?.status).toBe("failed");
    expect(port.categories[0]?.error).toMatch(
      /^page 2 could not be read: .*status=503/,
    );
  });

  it("🔴 a walk that saw fewer than 90% of the category's stated products falls back whole", async () => {
    // The category says 10; two pages show 8.
    const answers = new Map<string, Answer>([
      [
        CAT("switches"),
        catPage(
          1,
          [
            ["A", 1],
            ["B", 2],
            ["C", 3],
            ["D", 4],
          ],
          10,
          2,
        ),
      ],
      [
        `${CAT("switches")}?page=2`,
        catPage(
          2,
          [
            ["E", 5],
            ["F", 6],
            ["G", 7],
            ["H", 8],
          ],
          10,
          2,
        ),
      ],
      ...productPages("A", "E"),
    ]);
    const { port } = await run(
      job([category({ listings: watched("A", "E") })]),
      answers,
    );
    expect(port.readings.map((r) => r.priceSource)).toEqual([
      "product_page",
      "product_page",
    ]);
    expect(port.categories[0]).toMatchObject({
      status: "invalid",
      pagesRead: 2,
      productsSeen: 8,
      total: 10,
      error:
        "the walk saw 8 of the 10 products the category states, fewer than 90%",
    });
  });

  it("CONTROL: a walk that saw exactly 90% is whole", async () => {
    const answers = new Map<string, Answer>([
      [
        CAT("switches"),
        catPage(
          1,
          [
            ["A", 1],
            ["B", 2],
            ["C", 3],
            ["D", 4],
            ["E", 5],
          ],
          10,
          2,
        ),
      ],
      [
        `${CAT("switches")}?page=2`,
        catPage(
          2,
          [
            ["F", 6],
            ["G", 7],
            ["H", 8],
            ["I", 9],
          ],
          10,
          2,
        ),
      ],
    ]);
    const { port, fetcher } = await run(
      job([category({ listings: watched("A", "I") })]),
      answers,
    );
    expect(fetcher.calls).toHaveLength(2);
    expect(port.readings.map((r) => r.priceSource)).toEqual([
      "category_page",
      "category_page",
    ]);
    expect(port.categories[0]?.status).toBe("valid");
  });

  it("🔴 a throttled category page is read again at the measured pace, then fails the walk", async () => {
    const answers = new Map<string, Answer>([
      [CAT("switches"), catPage(1, [["A", 1]], 2, 2)],
      [`${CAT("switches")}?page=2`, THROTTLED],
      ...productPages("A"),
    ]);
    const { port, fetcher, sleeps, result } = await run(
      job([category({ listings: watched("A") })]),
      answers,
    );
    // 1 read + 3 re-reads of page 2, waiting 20 s, 40 s, 80 s before them.
    expect(fetcher.calls.filter((u) => u.endsWith("?page=2"))).toHaveLength(4);
    expect(sleeps).toEqual([...READ_PACING.rereadDelaysMs]);
    expect(result.rereads).toBe(3);
    expect(port.categories[0]?.status).toBe("failed");
    expect(port.categories[0]?.error).toMatch(/throttled on all 4 reads/);
    expect(port.readings[0]?.priceSource).toBe("product_page");
  });
});

const BH =
  "https://www.bhphotovideo.com/c/buy/mice-wireless-bluetooth-usb/ci/18369";
const BH_1910635 = "https://www.bhphotovideo.com/c/product/1910635-REG/x.html";
const BH_1431406 = "https://www.bhphotovideo.com/c/product/1431406-REG/x.html";
const bhRaw = (name: string): string =>
  gunzipSync(
    readFileSync(
      fileURLToPath(new URL(`./raw/${name}.html.gz`, import.meta.url)),
    ),
  ).toString("utf8");
const BH_P1 = bhRaw("bh-category-mice-p1");
const BH_P2 = bhRaw("bh-category-mice-p2");

/**
 * B&H's Mice & Touchpads, read through the real B&H reader, watching
 * `1910635` (priced at 11999 on page 1) and `1431406` (its price withheld).
 * At one page at once, so the order of fetches is the order asked.
 */
async function runBh(
  kind: "walk" | "size",
  pages: ReadonlyMap<string, string>,
): Promise<{ port: Port; fetcher: MapFetcher }> {
  const port = new Port({
    readRunId: READ_RUN_ID,
    retailerSlug: "bh",
    listings: [],
    pagesAtOnce: 1,
    categories: [
      {
        categoryId: uuid(7),
        url: BH,
        kind,
        lastPage: null,
        listings: [
          { listingId: uuid(71), itemId: "1910635", url: BH_1910635 },
          { listingId: uuid(72), itemId: "1431406", url: BH_1431406 },
        ],
      },
    ],
  });
  const fetcher = new MapFetcher(pages);
  await runReadJob({
    client: port,
    readerFor: () => bhAdapter,
    fetcher,
    log: () => undefined,
  });
  return { port, fetcher };
}

describe("how far a walk reads", () => {
  it("🔑 a size read buys page 1 only and reports the category's count and last page", async () => {
    const answers = new Map<string, Answer>([
      [
        CAT("switches"),
        catPage(
          1,
          [
            ["A", 1299],
            ["B", 2],
          ],
          140,
          5,
        ),
      ],
      ...productPages("Q"),
    ]);
    const { port, fetcher } = await run(
      job([category({ kind: "size", listings: watched("A", "Q") })]),
      answers,
    );
    expect(fetcher.calls.filter((u) => u.includes("/c/"))).toEqual([
      CAT("switches"),
    ]);
    expect(port.categories).toEqual([
      {
        categoryId: uuid(1),
        kind: "size",
        status: "valid",
        pagesRead: 1,
        productsSeen: 2,
        watchedFound: 1,
        total: 140,
        lastPage: 5,
        error: null,
      },
    ]);
    // 🔴 A size read counts; it prices nothing. A's card was seen and is
    // not used: every watched listing is read from its own page.
    expect(byItem(port.readings)["A"]?.priceSource).toBe("product_page");
    expect(byItem(port.readings)["Q"]?.priceSource).toBe("product_page");
    expect(fetcher.calls).toContain(PDP("A"));
  });

  it("🔑 reads to the last page the retailer states, and never buys the page past it", async () => {
    const answers = new Map<string, Answer>([
      [CAT("switches"), catPage(1, [["A", 1]], 3, 3)],
      [`${CAT("switches")}?page=2`, catPage(2, [["B", 2]], 3, 3)],
      [`${CAT("switches")}?page=3`, catPage(3, [["C", 3]], 3, 3)],
    ]);
    // The job knew 2 pages; the category now has 3.
    const { fetcher, port } = await run(
      job([category({ lastPage: 2, listings: watched("C") })]),
      answers,
    );
    expect(fetcher.calls).toEqual([
      CAT("switches"),
      `${CAT("switches")}?page=2`,
      `${CAT("switches")}?page=3`,
    ]);
    expect(port.readings[0]?.priceSource).toBe("category_page");
  });

  it("reads until the retailer says the end where no page states a last page", async () => {
    const answers = new Map<string, Answer>([
      [CAT("switches"), catPage(1, [["A", 1]])],
      [`${CAT("switches")}?page=2`, catPage(2, [["B", 2]])],
      [`${CAT("switches")}?page=3`, "END"],
    ]);
    const { fetcher, port } = await run(
      job([category({ listings: watched("B") })]),
      answers,
    );
    expect(fetcher.calls).toHaveLength(3);
    expect(port.categories[0]).toMatchObject({
      status: "valid",
      pagesRead: 2,
      productsSeen: 2,
      total: null,
      lastPage: null,
    });
  });

  it(`🔴 never reads past ${MAX_WALK_PAGES} pages`, async () => {
    // A category that never ends and never says how long it is.
    const answers = new Map<string, Answer>(
      Array.from({ length: 70 }, (_, i) => [
        i === 0 ? CAT("switches") : `${CAT("switches")}?page=${i + 1}`,
        catPage(i + 1, [[`P${i}`, 100 + i]]),
      ]),
    );
    const { fetcher } = await run(
      job([category({ listings: watched("P0") })]),
      answers,
    );
    expect(fetcher.calls).toHaveLength(MAX_WALK_PAGES);
  });

  it("🔴 a walk the job says is longer than a walk reads is not started", async () => {
    const answers = new Map<string, Answer>(productPages("A"));
    const { fetcher, port } = await run(
      job([category({ lastPage: MAX_WALK_PAGES + 1, listings: watched("A") })]),
      answers,
    );
    expect(fetcher.calls).toEqual([PDP("A")]);
    expect(port.categories[0]).toMatchObject({
      status: "failed",
      pagesRead: 0,
      error: `a walk of ${MAX_WALK_PAGES + 1} pages is past the ${MAX_WALK_PAGES} one walk reads; not started`,
    });
  });

  it("🔴 a category that states more pages than a walk reads stops after its first page", async () => {
    const answers = new Map<string, Answer>([
      [CAT("switches"), catPage(1, [["A", 1]], 2000, 72)],
      ...productPages("A"),
    ]);
    const { fetcher, port } = await run(
      job([category({ listings: watched("A") })]),
      answers,
    );
    expect(fetcher.calls).toEqual([CAT("switches"), PDP("A")]);
    expect(port.categories[0]).toMatchObject({
      status: "invalid",
      pagesRead: 1,
      lastPage: 72,
    });
    expect(port.readings[0]?.priceSource).toBe("product_page");
  });

  it("🔴 a competitor with no category reads reports every category failed and reads its listings from their pages", async () => {
    const answers = new Map<string, Answer>(productPages("A", "B"));
    const port = new Port(
      job([
        category({ categoryId: uuid(1), listings: watched("A") }),
        category({
          categoryId: uuid(2),
          url: CAT("mice"),
          kind: "size",
          listings: watched("B"),
        }),
      ]),
    );
    const fetcher = new MapFetcher(answers);
    await runReadJob({
      client: port,
      readerFor: () => reader(null),
      fetcher,
      log: () => undefined,
    });
    expect([...fetcher.calls].sort()).toEqual([PDP("A"), PDP("B")]);
    expect(
      port.categories.map((c) => [c.categoryId, c.status, c.pagesRead]),
    ).toEqual([
      [uuid(1), "failed", 0],
      [uuid(2), "failed", 0],
    ]);
    expect(port.categories[0]?.error).toMatch(/no category reads/);
    expect(port.types).toEqual(["readings", "categories", "completed"]);
  });

  it("reads B&H's real category page 1 for its size, and prices nothing from it", async () => {
    const { port, fetcher } = await runBh("size", new Map([[BH, BH_P1]]));
    expect(port.categories).toEqual([
      {
        categoryId: uuid(7),
        kind: "size",
        status: "valid",
        pagesRead: 1,
        productsSeen: 28,
        watchedFound: 2,
        total: 412,
        lastPage: 15,
        error: null,
      },
    ]);
    // Both are read from their own pages (refused, in this double) — the
    // priced card of 1910635 included.
    expect(fetcher.calls).toEqual([BH, BH_1910635, BH_1431406]);
    expect(port.readings.map((r) => [r.itemId, r.priceSource])).toEqual([
      ["1910635", "product_page"],
      ["1431406", "product_page"],
    ]);
    expect(byItem(port.readings)["1431406"]).toMatchObject({
      pageFound: null,
      category: null,
    });
  });

  it("🔴 a B&H page 1 listing no products fails the walk, whatever count it states", async () => {
    // SYNTHETIC: page 1 with its items emptied, still saying 412 products.
    const { port, fetcher } = await runBh(
      "walk",
      new Map([[BH, rewriteBhCategoryPage(BH_P1)]]),
    );
    expect(port.categories[0]).toMatchObject({
      status: "failed",
      pagesRead: 0,
      productsSeen: 0,
    });
    expect(port.categories[0]?.error).toMatch(
      /page 1 of the category lists no products/,
    );
    expect(fetcher.calls).toEqual([BH, BH_1910635, BH_1431406]);
  });

  it("🔴 a B&H walk whose page 2 lists nothing keeps page 1's count, and the 90% rule sends it back", async () => {
    // SYNTHETIC page 2: its items emptied. The walk ends there having seen 28
    // of the 412 the category states.
    const { port } = await runBh(
      "walk",
      new Map([
        [BH, BH_P1],
        [`${BH}/pn/2`, rewriteBhCategoryPage(BH_P2)],
      ]),
    );
    expect(port.categories[0]).toMatchObject({
      status: "invalid",
      pagesRead: 1,
      productsSeen: 28,
      total: 412,
      lastPage: 15,
    });
    expect(port.readings.map((r) => r.priceSource)).toEqual([
      "product_page",
      "product_page",
    ]);
  });

  it("🔴 a Newegg page 1 listing no products fails the walk, whatever count it states", async () => {
    const NE = "https://www.newegg.com/Desktop-Memory/SubCategory/ID-147";
    // SYNTHETIC: a Desktop Memory page 1 with no products and its count.
    const empty = neweggBody(
      {
        Breadcrumbs: [
          { Name: "Memory", StoreId: 17, StoreType: 1 },
          { Name: "Desktop Memory", StoreId: 147, StoreType: 2 },
        ],
        Products: [],
        TotalItemCount: 3564,
      },
      "1/20",
    );
    const port = new Port({
      readRunId: READ_RUN_ID,
      retailerSlug: "newegg",
      listings: [],
      pagesAtOnce: 2,
      categories: [
        {
          categoryId: uuid(8),
          url: NE,
          kind: "walk",
          lastPage: null,
          listings: [
            {
              listingId: uuid(81),
              itemId: "N82E16820236991",
              url: "https://www.newegg.com/p/N82E16820236991",
            },
          ],
        },
      ],
    });
    const fetcher = new MapFetcher(new Map([[NE, empty]]));
    await runReadJob({
      client: port,
      readerFor: () => neweggAdapter,
      fetcher,
      log: () => undefined,
    });
    expect(port.categories[0]).toMatchObject({
      status: "failed",
      pagesRead: 0,
    });
    expect(fetcher.calls).toEqual([
      NE,
      "https://www.newegg.com/p/N82E16820236991",
    ]);
    expect(port.readings[0]?.priceSource).toBe("product_page");
  });

  it("🔴 any reader's end on page 1 fails the walk, never an empty valid category", async () => {
    const answers = new Map<string, Answer>([
      [CAT("switches"), "END"],
      ...productPages("A"),
    ]);
    const { port } = await run(
      job([category({ listings: watched("A") })]),
      answers,
    );
    expect(port.categories[0]).toMatchObject({
      status: "failed",
      pagesRead: 0,
    });
    expect(port.readings[0]?.priceSource).toBe("product_page");
  });
});

describe("a card's price the gateway would refuse", () => {
  it("🔴 reads as no price, so its listing is read from its own page", async () => {
    // The gateway takes a whole number of cents from 1 to 1,000,000,000.
    const answers = new Map<string, Answer>([
      [
        CAT("switches"),
        catPage(
          1,
          [
            ["A", 1_000_000_001],
            ["B", 1_000_000_000],
            ["C", 12.5],
            ["D", -3],
          ],
          4,
          1,
        ),
      ],
      ...productPages("A", "C", "D"),
    ]);
    const { port, fetcher } = await run(
      job([category({ listings: watched("A", "B", "C", "D") })]),
      answers,
    );
    const got = byItem(port.readings);
    // CONTROL: the ceiling itself is a price.
    expect(got["B"]).toMatchObject({
      priceSource: "category_page",
      priceCents: 1_000_000_000,
    });
    for (const id of ["A", "C", "D"]) {
      expect(got[id]).toMatchObject({
        priceSource: "product_page",
        priceCents: 5000,
      });
    }
    expect(fetcher.calls).not.toContain(PDP("B"));
  });
});

describe("the listings a walk leaves", () => {
  it("🔴 are read at once by an idle worker, not after the walk's batch is sent", async () => {
    const answers = new Map<string, Answer>([
      [
        CAT("switches"),
        catPage(
          1,
          [
            ["A", 1299],
            ["B", null],
          ],
          2,
          1,
        ),
      ],
      ...productPages("B", "Z"),
    ]);
    const port = new Port(
      job([category({ listings: watched("A", "B", "Z") })], [], 2),
    );
    // The gateway holds the first batch — the walk's own reading — open.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const record = port.reportReadings.bind(port);
    port.reportReadings = async (readings) => {
      const outcome = await record(readings);
      if (first) {
        first = false;
        await held;
      }
      return outcome;
    };
    const fetcher = new MapFetcher(answers);
    const done = runReadJob({
      client: port,
      readerFor: () => reader(),
      fetcher,
      flushAt: 1,
      log: () => undefined,
    });
    await settle();
    // The other worker, waiting on the walk, has started on what it left.
    expect(fetcher.calls).toContain(PDP("B"));
    release();
    await done;
    expect(port.readings.map((r) => r.itemId).sort()).toEqual(["A", "B", "Z"]);
  });
});

describe("the category pages one job may buy", () => {
  it(`🔴 stop at ${MAX_CATEGORY_PAGES_PER_JOB}, and the walks past them are read from their listings' own pages`, async () => {
    // Eleven walks the job planned at 50 pages each (550), whose categories
    // now state 60 pages each.
    const answers = new Map<string, Answer>();
    const categories: ReadCategory[] = [];
    for (let c = 0; c < 11; c++) {
      const url = CAT(`grown${c}`);
      for (let n = 1; n <= 60; n++) {
        answers.set(
          n === 1 ? url : `${url}?page=${n}`,
          catPage(n, [[`G${c}P${n}`, 100]], 60, 60),
        );
      }
      const itemId = `G${c}P1`;
      answers.set(PDP(itemId), pdp(itemId, 5000));
      categories.push(
        category({
          categoryId: uuid(c + 1),
          url,
          lastPage: 50,
          listings: [{ listingId: uuid(500 + c), itemId, url: PDP(itemId) }],
        }),
      );
    }
    const { fetcher, port } = await run(job(categories, [], 1), answers);
    expect(fetcher.calls.filter((u) => u.includes("/c/"))).toHaveLength(
      MAX_CATEGORY_PAGES_PER_JOB,
    );
    expect(port.categories.slice(0, 10).map((c) => c.status)).toEqual(
      Array.from({ length: 10 }, () => "valid"),
    );
    expect(port.categories[10]).toMatchObject({
      status: "failed",
      pagesRead: 0,
    });
    expect(port.categories[10]?.error).toMatch(/600 category pages/);
    expect(byItem(port.readings)["G10P1"]?.priceSource).toBe("product_page");
  });
});

describe("pages at once, across walks and product reads", () => {
  const busyJob = (
    pagesAtOnce: number | null,
  ): [ReadJob, Map<string, Answer>] => {
    const answers = new Map<string, Answer>();
    const categories: ReadCategory[] = [];
    for (const c of [1, 2, 3]) {
      const url = CAT(`cat${c}`);
      for (let n = 1; n <= 4; n++) {
        answers.set(
          n === 1 ? url : `${url}?page=${n}`,
          catPage(n, [[`C${c}P${n}`, null]], 4, 4),
        );
      }
      // Every card unpriced: every watched listing falls back to its page.
      const listings = [1, 2, 3, 4].map((n) => ({
        listingId: uuid(c * 100 + n),
        itemId: `C${c}P${n}`,
        url: PDP(`C${c}P${n}`),
      }));
      for (const l of listings) answers.set(l.url, pdp(l.itemId, 1));
      categories.push(category({ categoryId: uuid(c), url, listings }));
    }
    const listings = Array.from({ length: 8 }, (_, i) => ({
      itemId: `L${i}`,
      url: PDP(`L${i}`),
    }));
    for (const l of listings) answers.set(l.url, pdp(l.itemId, 1));
    return [job(categories, listings, pagesAtOnce), answers];
  };

  it("🔴 never holds more pages open than the job's figure, however the work divides", async () => {
    for (const limit of [1, 2, 3]) {
      const [theJob, answers] = busyJob(limit);
      const { fetcher, port } = await run(theJob, answers, { holdMs: 2 });
      // 12 category pages, 12 fallbacks, 8 product reads — each bought once.
      expect(fetcher.calls).toHaveLength(32);
      expect(new Set(fetcher.calls).size).toBe(32);
      expect(port.readings).toHaveLength(20);
      expect(fetcher.most).toBe(limit);
    }
  });

  it("🔴 a job asking for 12 at once reads at 4", async () => {
    const [theJob, answers] = busyJob(12);
    const { fetcher } = await run(theJob, answers, { holdMs: 2 });
    expect(fetcher.most).toBe(4);
  });
});

describe("CONTROL: a job with no categories reads exactly as before", () => {
  const LISTINGS = ["A", "B", "C", "D", "E"].map((id) => ({
    itemId: id,
    url: PDP(id),
  }));

  it("🔑 buys the same pages in the same order and sends the same events, absent or empty", async () => {
    const answers = new Map<string, Answer>(
      productPages("A", "B", "C", "D", "E"),
    );
    const absent = await run(job(undefined, LISTINGS, 1), answers);
    const empty = await run(job([], LISTINGS, 1), answers);
    for (const { fetcher, port, result } of [absent, empty]) {
      expect(fetcher.calls).toEqual(LISTINGS.map((l) => l.url));
      // No categories event: only readings, then the end.
      expect(port.types).toEqual(["readings", "completed"]);
      expect(result.categories).toEqual([]);
      expect(port.readings.every((r) => r.priceSource === "product_page")).toBe(
        true,
      );
    }
    expect(empty.port.events).toEqual(absent.port.events);
  });

  it("parses a job with no categories as none", () => {
    const listings = [{ itemId: "A", url: PDP("A") }];
    expect(
      parseReadJob({ retailerSlug: "fake", listings }, READ_RUN_ID).categories,
    ).toEqual([]);
    expect(
      parseReadJob(
        { retailerSlug: "fake", listings, categories: null },
        READ_RUN_ID,
      ).categories,
    ).toEqual([]);
  });
});

describe("the categories event", () => {
  it("🔴 ends the batch in error, not completed, when the gateway refuses it", async () => {
    const answers = new Map<string, Answer>([
      [CAT("switches"), catPage(1, [["A", 1]], 1, 1)],
    ]);
    const port = new Port(job([category({ listings: watched("A") })]));
    port.answerCategories = { kind: "refused", status: 400, detail: "400" };
    await runReadJob({
      client: port,
      readerFor: () => reader(),
      fetcher: new MapFetcher(answers),
      log: () => undefined,
    });
    expect(port.types).toEqual(["readings", "categories", "error"]);
    expect(port.events.at(-1)?.message).toMatch(
      /categories were not accepted by the gateway \(refused: 400\)/,
    );
  });

  it("sends nothing more once the gateway says the run has ended", async () => {
    const answers = new Map<string, Answer>([
      [CAT("switches"), catPage(1, [["A", 1]], 1, 1)],
    ]);
    const port = new Port(job([category({ listings: watched("A") })]));
    port.answerCategories = { kind: "run-gone", detail: "404" };
    const result = await runReadJob({
      client: port,
      readerFor: () => reader(),
      fetcher: new MapFetcher(answers),
      log: () => undefined,
    });
    expect(port.types).toEqual(["readings", "categories"]);
    expect(result.stoppedEarly).toBe(true);
  });

  it("is posted with the counter, after the readings, by the read run's client", async () => {
    const bodies: unknown[] = [];
    const client = new ReadRunClient(
      { baseUrl: "http://gateway.local", user: "ci", password: "secret" },
      READ_RUN_ID,
      {
        fetch: (_url, init) => {
          bodies.push(
            JSON.parse(typeof init?.body === "string" ? init.body : "null"),
          );
          return Promise.resolve(new Response("{}", { status: 200 }));
        },
        sleep: () => Promise.resolve(),
        log: () => undefined,
      },
    );
    const report: CategoryReport = {
      categoryId: uuid(1),
      kind: "walk",
      status: "invalid",
      pagesRead: 2,
      productsSeen: 8,
      watchedFound: 1,
      total: 10,
      lastPage: 2,
      error: "thin",
    };
    expect(await client.reportCategories([report], 4, 3)).toEqual({
      kind: "applied",
    });
    // An empty report is not sent at all.
    expect(await client.reportCategories([], 4, 3)).toEqual({
      kind: "applied",
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toHaveProperty("runtime_version");
    expect(bodies).toEqual([
      {
        runtime_version: (bodies[0] as { runtime_version: unknown })
          .runtime_version,
        type: "categories",
        categories: [report],
        requests_spent: 4,
        pages_delivered: 3,
      },
    ]);
  });
});

describe("a read job's categories, as the gateway serves them", () => {
  const listing = { listingId: uuid(500), itemId: "A", url: PDP("A") };
  const good = {
    categoryId: uuid(1),
    url: CAT("switches"),
    kind: "walk",
    lastPage: 4,
    listings: [listing],
  };
  const parse = (categories: unknown, listings: unknown[] = []) =>
    parseReadJob({ retailerSlug: "fake", listings, categories }, READ_RUN_ID);

  it("CONTROL: reads a well-formed category, and a job of categories alone", () => {
    expect(parse([good]).categories).toEqual([good]);
    expect(
      parse([{ ...good, lastPage: null, kind: "size" }]).categories?.[0],
    ).toMatchObject({
      lastPage: null,
      kind: "size",
    });
  });

  it("🔴 refuses every malformed field before anything is bought", () => {
    const cases: [string, unknown][] = [
      ["not an array", { ...good }],
      ["a category not an object", ["x"]],
      ["a categoryId not a uuid", [{ ...good, categoryId: "1" }]],
      ["no url", [{ ...good, url: undefined }]],
      ["an http url", [{ ...good, url: "http://r.test/c/x" }]],
      ["a url with a port", [{ ...good, url: "https://r.test:8443/c/x" }]],
      ["another kind", [{ ...good, kind: "crawl" }]],
      ["a zero last page", [{ ...good, lastPage: 0 }]],
      ["a fractional last page", [{ ...good, lastPage: 1.5 }]],
      ["a last page as text", [{ ...good, lastPage: "4" }]],
      ["no listings array", [{ ...good, listings: undefined }]],
      ["a listing not an object", [{ ...good, listings: [7] }]],
      [
        "a listingId not a uuid",
        [{ ...good, listings: [{ ...listing, listingId: "x" }] }],
      ],
      [
        "a listing with no itemId",
        [{ ...good, listings: [{ ...listing, itemId: "" }] }],
      ],
      // Contract point 8: the fallback read needs the page.
      [
        "a listing with no url",
        [
          {
            ...good,
            listings: [{ listingId: listing.listingId, itemId: "A" }],
          },
        ],
      ],
      [
        "a listing with an http url",
        [{ ...good, listings: [{ ...listing, url: "http://r.test/p/A" }] }],
      ],
    ];
    for (const [name, categories] of cases) {
      expect(() => parse(categories), name).toThrow();
    }
  });

  it(`🔴 refuses more than ${MAX_CATEGORIES_PER_JOB} categories`, () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...good,
        categoryId: uuid(i + 1),
        url: CAT(`c${i}`),
        kind: "size",
        listings: [],
      }));
    expect(parse(many(MAX_CATEGORIES_PER_JOB)).categories).toHaveLength(
      MAX_CATEGORIES_PER_JOB,
    );
    expect(() => parse(many(MAX_CATEGORIES_PER_JOB + 1))).toThrow(
      /more than the 200/,
    );
  });

  it("🔴 refuses a listing read twice in one job, and a category asked for twice", () => {
    const second = { ...good, categoryId: uuid(2), url: CAT("mice") };
    // The same listing in two categories.
    expect(() => parse([good, second])).toThrow(/at most once per job/);
    // A category listing that is also a product read.
    expect(() => parse([good], [{ itemId: "A", url: PDP("A-other") }])).toThrow(
      /at most once per job/,
    );
    expect(() => parse([good], [{ itemId: "Q", url: PDP("A") }])).toThrow(
      /at most once per job/,
    );
    // The same category twice, by id or by address.
    const sized = { ...good, kind: "size", listings: [] };
    expect(() => parse([good, { ...sized, url: CAT("mice") }])).toThrow(
      /names a category twice/,
    );
    expect(() => parse([good, { ...sized, categoryId: uuid(2) }])).toThrow(
      /names a category twice/,
    );
  });

  it("🔴 refuses one category asked for twice under two spellings of its address", () => {
    const sized = { ...good, categoryId: uuid(2), kind: "size", listings: [] };
    for (const [first, second] of [
      // A trailing slash, and the host's case.
      [CAT("switches"), "https://R.TEST/c/switches/"],
      // The same query in another order; a fragment is no address at all.
      [`${CAT("switches")}?a=1&b=2`, `${CAT("switches")}?b=2&a=1#top`],
    ] as const) {
      expect(() =>
        parse([
          { ...good, url: first },
          { ...sized, url: second },
        ]),
      ).toThrow(/names a category twice/);
    }
    // CONTROL: another path, and a different query, are other categories.
    expect(
      parse([good, { ...sized, url: CAT("Switches") }]).categories,
    ).toHaveLength(2);
    expect(
      parse([
        { ...good, url: `${CAT("switches")}?a=1` },
        { ...sized, url: `${CAT("switches")}?a=2` },
      ]).categories,
    ).toHaveLength(2);
  });

  it("🔴 refuses one category asked for twice as two of its own pages, before buying anything", async () => {
    // B&H's page 2 address names the same category as its page 1.
    const port = new Port({
      readRunId: READ_RUN_ID,
      retailerSlug: "bh",
      listings: [],
      pagesAtOnce: 1,
      categories: [
        {
          categoryId: uuid(1),
          url: BH,
          kind: "walk",
          lastPage: null,
          listings: [
            { listingId: uuid(71), itemId: "1910635", url: BH_1910635 },
          ],
        },
        {
          categoryId: uuid(2),
          url: `${BH}/pn/2`,
          kind: "size",
          lastPage: null,
          listings: [],
        },
      ],
    });
    const fetcher = new MapFetcher(new Map());
    await expect(
      runReadJob({
        client: port,
        readerFor: () => bhAdapter,
        fetcher,
        log: () => undefined,
      }),
    ).rejects.toThrow(/names a category twice/);
    expect(fetcher.calls).toEqual([]);
  });

  it("🔴 refuses a walk with no watched listings — a walk prices, and would price nothing", () => {
    expect(() => parse([{ ...good, listings: [] }])).toThrow(
      /a walk with no listings/,
    );
    // CONTROL: a size read with none is a count, and is read.
    expect(
      parse([{ ...good, kind: "size", listings: [] }]).categories,
    ).toHaveLength(1);
  });

  it(`🔴 refuses a job planning more than ${MAX_CATEGORY_PAGES_PER_JOB} category pages`, () => {
    const walks = (n: number, lastPage: number | null) =>
      Array.from({ length: n }, (_, i) => ({
        ...good,
        categoryId: uuid(i + 1),
        url: CAT(`c${i}`),
        lastPage,
        listings: [
          { listingId: uuid(900 + i), itemId: `W${i}`, url: PDP(`W${i}`) },
        ],
      }));
    // A walk the job knows no last page for may read 60.
    expect(parse(walks(10, null)).categories).toHaveLength(10);
    expect(() => parse(walks(11, null))).toThrow(
      /plans 660 category pages, more than the 600/,
    );
    // A known last page plans that many; a size read plans one.
    expect(parse(walks(40, 15)).categories).toHaveLength(40);
    expect(() => parse(walks(41, 15))).toThrow(/plans 615 category pages/);
  });

  it("CONTROL: still refuses a job with no listings and no categories", () => {
    expect(() => parse([])).toThrow(/carries no listings/);
  });

  it("🔴 refuses a category or a category listing off the competitor's host before buying anything", async () => {
    for (const bad of [
      category({ url: "https://elsewhere.test/c/x", listings: watched("A") }),
      category({
        listings: [{ ...watched("A")[0]!, url: "https://elsewhere.test/p/A" }],
      }),
    ]) {
      const port = new Port(job([bad]));
      const fetcher = new MapFetcher(new Map());
      await expect(
        runReadJob({
          client: port,
          readerFor: () => reader(),
          fetcher,
          log: () => undefined,
        }),
      ).rejects.toThrow(/refused before anything was bought/);
      expect(fetcher.calls).toEqual([]);
      expect(port.types).toEqual(["error"]);
    }
  });
});

describe("a walk told to stop", () => {
  it("🔴 stops taking pages, reports no outcome for it, and files nothing after the end", async () => {
    const clock = new FakeClock();
    const stop = new StopSwitch(clock);
    const pages = new Map<string, Answer>();
    // At two pages at once: one worker sizes a category, then reads the
    // job's listing L; the other walks a ten-page category.
    pages.set(CAT("mice"), catPage(1, [["M", 7]], 1, 1));
    pages.set(PDP("L"), pdp("L", 5000));
    for (let n = 1; n <= 10; n++) {
      pages.set(
        n === 1 ? CAT("switches") : `${CAT("switches")}?page=${n}`,
        catPage(n, [[`S${n}`, n]], 10, 10),
      );
    }
    const inner = new MapFetcher(pages);
    const fetcher: Fetcher = {
      get liveRequestCount() {
        return inner.liveRequestCount;
      },
      get pagesDelivered() {
        return inner.pagesDelivered;
      },
      fetch: (url) => {
        // The stop arrives as the walk asks for its fourth page.
        if (url.endsWith("?page=4")) stop.request();
        return inner.fetch(url);
      },
    };
    const port = new Port(
      job(
        [
          category({
            categoryId: uuid(2),
            url: CAT("mice"),
            kind: "size",
            listings: [],
          }),
          category({ categoryId: uuid(1), listings: watched("S9") }),
        ],
        [{ itemId: "L", url: PDP("L") }],
        2,
      ),
    );
    const result = await runReadJob({
      client: port,
      readerFor: () => reader(),
      fetcher,
      clock,
      stop,
      log: () => undefined,
    });
    await settle();
    // The page in flight finished; no further page was bought.
    expect([...inner.calls].sort()).toEqual(
      [
        CAT("mice"),
        PDP("L"),
        CAT("switches"),
        `${CAT("switches")}?page=2`,
        `${CAT("switches")}?page=3`,
        `${CAT("switches")}?page=4`,
      ].sort(),
    );
    // The finished size read is reported; the stopped walk is not, nor are
    // its listings, which the gateway plans again next time.
    expect(port.categories.map((c) => c.categoryId)).toEqual([uuid(2)]);
    expect(port.readings.map((r) => r.itemId)).toEqual(["L"]);
    expect(port.types).toEqual(["readings", "categories", "error"]);
    expect(port.events.at(-1)?.message).toMatch(/told to stop.*1 of 2 listing/);
    expect(result.stopped).toBe(true);
    expect(clock.now()).toBeLessThan(SHUTDOWN.finishByMs);
  });
});
