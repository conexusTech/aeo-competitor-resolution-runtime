/**
 * Identity inferred from a general search engine's result page.
 *
 * 🔴 **This is the inference §8 rejected, and it is the last resort on purpose.**
 * It is the origin of every observed mis-resolution in the handover run, and it
 * once matched a $3,727 server to a $13 accessory. It is ported rather than
 * dropped because it is the only source that works for an item whose catalogue
 * publishes nothing — and because the 53-row measured outcome split this row
 * must reproduce was produced through it, so it is the honest comparison.
 *
 * Everything here is pure. The page comes from the pipeline.
 */

import { gtinCore } from "../gtin.js";
import type {
  IdentityInput,
  IdentitySource,
  ProductIdentity,
} from "./types.js";

export const searchInferenceIdentitySource: IdentitySource = {
  provenance: "search-inference",
  requestCost: 1,
};

/**
 * Retailer names and commerce boilerplate. Result titles are written by
 * whoever is selling the thing, so without this the extracted "identity" is
 * frequently a shop's name.
 */
const RESULT_NOISE =
  /\b(amazon|walmart|ebay|newegg|target|bestbuy|b&h|staples|costco|com|ca|co\.uk|buy|online|price|prices|sale|shop|free shipping|in stock|review|reviews)\b/gi;

/**
 * Words shaped like part numbers that are specs, standards or units. Without
 * this the extractor cheerfully searches a retailer for "USB3" or "80MM".
 */
const NOT_A_PART_NUMBER = new Set([
  "USB",
  "USB2",
  "USB3",
  "HDMI",
  "LED",
  "LCD",
  "RGB",
  "PWM",
  "RPM",
  "DDR3",
  "DDR4",
  "DDR5",
  "80MM",
  "120MM",
  "140MM",
  "1080P",
  "4K",
  "2K",
  "AC",
  "DC",
  "PC",
  "MAC",
  "WIN",
  "AMD",
  "USB-A",
  "USB-C",
  "RJ45",
  "PS2",
  "VGA",
  "DVI",
  "3D",
  "2X",
  "3X",
  "4X",
  "5X",
  "10X",
  "GHZ",
  "MHZ",
  "MBPS",
  "GBPS",
  "POE",
  "UPS",
  "AVR",
  "EA",
  "PACK",
]);

/** Retail boilerplate that is part-number-shaped: "30-DAY", "2-YEAR", "4-PACK". */
const BOILERPLATE_SHAPE =
  /^\d+-(DAY|YEAR|MONTH|WEEK|HOUR|PACK|PC|PCS|PK|CT|IN)S?(-\d+)?$/;

/**
 * Part-number-shaped: 4-20 chars, hyphens allowed.
 *
 * 🔴 **The letter-and-digit test is applied to the TOKEN, and it used to be
 * applied to the whole run of non-space characters.** The shape was one regex
 * whose lookaheads read `(?=[^\s]*[A-Za-z])(?=[^\s]*\d)` — and `[^\s]*` runs
 * to the next space, not to the end of the token being consumed. So inside
 * `https://m.media-amazon.com/images/I/61ABC123.jpg` the digits in the
 * filename satisfied the lookahead while the consumed token was `https`, and
 * a page full of image URLs produced `HTTPS`, `MEDIA-AMAZON`, `IMAGES` and
 * `NEWEGG` as part-number candidates.
 *
 * ⚠️ **`HTTPS` then passed the recurrence filter by construction.** Every
 * search page carries more than one URL, so it appeared at least twice, which
 * is exactly the test meant to separate a real part number from a seller's
 * private id. Measured on a real review case (X870 TAICHI CREATOR,
 * 2026-09-15): `ASRock HTTPS` and `HTTPS` were searched, two of the seven
 * requests that item spent, and neither could ever have matched anything.
 */
const TOKEN_SHAPE = /\b[A-Za-z0-9][A-Za-z0-9-]{3,19}\b/g;

/** The test the lookaheads were meant to make, on the token itself. */
function hasLetterAndDigit(token: string): boolean {
  return /[A-Za-z]/.test(token) && /\d/.test(token);
}

export function resultTitles(html: string): string[] {
  return [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)]
    .map((m) =>
      (m[1] ?? "")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&#39;|&quot;/g, "")
        .trim(),
    )
    .filter((t) => t !== "");
}

/**
 * Candidate part numbers: tokens that recur across *several* sellers' titles.
 *
 * 🔑 The recurrence threshold is the whole idea. A product's real part number
 * appears in every retailer's listing for it; each retailer's own internal SKU
 * appears once. A one-off token is therefore usually somebody's private id, and
 * searching it finds nothing or, worse, finds the wrong thing.
 */
