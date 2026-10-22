import type {
  ListingPageResult,
  ListingReader,
  ParsedCandidate,
  ParsedProduct,
  QuerySupport,
  RetailerAdapter,
} from "./types.js";
import { safeImageUrl } from "./types.js";

/**
 * The Amazon adapter.
 *
 * 🔑 **Parsed with scoped string matching, not a DOM library, and that is a
 * deliberate cost.** This package has *zero* production dependencies; the
 * launch retailer's adapter reads an embedded JSON blob and needs none. Amazon
 * publishes no such blob — every field lives in deeply nested, heavily-classed
 * HTML — so the obvious move is to add a parser. It is not worth a first
 * production dependency for the four fields resolution actually reads, and the
 * boundaries below are anchored on attributes Amazon uses structurally
 * (`data-asin`, `data-component-type`, `prodDetSectionEntry`) rather than on
 * presentational classes that move.
 *
 * ⚠️ **Weaker upstream signal than the launch retailer, by construction.**
 * Newegg publishes structured `ItemManufactory.Manufactory` and `ItemCell.Model`
 * fields. Amazon publishes neither at the search stage, so `brand` here is a
 * *guess* — the leading word of the title — and `model` is `null` rather than
 * invented. The barcode gate is what keeps that safe: a guessed brand narrows
 * which pages are worth probing and never decides a pairing.
 */

/**
 * The result-cell boundary.
 *
 * ⚠️ **A cell starts at the enclosing `<div`, not at this marker.** The ASIN is
 * an attribute on the same tag and appears *before* `data-component-type` in
 * it, so splitting on the marker would cut every cell's own identifier into the
 * cell above. Measured on a real captured page: anchoring on the marker alone
 * yields 16 cells and 15 usable ones.
 */
const RESULT_MARKER = 'data-component-type="s-search-result"';

/**
 * The container Amazon wraps a search's results in — present whether the
 * search matched sixteen listings or none.
 *
 * 🔴 **Necessary, not sufficient.** Measured on two real no-results pages
 * captured through the proxy on 2026-10-22: each carries this container
 * exactly once and no result cell at all, as does the committed page of
 * sixteen results. A robot check or an error page carries neither — and before
 * this existed both read as "no results", so a blocked search reached the
 * customer as "Amazon does not carry this". But the container arrives early in
 * the body, so a TRUNCATED page carries it too; see `NO_RESULTS_WIDGET` for
 * what an empty answer additionally needs.
 *
 * ⚠️ The closing quote matters: without it this would also match every
 * `s-search-result` cell, and a lone cell is not a results page.
 */
const RESULTS_CONTAINER = 'data-component-type="s-search-results"';

/**
 * Amazon's own "No results for …" message, by its widget id.
 *
 * 🔴 **An empty page is an answer only when Amazon says it is.** A page with
 * the container and no result cells is either Amazon saying nothing matched or
 * a body cut short before the first cell arrived — and the two must not be
 * confused, because the first is filed as "not carried". Measured on the
 * committed no-results capture: this widget id appears once, inside the
 * results container. It is absent from the page of sixteen results.
 */
const NO_RESULTS_WIDGET = "widgetId=messaging-messages-no-results";

const ASIN = /^<div[^>]*\sdata-asin="([^"]*)"/;
const TITLE = /<h2[^>]*\saria-label="([^"]*)"/;

/**
 * The price the listing is actually offered at.
 *
 * 🔴 **`class="a-price"` exactly — a discounted listing carries three
 * `a-offscreen` values and only the first is the real one.** Measured on one
 * captured cell: `$119.99` inside `class="a-price"`, then `List: $129.99` as
 * loose text, then `$129.99` inside `class="a-price a-text-price"` with
 * `data-a-strike="true"`. Matching `a-offscreen` loosely, or accepting any
 * span whose class *contains* `a-price`, reports the struck-through list price
 * as the competitor's price — an overstatement of exactly the number this
 * product exists to report.
 */
/**
 * The product thumbnail.
 *
 * 🔴 **Anchored on `s-image`, because a result cell holds other images.**
 * Amazon's own chrome — sprites, badges, a Prime logo — sits in the same
 * markup, and the first `<img>` in a cell is routinely not the product.
 *
 * ⚠️ `[^>]*` before `src` rather than a bounded run: the tag carries a
 * `srcset` listing four resolutions, so it is comfortably longer than any
 * cap worth writing. That length is also what made a first reading of this
 * page report no images at all.
 */
const IMAGE = /<img[^>]*\sclass="[^"]*\bs-image\b[^"]*"[^>]*\ssrc="([^"]+)"/;

const PRICE =
  /<span class="a-price"[^>]*>\s*<span class="a-offscreen">([^<]*)</;

