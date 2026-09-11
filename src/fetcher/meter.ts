/**
 * A fetcher that counts what **one item** bought, and nothing else.
 *
 * 🔴 **This exists because `liveRequestCount - startedAt` was not an
 * attribution.** `resolveItem` took a delta on the shared fetcher's counter
 * across its own span — but three workers run concurrently by default, so each
 * item's delta absorbed its two peers'. Measured over the committed corpus
 * through a counting fetcher: at concurrency 1 the per-item figures sum to 44
 * against the fetcher's 58; at concurrency 3 they sum to **117 against 58**.
 * A live queue run on 2026-09-11 showed the same shape, **171 reported against
 * the container's own 62** — and `requests_spent` is what prices a run at the
 * approval gate and on the customer's screen.
 *
 * 🔑 **The fix is a counter per item rather than arithmetic on a shared one.**
 * A meter counts only the calls made through it, so two meters over one
 * fetcher cannot see each other and nothing has to be subtracted.
 *
 * ⚠️ **A cache hit is not a purchase.** `LiveFetcher` reads a previously bought
 * page off disk and returns `cached: true`; that page cost money once, on the
 * run that bought it, and counting it again would bill this run for it. The
 * replay fetcher serves its whole corpus as `cached: true` for the same reason,
 * which is why a replayed run correctly reports zero.
 *
 * ⚠️ **The rule "a live request is a non-cached success" is now stated in two
 * places** — here and in `LiveFetcher.fetch`. That duplication is deliberate
 * and it is pinned rather than commented: a check asserts that the per-item
 * meters sum to the fetcher's own total, so the two definitions cannot drift
 * apart without turning a test red.
 */

import type { Fetcher, FetchResult } from "./types.js";

export class RequestMeter implements Fetcher {
  private spent = 0;

  constructor(private readonly inner: Fetcher) {}

  async fetch(url: string): Promise<FetchResult> {
    const result = await this.inner.fetch(url);
    if (!result.cached) this.spent++;
    return result;
  }

  /**
   * What was bought through this meter.
   *
   * ⚠️ A failed fetch counts **nothing**, because the inner fetcher counts
   * nothing for it either — it throws before incrementing. That is a known
   * under-count of the vendor's side of the ledger, not a property of this
   * class: a 200 rejected for carrying too short a body is a request that was
   * made and answered. Roadmap row
   * `resolution-runtime-counts-a-bought-request`.
   */
  get liveRequestCount(): number {
    return this.spent;
  }
}