export function candidatePartNumbers(html: string, barcode: string): string[] {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    // Entity NAMES tokenise as part numbers ("quot") if left in.
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ");

  const core = gtinCore(barcode);
  const freq = new Map<string, number>();

  for (const match of text.matchAll(TOKEN_SHAPE)) {
    const token = match[0].toUpperCase();
    if (!hasLetterAndDigit(token)) continue;
    if (NOT_A_PART_NUMBER.has(token)) continue;
    if (BOILERPLATE_SHAPE.test(token)) continue;
    if (/^\d+$/.test(token)) continue; // bare numbers are prices and quantities
    if (core !== "" && gtinCore(token) === core) continue; // the barcode itself
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }

  return [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([token]) => token);
}

/**
 * `K72337WW` -> `K72337`. Manufacturers suffix part numbers by region, and a
 * retailer may stock the `US` variant under the same barcode, so the stem finds
 * the sibling the literal part number misses. `null` when there is no suffix.
 */
export function partNumberStem(partNumber: string): string | null {
  const m = /^(.*\d)(US|WW|EU|UK|CA|AU|JP|NA|INTL)$/.exec(partNumber);
  const stem = m?.[1];
  return stem !== undefined && stem.length >= 4 ? stem : null;
}

/** The first word of the first title, when it looks like a brand. */
export function inferBrand(titles: readonly string[]): string | null {
  const first = (titles[0] ?? "")
    .replace(/[^\w\s-]/g, " ")
    .trim()
    .split(/\s+/)[0];
  return first !== undefined && first.length >= 2 && !/^\d+$/.test(first)
    ? first
    : null;
}

/**
 * A searchable phrase built from the titles, for when no part number surfaced.
 *
 * Tokens are scored by how many *distinct* titles carry them: a product's real
 * brand and model words recur across every seller's listing, while each
 * seller's boilerplate does not. Kept in first-title order so the phrase reads
 * "brand model" rather than as a bag of words.
 */
export function inferPhrase(titles: readonly string[]): string | null {
  if (titles.length === 0) return null;

  const ascii = titles.filter((t) => /^[\x20-\x7E]+$/.test(t));
  const pool = (ascii.length > 0 ? ascii : titles).slice(0, 6);
  const head = pool[0];
  if (head === undefined) return null;

  const freq = new Map<string, number>();
  for (const title of pool) {
    const tokens = new Set(
      title
        .replace(RESULT_NOISE, " ")
        .replace(/[^\w\-/]+/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 2 && !/^\d{5,}$/.test(t))
        .map((t) => t.toLowerCase()),
    );
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  }

  const threshold = Math.max(2, Math.ceil(pool.length / 2));
  const keep = new Set(
    [...freq.entries()].filter(([, n]) => n >= threshold).map(([t]) => t),
  );

  const ordered: string[] = [];
  for (const word of head.replace(/[^\w\-/]+/g, " ").split(/\s+/)) {
    const lower = word.toLowerCase();
    if (keep.has(lower) && !ordered.includes(word)) ordered.push(word);
  }

  const phrase = ordered.slice(0, 6).join(" ").trim();
  return phrase.length >= 3
    ? phrase
    : head
        .replace(/\.\.\.$/, "")
        .slice(0, 60)
        .trim();
}

/** Everything this source can say, plus the extra candidates a query plan wants. */
export interface InferredIdentity extends Omit<
  ProductIdentity,
  "provenance" | "corroboratedBy"
> {
  /** Every part-number candidate, best first — not only the winner. */
  readonly partNumberCandidates: readonly string[];
  /** A searchable phrase, for when no part number surfaced at all. */
  readonly phrase: string | null;
}

export function identityFromSearchResults(
  input: IdentityInput,
): InferredIdentity | null {
  if (input.document === undefined) return null;

  const titles = resultTitles(input.document);
  const partNumbers = candidatePartNumbers(input.document, input.barcode);
  const brand = inferBrand(titles);
  const phrase = inferPhrase(titles);

  if (titles.length === 0 && partNumbers.length === 0) return null;

  // Stems are additional candidates, never replacements.
  const withStems = [
    ...new Set(
      partNumbers.flatMap((p) => {
        const stem = partNumberStem(p);
        return stem === null ? [p] : [p, stem];
      }),
    ),
  ];

  return {
    partNumber: partNumbers[0] ?? null,
    brand,
    title: titles[0] ?? null,
    partNumberCandidates: withStems,
    phrase,
  };
}
