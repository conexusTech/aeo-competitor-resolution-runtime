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

import type { FetchProfile } from "../fetcher/types.js";

/**
 * An image URL an adapter may publish, or `null`.
 *
 * 🔑 One implementation rather than one per adapter: two spellings of "is this
 * URL safe to render" is how one of them comes to allow `data:`.
 */
export function safeImageUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim();
  // 🔴 https only: an `http:` image is mixed content on the https portal.
  if (!/^https:\/\//i.test(value)) return null;
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
  /**
   * `null` where the search result states no availability — unknown, never
   * assumed either way. ⚠️ Scores as not in stock: only a stated `true` earns
   * the in-stock credit.
   */
  readonly inStock: boolean | null;
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
   * The retailer's own product photo, absolute https URL, or `null`.
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
   * 🔴 **Only https.** The value is persisted by the gateway and rendered
   * into an `<img src>` by the portal, and it comes from a page a competitor
   * controls. An adapter returns `null` rather than passing on a
   * `javascript:`, a `data:` or a relative path.
   */
  readonly imageUrl: string | null;
  /**
   * The retailer says this result matched only part of what was asked — a
   * partial or look-alike answer, not a match for the query.
   *
   * 🔴 **Never opened for a barcode query.** A barcode names exactly one
   * product, so a result the retailer itself marks as not matching it is a
   * look-alike, and probing it spends a page on a product that is not the
   * item. Measured at B&H: a query it matches nothing of comes back as
   * `PARTIAL_SEARCH` with 28 screen kits. Kept in the pool for the ranking to
   * judge, since a partial page answering a part number can hold the item.
   *
   * Required, so the next adapter states its answer; `false` for a retailer
   * that says nothing, or drops its look-alikes itself.
   */
  readonly partialMatch: boolean;
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
  /**
   * The seller the page names for its offer, or `null` where it names none.
   *
   * 🔑 **Required, because a search result may not say.** Best Buy's search
   * card names Best Buy's own offers and never a marketplace seller; the
   * product page does. The pairing's evidence takes this before the search
   * result's, as it does the price.
   */
  readonly sellerName: string | null;
  /**
   * Whether the page's offer is the retailer's own, or a marketplace seller's
   * — `null` where the page does not say.
   *
   * 🔴 **Required, because a search card may not say.** Best Buy hydrates
   * only the first few cards of a search; the rest carry a SKU and no seller,
   * so their `isFirstParty` is unknown while the product page states
   * `seller.classification`. The pairing's evidence takes this before the
   * card's, as it does the seller's name: an unknown is persisted as a
   * marketplace listing, and a first-party one stored that way weakens a
   * barcode agreement that is in fact authoritative.
   */
  readonly isFirstParty: boolean | null;
  /**
   * Why this page publishes no barcode, where the page itself says — or
   * `null` where it says nothing, or publishes one.
   *
   * 🔑 **Jody's rule: a candidate without a barcode match goes to a person**,
   * and the person needs the reason. B&H's discontinued items are the first:
   * the right MFR # and brand, no UPC, no price — "discontinued at B&H, no
   * UPC published". It reaches the reviewer as the evidence's
   * `unverifiableReason`, and only on an `unverifiable` pairing.
   *
   * ⚠️ **At most `MAX_UNVERIFIABLE_REASON_LENGTH` characters.** Required, so
   * the next adapter states its answer.
   */
  readonly unverifiableReason: string | null;
  /**
   * The retailer's own category this product sits in — the deepest level of
   * the page's breadcrumb — or `null` where the page names none this build
   * can read.
   *
   * 🔑 **Required, so the next adapter states its answer.** It is how a
   * watched listing is placed in a category a category read can cover; a
   * retailer without category reads answers `null`.
   */
  readonly category: ListingCategory | null;
}

/**
 * A retailer category, as the retailer's own breadcrumb names it.
 *
 * 🔴 **All three or nothing.** A category with no address cannot be read, and
 * one with no name cannot be shown to a person, so an adapter that finds only
 * part of it answers `null` rather than a partial category.
 */
export interface ListingCategory {
  /**
   * The retailer's own id for the category, as a string. At Newegg it carries
   * the kind as well as the number — `cat-358`, `sub-696` — because Newegg
   * numbers its Categories and SubCategories separately.
   */
  readonly id: string;
  /** Its name, entities decoded, as the breadcrumb shows it. */
  readonly name: string;
  /** Its page, absolute https on the retailer's own host. */
  readonly url: string;
}

