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
  /**
   * Requests sent to the vendor to get this page: every attempt, the one that
   * delivered included. `0` for a page served from a cache or a corpus.
   *
   * 🔑 **On the result, not only on the fetcher's counter**, because a meter
   * attributes spend to one item by what passes through it — see
   * `RequestMeter`. A counter read across a span absorbs whatever concurrent
   * items bought in it.
   */
  readonly attempts: number;
}

/** A PNG the proxy rendered, and what it cost to get. */
export interface Screenshot {
  readonly bytes: Uint8Array;
  /** Requests sent to the vendor for it, the one that delivered included. */
  readonly attempts: number;
}

/**
 * How a competitor's pages must be fetched.
 *
 * 🔑 **Facts about the retailer, so they live in code, on the adapter** — unlike
 * pages at once, which is tuning and lives in the registry (the lead,
 * 2026-11-10). Required on every adapter and reader, so the next one states
 * its answer; `null` in a field means "as the vendor does by default".
 */
export interface FetchProfile {
  /**
   * The country the vendor should fetch from, as its request parameter — not
   * a zone setting. `null` sends none.
   */
  readonly country: string | null;
  /**
   * Abandon one attempt after this long. A timeout is an ordinary failed
   * attempt: retried like any other and counted as a request sent. `null`
   * leaves the attempt to the vendor's own limit.
   */
  readonly timeoutMs: number | null;
}

export interface Fetcher {
  /**
   * Fetch a page.
   *
   * Rejects when the page cannot be had. A caller distinguishes "the retailer
   * said no such product" (an empty parse) from "we could not ask" (a rejection)
   * — collapsing those two is how a run reports 14 not-found and 0 errors while
   * a proxy was down for half of it.
   *
   * @param profile How the competitor's pages must be fetched. Absent for a
   * page that is not a competitor's — the client's catalogue, the search
   * engine — which the vendor fetches with its defaults.
   */
  fetch(url: string, profile?: FetchProfile): Promise<FetchResult>;

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
  fetchScreenshot?(url: string): Promise<Screenshot>;

  /**
   * Requests sent to the vendor: **every attempt**, a retry, a 200 too short to
   * be a page and a timeout each included. Never a cache hit.
   *
   * 🔴 **This counted delivered pages only, until
   * `resolution-runtime-counts-a-bought-request`.** A retried page counted
   * once however many times it was asked for, so one Best Buy investigation
   * read 110 where 166 had been sent. Whether the vendor bills every attempt
   * is not invoice-validated; counting attempts makes the figure safe either
   * way, since it can only overstate.
   */
  readonly liveRequestCount: number;

  /**
   * Pages (and screenshots) the vendor actually delivered — the figure
   * `liveRequestCount` used to be. Reported beside it so a run says both what
   * it asked for and what it got.
   */
  readonly pagesDelivered: number;
}

/** Raised when a page could not be fetched, as distinct from being empty. */
export class FetchFailed extends Error {
  constructor(
    readonly url: string,
    override readonly cause: unknown,
    /**
     * The HTTP status the vendor answered the LAST attempt with, or `null`
     * when no response arrived (a dropped connection, a timeout).
     *
     * ⚠️ **It is the vendor's status, which is not proven to be the
     * retailer's.** Whether the proxy relays a retailer's 404 as its own 404
     * has not been measured.
     */
    readonly status: number | null,
    /**
     * Requests sent to the vendor before giving up, every one of them paid
     * for. `0` where nothing was sent — a refusal before any request.
     *
     * 🔴 **Required, with no default, at every throw site.** It defaulted to
     * `0`, so a new failure path that forgot it compiled and silently charged
     * nothing for requests the vendor billed. A required argument makes the
     * next throw site state what it sent.
     */
    readonly attempts: number,
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
