/**
 * Turning what is known about an item into an ordered list of things to ask the
 * retailer.
 *
 * Separated from identity deliberately: the spike built its query attempts
 * inside identity resolution, which meant the ordering could not be reasoned
 * about or checked without a search-engine page in hand. What to *ask* is a
 * pipeline decision that depends on the retailer's own limits; what the item
 * *is* is a fact about the item.
 *
 * Pure. Ordered most precise first, so a cheap precise hit costs one request.
 */

import { canQuery, type QuerySupport } from "./adapters/types.js";
import { gtinCore } from "./gtin.js";
import { manufacturerItemRef } from "./identity/from-barcode.js";
import { partNumberStem } from "./identity/from-search-results.js";

export interface QueryPlanInput {
  readonly barcode: string;
  readonly brand: string | null;
  /** Part-number candidates, best first. */
  readonly partNumbers: readonly string[];
  /**
   * The part number the CLIENT's own list states, or `null`.
   *
   * 🔴 **Not the same as `partNumbers` being non-empty.** Those include
   * candidates inferred from a search engine's page for the barcode, which
   * are often not the product's part number at all (`HTTPS`, measured). Only
   * the client's own part number is an exact key worth sparing the
   * spelled-out name for.
   */
  readonly clientPartNumber: string | null;
  /** A phrase to fall back on when no part number is known. */
  readonly phrase: string | null;
  /**
   * What the CLIENT calls the product, from their own list.
   *
   * 🔑 **Always tried as written**, because that is what the retailer's own
   * search box is good at: "X870 TAICHI CREATOR" returns the item on the
   * first page where "ASRock X870" returns nothing. Where the item has no part
   * number from the client it is ALSO tried spelled out, right after and only
   * if that found nothing — see `spelledOutName` and `planSearch`.
   * A brand is never prefixed onto a name that already leads with it:
   * "ASRock ASRock X870 Taichi" is a query no catalogue answers.
   */
  readonly productName: string | null;
}

/**
 * The barcode, as a query, for a retailer that answers one — or `null`.
 *
 * 🔑 **Its core zero-padded to 12 digits, or to 13 when the core is longer**:
 * the UPC-A form the retailers measured answer, and EAN-13 for a barcode that
 * does not fit one. `null` when the retailer cannot search a barcode, or the
 * value is not a barcode at all — `gtinCore` refuses a digit run outside a
 * barcode width rather than mining digits out of a part number.
 */
export function barcodeQuery(
  barcode: string,
  support: QuerySupport,
): string | null {
  if (!support.barcodeIsSearchable) return null;
  const core = gtinCore(barcode);
  if (core === "") return null;
  return core.padStart(core.length > 12 ? 13 : 12, "0");
}

/**
 * Micro Center's shorthand, and the word each one stands for.
 *
 * 🔑 **Measured, not guessed**: every entry is a whole word in Micro Center's
 * own motherboard names (227 rows, 2026-11-12), written in full elsewhere in
 * the same list — `WF` 46 times beside `WIFI` 43, `GAM` 12 beside `GAMING` 37, `XHAIR` 2
 * beside `CROSSHAIR` 5.
 * A retailer whose search needs every word answers none of them: Newegg finds
 * nothing for `MAG X870E TOMAHAWK MAX WF` and the product first for
 * `MSI MAG X870E TOMAHAWK MAX WIFI`.
 *
 * 🔴 **Only words that mean nothing else.** `AX`, `PRO`, `ICE`, `MAX`, `ATX`,
 * `MATX`, `II`, `WS` and `EEB` are shorthand-shaped and also real words in
 * somebody's product name, and `D4`/`D5` are also cameras — rewriting any of
 * them would turn a right query into a wrong one. They stay as written.
 */
const SHORTHAND: ReadonlyMap<string, string> = new Map([
  ["WF", "WIFI"],
  ["WF7", "WIFI7"],
  ["WF6E", "WIFI6E"],
  ["GAM", "GAMING"],
  ["AOR", "AORUS"],
  ["MASTR", "MASTER"],
  ["XTRM", "XTREME"],
  ["TOMHWK", "TOMAHAWK"],
  ["CREATR", "CREATOR"],
  ["ELTE", "ELITE"],
  ["XHAIR", "CROSSHAIR"],
]);