/**
 * The longest `unverifiableReason` the gateway accepts.
 *
 * 🔴 **One home, because a longer one costs a batch.** The gateway validates
 * the field at 200 characters (`aeo-backend` `MAX_UNVERIFIABLE_REASON_LENGTH`),
 * and a value past it fails the whole resolutions event with a 400 the
 * runtime never retries — every finding in it lost. Every adapter's reasons
 * are held to this in a test, and the gateway client sends a longer one as
 * `null`, logged as an error, rather than truncating it into something nobody
 * wrote or losing the batch.
 */
export { MAX_UNVERIFIABLE_REASON_LENGTH } from "../wire-limits.js";

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
  /**
   * Whether a barcode can be searched directly. Measured false at Newegg and
   * Amazon. Where true, the barcode is asked first, before anything is bought
   * to identify the item — see `barcodeQuery` and `resolveItem`.
   *
   * ⚠️ The barcode query is still subject to `maxNumericQueryDigits`: a
   * retailer that answers barcodes must not also cap numeric queries below
   * 12 digits, or the barcode is refused locally like any other.
   */
  readonly barcodeIsSearchable: boolean;
  /**
   * Whether a part number at this retailer names a product only together with
   * its brand.
   *
   * 🔴 **Measured at B&H**, whose catalogue spans photo, video, audio and
   * computing: the MFR # of four rows the investigation found B&H does not
   * carry each belonged to ANOTHER brand's item there — "29538" a C2G cable,
   * "10174" an Aquatech housing, "63005" a SIG SAUER scope, "30206" an
   * Aquatica port. An equal part number alone would have spent a probe on
   * each and proposed a cable for a wrist rest.
   *
   * Where true, once the item's brand is known:
   * - a listing is a candidate only when it has part-number evidence AND its
   *   brand agrees with the item's — never probed, never proposed otherwise;
   * - the bare part number is asked BEFORE the brand-scoped one, because the
   *   brand is checked on every answer, and a search that requires every word
   *   is narrowed by a client's brand spelling to nothing (measured at B&H:
   *   brand-scoped queries found none of 9, the bare MFR # all 11 it carries).
   *
   * ⚠️ A listing found by the barcode is untouched: the barcode names the
   * product, and nothing is known about the item's brand at that stage.
   * Where false, every plan and every ranking is what it always was.
   */
  readonly partNumberNeedsBrand: boolean;
}

/**
 * How hard a retailer may be pressed.
 *
 * 🔑 **A fallback, not the setting.** How many pages a competitor is read at
 * once is operational tuning — one retailer's page time was measured at 20 s
 * one day and 1-3 min the day before — so it lives in the gateway's retailer
 * registry and arrives with the job, where it can change without a rebuild and
 * a re-pin. This is what the runtime uses only when a gateway that predates the
 * field sends none. Required, so the next adapter must state its answer.
 *
 * ⚠️ Pages within one item are fetched one after another, so pages at once is
 * the number of items (or listings) worked at once.
 */
export interface Pacing {
  readonly pagesAtOnce: number;
}

/**
 * The most pages any competitor is read at once, whatever the job or the
 * adapter asks for.
 *
 * 🔴 **A politeness rule, not a tuning value** (the lead, 2026-11-10, on
 * Jody's rule of two to four parallel fetches). The registry can lower a
 * competitor below it; nothing can raise one above it, so a mistyped registry
 * row cannot turn a run into a burst the retailer reads as an attack.
 */
export const MAX_PAGES_AT_ONCE = 4;

/**
 * How many pages to read at once: the job's figure, else the adapter's, never
 * more than `MAX_PAGES_AT_ONCE` and never fewer than one.
 *
 * Pure, and written once for both run kinds — a resolution run and a read run
 * are the same pages through the same proxy.
 */
export function pagesAtOnce(requested: number | null, pacing: Pacing): number {
  const wanted = requested ?? pacing.pagesAtOnce;
  return Math.min(MAX_PAGES_AT_ONCE, Math.max(1, wanted));
}

/**
 * One product a retailer's own product index lists.
 *
 * 🔑 **Only what the index states**: an id, the url, and the name its url
 * spells. Costco's sitemap carries no barcode, no price and no brand field —
 * a brand is read off the name only where the name leads with it.
 */
export interface ProductIndexEntry {
  /** The retailer's own id for the product, in the form its pages state. */
  readonly itemId: string;
  /** The product page's url, ready to fetch. */
  readonly url: string;
  /** The name the index gives it, lower-case words. */
  readonly name: string;
}

