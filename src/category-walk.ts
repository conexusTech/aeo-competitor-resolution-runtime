/**
 * A category walk: read a category's pages, and price the watched listings
 * from their cards.
 *
 * A monitoring day that watches many products in one category pays one
 * request a product to read each of them. One category page lists 28 (B&H)
 * to 36 (Newegg) products for one request, so where the gateway's plan says a
 * walk is cheaper, the read job asks for the category instead, and this reads
 * it page by page and hands back the card each watched listing was found on.
 *
 * ── A walk is all or nothing ──────────────────────────────────────────
 * 🔴 **A walk that cannot be trusted prices nothing.** A page that was not a
 * category page, a page that could not be had after its re-reads, or a walk
 * that saw fewer than 90% of the products the category says it holds is
 * `invalid` or `failed`, and every watched listing in it is then read from
 * its own page — the cards it did see included. A walk that stopped short
 * cannot tell a listing the category no longer lists from one on a page it
 * never reached, and a missing card is never "not carried".
 *
 * ⚠️ **A valid walk can still miss a listing.** Its card may be on no page,
 * or show no price; that listing alone is read from its own page. Deciding
 * that is `settleWalk`'s, not the walk's.
 *
 * ── What it costs, and where the pages come from ──────────────────────
 * The same fetcher as a product read, with the reader's fetch profile: every
 * attempt counts in the run's one total, and every page waits the live
 * fetcher's politeness jitter. A throttled page is read again after the same
 * doubling delays a product page is, from the same job-wide re-read budget —
 * inline, because the next page of a walk needs this one's answer first.
 *
 * 🔑 **Pages of one walk are read one after another**, so a walk is one of
 * the job's workers, and pages at once stays the number of workers however
 * the job divides between walks and product reads.
 *
 * Pure apart from the fetcher it is handed: the clock, the waits and the stop
 * all come in, so every rule here is checked offline.
 */

import type { CategoryCard, CategoryReader } from "./adapters/types.js";
import {
  FetchFailed,
  isThrottled,
  type FetchProfile,
  type Fetcher,
} from "./fetcher/types.js";
import type {
  CategoryReadKind,
  ReadCategory,
  ReadCategoryListing,
} from "./gateway/client.js";
import {
  boundText,
  MAX_CATEGORY_ERROR_LENGTH,
  priceWithinLimits,
} from "./wire-limits.js";

/**
 * The most pages one walk reads.
 *
 * 🔴 **A ceiling, not a target.** A walk past it is no longer the cheap way
 * to read a category, and a planner asking for one disagrees with this build.
 * So a walk the job says has more pages is not started, and one whose
 * category says so on a page it read stops there; both read their listings
 * from their own pages.
 */
export const MAX_WALK_PAGES = 60;

/**
 * The most category pages one read job may buy, across all its walks and
 * size reads.
 *
 * 🔴 **A spend ceiling, held twice.** A job planning more is refused before
 * anything is bought; and since a walk follows its category's own last page,
 * one that grew past its plan stops when the job's pages are spent, its
 * listings read from their own pages.
 */
export const MAX_CATEGORY_PAGES_PER_JOB = 600;

/**
 * The most pages a job's plan lets one category buy: one for a size read;
 * the job's last page for a walk, or the 60 a walk may read where the job
 * knows none. What `MAX_CATEGORY_PAGES_PER_JOB` is held against before
 * anything is bought.
 */
export function plannedPages(category: {
  readonly kind: CategoryReadKind;
  readonly lastPage: number | null;
}): number {
  return category.kind === "size"
    ? 1
    : Math.min(category.lastPage ?? MAX_WALK_PAGES, MAX_WALK_PAGES);
}

/**
 * One category address in one spelling, so a category asked for twice is
 * seen as one: host in lower case, no trailing slash, no fragment, the query
 * in order. The path keeps its case — a retailer's paths may not.
 *
 * Returns the url unchanged when it does not parse; the job's own checks
 * refuse it.
 */