/**
 * A row of the product-details table.
 *
 * Anchored on Amazon's own `prodDetSectionEntry` / `prodDetAttrValue` class
 * pair, which is the structure the table is built from rather than a styling
 * choice.
 */
const DETAIL_ROW =
  /prodDetSectionEntry"[^>]*>([\s\S]{0,160}?)<\/th>[\s\S]{0,240}?prodDetAttrValue"[^>]*>([\s\S]{0,160}?)</g;

/**
 * Every label Amazon has been observed to publish a barcode under.
 *
 * 🔴 **`upc` alone is not enough, and assuming it was cost real time.** The
 * handover's own recon states that every product page checked exposes a row
 * labelled `UPC` — and the single product page committed alongside it does not:
 * it publishes a valid EAN-13 under **`Global Trade Identification Number`**.
 * An extractor keyed on `UPC` returns nothing on that page.
 *
 * ⚠️ **This is also how a reviewer of this repo concluded Amazon publishes no
 * barcode at all.** Searching a captured page for `UPC`, `EAN` and `GTIN`
 * returned only noise, and absence was reported from a search that could not
 * have found what was there under a spelled-out name. Read the table's labels;
 * do not guess them.
 */
const BARCODE_LABELS: ReadonlySet<string> = new Set([
  "upc",
  "ean",
  "gtin",
  "global trade identification number",
  "global trade item number",
]);

/**
 * ⚠️ **No measured refusal, so no limit is claimed.** The launch retailer routes
 * a numeric query of 10+ digits to an error page, which is why that field
 * exists. Amazon has not been observed to refuse any query shape: a bare
 * five-digit part number is *answered*, with a page of unrelated products.
 * That is noise, not a refusal, and `canQuery` can only express a refusal —
 * so stating a limit here would decline queries the retailer would have served.
 * Noise is the ranking's problem and the barcode gate's; it is not this field's.
 */
const QUERY_SUPPORT: QuerySupport = {
  maxNumericQueryDigits: null,
  barcodeIsSearchable: false,
};

/** The handful of entities Amazon emits inside attribute values. */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

/** Tags stripped, whitespace (including Amazon's bidi marks) collapsed. */
function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ""))
    .split(/[\s‎‏]+/)
    .join(" ")
    .trim();
}

/**
 * `$1,234.56` -> `123456`.
 *
 * Returns `null` rather than 0 for an unparseable value: a listing whose price
 * could not be read is not a free one.
 */
function priceCentsOf(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const match = /([0-9][0-9,]*)\.([0-9]{2})/.exec(raw);
  if (match === null) return null;
  const whole = Number((match[1] ?? "").replace(/,/g, ""));
  const fraction = Number(match[2] ?? "");
  if (!Number.isFinite(whole) || !Number.isFinite(fraction)) return null;
  return whole * 100 + fraction;
}

/** The raw HTML of each result cell, in page order. */
export function splitResultCells(html: string): string[] {
  const starts: number[] = [];
  let cursor = 0;
  for (;;) {
    const marker = html.indexOf(RESULT_MARKER, cursor);
    if (marker < 0) break;
    const open = html.lastIndexOf("<div", marker);
    if (open >= 0) starts.push(open);
    cursor = marker + RESULT_MARKER.length;
  }
  return starts.map((start, i) =>
    html.slice(start, i + 1 < starts.length ? starts[i + 1] : html.length),
  );
}

/**
 * Candidates from a search page: `[]` for a results page that holds none, and
 * `null` for a page that is not a results page — see the seam's contract.
 */
export function parseSearchResults(html: string): ParsedCandidate[] | null {
  if (!html.includes(RESULTS_CONTAINER)) return null;

  const cells = splitResultCells(html);
  // No cells: an answer only if Amazon said "no results" in so many words.
  if (cells.length === 0) return html.includes(NO_RESULTS_WIDGET) ? [] : null;

  const out: ParsedCandidate[] = [];
  const seen = new Set<string>();

  for (const cell of cells) {
    const itemId = ASIN.exec(cell)?.[1]?.trim();
    if (itemId === undefined || itemId === "") continue;
    if (seen.has(itemId)) continue;

    const rawTitle = TITLE.exec(cell)?.[1];
    if (rawTitle === undefined) continue;
    const title = decodeEntities(rawTitle).trim();
    if (title === "") continue;

    seen.add(itemId);

    out.push({
      itemId,
      // Built from the ASIN rather than lifted from the cell's href, which
      // carries click-tracking query parameters that are neither canonical nor
      // stable between captures of the same page.
      url: `https://www.amazon.com/dp/${itemId}`,
      // 🔴 Amazon publishes no model or part number at the search stage. `null`
      // says so; a guess here would be scored as published evidence.
      model: null,
      title,
      // A guess, and the docblock above says why it is tolerable.
      brand: title.split(/\s+/)[0] ?? null,
      priceCents: priceCentsOf(PRICE.exec(cell)?.[1]),
      // No out-of-stock example has been captured, so absence of the phrase is
      // the only available signal. Recorded, never inferred from anything else.
      inStock: !cell.includes("Currently unavailable"),
      // 🔴 `null`, never `true`. Amazon exposes no seller at the search stage,
      // and the contract is explicit that unknown must not become
      // "first-party" — a marketplace listing publishes the SELLER's barcode,
      // which is the whole reason ranking cares.
      isFirstParty: null,
      sellerName: null,
      imageUrl: safeImageUrl(IMAGE.exec(cell)?.[1] ?? null),
    });
  }

  // 🔴 Cells and not one readable: the markup has moved under us. That is not
  // Amazon saying nothing matched, and reading it as `[]` would file every
  // item on the list as not carried the day Amazon renames an attribute.
  return out.length === 0 ? null : out;
}

