/**
 * The adapter seam.
 *
 * Everything a retailer does differently lives behind this interface, and
 * **nothing behind it is named above it**. The change's exit criterion requires
 * reproducing a measured outcome split *from configuration alone*, with no
 * retailer named in a code path — so `slug` is a plain string read from the
 * registry rather than a union of the retailers we happen to have looked at.
 *
 * ⚠️ The handover's own seam got this wrong in a way worth not repeating:
 * `type Retailer = "autozone" | "newegg"`. A union is a code path per retailer.
 * Adding the third means editing the type, then every `switch` that narrows on
 * it, and the compiler helpfully points at all of them — which feels like
 * safety and is actually the coupling the seam exists to remove.
 *
 * 🔑 **Every method here is pure.** Adapters parse; they never fetch. That is
 * what lets the whole pipeline above them be replayed offline from a committed
 * corpus, at zero request cost — the property that turns this row's exit
 * criterion from a paid manual run into a deterministic test.
 */

/**
 * An image URL an adapter may publish, or `null`.
 *
 * 🔑 One implementation rather than one per adapter: two spellings of "is this
 * URL safe to render" is how one of them comes to allow `data:`.
 */
export function safeImageUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return null;
  return value.length > 1000 ? null : value;
}

/** One listing a retailer's search returned, in retailer-neutral shape. */
export interface ParsedCandidate {
  /** The retailer's own public identifier for this listing. */
  readonly itemId: string;
  /** Canonical product URL, ready to fetch. */
  readonly url: string;
  /** The retailer's model / part-number field, when it publishes one. */
  readonly model: string | null;
  readonly title: string;
  readonly brand: string | null;
  readonly priceCents: number | null;
  readonly inStock: boolean;
  /**
   * Sold by the retailer itself rather than by a marketplace seller.
   *
   * 🔴 **Load-bearing for ranking, and the reason is measured.** A marketplace
   * listing carries the *seller's* barcode in the retailer's barcode field —
   * observed on a network-switch offer reporting an unrelated barcode. So a
   * first-party match is strong evidence while a marketplace mismatch is weak,
   * and first-party listings must be probed first. `null` where the retailer
   * does not expose the distinction: unknown, never assumed first-party.
   */
  readonly isFirstParty: boolean | null;
  readonly sellerName: string | null;
  /**
   * The retailer's own product photo, absolute http(s) URL, or `null`.
   *
   * 🔴 **Required, not optional, for the same reason `additionalBarcodes` is.**
   * `insights_listings.image_url` has existed since the table did and the
   * review screen has always rendered it; nothing ever wrote it, because this
   * interface had no field and so no adapter could. A required field makes the
   * next adapter state an answer rather than inherit a silent `undefined`.
   *
   * ⚠️ **Not a screenshot.** A picture OF the page needs a browser this
   * runtime deliberately does not have — see `capture/types.ts`. This is an
   * attribute in HTML the run has already bought.
   *
   * 🔴 **Only http(s).** The value is persisted by the gateway and rendered
   * into an `<img src>` by the portal, and it comes from a page a competitor
   * controls. An adapter returns `null` rather than passing on a
   * `javascript:`, a `data:` or a relative path.
   */
  readonly imageUrl: string | null;
}

/** What a product page yields. */
export interface ParsedProduct {
  /**
   * The barcode the retailer publishes for this product, verbatim.
   *
   * ⚠️ **Verbatim, not normalised.** The retailer zero-pads inconsistently —
   * measured across 22 proven pairings as 18 twelve-digit, 2 thirteen and 2
   * fourteen — and normalising here would throw away the evidence of what the
   * retailer actually said. Comparison is `gtinCore`'s job, at compare time.
   *
   * `null` means the page publishes no barcode, which is a **different answer**
   * from a barcode that disagrees: the first makes an item `unverifiable`, the
   * second makes it a mismatch.
   */
  readonly barcode: string | null;
  /**
   * Further barcodes the SAME field published, when it holds more than one.
   *
   * 🔴 **A measured case, not a hypothetical.** One real product page returns
   * two space-separated barcodes in a single field
   * (`812348010548 191120055664`), and the client's value was one of them.
   * Returning the raw field would be worse than useless here: `gtinCore`
   * refuses a digit run outside 8-14 digits, so the two concatenate to 24 and
   * core to nothing — which reads to `resolve` as **a barcode that disagrees**
   * rather than as no barcode at all. That is the false mismatch `gtin.ts`
   * calls the worst output this product can produce.
   *
   * ⚠️ The adapter cannot choose between them: `parseProductPage` is pure and
   * never sees the client's barcode. So it publishes all of them and lets the
   * comparison decide, which is the only place that can.
   *
   * Empty where the field held a single value, which is every page measured
   * at the launch retailer.
   */
  readonly additionalBarcodes: readonly string[];
  readonly priceCents: number | null;
  readonly inStock: boolean | null;
  readonly title: string | null;
}

/**
 * Which query shapes a retailer can actually answer, as configuration.
 *
 * 🔴 This exists because of a measurement, and it must never become an
 * `if (retailer === …)`. The launch retailer routes a numeric query of **10 or
 * more digits** to an error page — probed directly with a control: a model
 * number returns results, a real 7-digit numeric model returns results,
 * `123456789` returns an empty results page, and `1234567890` and every barcode
 * form return the error page. So the constraint is a digit count, not
 * "numeric", and a 9-digit numeric part number *is* searchable.
 *
 * Encoding it as data means the pipeline can decline to spend a request rather
 * than paying to discover the refusal, for any retailer, without knowing which.
 */
