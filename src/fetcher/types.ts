/**
 * The HTTP seam.
 *
 * One interface, two implementations: a live fetcher that spends money, and a
 * replay fetcher that reads a committed corpus. The pipeline cannot tell them
 * apart, which is the entire reason this row's exit criterion can be a free
 * deterministic test instead of a paid manual run.
 */

export interface FetchResult {
  readonly url: string;
  readonly body: string;
  /** True when no network request was made. */
  readonly cached: boolean;
  /**
   * When the page arrived from the vendor — before it was cached and before
   * the politeness jitter. Absent for a page served from a cache or a corpus.
   *
   * 🔑 A read run's "as of" is this, not the moment the fetcher returned: the
   * jitter alone is up to a second and a half per page.
   */
  readonly fetchedAt?: Date;
}

export interface Fetcher {
  /**
   * Fetch a page.
   *
   * Rejects when the page cannot be had. A caller distinguishes "the retailer
   * said no such product" (an empty parse) from "we could not ask" (a rejection)
   * — collapsing those two is how a run reports 14 not-found and 0 errors while
   * a proxy was down for half of it.
   */
  fetch(url: string): Promise<FetchResult>;

  /**
   * A PNG of the page, rendered by the proxy.
   *
   * 🔑 **Optional, and that is the honest shape.** A live fetcher can ask the
   * proxy to render; a REPLAY fetcher serves committed bytes and has no proxy
   * to ask, so it has no picture to give. Declaring this required would force
   * the replay path to invent one — and a fabricated screenshot is the exact
   * failure the Screenshots screen already had, where a drawn mock sat beside
   * real stored bytes looking like evidence.
   *
   * ⚠️ A caller that needs one must handle its absence rather than assume it.
   */
  fetchScreenshot?(url: string): Promise<Uint8Array>;

  /** Requests actually sent, for the cost meter. Never includes cache hits. */
  readonly liveRequestCount: number;
}

/** Raised when a page could not be fetched, as distinct from being empty. */
export class FetchFailed extends Error {
  constructor(
    readonly url: string,
    override readonly cause?: unknown,
    /**
     * The HTTP status the vendor answered the LAST attempt with, or `null`
     * when no response arrived (a dropped connection, a timeout).
     *
     * ⚠️ **It is the vendor's status, which is not proven to be the
     * retailer's.** Whether the proxy relays a retailer's 404 as its own 404
     * has not been measured.
     */
    readonly status: number | null = null,
  ) {
    super(`could not fetch ${url}`);
    this.name = "FetchFailed";
  }
}

/**
 * Whether a failed fetch was the vendor saying *not now* rather than *no*.
 *
 * 🔑 **The live fetcher's own classification, read back from the status it
 * settled on.** It fails a 2xx only when the body is too short to be a page —
 * measured as a literal zero-byte 200 under load, and the same url answering
 * 338 KB after a wait — so a `FetchFailed` carrying a status below 400 IS that
 * silent throttle. A 429 is the same answer said out loud.
 *
 * ⚠️ **Nothing else is a throttle.** A 404 or 410 is the page gone, a 403 or a
 * 5xx is a refusal or an outage, and no response at all is a dropped
 * connection; re-reading any of those later spends again to be told the same.
 * An adapter's `not-a-product-page` is not one either: a body arrived.
 */
export function isThrottled(error: FetchFailed): boolean {
  return error.status !== null && (error.status < 400 || error.status === 429);
}

/**
 * Raised by the replay fetcher for a url the corpus does not hold.
 *
 * 🔑 A distinct type, and deliberately not a `FetchFailed`. During a replay this
 * means **the corpus is incomplete**, which is a defect in the test data rather
 * than a simulated network problem — and a replay that silently reported those
 * as network errors would land squarely on the spike's 5 `error` rows and look
 * like a faithful reproduction.
 */
export class NotInCorpus extends Error {
  constructor(readonly url: string) {
    super(`not in the replay corpus: ${url}`);
    this.name = "NotInCorpus";
  }
}