export function parseProductPage(html: string): ParsedProduct {
  const values: string[] = [];
  DETAIL_ROW.lastIndex = 0;
  let row: RegExpExecArray | null;
  while ((row = DETAIL_ROW.exec(html)) !== null) {
    const label = textOf(row[1] ?? "")
      .toLowerCase()
      .replace(/[:：]\s*$/, "");
    if (!BARCODE_LABELS.has(label)) continue;
    // 🔴 One field, possibly several barcodes. A real product page publishes
    // `812348010548 191120055664` in a single cell and the client's value was
    // one of the two. Handing the raw field on would be worse than dropping
    // it: the two concatenate to 24 digits, core to nothing, and read as a
    // barcode that DISAGREES rather than as nothing to compare.
    for (const token of textOf(row[2] ?? "").split(/\s+/)) {
      if (token !== "" && !values.includes(token)) values.push(token);
    }
  }

  return {
    // Verbatim. Amazon zero-pads to GTIN-14 where the launch retailer does not;
    // reconciling encodings is `gtinCore`'s job at compare time, not the
    // adapter's, and normalising here would discard what the retailer said.
    barcode: values[0] ?? null,
    additionalBarcodes: values.slice(1),
    // Price and stock are read from the search cell, which carries both. The
    // product page is fetched to settle identity, so probing it for figures the
    // caller already holds would spend a request's worth of parsing for nothing.
    priceCents: null,
    inStock: null,
    title: null,
  };
}

/**
 * A product page's own title — present on every product page and on no search
 * page or block page captured. It is how a body is recognised as a product page
 * at all.
 */
const PRODUCT_TITLE = 'id="productTitle"';

/** The page's own ASIN, from the hidden form field the buy box posts. */
const ASIN_INPUT = /<input\b[^>]*\bid="ASIN"[^>]*>/;
const VALUE_ATTRIBUTE = /\bvalue="([^"]*)"/;

/** The buy box, and the marker every buying option row carries. */
const BUYBOX = 'id="buybox"';
const OPTION_ROW = "data-a-accordion-row-name=";

/**
 * The offer's price-to-pay, inside one buying option.
 *
 * Its figure is in an `a-offscreen` span inside the `apex-pricetopay-value`
 * price; where that span is blank the figure is spelled out in
 * `a-price-whole` / `a-price-fraction`, so both are read.
 */
