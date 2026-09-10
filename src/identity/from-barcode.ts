/**
 * Identity derived from the barcode itself. Costs nothing — no request, no key,
 * no rate limit.
 *
 * A UPC-A is `[GS1 company prefix][manufacturer item reference][check digit]`,
 * and for many brands the item reference **is** the catalogue part number. The
 * handover spike asserted this from one example; it can now be scored, because
 * the client's own catalogue publishes the real part number for 7 rows:
 *
 * | barcode | published part number | derived | agrees |
 * |---|---|---|---|
 * | 035286301848 | `30184`    | `30184` | yes |
 * | 649833101746 | `10174`    | `10174` | yes |
 * | 035286296489 | `29648`    | `29648` | yes |
 * | 813810010431 | `63005`    | `01043` | no  |
 * | 812348010548 | `CF-08LB`  | `01054` | no  |
 * | 188218000453 | `CRW-UINB` | `00045` | no  |
 * | 812348010555 | `CF-012LB` | `01055` | no  |
 *
 * **3 of the 4 numeric part numbers, exactly. 0 of the 3 alphanumeric ones,
 * necessarily** — the derivation can only ever produce digits.
 *
 * 🔑 **So this is a corroborator, not a source to stop at.** Consulting it first
 * *and stopping* would take a wrong part number (`01043` for a real `63005`)
 * while an authoritative one was a single request away. Consulting it alongside
 * an authoritative source, and recording agreement, is what makes a match
 * stronger than either source alone.
 */

import { gtinCore } from "../gtin.js";
import type {
  IdentityInput,
  IdentitySource,
  ProductIdentity,
} from "./types.js";

/** UPC-A width. The derivation is only defined at this width. */
const UPC_A_DIGITS = 12;
/** Digits of the manufacturer item reference in a UPC-A. */
const ITEM_REF_DIGITS = 5;

export const barcodeIdentitySource: IdentitySource = {
  provenance: "barcode-derived",
  requestCost: 0,
};

/**
 * The manufacturer item reference: the 5 digits before the check digit, once the
 * value is expressed at UPC-A width.
 *
 * ⚠️ **Returns `null` for anything that is not a UPC-A**, rather than slicing
 * whatever it was given. A genuine EAN-13 has a different structure — its
 * leading digits are a GS1 country/company prefix, not a US company prefix —
 * so the same slice yields digits that are **not** an item reference and are
 * not anybody's part number. 1,081 of one real client's 8,926 items are genuine
 * EAN-13s, so guessing here would manufacture a wrong search key for 12% of a
 * list, and a wrong key produces a confident wrong match rather than an error.
 */
export function manufacturerItemRef(barcode: string): string | null {
  const core = gtinCore(barcode);
  if (core === "") return null;
  // Expressible as a UPC-A only if it fits in 12 digits.
  if (core.length > UPC_A_DIGITS) return null;
  const padded = core.padStart(UPC_A_DIGITS, "0");
  return padded.slice(-(ITEM_REF_DIGITS + 1), -1);
}

/** What this source can say about the item, from the barcode alone. */
export function identityFromBarcode(
  input: IdentityInput,
): Omit<ProductIdentity, "provenance" | "corroboratedBy"> | null {
  const partNumber = manufacturerItemRef(input.barcode);
  if (partNumber === null) return null;
  // A barcode names no brand and no title. Saying so explicitly matters: the
  // merge falls back through the authority order per field, so a `null` here
  // lets a lower-authority source supply the brand without overriding the part
  // number this source won.
  return { partNumber, brand: null, title: null };
}
