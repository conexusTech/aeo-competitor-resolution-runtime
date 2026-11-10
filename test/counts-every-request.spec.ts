import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RetailerAdapter } from "../src/adapters/types.js";
import {
  LiveFetcher,
  LIVE_DEFAULTS,
  type LiveFetcherOptions,
} from "../src/fetcher/live.js";
import { RequestMeter } from "../src/fetcher/meter.js";
import { FetchFailed } from "../src/fetcher/types.js";
import { GatewayClient, ReadRunClient } from "../src/gateway/client.js";
import { RUN_DEFAULTS, runList } from "../src/run.js";

/**
 * Every request the vendor was asked for is counted
 * (`resolution-runtime-counts-a-bought-request`).
 *
 * 🔴 **`liveRequestCount` counted delivered pages only.** A page retried three
 * times counted once, and a page that failed three times counted nothing — so
 * a Best Buy investigation that sent 166 requests read as 110. The registry's
 * rates are priced on this figure, and the vendor's side of the ledger is
 * attempts. So the run now reports attempts as `requests_spent`, and the pages
 * that came back separately as `pages_delivered`.
 *
 * ⚠️ **No real waiting and no network.** `setTimeout` runs its callback at once
 * (the backoff spec's technique) and `fetch` is a stub.
 */

let cacheDir: string;
const opts = (over: Partial<LiveFetcherOptions> = {}): LiveFetcherOptions => ({
  ...LIVE_DEFAULTS,
  apiKey: "k",
  zone: "z",
  cacheDir,
  delayMinMs: 0,
  delayMaxMs: 0,
  ...over,
});

const PAGE = "x".repeat(5000);
const realSetTimeout = globalThis.setTimeout;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(os.tmpdir(), "counts-every-request-"));
  // Runs the callback at once and hands back a genuine, empty timer, so the
  // backoff costs no wall clock.
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: () => void) => {
    fn();
    return realSetTimeout(() => undefined, 0);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(cacheDir, { recursive: true, force: true });
});

/** Stubs the vendor: each call gets the next answer, the last one repeating. */
function vendor(...answers: (() => Promise<Response>)[]): { calls: number } {
  const seen = { calls: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      const answer = answers[Math.min(seen.calls, answers.length - 1)];
      seen.calls += 1;
      if (answer === undefined) throw new Error("no answer scripted");
      return answer();
    }),
  );
  return seen;
}

const status =
  (code: number, body = ""): (() => Promise<Response>) =>
  () =>
    Promise.resolve(new Response(body, { status: code }));
const dropped = (): Promise<Response> =>
  Promise.reject(new TypeError("fetch failed"));
const png = (): Promise<Response> =>
  Promise.resolve(new Response(PNG, { status: 200 }));

/** The JSON object a request carried, or an empty one. */
function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  const raw = typeof init?.body === "string" ? init.body : "{}";
  const parsed: unknown = JSON.parse(raw);
  return parsed !== null && typeof parsed === "object"
    ? Object.fromEntries(Object.entries(parsed))
    : {};
}

async function failure(promise: Promise<unknown>): Promise<FetchFailed> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FetchFailed) return error;
    throw error;
  }
  throw new Error("expected the fetch to fail");
}

describe("the live fetcher counts every attempt it sends", () => {
  it("🔴 a fetch that fails 3 times counts 3", async () => {
    const sent = vendor(status(500, "upstream is unwell"));
    const fetcher = new LiveFetcher(opts());

    const error = await failure(fetcher.fetch("https://x.test/a"));

    expect(sent.calls).toBe(3);
    expect(error.attempts).toBe(3);
    expect(fetcher.liveRequestCount).toBe(3);
    expect(fetcher.pagesDelivered).toBe(0);
  });

  it("🔴 a short 200 counts 1", async () => {
    vendor(status(200, "too short"));
    const fetcher = new LiveFetcher(opts({ attempts: 1 }));

    const error = await failure(fetcher.fetch("https://x.test/b"));

    expect(error.attempts).toBe(1);
    expect(fetcher.liveRequestCount).toBe(1);
    expect(fetcher.pagesDelivered).toBe(0);
  });

  it("a dropped connection counts, because the request was sent", async () => {
    vendor(dropped);
    const fetcher = new LiveFetcher(opts());

    const error = await failure(fetcher.fetch("https://x.test/c"));

    expect(error.attempts).toBe(3);
    expect(fetcher.liveRequestCount).toBe(3);
  });

  it("a page that arrives on its second attempt is 2 sent and 1 delivered", async () => {
    vendor(status(503), status(200, PAGE));
    const fetcher = new LiveFetcher(opts());

    const result = await fetcher.fetch("https://x.test/d");

    expect(result.attempts).toBe(2);
    expect(fetcher.liveRequestCount).toBe(2);
    expect(fetcher.pagesDelivered).toBe(1);
  });

  it("CONTROL: a page served from the disk cache counts nothing", async () => {
    vendor(status(200, PAGE));
    const fetcher = new LiveFetcher(opts());
    await fetcher.fetch("https://x.test/e");

    const again = await fetcher.fetch("https://x.test/e");

    expect(again.cached).toBe(true);
    expect(again.attempts).toBe(0);
    expect(fetcher.liveRequestCount).toBe(1);
    expect(fetcher.pagesDelivered).toBe(1);
  });

  it("a screenshot counts every attempt too", async () => {
    vendor(status(200, '{"error":"zone throttled"}'), png);
    const fetcher = new LiveFetcher(opts());

    const shot = await fetcher.fetchScreenshot("https://x.test/p");

    expect(shot.attempts).toBe(2);
    expect(fetcher.liveRequestCount).toBe(2);
    expect(fetcher.pagesDelivered).toBe(1);
  });

  it("a screenshot refused on every attempt is a FetchFailed carrying them", async () => {
    vendor(status(500));
    const fetcher = new LiveFetcher(opts());

    const error = await failure(fetcher.fetchScreenshot("https://x.test/p"));

    expect(error.attempts).toBe(3);
    expect(fetcher.liveRequestCount).toBe(3);
  });
});

