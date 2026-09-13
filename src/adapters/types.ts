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

  /** Raw search-page body -> candidates. Pure. Returns `[]` for an unparseable page. */
  parseSearchResults(html: string): ParsedCandidate[];

  /** Raw product-page body -> the fields resolution needs. Pure. */
  parseProductPage(html: string): ParsedProduct;
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