const PRICE_TO_PAY = /class="a-price\b[^"]*\bapex-pricetopay-value\b[^"]*"/;
const OFFSCREEN = /<span class="a-offscreen">([^<]*)</;
const WHOLE_AND_FRACTION =
  /a-price-whole">([0-9,]+)[\s\S]{0,120}?a-price-fraction">([0-9]{2})</;

/** The availability line inside one buying option. */
const AVAILABILITY = /primary-availability-message[^>]*>([^<]*)</;

/**
 * Amazon saying in so many words that there is no offer to read.
 *
 * ⚠️ **Matched as visible text, not as a string anywhere in the page.** The
 * committed page carries "No featured offers" inside a JSON label table it
 * ships to every product page; only a text node between tags is Amazon telling
 * this visitor so. No captured page shows it, so this is the wording Amazon
 * uses rather than a calibration.
 */
const NO_FEATURED_OFFER = />\s*No featured offers available\s*</i;

const DIV_TAG = /<div\b|<\/div\s*>/g;

/**
 * The element opening at `open`, by balancing `<div>` tags — or everything to
 * the end of the body when the page is cut short before it closes.
 */
function divAt(html: string, open: number): string {
  let depth = 0;
  DIV_TAG.lastIndex = open;
  let tag: RegExpExecArray | null;
  while ((tag = DIV_TAG.exec(html)) !== null) {
    depth += tag[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(open, DIV_TAG.lastIndex);
  }
  return html.slice(open);
}

/** The `<div` whose opening tag contains `marker` at `at`. */
function divOpening(html: string, at: number): number {
  return html.lastIndexOf("<div", at);
}

/**
 * The featured buying option: the buy box's first option row, or the buy box
 * itself when it holds no rows. `null` when the page has no buy box.
 *
 * 🔴 **Price and availability are both read from this one element.** The
 * committed page carries two buying options — the open one at $472.00 ("Only 8
 * left in stock") and a second at $479.99 ("In Stock") — and repeats both
 * further down the page. Reading each figure from wherever it first appears
 * would let a gap in one option be filled from another, pairing one offer's
 * price with another's stock.
 *
 * ⚠️ **One captured product page calibrates this.** On it the buy box opens
 * at offset 243,239 and its first row is offset 246,504 to 349,179.
 */
function featuredOffer(html: string): string | null {
  const box = html.indexOf(BUYBOX);
  if (box < 0) return null;
  const buybox = divAt(html, divOpening(html, box));
  const row = buybox.indexOf(OPTION_ROW);
  if (row < 0) return buybox;
  return divAt(buybox, divOpening(buybox, row));
}

/** `$0.00` is not a price: the same rule the launch retailer's reader keeps. */
function offerPriceCents(offer: string): number | null {
  const at = offer.search(PRICE_TO_PAY);
  if (at < 0) return null;
  const span = offer.slice(at, at + 1200);
  const parts = WHOLE_AND_FRACTION.exec(span);
  const cents =
    priceCentsOf(OFFSCREEN.exec(span)?.[1]) ??
    (parts === null
      ? null
      : priceCentsOf(`${parts[1] ?? ""}.${parts[2] ?? ""}`));
  return cents !== null && cents > 0 ? cents : null;
}

/**
 * `true` for "In Stock" and "Only 8 left in stock"; `false` for "Currently
 * unavailable", "Temporarily out of stock", "In stock soon" and "In Stock on
 * <date>" — the last two are a back-order, not stock; `null` for anything else.
 */
function offerInStock(offer: string): boolean | null {
  const text = AVAILABILITY.exec(offer)?.[1];
  if (text === undefined) return null;
  const said = textOf(text).toLowerCase();
  if (/out of stock|unavailable|in stock soon|in stock on\b/.test(said)) {
    return false;
  }
  if (/in stock/.test(said)) return true;
  return null;
}

/**
 * What a listing's own page says, for a read run.
 *
 * ⚠️ **The barcode is the resolution parse's**, by calling it: a reading and
 * the pairing it is checked against read the same labelled rows. Amazon has no
 * field it publishes empty, so a page publishing no barcode reads `null`.
 */
export function readListingPage(html: string): ListingPageResult {
  if (!html.includes(PRODUCT_TITLE)) {
    return { kind: "not-a-product-page", detail: "no product title" };
  }

  const offer = featuredOffer(html);
  const priceCents = offer === null ? null : offerPriceCents(offer);
  const inStock = offer === null ? null : offerInStock(offer);

  // 🔴 An offer in stock always has a price. In stock with none readable is a
  // buying option whose markup moved — not a listing with no price.
  if (inStock === true && priceCents === null) {
    return {
      kind: "unreadable-offer",
      detail: "the featured offer is in stock with no readable price",
    };
  }
  // Neither figure, and nothing saying there is no offer: unreadable too.
  if (
    priceCents === null &&
    inStock === null &&
    !NO_FEATURED_OFFER.test(html)
  ) {
    return {
      kind: "unreadable-offer",
      detail:
        offer === null
          ? "no buy box"
          : "the featured offer shows neither a price nor an availability",
    };
  }

  const asinTag = ASIN_INPUT.exec(html)?.[0];
  const asin =
    asinTag === undefined ? undefined : VALUE_ATTRIBUTE.exec(asinTag)?.[1];
  const product = parseProductPage(html);
  return {
    kind: "page",
    page: {
      pageItemId: asin === undefined || asin.trim() === "" ? null : asin.trim(),
      barcode: product.barcode,
      additionalBarcodes: product.additionalBarcodes,
      priceCents,
      inStock,
    },
  };
}

export const amazonAdapter: RetailerAdapter & ListingReader = {
  slug: "amazon",
  querySupport: QUERY_SUPPORT,
  buildSearchUrl: (query) =>
    `https://www.amazon.com/s?k=${encodeURIComponent(query)}`,
  parseSearchResults,
  parseProductPage,
  hosts: ["amazon.com", "www.amazon.com"],
  readListingPage,
};