/** Whitespace-separated words, empty ones dropped. */
const wordsOf = (text: string): string[] =>
  text.split(/\s+/).filter((w) => w !== "");

/**
 * The client's name as a retailer's search reads it: the brand first, unless
 * the name already leads with it, and the shorthand written out.
 *
 * ⚠️ **Whole words only**: `WFH` and `AORUSX` are not `WF` and `AOR`, and a
 * hyphenated `WF-7` is left as written.
 */
export function spelledOutName(name: string, brand: string | null): string {
  const words = wordsOf(name);
  const brandWords = wordsOf(brand ?? "");
  // 🔴 Read off the name AS WRITTEN: a brand that is itself shorthand-shaped
  // (`AOR`) still leads its own name, and is never rewritten.
  const leadsWithBrand =
    words.slice(0, brandWords.length).join(" ").toUpperCase() ===
    brandWords.join(" ").toUpperCase();
  const lead = leadsWithBrand ? words.slice(0, brandWords.length) : brandWords;
  const rest = words
    .slice(leadsWithBrand ? brandWords.length : 0)
    .map((w) => SHORTHAND.get(w.toUpperCase()) ?? w);
  return [...lead, ...rest].join(" ");
}

/** Whether two queries are one to a search box: spacing and case aside. */
const sameQuery = (a: string, b: string): boolean =>
  wordsOf(a).join(" ").toUpperCase() === wordsOf(b).join(" ").toUpperCase();

/** The ordered attempts, and which of them depend on an earlier one. */
export interface QueryPlan {
  /** Every attempt, in order — conditional ones in their place. */
  readonly queries: string[];
  /**
   * 🔑 A query asked ONLY IF another, asked before it, was answered with an
   * empty results page — keyed by the conditional query, valued by the one
   * whose empty answer opens it. A failed fetch, or a page that was not a
   * results page, says nothing about the query and opens nothing.
   */
  readonly askedOnlyIfEmpty: ReadonlyMap<string, string>;
}

/**
 * How many attempts are worth making before a query is just noise — not
 * counting the barcode, which a retailer that answers one is asked first.
 */
export const MAX_QUERY_ATTEMPTS = 6;

/**
 * The ordered attempts.
 *
 * The ordering is the spike's, and its reasoning holds: a part number is a
 * retailer's strongest key — `?d=TL-SG1005D` returns 2 exact results where the
 * product name returns 44 — so a published part number goes first, brand-scoped
 * ahead of bare. The barcode-derived item reference goes near the front but
 * *behind* the top published candidate, because it is measured right 3 times
 * out of 4 and wrong in a way nothing about the answer reveals.
 *
 * 🔑 **Every attempt is filtered through the retailer's own limits**, so a query
 * the retailer is known to refuse is never spent. The launch retailer routes a
 * numeric query of 10 or more digits to an error page; a 9-digit numeric part
 * number is fine. That is configuration, read here, not a branch on a name.
 */
export function planQueries(
  input: QueryPlanInput,
  support: QuerySupport,
): string[] {
  return planSearch(input, support).queries;
}

