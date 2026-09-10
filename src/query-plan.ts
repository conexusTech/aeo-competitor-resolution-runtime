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
import { manufacturerItemRef } from "./identity/from-barcode.js";
import { partNumberStem } from "./identity/from-search-results.js";

export interface QueryPlanInput {
  readonly barcode: string;
  readonly brand: string | null;
  /** Part-number candidates, best first. */
  readonly partNumbers: readonly string[];
  /** A phrase to fall back on when no part number is known. */
  readonly phrase: string | null;
}

/** How many attempts are worth making before a query is just noise. */
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
  const attempts: string[] = [];
  const push = (q: string | null | undefined): void => {
    if (q == null) return;
    const trimmed = q.trim();
    if (trimmed === "") return;
    if (!canQuery(support, trimmed)) return;
    if (!attempts.includes(trimmed)) attempts.push(trimmed);
  };

  const { brand } = input;
  const itemRef = manufacturerItemRef(input.barcode);

  input.partNumbers.forEach((partNumber, i) => {
    // After the single best published candidate, the free derivation is worth
    // trying — for many brands the item reference IS the catalogue number.
    if (i === 1 && itemRef !== null && brand !== null)
      push(`${brand} ${itemRef}`);
    if (brand !== null) push(`${brand} ${partNumber}`);
    push(partNumber);
    const stem = partNumberStem(partNumber);
    if (stem !== null) push(brand !== null ? `${brand} ${stem}` : stem);
  });

  // Also covers the case of fewer than two published candidates.
  if (itemRef !== null && brand !== null) push(`${brand} ${itemRef}`);
  push(input.phrase);

  return attempts.slice(0, MAX_QUERY_ATTEMPTS);
}
