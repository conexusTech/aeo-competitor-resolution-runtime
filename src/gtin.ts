/**
 * The barcode comparison key.
 *
 * 🔴 **This module exists because a byte comparison is wrong 18% of the time.**
 * Measured across the 22 proven pairings in the handover's 53-row run, the
 * retailer's own barcode field came back 18 twelve-digit, 2 thirteen-digit and 2
 * fourteen-digit — and **only 18 of 22 were byte-equal to the client's value**.
 * All four differences are zero-padded forms of the same UPC-A:
 *
 *   client 097855114693  ->  retailer 00097855114693
 *   client 619659075538  ->  retailer 0619659075538
 *
 * A false mismatch is the worst output this product can produce, because it
 * reads exactly like a real one.
 *
 * 🔑 **The comparison key is derived at compare time and never stored.** Storage
 * stays faithful to whatever the client sent — `aeo-backend` keeps a genuine
 * EAN-13 at 13 digits on purpose, because 1,081 of one real client's 8,926 items
 * are EAN-13s with no UPC-A equivalent and shortening one names a different
 * product. Storage is the record; the comparison key is a function of it.
 */

/** A GTIN with every leading zero stripped — the value all encodings share. */
export type GtinCore = string;

const DIGITS_ONLY = /\D/g;
const LEADING_ZEROS = /^0+/;

/**
 * Narrowest and widest GTIN encodings: GTIN-8 through GTIN-14. A digit run
 * outside this range is not a barcode in any encoding, whatever it is.
 */
const MIN_GTIN_DIGITS = 8;
const MAX_GTIN_DIGITS = 14;

/**
 * The digit core: non-digits removed, leading zeros stripped.
 *
 * UPC-A `012345678905`, EAN-13 `0012345678905` and GTIN-14 `00012345678905` are
 * the same product in three encodings, and they share exactly one thing — the
 * core. Comparing on it makes all three agree without altering any of them.
 *
 * ⚠️ Deliberately **not** a check-digit validator. It answers "what do these two
 * values have in common", which is a different question from "is this a real
 * barcode" — `isValidGtin` answers that, and the two are used at different
 * points. Folding them together would make a comparison refuse input it is only
 * being asked to compare.
 *
 * 🔴 **It does, however, refuse a digit run that is not a barcode width, and the
 * first version of this function did not — which was a live defect caught by its
 * own control test.** Stripping non-digits is right for a *formatted* barcode
 * (`0-12345-67890-5`) and catastrophic for a *part number*: `SQR-WKIT-R2` is a
 * real value from a real client's barcode column, and mining digits out of it
 * yielded `2`. `1PZ1ML00050` yields `100050`. Both would then have compared
 * equal to any other value coring to the same thing. **That is the "mine digits
 * from a non-barcode" failure `aeo-backend`'s upload explicitly refuses**, and it
 * would have arrived here through the back door of a comparison helper.
 */
export function gtinCore(value: string): GtinCore {
  const digits = value.replace(DIGITS_ONLY, "");
  if (digits.length < MIN_GTIN_DIGITS || digits.length > MAX_GTIN_DIGITS) {
    return "";
  }
  // An all-zero input strips to nothing. Return the empty string rather than
  // "0" so it can never accidentally equal another value's core.
  return digits.replace(LEADING_ZEROS, "");
}

/**
 * Every encoding of one barcode, so a lookup is a set membership test rather
 * than four comparisons a caller has to remember to write.
 *
 * A value longer than a width is left alone rather than truncated: `padStart`
 * cannot shorten, which is the property that stops a GTIN-14 being silently
 * cut down to something that names a different product.
 */
export function gtinVariants(value: string): ReadonlySet<string> {
  const core = gtinCore(value);
  if (core === "") return new Set();
  return new Set([
    core,
    core.padStart(12, "0"),
    core.padStart(13, "0"),
    core.padStart(14, "0"),
  ]);
}

/**
 * Do two barcodes name the same product, whatever encoding each arrived in?
 *
 * An empty or non-numeric value on either side is **never** a match. Without
 * that guard two unrelated junk values both core to `""` and compare equal —
 * which would turn "neither of these is a barcode" into "these are the same
 * product", the exact false-positive this module exists to prevent.
 */
export function gtinMatches(a: string, b: string): boolean {
  const coreA = gtinCore(a);
  if (coreA === "") return false;
  return coreA === gtinCore(b);
}

/**
 * The GS1 mod-10 check digit, evaluated at GTIN-14 width so one implementation
 * covers UPC-A, EAN-13 and GTIN-14. Padding to 14 does not change the
 * arithmetic: the weights alternate from the right, and leading zeros
 * contribute nothing.
 */
export function isValidGtin(value: string): boolean {
  const digits = value.replace(DIGITS_ONLY, "");
  if (digits.length < 8 || digits.length > 14) return false;
  if (digits !== value.trim()) return false; // formatted or padded input is the caller's problem
  const padded = digits.padStart(14, "0");

  let sum = 0;
  for (let i = 0; i < 13; i++) {
    // `padded` is exactly 14 chars, but `noUncheckedIndexedAccess` is on and a
    // non-null assertion here would be the kind of cast that hides a real bug
    // the day this function is reused on a different width.
    const digit = Number(padded[i] ?? "");
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(padded[13] ?? "");
}