/** What an item is known as, for finding it in a product index. */
export interface ProductIndexQuery {
  readonly brand: string | null;
  readonly partNumbers: readonly string[];
  /** The client's own name for the product, or `null` where none is known. */
  readonly productName: string | null;
}

/**
 * Where a retailer that cannot be searched lists what it sells.
 *
 * ── 🔴 Why this exists ───────────────────────────────────────────────
 *
 * Costco's search and category pages arrive as client-rendered shells: 40 of
 * 40 searches in the investigation, by barcode and by part number, came back
 * with 0 products, a search for an item Costco sells looking exactly like a
 * search for nonsense. Its product sitemap is the only server-side list of
 * what it sells online (about 18,180 products), so a candidate comes from
 * there, and the product page still proves it by barcode.
 *
 * ⚠️ **Read once per run, never per item** — see `IndexCache`. The files are
 * megabytes each, and every item of a run asks the same question of them.
 *
 * 🔑 **Two levels, as the retailer publishes it.** `urls` is the list of the
 * index's files (Costco's sitemap index), read FIRST so a product file the
 * retailer adds is read rather than missed silently; `parseListing` names the
 * product files in it, and `parse` reads each of those.
 *
 * Every function here is pure, like the rest of the seam.
 */
export interface ProductIndex {
  /** The index's own list of files, read before anything else. */
  readonly urls: readonly string[];
  /**
   * Shortest body accepted as that list.
   *
   * ⚠️ **Its own figure, not the fetcher's page minimum.** Costco's sitemap
   * index is a real 1,547-byte file, below the 2,000 bytes a fetcher takes as
   * the least a page can be — the investigation lost it once to exactly that.
   */
  readonly minListBytes: number;
  /** The list's body -> the product files it names, or `null` if it is no list. */
  parseListing(body: string): string[] | null;
  /**
   * Fewest products a whole index holds. Fewer means a file cut short or a
   * file that changed shape, and the read is refused rather than trusted:
   * a short index makes every item it lacks look not carried.
   */
  readonly minEntries: number;
  /**
   * Most product files a whole index may name. More, and the read is refused
   * before any of them is fetched.
   *
   * 🔴 **The list is the retailer's to write**, and every file it names is a
   * paid request of megabytes: a list that grew to hundreds of files — or was
   * answered by something that is not the retailer's index — would spend a
   * run's budget before the first item is looked up. A refused read is a
   * failure for every item, never a miss.
   */
  readonly maxFiles: number;
  /** A product file's body -> its entries, or `null` if it is no product file. */
  parse(body: string): ProductIndexEntry[] | null;
  /**
   * The entries worth probing for an item, best first.
   *
   * 🔴 **Every candidate returned matched the item by the word its name leads
   * with** — the item's brand, or a product-line word of the client's name
   * for it. Resolution leans on that: an index states no model, so this match
   * is the floor that sends a candidate whose page publishes no barcode to a
   * person as `unverifiable` (Jody's rule). It is never the floor for
   * `unconfirmed`, and never for `verified`.
   *
   * 🔴 A candidate's `brand` is set only where the entry's name leads with
   * the item's brand — never invented from a name that does not say it.
   */
  candidates(
    entries: readonly ProductIndexEntry[],
    query: ProductIndexQuery,
  ): ParsedCandidate[];
}

export interface RetailerAdapter {
  /**
   * The registry slug — a string, deliberately. Retailer capability is a row in
   * `aeo-backend`'s retailer registry, not a constant here.
   */
  readonly slug: string;

  readonly querySupport: QuerySupport;

  /** Pages at once when the job does not say. See `Pacing`. */
  readonly pacing: Pacing;

  /**
   * The only hosts this competitor's listings live on, lower-case, exact —
   * the same list its `ListingReader` states.
   *
   * 🔴 **A listing off them is never probed, never proposed** (see
   * `isOwnHostUrl`): its url comes from a page the competitor controls, is
   * fetched through a paid proxy, and is persisted as a link everyone sees.
   */
  readonly hosts: readonly string[];

  /**
   * How this competitor's pages are fetched: its searches and its product
   * pages, never the client's catalogue or the search engine.
   */
  readonly fetchProfile: FetchProfile;

  /**
   * Ceiling on product-page probes per item at this retailer, or `null` for
   * the run's default (`ResolveOptions.maxProbes`). Required, so the next
   * adapter states its answer.
   */
  readonly maxProbes: number | null;

