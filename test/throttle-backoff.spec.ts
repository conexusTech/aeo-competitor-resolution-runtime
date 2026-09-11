import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveFetcher, LIVE_DEFAULTS } from "../src/fetcher/live.js";
import { FetchFailed } from "../src/fetcher/types.js";

/**
 * A silent throttle is waited out, not retried into.
 *
 * 🔴 **21% of a live 73-row run failed at the identity lookup, and those rows
 * were never searched at all** — the largest single cause of that run reaching
 * 28 verified against the handover spike's 35 on identical rows. Reproduced on
 * the host under the run's own shape, three at a time: **33%, 6 of 18**.
 *
 * 🔑 **The signature is an HTTP 200 with a ZERO-BYTE body.** Not a 4xx, not a
 * timeout, not a block page — nothing. And it is a throttle rather than a dead
 * url: a barcode that returned 0 bytes twice returned **338,079 bytes after a
 * 15-second wait**, while the old schedule waited 1 s then 2 s and gave up at 3.
 *
 * ⚠️ **These checks measure the WAITS, with fake timers**, because the property
 * is "it waits long enough" and a check that only asserted "it retried" would
 * have passed against the code that shipped.
 */

/**
 * ⚠️ **A fresh cache directory per test, and this is not tidiness.** The
 * first version used one fixed path; an earlier aborted run had left a page
 * cached there, so a later run read it back and reported `cached: true` for a
 * fetch it never made. A spec that writes to a fixed path carries state
 * between runs and will eventually assert something about the last run
 * instead of this one.
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

/**
 * Records every `sleep` the fetcher asks for, without spending the time.
 *
 * ⚠️ **No `vi.useFakeTimers()`.** The first version called it and then
 * captured `globalThis.setTimeout` to delegate to — but by then that WAS the
 * fake, so nothing ever fired and all five checks timed out. Recording the
 * delay and running the callback synchronously is both simpler and the thing
 * actually under test: the assertion is on the duration asked for.
 */
function recordWaits(): number[] {
  const waits: number[] = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(
    (fn: () => void, ms?: number) => {
      waits.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
  );
  return waits;
}

const respond = (status: number, body: string) =>
  ({ status, text: () => Promise.resolve(body) }) as unknown as Response;

describe("a silent throttle is waited out", () => {
  let waits: number[];

  beforeEach(() => {
    cacheDir = mkdtempSync(path.join(os.tmpdir(), "throttle-spec-"));
    waits = recordWaits();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("waits far longer after an empty 200 than after a dropped connection", async () => {
    // Every attempt throttled: 200 with nothing in it.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(respond(200, ""))),
    );
    const fetcher = new LiveFetcher(opts());

    await expect(fetcher.fetch("https://x.test/a")).rejects.toBeInstanceOf(
      FetchFailed,
    );

    // 🔑 5 s then 10 s — 15 s of waiting, which is what recovered the
    // measured case. The old schedule was 1 s then 2 s.
    expect(waits).toEqual([
      LIVE_DEFAULTS.throttleDelayMs,
      LIVE_DEFAULTS.throttleDelayMs * 2,
    ]);
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(15_000);
  });

  it("keeps the SHORT backoff for an ordinary failure", async () => {
    // ⚠️ The control. A fix that simply made every retry slow would pass the
    // check above and make every transient error cost 15 s.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(respond(500, "upstream is unwell"))),
    );
    const fetcher = new LiveFetcher(opts());

    await expect(fetcher.fetch("https://x.test/b")).rejects.toBeInstanceOf(
      FetchFailed,
    );

    expect(waits).toEqual([1000, 2000]);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThan(5_000);
  });

  it("recovers when a later attempt answers, and spends only once", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        n += 1;
        return Promise.resolve(
          n === 1 ? respond(200, "") : respond(200, "x".repeat(5000)),
        );
      }),
    );
    const fetcher = new LiveFetcher(opts());

    const result = await fetcher.fetch("https://x.test/c");

    expect(result.body.length).toBe(5000);
    expect(result.cached).toBe(false);
    // Only the attempt that produced a page counts as a request bought.
    expect(fetcher.liveRequestCount).toBe(1);
    expect(fetcher.throttleCount).toBe(0);
    // ⚠️ Filtered: a SUCCESSFUL fetch also sleeps the politeness jitter,
    // which is zero here and is not a backoff. Asserting the raw list
    // would couple this check to an unrelated delay.
    expect(waits.filter((w) => w > 0)).toEqual([LIVE_DEFAULTS.throttleDelayMs]);
  });

  it("counts a throttle apart from an ordinary failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(respond(200, ""))),
    );
    const throttledFetcher = new LiveFetcher(opts());
    await expect(
      throttledFetcher.fetch("https://x.test/d"),
    ).rejects.toBeInstanceOf(FetchFailed);
    expect(throttledFetcher.failureCount).toBe(1);
    // 🔑 `failures: 16` says something went wrong; `16 throttled` says what
    // to do about it.
    expect(throttledFetcher.throttleCount).toBe(1);

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(respond(503, "gone"))),
    );
    const brokenFetcher = new LiveFetcher(opts());
    await expect(
      brokenFetcher.fetch("https://x.test/e"),
    ).rejects.toBeInstanceOf(FetchFailed);
    expect(brokenFetcher.failureCount).toBe(1);
    expect(brokenFetcher.throttleCount).toBe(0);
  });

  it("treats a short-but-not-empty 200 as a throttle too", async () => {
    // ⚠️ The vendor also returns a small block notice. Measured at 300-odd
    // bytes on the handover's own runs, which is why the floor is 2,000 and
    // not 1.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(respond(200, "x".repeat(300)))),
    );
    const fetcher = new LiveFetcher(opts());
    await expect(fetcher.fetch("https://x.test/f")).rejects.toBeInstanceOf(
      FetchFailed,
    );
    expect(waits[0]).toBe(LIVE_DEFAULTS.throttleDelayMs);
  });
});