/** `planQueries`, with the attempts that are asked only on an empty answer. */
export function planSearch(
  input: QueryPlanInput,
  support: QuerySupport,
): QueryPlan {
  const attempts: string[] = [];
  const askedOnlyIfEmpty = new Map<string, string>();
  const push = (q: string | null | undefined): void => {
    if (q == null) return;
    const trimmed = q.trim();
    if (trimmed === "") return;
    if (!canQuery(support, trimmed)) return;
    if (!attempts.includes(trimmed)) attempts.push(trimmed);
  };

  /**
   * 🔑 **The barcode first, where the retailer answers one.** It is the one key
   * that names exactly this product, so a hit is proven by the same value that
   * found it, and the identity lookup is never bought. ⚠️ Read from the
   * retailer's configuration, never from its name; where the switch is off,
   * nothing is pushed and every plan is what it always was.
   *
   * 🔴 **Outside `MAX_QUERY_ATTEMPTS`.** Counted among the six, it pushed the
   * plan's last query off the end — for an item with several part numbers,
   * the client's own name — so a retailer that answers barcodes was asked
   * one question fewer about the item than one that does not.
   */
  const barcode = barcodeQuery(input.barcode, support);
  push(barcode);
  const first = attempts.length;

  const { brand } = input;
  const itemRef = manufacturerItemRef(input.barcode);

  input.partNumbers.forEach((partNumber, i) => {
    // After the single best published candidate, the free derivation is worth
    // trying — for many brands the item reference IS the catalogue number.
    if (i === 1 && itemRef !== null && brand !== null)
      push(`${brand} ${itemRef}`);
    // Where the brand is checked on every answer, the bare part number goes
    // first — see `QuerySupport.partNumberNeedsBrand`.
    if (support.partNumberNeedsBrand) {
      push(partNumber);
      if (brand !== null) push(`${brand} ${partNumber}`);
    } else {
      if (brand !== null) push(`${brand} ${partNumber}`);
      push(partNumber);
    }
    const stem = partNumberStem(partNumber);
    if (stem !== null) push(brand !== null ? `${brand} ${stem}` : stem);
  });

  // Also covers the case of fewer than two published candidates.
  if (itemRef !== null && brand !== null) push(`${brand} ${itemRef}`);

  /**
   * 🔴 **The client's own description, which was never tried.**
   *
   * Measured on a real review case (X870 TAICHI CREATOR, 2026-09-15): the six
   * attempts were `ASRock X870`, `X870`, `ASRock A0UAYZ`, `A0UAYZ`,
   * `ASRock HTTPS` and `HTTPS` — every one a no-result, while the retailer's
   * own search returns the product for its name on the first page. The item
   * had no part number supplied, so the plan had nothing but a derivation and
   * junk to work with.
   *
   * ⚠️ **It goes AFTER the published candidates and the derivation, not
   * before.** A part number is an exact key; a name is a phrase that a
   * retailer's search will answer with a page of near-misses, and the ranker
   * then has to tell a sibling size or a regional variant apart from the real
   * thing. It is a fallback, which is exactly what it was asked to be.
   *
   * 🔑 It sits before the INFERRED phrase deliberately: this is what the
   * customer says the product is, and that is worth more than a phrase we
   * assembled from somebody else's result titles.
   *
   * 🔴 **Then spelled out, where the client gave no part number — and only
   * if the name as written found nothing.** Measured in production on
   * 2026-11-12: 25 of Micro Center's 227 motherboards were filed
   * `not_carried` at Newegg after one query — this name, unbranded and in
   * shorthand — and no candidate. Newegg's search needs every word, so
   * `ROG STRIX B850-A GAM WF` answers nothing while
   * `ASUS ROG STRIX B850-A GAMING WIFI` answers 36.
   *
   * ⚠️ **A fallback, never a second ask.** 220 of those 227 names differ when
   * spelled out, so asking both would buy ~220 searches a run per retailer
   * that the name as written already answers. It is planned here, in its
   * place, and `askedOnlyIfEmpty` tells the search loop when to skip it.
   * Nothing is planned where the two forms are one query to a search box.
   *
   * ⚠️ **A row whose client gave a part number is asked exactly what it was
   * asked before**: its exact key is already on the plan.
   */
  const asWritten = input.productName?.trim() ?? "";
  push(asWritten);
  if (asWritten !== "" && input.clientPartNumber === null) {
    const spelledOut = spelledOutName(asWritten, brand);
    if (
      !sameQuery(spelledOut, asWritten) &&
      attempts.includes(asWritten) &&
      !attempts.includes(spelledOut)
    ) {
      push(spelledOut);
      if (attempts.includes(spelledOut))
        askedOnlyIfEmpty.set(spelledOut, asWritten);
    }
  }
  push(input.phrase);

  const queries = [
    ...attempts.slice(0, first),
    ...attempts.slice(first, first + MAX_QUERY_ATTEMPTS),
  ];
  // A conditional attempt cut off the end is not on the plan at all. (It
  // always follows the attempt that opens it, so that one is never cut alone.)
  for (const query of [...askedOnlyIfEmpty.keys()])
    if (!queries.includes(query)) askedOnlyIfEmpty.delete(query);
  return { queries, askedOnlyIfEmpty };
}
