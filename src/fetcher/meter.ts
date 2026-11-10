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
 * 🔑 **What counts is every request sent, not every page delivered**
 * (`resolution-runtime-counts-a-bought-request`). A retry, a 200 too short to
 * be a page and a timeout are each a request the vendor was asked for. The
 * live fetcher retries INSIDE one `fetch` call, so a meter that counted calls
 * would see one request where three were sent; instead each result, and each
 * `FetchFailed`, says how many attempts it took, and the meter adds that.
 *
 * ⚠️ **The rule is still stated in two places** — here and in `LiveFetcher`,
 * which counts the same attempts on its shared counter. That duplication is
 * deliberate and pinned rather than commented: a check asserts that the
 * per-item meters sum to the fetcher's own total, failures included, so the
 * two definitions cannot drift apart without turning a test red.
 */

import {
  FetchFailed,
  type Fetcher,
  type FetchProfile,
  type FetchResult,
  type Screenshot,
} from "./types.js";

export class RequestMeter implements Fetcher {
  private spent = 0;
  private delivered = 0;

  constructor(private readonly inner: Fetcher) {
    // Assigned in the constructor rather than as a field initialiser: the
    // property has to be ABSENT, not undefined-valued, when the inner fetcher
    // cannot take a screenshot — the capturer branches on presence.
    const take = inner.fetchScreenshot?.bind(inner);
    if (take !== undefined) {
      this.fetchScreenshot = async (
        url: string,
        profile?: FetchProfile,
      ): Promise<Screenshot> => {
        const shot = await this.counted(() => take(url, profile));
        this.spent += shot.attempts;
        this.delivered++;
        return shot;
      };
    }
  }

  async fetch(url: string, profile?: FetchProfile): Promise<FetchResult> {
    const result = await this.counted(() => this.inner.fetch(url, profile));
    this.spent += result.attempts;
    if (!result.cached) this.delivered++;
    return result;
  }

  /**
   * Run one call, charging a `FetchFailed`'s attempts before it propagates.
   *
   * 🔴 **A failed fetch was charged nothing**, because the inner fetcher
   * counted nothing for it either — it threw before incrementing. Three
   * attempts that each came back empty are three requests the vendor was
   * asked for. Any other error carries no count and is charged nothing: it is
   * not a request that was sent.
   */
  private async counted<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof FetchFailed) this.spent += error.attempts;
      throw error;
    }
  }

  /**
   * A screenshot, counted.
   *
   * 🔴 **This was missing, and its absence was the defect this class exists
   * to prevent, through the one path it did not cover.** `fetchScreenshot` is
   * OPTIONAL on `Fetcher`, so the meter kept compiling without forwarding it,
   * and `LiveFetcher.fetchScreenshot` increments the SHARED counter directly —
   * every screenshot billed to the run and attributed to no item, while this
   * module's own docblock claims the per-item figures sum to what the fetcher
   * bought.
   *
   * 🔑 **Defined CONDITIONALLY, and that is deliberate.** A replay fetcher has
   * no proxy to ask; a meter over one must not ADVERTISE a screenshot it
   * cannot take, because the capturer branches on presence and a method that
   * always exists and always throws turns a clean refusal into an
   * item-by-item failure.
   *
   * ⚠️ **No cache clause, unlike `fetch`.** Screenshots are not cached — see
   * `LiveFetcher.fetchScreenshot` — so every attempt is a purchase.
   */
  readonly fetchScreenshot?: (
    url: string,
    profile?: FetchProfile,
  ) => Promise<Screenshot>;

  /**
   * Requests sent through this meter: every attempt, failures included.
   */
  get liveRequestCount(): number {
    return this.spent;
  }

  /** Pages (and screenshots) delivered through this meter. */
  get pagesDelivered(): number {
    return this.delivered;
  }
}