export interface QuerySupport {
  /**
   * Longest all-digit query the retailer will answer. `null` = no limit known.
   * A query of purely digits at or above this length is refused locally.
   */
  readonly maxNumericQueryDigits: number | null;
  /** Whether a barcode can be searched directly. Measured false everywhere so far. */
  readonly barcodeIsSearchable: boolean;
}

export interface RetailerAdapter {
  /**
   * The registry slug — a string, deliberately. Retailer capability is a row in
   * `aeo-backend`'s retailer registry, not a constant here.
   */
  readonly slug: string;

  readonly querySupport: QuerySupport;

  /** Where to send a search for `query`. Pure. */
  buildSearchUrl(query: string): string;

  /**
   * Raw search-page body -> candidates. Pure.
   *
   * 🔴 **Two empty answers, and they must not be confused.** `[]` is the
   * retailer answering the search with a results page that holds nothing —
   * the item is not carried, which is real assortment information. `null` is a
   * body that is not a results page at all: a robot check, an error page,
   * something truncated. The pipeline treats `null` exactly as it treats a
   * fetch that failed — a search nobody answered — so the customer is never
   * told a retailer does not stock an item on the strength of a block page.
   *
   * ⚠️ Each adapter recognises its own results page by STRUCTURE the retailer
   * always emits for one, calibrated on a real no-results page; never by the
   * absence of results, which is the very thing the two answers differ on.
   */
  parseSearchResults(html: string): ParsedCandidate[] | null;

  /** Raw product-page body -> the fields resolution needs. Pure. */
  parseProductPage(html: string): ParsedProduct;
}

/**
 * What one read of a listing's own page says, for a listing already paired.
 *
 * 🔑 **Separate from `ParsedProduct` because the two answer different
 * questions.** Resolution fetches a product page to settle identity and takes
 * price and stock from the search cell it already holds, so its parse reads
 * only the barcode. A read has no search cell: the page is the only source, so
 * price and stock must come off it.
 */
export interface ListingPageReading {
  /**
   * The listing this page says it is, in the same form a search names it —
   * or `null` when the page carries no identity this build can read.
   *
   * 🔴 **The gateway must refuse a reading whose page names a different
   * listing from the one it asked for.** A product url can come to serve
   * another product, and a reading that echoed the job's id would file that
   * product's price against this one.
   */
  readonly pageItemId: string | null;
  /**
   * The retailer's barcode field, trimmed of surrounding whitespace and
   * otherwise exactly as published: `""` where the page carries the field and
   * leaves it empty, `null` where there is no barcode field at all. Resolution
   * collapses both to `null`; a reading keeps the difference.
   */
  readonly barcode: string | null;
  /** Further barcodes the same field published. Empty for a single value. */
  readonly additionalBarcodes: readonly string[];
  /** The price the offer is made at, or `null` when it shows none. Never 0. */
  readonly priceCents: number | null;
  /** `null` where the page states no availability this build recognises. */
  readonly inStock: boolean | null;
}

/**
 * What a reader made of a body.
 *
 * Three answers, because the caller files three different things:
 * - `page`: a product page, and what it says;
 * - `not-a-product-page`: a robot check, an error page, a search page, a body
 *   cut short — nothing about the listing at all;
 * - `unreadable-offer`: a product page whose offer this build cannot read —
 *   in stock with no readable price, or neither a price nor an availability
 *   with nothing saying there is no offer. Markup that moved, most likely.
 *
 * 🔴 **Neither refusal is "no price" or "out of stock".** Each says something
 * about our parse, not about the retailer, and is filed as a failed reading.
 */
export type ListingPageResult =
  | { readonly kind: "page"; readonly page: ListingPageReading }
  | { readonly kind: "not-a-product-page"; readonly detail: string }
  | { readonly kind: "unreadable-offer"; readonly detail: string };

/**
 * Reading a page the platform already knows, for a read run.
 *
 * 🔑 **A second seam beside `RetailerAdapter`, not a method added to it**, so
 * the resolution path's type is untouched and every adapter double in its tests
 * stays what it was. Each adapter in this repo implements both.
 */
export interface ListingReader {
  /** The registry slug. */
  readonly slug: string;
  /**
   * The only hosts a read job may send this reader to, lower-case, exact.
   *
   * 🔴 **A listing url is fetched through a paid proxy on the job's say-so.**
   * Checking the host before anything is bought stops a malformed or hostile
   * job spending on, or reaching, somewhere that is not this retailer.
   */
  readonly hosts: readonly string[];
  /** Raw product-page body -> what it says. Pure. */
  readListingPage(html: string): ListingPageResult;
}

/**
 * Can this retailer be asked this query at all?
 *
 * Pure, and deliberately outside the adapter so the rule is written once rather
 * than once per retailer — the adapter supplies the numbers, not the logic.
 */
export function canQuery(support: QuerySupport, query: string): boolean {
  const trimmed = query.trim();
  if (trimmed === "") return false;
  if (!/^\d+$/.test(trimmed)) return true;
  if (support.maxNumericQueryDigits === null) return true;
  return trimmed.length <= support.maxNumericQueryDigits;
}
