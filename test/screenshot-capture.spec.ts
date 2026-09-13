import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveFetcher, LIVE_DEFAULTS } from "../src/fetcher/live.js";

/**
 * A picture of the page, from the proxy that already fetches it.
 *
 * ── 🔴 What this corrects ──────────────────────────────────────────────
 *
 * `capture/types.ts` REFUSED a `png` capture outright, reasoning that this
 * runtime "reads pages through a proxy and holds no browser", and that a
 * headless browser inside a k8s Job "makes exactly the request the proxy
 * exists to avoid". The second half is true; the conclusion does not follow.
 * **The proxy renders it on ITS side.** `api.brightdata.com/request` takes
 * `data_format: "screenshot"` on the same endpoint, the same zone and the same
 * credential this runtime already uses, and answers with a PNG.
 *
 * Measured 2026-09-13 against a real Amazon product page: HTTP 200,
 * **2,994,302 bytes**, magic `89 50 4E 47`, **1529 × 10,621** — the whole
 * page, gallery, price and reviews.
 *
 * 🔑 So a screenshot costs one request and no new dependency, and the
 * Screenshots screen stops drawing a MOCK of a page beside real stored bytes —
 * which is worse than showing nothing, because it looks like evidence.
 */

let cacheDir: string;
const opts = () => ({
  ...LIVE_DEFAULTS,
  apiKey: "k",
  zone: "z",
  cacheDir,
  delayMinMs: 0,
  delayMaxMs: 0,
});

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);

const respondBytes = (status: number, bytes: Uint8Array) =>
  ({
    status,
    arrayBuffer: () =>
      Promise.resolve(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      ),
  }) as unknown as Response;

/**
 * Stubs `globalThis.fetch` with a body-returning responder.
 *
 * ⚠️ One helper rather than a cast at each call site: every stub here returns
 * a plain object, so an `async` arrow would carry no `await` and the repo's
 * lint refuses that — correctly, since it advertises work that never happens.
 */
const stubFetch = (
  respond: (url: string, init: { body: string }) => Response,
): void => {
  vi.spyOn(globalThis, "fetch").mockImplementation(((
    url: string,
    init: { body: string },
  ) => Promise.resolve(respond(url, init))) as never);
};

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(os.tmpdir(), "shot-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("fetchScreenshot", () => {
  it("asks the proxy for a screenshot, not a page", async () => {
    const calls: unknown[] = [];
    stubFetch((_url, init) => {
      calls.push(JSON.parse(init.body));
      return respondBytes(200, PNG);
    });

    const fetcher = new LiveFetcher(opts());
    await fetcher.fetchScreenshot("https://www.amazon.com/dp/B001QUA6R0");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      zone: "z",
      url: "https://www.amazon.com/dp/B001QUA6R0",
      data_format: "screenshot",
    });
  });

  it("returns the bytes verbatim", async () => {
    stubFetch(() => respondBytes(200, PNG));
    const bytes = await new LiveFetcher(opts()).fetchScreenshot(
      "https://x.test/p",
    );
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(bytes).toHaveLength(PNG.length);
  });

  /**
   * 🔴 **A 200 that is not a PNG is refused, never stored.** The vendor answers
   * a throttle with a 200 and a short JSON error — the existing page path
   * already treats a short 200 as a silent throttle. An image path cannot use
   * length alone, because a truncated PNG is long; the magic bytes are the
   * check, and they fail a JSON error body immediately.
   */
  it("refuses a 200 that is not a PNG", async () => {
    stubFetch(() =>
      respondBytes(200, new TextEncoder().encode('{"error":"zone throttled"}')),
    );
    await expect(
      new LiveFetcher({ ...opts(), attempts: 1 }).fetchScreenshot(
        "https://x.test/p",
      ),
    ).rejects.toThrow();
  });

  it("accepts a PNG far larger than any page body cap — the CONTROL", async () => {
    // Without this, a length ceiling copied from the page path would refuse
    // every real screenshot: the one measured is 2.86 MB.
    const big = new Uint8Array(3_000_000);
    big.set(PNG.slice(0, 8));
    stubFetch(() => respondBytes(200, big));
    const bytes = await new LiveFetcher(opts()).fetchScreenshot(
      "https://x.test/p",
    );
    expect(bytes).toHaveLength(3_000_000);
  });

  it("counts as a request, because it is one", async () => {
    // 🔑 A screenshot is a SECOND paid request on top of the page read. A meter
    // that missed it would under-report every captured item.
    stubFetch(() => respondBytes(200, PNG));
    const fetcher = new LiveFetcher(opts());
    const before = fetcher.liveRequestCount;
    await fetcher.fetchScreenshot("https://x.test/p");
    expect(fetcher.liveRequestCount).toBe(before + 1);
  });
});