describe("the meter charges failed attempts to the item that made them", () => {
  it("🔴 charges a failure's attempts, where it used to charge nothing", async () => {
    vendor(status(500));
    const meter = new RequestMeter(new LiveFetcher(opts()));

    await failure(meter.fetch("https://x.test/a"));

    expect(meter.liveRequestCount).toBe(3);
    expect(meter.pagesDelivered).toBe(0);
  });

  it("charges a retried page for every attempt and one delivery", async () => {
    vendor(status(200, ""), status(200, PAGE));
    const meter = new RequestMeter(new LiveFetcher(opts()));

    await meter.fetch("https://x.test/b");

    expect(meter.liveRequestCount).toBe(2);
    expect(meter.pagesDelivered).toBe(1);
  });

  /** A retailer whose searches are never reached: identity alone is fetched. */
  const adapter: RetailerAdapter = {
    slug: "fake",
    querySupport: { maxNumericQueryDigits: null, barcodeIsSearchable: false },
    pacing: { pagesAtOnce: 3 },
    fetchProfile: { country: null, timeoutMs: null },
    maxProbes: null,
    buildSearchUrl: (q) => `https://r.test/s?q=${encodeURIComponent(q)}`,
    parseSearchResults: () => [],
    parseProductPage: () => ({
      barcode: null,
      additionalBarcodes: [],
      priceCents: null,
      inStock: null,
      title: null,
    }),
  };

  it("🔑 per-item figures still sum to the fetcher's total, failures and retries included", async () => {
    // Odd barcodes' lookups always fail; even ones answer on the second
    // attempt. So the run has failed attempts, retried attempts, deferred
    // items and their second pass, all at three items at once.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const sentUrl: unknown = Reflect.get(bodyOf(init), "url");
        const target = typeof sentUrl === "string" ? sentUrl : "";
        const digit = Number(/(\d)%22$/.exec(target)?.[1] ?? "0");
        if (digit % 2 === 1) {
          return Promise.resolve(new Response("", { status: 500 }));
        }
        const firstTime = !answered.has(target);
        answered.add(target);
        return Promise.resolve(
          firstTime
            ? new Response("", { status: 200 })
            : new Response(PAGE, { status: 200 }),
        );
      }),
    );
    const answered = new Set<string>();
    const runDir = mkdtempSync(path.join(os.tmpdir(), "counts-run-"));
    try {
      const fetcher = new LiveFetcher(opts());
      const results = await runList(
        Array.from({ length: 6 }, (_, i) => ({
          barcode: `81234801054${i}`,
          clientSku: `SKU-${i}`,
        })),
        adapter,
        fetcher,
        { ...RUN_DEFAULTS, runDir },
      );

      const charged = results.reduce((n, r) => n + r.requests, 0);
      // Not vacuous: attempts outnumber deliveries, or no retry happened.
      expect(fetcher.liveRequestCount).toBeGreaterThan(fetcher.pagesDelivered);
      expect(charged).toBe(fetcher.liveRequestCount);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe("pages_delivered goes beside requests_spent on the wire", () => {
  function recordingHttp(): {
    readonly bodies: Record<string, unknown>[];
    readonly http: typeof globalThis.fetch;
  } {
    const bodies: Record<string, unknown>[] = [];
    const http: typeof globalThis.fetch = (_input, init) => {
      bodies.push(bodyOf(init));
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    return { bodies, http };
  }
  const credentials = { baseUrl: "https://gw.test", user: "u", password: "p" };
  const seams = (http: typeof globalThis.fetch) => ({
    fetch: http,
    sleep: () => Promise.resolve(),
    log: () => {},
  });

  it("on every resolution-run event that carries a spend", async () => {
    const { bodies, http } = recordingHttp();
    const client = new GatewayClient(
      credentials,
      { runId: "r", tenantId: "t", organizationId: "o" },
      seams(http),
    );
    await client.reportProgress({
      itemsReported: 1,
      requestsSpent: 9,
      pagesDelivered: 6,
    });
    await client.reportCompleted(9, 6);
    await client.reportError("boom", undefined, 9, 6);

    for (const body of bodies) {
      expect(body).toMatchObject({ requests_spent: 9, pages_delivered: 6 });
    }
    expect(bodies).toHaveLength(3);
  });

  it("CONTROL: absent when the caller has no figure, never a zero", async () => {
    const { bodies, http } = recordingHttp();
    const client = new GatewayClient(
      credentials,
      { runId: "r", tenantId: "t", organizationId: "o" },
      seams(http),
    );
    await client.reportCompleted(9);
    expect(bodies[0]).toMatchObject({ requests_spent: 9 });
    expect(bodies[0]).not.toHaveProperty("pages_delivered");
  });

  it("on every read-run event", async () => {
    const { bodies, http } = recordingHttp();
    const client = new ReadRunClient(credentials, "read-1", seams(http));
    await client.reportCompleted(5, 4);
    await client.reportError("boom", 5, 4);
    for (const body of bodies) {
      expect(body).toMatchObject({ requests_spent: 5, pages_delivered: 4 });
    }
    expect(bodies).toHaveLength(2);
  });
});