export function categoryKey(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  url.hash = "";
  url.searchParams.sort();
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/**
 * The least share of a category's stated products a walk must see to count.
 *
 * Below it the walk missed pages' worth of products — a page served short, a
 * category re-sorted under the walk — and a watched listing missing from it
 * says nothing. Judged only where the category states a count.
 */
export const WHOLE_WALK_SHARE = 0.9;

/** How a category's read ended. */
export type CategoryStatus = "valid" | "invalid" | "failed";

/**
 * One category's outcome, exactly as the `categories` event carries it.
 *
 * - `valid`: read as asked; a walk's cards price the listings found on them.
 * - `invalid`: read, but not whole — fewer than 90% of the products it
 *   states, or more pages than a walk reads. No card prices anything.
 * - `failed`: not read: no category reads at this competitor, an address
 *   this build cannot read, a page 1 that lists nothing or is the end, a page
 *   that could not be had or was not a page of the category, more pages asked
 *   for than a walk reads, or the job's category pages spent.
 *
 * ⚠️ A `size` read that is `valid` still prices nothing: it counts.
 */
export interface CategoryReport {
  readonly categoryId: string;
  readonly kind: CategoryReadKind;
  readonly status: CategoryStatus;
  /** Pages read as pages of the category; the end and a failed page are not. */
  readonly pagesRead: number;
  /** Distinct products across those pages. */
  readonly productsSeen: number;
  /** Of the category's watched listings, how many had a card, priced or not. */
  readonly watchedFound: number;
  /** The product count the category states, or `null` where it states none. */
  readonly total: number | null;
  /** The last page the category states, or `null` where it states none. */
  readonly lastPage: number | null;
  /** Why it is not `valid`; `null` when it is. */
  readonly error: string | null;
}

/** A watched listing's card, and when the page it was on arrived. */
export interface FoundCard {
  readonly card: CategoryCard;
  readonly readAt: Date;
}

/** What a walk read. */
export interface WalkOutcome {
  readonly report: CategoryReport;
  /** Each watched listing whose card the walk saw, by its item id. */
  readonly found: ReadonlyMap<string, FoundCard>;
}

export interface WalkDeps {
  readonly fetcher: Fetcher;
  readonly profile: FetchProfile;
  readonly now: () => Date;
  /** The wait before each re-read of a throttled page; see `READ_PACING`. */
  readonly rereadDelaysMs: readonly number[];
  /** Takes one re-read from the job's budget, or says none is left. */
  readonly takeReread: () => boolean;
  /**
   * Takes one page from the job's `MAX_CATEGORY_PAGES_PER_JOB`, before its
   * first read, or says none is left.
   */
  readonly takePage: () => boolean;
  /** Waits out a re-read's delay, or less if the walk must stop. */
  readonly wait: (ms: number) => Promise<void>;
  /** True once the job must buy nothing more: a stop, a crash, a run gone. */
  readonly shouldStop: () => boolean;
}

type FetchedPage =
  | { readonly kind: "page"; readonly body: string; readonly readAt: Date }
  | { readonly kind: "failed"; readonly detail: string }
  | { readonly kind: "stopped" };

/**
 * One page, read again while the vendor says *not now* and the budget lasts.
 *
 * ⚠️ **A corpus gap is rethrown, not filed**, as for a product read.
 */
async function fetchPage(url: string, deps: WalkDeps): Promise<FetchedPage> {
  for (let reads = 1; ; reads++) {
    try {
      const result = await deps.fetcher.fetch(url, deps.profile);
      return {
        kind: "page",
        body: result.body,
        readAt: result.fetchedAt ?? deps.now(),
      };
    } catch (error) {
      if (!(error instanceof FetchFailed)) throw error;
      const cause =
        error.cause instanceof Error ? ` (${error.cause.message})` : "";
      const detail = `${error.message}${cause}`;
      const delay = deps.rereadDelaysMs[reads - 1];
      if (!isThrottled(error)) return { kind: "failed", detail };
      if (delay === undefined) {
        return {
          kind: "failed",
          detail: `${detail} — throttled on all ${reads} reads`,
        };
      }
      if (!deps.takeReread()) {
        return {
          kind: "failed",
          detail: `${detail} — throttled, not read again: this job's re-read cap is spent`,
        };
      }
      await deps.wait(delay);
      if (deps.shouldStop()) return { kind: "stopped" };
    }
  }
}

/**
 * Walk one category, or read its page 1 for its size.
 *
 * @returns what the walk read, or `null` when the job was told to stop
 * before it finished — unfinished category work just stops, and the gateway
 * plans the category again next time.
 */
export async function walkCategory(
  category: ReadCategory,
  reader: CategoryReader | null,
  deps: WalkDeps,
): Promise<WalkOutcome | null> {
  const watched = new Set(category.listings.map((l) => l.itemId));
  const found = new Map<string, FoundCard>();
  const seen = new Set<string>();
  let pagesRead = 0;
  let total: number | null = null;
  let statedLast: number | null = null;
  // 🔴 Pages 2 and on are asked of the address page 1 states as the
  // category's own, where it states one: B&H sends `/pn/N` of an address that
  // is not canonical back to page 1, which reads as the end of the category.
  let pagesFrom = category.url;

  const outcome = (
    status: CategoryStatus,
    error: string | null,
  ): WalkOutcome => ({
    report: {
      categoryId: category.categoryId,
      kind: category.kind,
      status,
      pagesRead,
      productsSeen: seen.size,
      watchedFound: found.size,
      total,
      lastPage: statedLast,
      error:
        error === null ? null : boundText(error, MAX_CATEGORY_ERROR_LENGTH),
    },
    found,
  });

  if (reader === null) {
    return outcome(
      "failed",
      "this competitor has no category reads; its listings are read from " +
        "their own pages",
    );
  }
  if (
    category.kind === "walk" &&
    category.lastPage !== null &&
    category.lastPage > MAX_WALK_PAGES
  ) {
    return outcome(
      "failed",
      `a walk of ${category.lastPage} pages is past the ${MAX_WALK_PAGES} ` +
        `one walk reads; not started`,
    );
  }

  // 🔑 The retailer's own last page, once a page states it, over the job's:
  // a category that grew is read to its new end, and one that shrank never
  // buys the page past it. Neither known: until the retailer says the end.
  const pagesToRead = (): number =>
    category.kind === "size"
      ? 1
      : Math.min(
          MAX_WALK_PAGES,
          statedLast ?? category.lastPage ?? MAX_WALK_PAGES,
        );

  for (let n = 1; n <= pagesToRead(); n++) {
    if (deps.shouldStop()) return null;
    const url = reader.pageUrl(pagesFrom, n);
    if (url === null) {
      return outcome(
        "failed",
        `${pagesFrom} is not a category address this build can read ` +
          `(page ${n})`,
      );
    }
    if (!deps.takePage()) {
      return outcome(
        "failed",
        `this job's ${MAX_CATEGORY_PAGES_PER_JOB} category pages are spent; ` +
          `not read past page ${n - 1}`,
      );
    }
    const fetched = await fetchPage(url, deps);
    if (fetched.kind === "stopped") return null;
    if (fetched.kind === "failed") {
      return outcome(
        "failed",
        `page ${n} could not be read: ${fetched.detail}`,
      );
    }
    const result = reader.readCategoryPage(fetched.body, n, category.url);
    if (result.kind === "not-a-category-page") {
      return outcome(
        "failed",
        `page ${n} (${url}) answered with ${fetched.body.length} bytes that ` +
          `are not a page of the category (${result.detail})`,
      );
    }
    if (result.kind === "end") {
      // 🔴 A category with no page 1 is never an empty valid one: the walk
      // would report nothing seen, against no count, as whole.
      if (n === 1) {
        return outcome(
          "failed",
          `page 1 (${url}) is the end of the category (${result.detail})`,
        );
      }
      break;
    }
    pagesRead++;
    const page = result.page;
    if (n === 1 && page.canonicalUrl) pagesFrom = page.canonicalUrl;
    total ??= page.total;
    statedLast ??= page.lastPage;
    for (const card of page.products) {
      seen.add(card.itemId);
      if (watched.has(card.itemId) && !found.has(card.itemId)) {
        found.set(card.itemId, {
          // A card price the gateway would refuse is no price: its listing
          // is then read from its own page.
          card: { ...card, priceCents: priceWithinLimits(card.priceCents) },
          readAt: fetched.readAt,
        });
      }
    }
    if (
      category.kind === "walk" &&
      statedLast !== null &&
      statedLast > MAX_WALK_PAGES
    ) {
      return outcome(
        "invalid",
        `the category states ${statedLast} pages, past the ` +
          `${MAX_WALK_PAGES} one walk reads; stopped after page ${n}`,
      );
    }
  }

  if (
    category.kind === "walk" &&
    total !== null &&
    seen.size < WHOLE_WALK_SHARE * total
  ) {
    return outcome(
      "invalid",
      `the walk saw ${seen.size} of the ${total} products the category ` +
        `states, fewer than ${Math.round(WHOLE_WALK_SHARE * 100)}%`,
    );
  }
  return outcome("valid", null);
}

/** A watched listing priced from its category's page. */
export interface CardPrice {
  readonly listing: ReadCategoryListing;
  readonly card: CategoryCard & { readonly priceCents: number };
  readonly readAt: Date;
}

/**
 * Which watched listings a walk priced, and which must be read from their
 * own pages.
 *
 * 🔴 **Only a valid walk prices anything**, and only from a card that shows
 * a price. Everything else — a card missing, a card with no price, every
 * listing of a walk that is not valid, every listing of a size read — is read
 * from its own page, in this container, today.
 *
 * ⚠️ **A size read counts; it never prices.** It is a question about the
 * category, asked of page 1, and a card that happened to be there says
 * nothing a walk would have checked.
 */
export function settleWalk(
  category: ReadCategory,
  walk: WalkOutcome,
): {
  readonly priced: readonly CardPrice[];
  readonly fallback: readonly ReadCategoryListing[];
} {
  const priced: CardPrice[] = [];
  const fallback: ReadCategoryListing[] = [];
  for (const listing of category.listings) {
    const hit = walk.found.get(listing.itemId);
    const priceCents = hit?.card.priceCents ?? null;
    if (
      category.kind === "walk" &&
      walk.report.status === "valid" &&
      hit !== undefined &&
      priceCents !== null
    ) {
      priced.push({
        listing,
        card: { ...hit.card, priceCents },
        readAt: hit.readAt,
      });
    } else {
      fallback.push(listing);
    }
  }
  return { priced, fallback };
}
