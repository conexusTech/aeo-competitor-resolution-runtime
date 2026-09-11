/**
 * The live fetcher: pages through a proxy that can reach retailers which refuse
 * a plain request, with every response cached to disk.
 *
 * 🔑 **The disk cache is not an optimisation, it is what makes a run
 * restartable.** A resolution run over a real client list is tens of thousands
 * of requests and hours of wall clock, all of it paid. Re-running after a crash,
 * a rate-limit stall or a redeploy must not re-buy what was already fetched.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { FetchFailed, type Fetcher, type FetchResult } from "./types.js";

export interface LiveFetcherOptions {
  readonly apiKey: string;
  readonly zone: string;
  readonly cacheDir: string;
  /** Attempts per url, including the first. */
  readonly attempts: number;
  /** Politeness delay bounds between requests, milliseconds. */
  readonly delayMinMs: number;
  readonly delayMaxMs: number;
  /**
   * Shortest body treated as a real page.
   *
   * A proxy returns a short error document with a 200 for a blocked or
   * throttled request, so status alone does not say whether a page arrived.
   * Accepting it would cache a failure permanently and report the item as a
   * clean miss.
   */
  readonly minBodyBytes: number;
  /**
   * How long to wait after a **silent throttle**, before doubling.
   *
   * 🔴 **Separate from the ordinary retry delay because the two are
   * different failures.** A 4xx or a dropped connection is worth another try
   * in a second; an empty 200 is the vendor saying *not now*, and a second is
   * nowhere near long enough.
   */
  readonly throttleDelayMs: number;
}

export const LIVE_DEFAULTS = {
  attempts: 3,
  delayMinMs: 500,
  delayMaxMs: 1500,
  minBodyBytes: 2000,
  /**
   * 🔑 **5 s, then 10 s — 15 s of waiting across three attempts, and the
   * figure is measured rather than chosen.** A barcode whose lookup returned
   * a zero-byte body twice in a row returned 338,079 bytes after a 15-second
   * wait; the old schedule waited 1 s then 2 s and gave up at 3.
   *
   * 🔴 **21% of a live 73-row run failed this way**, and those rows were never
   * searched at all — the single largest cause of that run reaching 28 verified
   * against the handover spike's 35 on identical rows.
   *
   * ⚠️ **The trade is run time.** A row that is throttled on every attempt now
   * costs 15 s of waiting instead of 3. On a list where a fifth of lookups are
   * throttled that is real, and it is the reason this is a constant rather
   * than a hardcoded number.
   */
  throttleDelayMs: 5000,
} as const;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class LiveFetcher implements Fetcher {
  liveRequestCount = 0;
  cacheHitCount = 0;
  failureCount = 0;
  /**
   * Requests the vendor answered with nothing.
   *
   * 🔑 Counted apart from `failureCount` because they are the actionable
   * half: a run reporting `failures: 16` says something went wrong, and one
   * reporting `16 throttled` says what to do about it.
   */
  throttleCount = 0;

  constructor(private readonly options: LiveFetcherOptions) {}

  private cachePath(url: string): string {
    const key = createHash("sha256").update(url).digest("hex").slice(0, 32);
    return path.join(this.options.cacheDir, `${key}.html`);
  }

  async fetch(url: string): Promise<FetchResult> {
    const cached = this.cachePath(url);
    try {
      const body = await readFile(cached, "utf8");
      this.cacheHitCount++;
      return { url, body, cached: true };
    } catch {
      // Not cached; fall through and pay for it.
    }

    // 🔑 **Two backoffs, because there are two failures.** `throttled` is set
    // when the vendor answered with a body too short to be a page — measured
    // as a literal ZERO bytes on a 200 — and that needs a far longer wait than
    // a dropped connection does.
    let throttled = false;
    for (let attempt = 0; attempt < this.options.attempts; attempt++) {
      if (attempt > 0) {
        await sleep(
          throttled
            ? this.options.throttleDelayMs * 2 ** (attempt - 1)
            : 500 * 2 ** attempt,
        );
      }
      try {
        const response = await globalThis.fetch(
          "https://api.brightdata.com/request",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.options.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              zone: this.options.zone,
              url,
              format: "raw",
            }),
          },
        );
        const body = await response.text();

        // Both conditions. A 200 carrying a 300-byte block notice is a failure
        // that looks like a success, and caching it makes the failure permanent.
        if (response.status >= 400 || body.length < this.options.minBodyBytes) {
          // 🔴 **A short body on a 2xx is a SILENT THROTTLE and the next attempt
          // must wait much longer.** Measured: the vendor answers the identity
          // lookup with `200` and **zero bytes** for about a fifth of requests
          // under an ordinary run's load, and the same url returns 338 KB after
          // a 15-second wait. Retrying it in one second simply spends again to
          // be told nothing a second time.
          throttled = response.status < 400;
          throw new Error(`status=${response.status} bytes=${body.length}`);
        }

        this.liveRequestCount++;
        await mkdir(this.options.cacheDir, { recursive: true });
        await writeFile(cached, body, "utf8");
        await this.jitter();
        return { url, body, cached: false };
      } catch (error) {
        if (attempt === this.options.attempts - 1) {
          this.failureCount++;
          // 🔑 Counted apart, because a run that says `16 throttled` tells an
          // operator what to change and one that says `16 failures` does not.
          if (throttled) this.throttleCount++;
          throw new FetchFailed(url, error);
        }
      }
    }

    // Unreachable: the loop either returns or throws on its last attempt.
    this.failureCount++;
    throw new FetchFailed(url);
  }

  private jitter(): Promise<void> {
    const { delayMinMs, delayMaxMs } = this.options;
    return sleep(delayMinMs + Math.random() * (delayMaxMs - delayMinMs));
  }
}

/**
 * Build a live fetcher from the environment, or explain what is missing.
 *
 * ⚠️ Read at call time, never at module load. A sibling runtime in this
 * workspace shipped a bug where a top-level `const x = process.env.X` captured
 * `undefined` because nothing had loaded the environment yet, and then served
 * its default forever — a correctly-set variable that did nothing.
 */
export function liveFetcherFromEnv(
  overrides: Partial<LiveFetcherOptions> = {},
): LiveFetcher {
  const apiKey = process.env["BRIGHTDATA_API_KEY"];
  const zone = process.env["BRIGHTDATA_UNLOCKER_ZONE"];
  if (apiKey == null || apiKey === "" || zone == null || zone === "") {
    throw new Error(
      "BRIGHTDATA_API_KEY and BRIGHTDATA_UNLOCKER_ZONE are required for a live " +
        "run. The test suite needs neither — it replays a committed corpus.",
    );
  }
  return new LiveFetcher({
    ...LIVE_DEFAULTS,
    cacheDir: process.env["RESOLUTION_CACHE_DIR"] ?? "./captures",
    ...overrides,
    apiKey,
    zone,
  });
}
