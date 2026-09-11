import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ParsedCandidate,
  ParsedProduct,
  RetailerAdapter,
} from "../src/adapters/types.js";
import { RequestMeter } from "../src/fetcher/meter.js";
import type { Fetcher, FetchResult } from "../src/fetcher/types.js";
import { DEFAULT_OPTIONS, resolveItem } from "../src/resolve.js";
import type { GatewayClient } from "../src/gateway/client.js";
import { GatewayReporter } from "../src/reporting/reporter.js";
import type { Resolution } from "../src/resolve.js";
import { RUN_DEFAULTS, runList } from "../src/run.js";

/**
 * What a run says it spent, and on what.
 *
 * 🔴 **Every check here fails against the code as it shipped**, because the
 * per-item figure was `liveRequestCount - startedAt` on a fetcher three
 * concurrent workers share. Measured over the committed corpus before the fix:
 * 117 attributed against a true 58 at concurrency 3, and a live queue run
 * reported 171 against the container's own 62.
 *
 * 🔑 **The load-bearing check is the one that compares the two totals**, not
 * one that asserts a magic number. `sum(per-item) === fetcher.liveRequestCount`
 * is the invariant; an assertion on `117` would have passed before the fix and
 * an assertion on `58` would go stale the moment the query plan changes.
 */

const SERP_BODY = `<h3>Kingwin CF-08LB Fan</h3><h3>Kingwin CF-08LB 80mm</h3><p>CF-08LB CF-08LB</p>`;