  /**
   * Where this retailer lists what it sells, for a retailer that cannot be
   * searched — or `null` for one that can.
   *
   * 🔑 **Required, so the next adapter states its answer.** Where set, an
   * item's candidates come from the index instead of from searches, and
   * `parseSearchResults` is never called.
   */
  readonly productIndex: ProductIndex | null;

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

  /**
   * Raw product-page body -> the fields resolution needs, or `null` when the
   * body is not a product page at all. Pure.
   *
   * 🔴 **`null` is not "publishes no barcode".** A product shell, a
   * replacement page or a page with no product payload says nothing about
   * the listing; the pipeline counts it as a probe nobody answered — exactly
   * as it counts a page that could not be fetched — never as a listing that
   * publishes no barcode, which would make the item `unverifiable` on the
   * strength of a page that was never the product's.
   */
  parseProductPage(html: string): ParsedProduct | null;
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
  /** The page's breadcrumb category, as `ParsedProduct.category` reads it. */
  readonly category: ListingCategory | null;
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
  /** Pages at once when the read job does not say. See `Pacing`. */
  readonly pacing: Pacing;
  /** How this competitor's listing pages are fetched. */
  readonly fetchProfile: FetchProfile;
  /** Raw product-page body -> what it says. Pure. */
  readListingPage(html: string): ListingPageResult;
}

/** One product a category page lists, and what its card says. */
export interface CategoryCard {
  /**
   * The listing's id, in exactly the form a search names it — so a card
   * finds the watched listing it prices.
   */
  readonly itemId: string;
  /**
   * The price the card offers it at, or `null` where it shows none: a price
   * withheld, a card with no offer. 🔴 **Never 0** — a price that reads 0 is
   * not a price, and a card with none is never a free product.
   */
  readonly priceCents: number | null;
  /** `null` where the card states no availability this build recognises. */
  readonly inStock: boolean | null;
}

/** One page of a category, read. */
export interface CategoryPage {
  /** Every product the page lists, in page order, once each. */
  readonly products: readonly CategoryCard[];
  /**
   * How many products the retailer says the whole category holds, or `null`
   * where it states no count this build trusts.
   *
   * ⚠️ **A claim, not a promise that a walk reaches them all.** Newegg states
   * a count its browsing stops short of; whether a category is read whole is
   * the walk's decision, against the competitor's browse ceiling.
   */
  readonly total: number | null;
  /**
   * The last page number the retailer says this category has, or `null`
   * where the page does not say. A walk need never buy the page past it.
   */
  readonly lastPage: number | null;
}

/**
 * What a category reader made of a body.
 *
 * Three answers, because the walk does three different things with them:
 * - `page`: a page of the category, and every product on it;
 * - `end`: the retailer saying there is no such page — the walk is done;
 * - `not-a-category-page`: a refusal, a robot check, a product page, a search
 *   page, an empty body, a page cut short — nothing about the category.
 *
 * 🔴 **`not-a-category-page` is a failure, never an empty category.** Reading
 * a block page as "nothing on this page" would end a walk early and leave
 * every product after it looking as if the category no longer lists it.
 */
export type CategoryPageResult =
  | { readonly kind: "page"; readonly page: CategoryPage }
  | { readonly kind: "end"; readonly detail: string }
  | { readonly kind: "not-a-category-page"; readonly detail: string };

/**
 * Reading a retailer's category pages: one page, every product it lists.
 *
 * 🔑 **A third seam, beside `RetailerAdapter` and `ListingReader`**, for the
 * same reason the second is one: the paths that do not read categories keep
 * their types untouched. Pure, like the others — it builds addresses and
 * parses bodies, and never fetches.
 */
export interface CategoryReader {
  /**
   * The address of page `n` (1-based) of the category at `categoryUrl`, or
   * `null` when `categoryUrl` is not a category address on this retailer's
   * own hosts, or `n` is not a whole page number.
   */
  pageUrl(categoryUrl: string, n: number): string | null;
  /** The body served for page `n` -> what it says. Pure. */
  readCategoryPage(html: string, n: number): CategoryPageResult;
}

/**
 * Whether a competitor's categories can be read, as each adapter states it.
 *
 * Required, so the next adapter states its answer: `null` for a retailer
 * whose category pages carry no products a server-side read can see.
 */
export interface CategoryReading {
  readonly categoryReader: CategoryReader | null;
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
