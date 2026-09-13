import type {
  ParsedCandidate,
  ParsedProduct,
  QuerySupport,
  RetailerAdapter,
} from "./types.js";

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

export function parseSearchResults(html: string): ParsedCandidate[] {
  const out: ParsedCandidate[] = [];
  const seen = new Set<string>();

  for (const cell of splitResultCells(html)) {
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
    });
  }

  return out;
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

export const amazonAdapter: RetailerAdapter = {
  slug: "amazon",
  querySupport: QUERY_SUPPORT,
  buildSearchUrl: (query) =>
    `https://www.amazon.com/s?k=${encodeURIComponent(query)}`,
  parseSearchResults,
  parseProductPage,
};