/** A retailer whose every search yields one probeable candidate. */
function adapter(): RetailerAdapter {
  return {
    slug: "fake",
    querySupport: { maxNumericQueryDigits: 9, barcodeIsSearchable: false },
    buildSearchUrl: (q) => `https://r.test/s?q=${encodeURIComponent(q)}`,
    parseSearchResults: (html): ParsedCandidate[] =>
      html.startsWith("SEARCH ")
        ? [
            {
              itemId: "I1",
              url: `https://r.test/p/${encodeURIComponent(html.slice(7))}`,
              model: "CF-08LB",
              title: "Kingwin CF-08LB 80mm Fan",
              brand: "Kingwin",
              priceCents: 899,
              inStock: true,
              isFirstParty: true,
              sellerName: null,
            },
          ]
        : [],
    // No published barcode, so every item lands `unverifiable` after probing —
    // the branch that spends the most and therefore has the most to attribute.
    parseProductPage: (): ParsedProduct => ({
      barcode: null,
      priceCents: 899,
      inStock: true,
      title: "Kingwin CF-08LB 80mm Fan",
    }),
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serves a body for any url and counts what it sold.
 *
 * ⚠️ **The `await` before the count is what makes this test able to fail.**
 * Without a suspension point every worker runs to completion before the next
 * one starts, the shared counter never interleaves, and a delta on it looks
 * like an honest attribution. The defect only exists when work overlaps, so
 * the check has to make it overlap.
 */
class CountingFetcher implements Fetcher {
  liveRequestCount = 0;
  constructor(private readonly failOn: RegExp | null = null) {}
  async fetch(url: string): Promise<FetchResult> {
    await sleep(1);
    if (this.failOn?.test(url) === true) {
      // Deliberately NOT `FetchFailed`: `tryFetch` swallows that one and the
      // pipeline reports a clean miss. This reaches `runList`'s catch branch,
      // which is the path whose spend used to be reported as zero.
      throw new Error(`boom on ${url}`);
    }
    this.liveRequestCount++;
    const body = url.includes("google.com/search")
      ? SERP_BODY
      : url.includes("/s?q=")
        ? `SEARCH ${url}`
        : `PRODUCT ${url}`;
    return { url, body, cached: false };
  }
}

const items = (n: number): { barcode: string; clientSku: string }[] =>
  Array.from({ length: n }, (_, i) => ({
    barcode: `81234801054${i}`,
    clientSku: `SKU-${i}`,
  }));

describe("what a run says it spent", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(path.join(os.tmpdir(), "attribution-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  for (const concurrency of [1, 3]) {
    it(`attributes every request to exactly one item at concurrency ${concurrency}`, async () => {
      const fetcher = new CountingFetcher();
      const results = await runList(items(9), adapter(), fetcher, {
        ...RUN_DEFAULTS,
        concurrency,
        runDir,
      });

      const attributed = results.reduce((sum, r) => sum + r.requests, 0);

      // Not vacuous: the run has to have bought something, and more than one
      // page per item, or the arithmetic under test never gets exercised.
      expect(results).toHaveLength(9);
      expect(fetcher.liveRequestCount).toBeGreaterThan(9);
      expect(attributed).toBe(fetcher.liveRequestCount);
    });
  }

  it("charges a failed item what it had already bought, not zero", async () => {
    // The SERP and the search succeed; the product probe throws. So the item
    // has bought two pages by the time the pipeline gives up.
    const fetcher = new CountingFetcher(/\/p\//);
    const results = await runList(items(1), adapter(), fetcher, {
      ...RUN_DEFAULTS,
      concurrency: 1,
      runDir,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.failure).not.toBeNull();
    expect(fetcher.liveRequestCount).toBeGreaterThan(0);
    expect(results[0]?.requests).toBe(fetcher.liveRequestCount);
  });
});

describe("resolveItem, called directly", () => {
  /**
   * 🔴 **This check exists because a mutation reported GREEN.** Restoring
   * `liveRequestCount - startedAt` inside `resolveItem` left every check above
   * passing — because `runList` wraps each item in its own meter first, so the
   * delta it was taking was already honest. The suite was proving `runList`
   * and calling it a property of `resolveItem`.
   *
   * 🔑 **Direct callers have no such protection**, and there are some: the
   * 53-row exit-criterion spec and the outcome-branch spec both call
   * `resolveItem` with a fetcher of their own. So the attribution has to hold
   * at this seam too, and that is what this asserts.
   */
  it("charges each concurrent item only for its own requests", async () => {
    const fetcher = new CountingFetcher();
    const a = adapter();

    const [first, second, third] = await Promise.all([
      resolveItem(items(3)[0]!, a, fetcher, DEFAULT_OPTIONS),
      resolveItem(items(3)[1]!, a, fetcher, DEFAULT_OPTIONS),
      resolveItem(items(3)[2]!, a, fetcher, DEFAULT_OPTIONS),
    ]);

    const attributed = first.requests + second.requests + third.requests;
    expect(fetcher.liveRequestCount).toBeGreaterThan(3);
    expect(attributed).toBe(fetcher.liveRequestCount);
  });
});

describe("RequestMeter", () => {
  it("two meters over one fetcher cannot see each other's requests", async () => {
    const shared = new CountingFetcher();
    const a = new RequestMeter(shared);
    const b = new RequestMeter(shared);

    await Promise.all([
      a.fetch("https://r.test/a"),
      b.fetch("https://r.test/b"),
      b.fetch("https://r.test/c"),
    ]);

    expect(a.liveRequestCount).toBe(1);
    expect(b.liveRequestCount).toBe(2);
    expect(shared.liveRequestCount).toBe(3);
  });

  it("does not charge this run for a page a previous one bought", async () => {
    // A `LiveFetcher` disk hit and the whole replay corpus both come back
    // `cached: true`. That page cost money once, on the run that bought it.
    const cache: Fetcher = {
      liveRequestCount: 0,
      fetch: (url) => Promise.resolve({ url, body: "x", cached: true }),
    };
    const meter = new RequestMeter(cache);

    await meter.fetch("https://r.test/already-had-it");

    expect(meter.liveRequestCount).toBe(0);
  });
});

/**
 * The counter on the wire.
 *
 * 🔑 **The gateway takes a `GREATEST` of this, so it has to be a RUNNING total
 * read at send time** — not a captured number, and not this batch's share. A
 * batch is sent after the pages that produced it were bought, so a value
 * captured at construction is stale by exactly the last batch's cost.
 */
describe("what the reporter tells the gateway it spent", () => {
  /** Records the events a reporter posts, and answers every one. */
  function recordingClient(): {
    readonly events: Record<string, unknown>[];
    readonly client: GatewayClient;
  } {
    const events: Record<string, unknown>[] = [];
    const client = {
      reportResolutions: (
        resolutions: readonly unknown[],
        requestsSpent?: number,
      ) => {
        events.push({
          type: "resolutions",
          n: resolutions.length,
          requestsSpent,
        });
        return Promise.resolve({ kind: "applied" as const });
      },
      reportError: (
        message: string,
        context?: Record<string, unknown>,
        requestsSpent?: number,
      ) => {
        events.push({ type: "error", message, requestsSpent });
        return Promise.resolve({ kind: "applied" as const });
      },
    } as unknown as GatewayClient;
    return { events, client };
  }

  const resolution = (barcode: string): Resolution => ({
    barcode,
    clientSku: `SKU-${barcode}`,
    outcome: "not-found",
    identity: null,
    queriesTried: [],
    candidatesSeen: 0,
    probes: 0,
    requests: 1,
    match: null,
    alternatives: [],
    failure: null,
  });

  it("sends the counter as it reads WHEN THE BATCH GOES, not when the reporter was built", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "reporter-"));
    try {
      let spent = 0;
      const { events, client } = recordingClient();
      const reporter = new GatewayReporter(client, {
        runDir,
        flushAt: 1,
        log: () => {},
        requestsSpent: () => spent,
      });

      spent = 11;
      await reporter.offer(resolution("111111111111"));
      spent = 26;
      await reporter.offer(resolution("222222222222"));
      spent = 26;
      await reporter.reportError("the proxy refused every attempt");

      expect(events).toEqual([
        { type: "resolutions", n: 1, requestsSpent: 11 },
        { type: "resolutions", n: 1, requestsSpent: 26 },
        {
          type: "error",
          message: "the proxy refused every attempt",
          requestsSpent: 26,
        },
      ]);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it("sends no counter at all when none is configured", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "reporter-"));
    try {
      const { events, client } = recordingClient();
      const reporter = new GatewayReporter(client, {
        runDir,
        flushAt: 1,
        log: () => {},
      });

      await reporter.offer(resolution("333333333333"));

      // ⚠️ `undefined`, never `0`. The gateway reads an absent counter as
      // "this container predates the field" and falls back to summing the
      // per-item figures; a zero would tell it the run bought nothing.
      expect(events[0]?.requestsSpent).toBeUndefined();
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

/**
 * A pipeline that could not complete gets one more go, once the run stops
 * pressing.
 *
 * 🔴 **Measured: the throttle is OURS.** A live 73-row run left 6 items whose
 * identity lookup the vendor answered with an empty body even after the
 * 15-second backoff — and every one of those six returned 250–390 KB on the
 * FIRST attempt, with no wait, once the run was over. The vendor is not blocking
 * those urls; it is rate-limiting us while three workers press it.
 *
 * 🔑 **So the retry waits for the pressure to stop rather than for a timer**, and
 * runs one at a time, because retrying three-at-once would recreate the very
 * condition being recovered from.
 */
describe("a failed item is retried once, after the run", () => {
  /**
   * Refuses each matching url its first `failTimes` attempts, then answers.
   *
   * ⚠️ **Self-healing by attempt count, not by a flag a callback sets.** The
   * first version healed inside `onResolved`, which never fires for a deferred
   * item — that being the whole point of deferring it. The double was modelling
   * the fix wrongly, and the check failed for the double's reason rather than
   * the code's.
   */
  class HealingFetcher implements Fetcher {
    liveRequestCount = 0;
    private readonly attempts = new Map<string, number>();
    constructor(
      private readonly failOn: RegExp,
      private readonly failTimes = 1,
    ) {}
    async fetch(url: string): Promise<FetchResult> {
      await sleep(1);
      if (this.failOn.test(url)) {
        const n = (this.attempts.get(url) ?? 0) + 1;
        this.attempts.set(url, n);
        if (n <= this.failTimes) throw new Error(`boom on ${url}`);
      }
      this.liveRequestCount++;
      const body = url.includes("google.com/search")
        ? SERP_BODY
        : url.includes("/s?q=")
          ? `SEARCH ${url}`
          : `PRODUCT ${url}`;
      return { url, body, cached: false };
    }
  }

  it("resolves on the second pass what it could not on the first", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "retry-"));
    try {
      const fetcher = new HealingFetcher(/\/p\//);
      const seen: string[] = [];
      const results = await runList(items(3), adapter(), fetcher, {
        ...RUN_DEFAULTS,
        concurrency: 3,
        runDir,
        onResolved: (r) => {
          seen.push(r.clientSku);
          return Promise.resolve();
        },
      });

      // Every item settled, and none reported as a failure.
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.failure === null)).toBe(true);
      // ⚠️ Reported ONCE each. `offer` skips an acknowledged SKU, so an
      // item reported on the first pass and again on the retry would be
      // silently dropped by the gateway — which is why a failed item is
      // deferred BEFORE it is reported rather than retried after.
      expect(seen.sort()).toEqual(results.map((r) => r.clientSku).sort());
      expect(new Set(seen).size).toBe(3);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it("charges a retried item for BOTH attempts", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "retry-"));
    try {
      const fetcher = new HealingFetcher(/\/p\//);
      let settled = 0;
      const results = await runList(items(1), adapter(), fetcher, {
        ...RUN_DEFAULTS,
        concurrency: 1,
        runDir,
        onResolved: () => {
          settled += 1;
          return Promise.resolve();
        },
      });

      // 🔴 A retry's meter starts at zero. Settling on it alone would drop
      // the first attempt's requests — the spend-vanishing defect the
      // per-item meter exists to remove, reintroduced by the retry.
      expect(settled).toBe(1);
      expect(results[0]?.requests).toBe(fetcher.liveRequestCount);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it("retries once and no more, so a hopeless item cannot loop", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "retry-"));
    try {
      // Never heals: every attempt fails, so both passes fail.
      const fetcher = new HealingFetcher(/\/p\//, Number.MAX_SAFE_INTEGER);
      const results = await runList(items(2), adapter(), fetcher, {
        ...RUN_DEFAULTS,
        concurrency: 2,
        runDir,
      });

      expect(results).toHaveLength(2);
      // ⚠️ Settled as failures rather than retried for ever, and still
      // charged what they spent.
      expect(results.every((r) => r.failure !== null)).toBe(true);
      const charged = results.reduce((n, r) => n + r.requests, 0);
      expect(charged).toBe(fetcher.liveRequestCount);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

/**
 * The retry pass runs ONE at a time.
 *
 * 🔴 **This check exists because a mutation reported GREEN.** Running the second
 * pass at full concurrency left every other check passing — and it is the one
 * property that matters most, because three workers pressing at once is exactly
 * what the vendor rate-limits. A retry at full concurrency recreates the
 * condition it exists to recover from.
 */
describe("the retry pass does not recreate the throttle", () => {
  it("never has more than one fetch in flight during the retry", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "retry-conc-"));
    try {
      let inFlight = 0;
      let maxDuringRetry = 0;
      let productFetches = 0;
      const serpAttempts = new Map<string, number>();

      // ⚠️ **The product probe fails by COUNT, not by url.** Every item here
      // derives the same identity and so shares one product url — keyed on
      // the url, only the FIRST item would fail and the rest would succeed on
      // pass one, leaving a single deferred item and a retry that cannot be
      // concurrent whatever the code does. The check passed against a
      // deliberately-broken retry for exactly that reason.
      const fetcher: Fetcher = {
        liveRequestCount: 0,
        async fetch(url: string) {
          inFlight += 1;
          // 🔑 The search-engine url carries the barcode, so it is unique
          // per item and its second attempt marks the retry pass.
          if (url.includes("google.com/search")) {
            const n = (serpAttempts.get(url) ?? 0) + 1;
            serpAttempts.set(url, n);
            if (n > 1) {
              maxDuringRetry = Math.max(maxDuringRetry, inFlight);
            }
          }
          try {
            await sleep(5);
            if (url.includes("/p/") && productFetches < 6) {
              productFetches += 1;
              throw new Error(`boom on ${url}`);
            }
            (fetcher as { liveRequestCount: number }).liveRequestCount += 1;
            const body = url.includes("google.com/search")
              ? SERP_BODY
              : url.includes("/s?q=")
                ? `SEARCH ${url}`
                : `PRODUCT ${url}`;
            return { url, body, cached: false };
          } finally {
            inFlight -= 1;
          }
        },
      };

      const results = await runList(items(6), adapter(), fetcher, {
        ...RUN_DEFAULTS,
        concurrency: 3,
        runDir,
      });

      expect(results).toHaveLength(6);
      // Several items really were deferred, or the check proves nothing.
      expect(serpAttempts.size).toBeGreaterThan(1);
      expect(
        [...serpAttempts.values()].filter((n) => n > 1).length,
      ).toBeGreaterThan(1);
      // 🔑 And the retry ran one at a time.
      expect(maxDuringRetry).toBe(1);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});
