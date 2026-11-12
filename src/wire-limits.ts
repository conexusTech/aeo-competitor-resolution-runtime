/**
 * The gateway's limits on what a run posts, in one place.
 *
 * 🔴 **Each one is the gateway's own `@MaxLength`, and a value past it costs a
 * batch.** `aeo-backend`'s `insights-run-event.dto.ts` validates every finding
 * in a resolutions event, and one field too long answers the WHOLE event with
 * a 400 the runtime never retries — every finding in it lost to one item's
 * string. So the runtime holds every value it posts to these, and they live
 * here rather than beside each use, where two spellings of one limit drift.
 */

/** `ResolutionDto.failure`. */
export const MAX_FAILURE_LENGTH = 512;

/**
 * A category's `error` in a read run's `categories` event.
 *
 * 🔴 **A requirement on the gateway's categories event, not a description of
 * it:** its DTO must accept at least this many characters. The same figure as
 * a resolution's failure, so the two callbacks agree.
 */
export const MAX_CATEGORY_ERROR_LENGTH = 512;

/**
 * The highest price, in cents, the gateway takes on a reading
 * (`aeo-backend` `listing-read-event.dto.ts`, `MAX_PRICE_CENTS`): a whole
 * number from 1 to this. A reading past it is refused on its own.
 */
export const MAX_PRICE_CENTS = 1_000_000_000;

/**
 * A price as the gateway will take it — a whole number of cents from 1 to
 * `MAX_PRICE_CENTS` — or `null`.
 *
 * 🔴 **Out of range is no price, never a price the gateway refuses.** A price
 * past the ceiling, or a fraction of a cent, is a parse that went wrong; sent
 * as it is, the gateway would refuse the reading carrying it.
 */
export function priceWithinLimits(priceCents: number | null): number | null {
  return priceCents !== null &&
    Number.isInteger(priceCents) &&
    priceCents > 0 &&
    priceCents <= MAX_PRICE_CENTS
    ? priceCents
    : null;
}

/**
 * `text` held to `max` characters: as it is when it fits, otherwise cut and
 * ended with "…", so a reader can see it was cut.
 */
export function boundText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * `ResolutionEvidenceDto`'s limits on the strings a competitor's page puts on
 * a finding — the chosen listing's and every alternative's.
 */
export const EVIDENCE_LIMITS = {
  title: 512,
  sellerName: 255,
  brand: 160,
  model: 128,
  itemId: 128,
} as const;

/** `ResolutionQueryAttemptDto.query`: one entry of a finding's query trail. */
export const MAX_QUERY_LENGTH = 500;

/**
 * `MAX_QUERY_TRAIL_PER_RESOLUTION`: the most entries a finding's
 * `queriesTried` and its `queryTrail` may each carry.
 *
 * 🔑 **One ceiling for both lists, because they describe the same attempts**,
 * one as bare strings and one with each attempt's count. A plan asks at most
 * eight (six, the barcode beside them and the spelled-out fallback), so this
 * is never reached by a working plan; it is held so a defect that grew the
 * list cannot cost the batch its finding rides in.
 */
export const MAX_QUERY_ATTEMPTS_REPORTED = 50;

/**
 * `ResolutionEvidenceDto.unverifiableReason`. Re-exported by the adapter seam,
 * where every adapter's reasons are held to it.
 */
export const MAX_UNVERIFIABLE_REASON_LENGTH = 200;

/** The page-derived strings a finding carries about a listing. */
interface ListingStrings {
  readonly itemId: string;
  readonly title: string;
  readonly brand: string | null;
  readonly model: string | null;
  readonly sellerName: string | null;
}

const bounded = (value: string | null, max: number): string | null =>
  value === null ? null : boundText(value, max);

/**
 * A listing's page-derived strings held to `EVIDENCE_LIMITS`, everything else
 * as it is.
 *
 * 🔴 **For the chosen listing and every alternative alike**: both are
 * validated by the same DTO, and either one too long refuses the batch.
 *
 * ⚠️ An `itemId` past 128 characters is cut like the rest. No retailer's id
 * comes near it (the longest measured is Costco's ten digits); one that long
 * is a page that broke the adapter, and a cut id is a finding the gateway can
 * take — where the whole id would lose the batch it rides in.
 */
export function withinEvidenceLimits<T extends ListingStrings>(listing: T): T {
  return {
    ...listing,
    itemId: boundText(listing.itemId, EVIDENCE_LIMITS.itemId),
    title: boundText(listing.title, EVIDENCE_LIMITS.title),
    brand: bounded(listing.brand, EVIDENCE_LIMITS.brand),
    model: bounded(listing.model, EVIDENCE_LIMITS.model),
    sellerName: bounded(listing.sellerName, EVIDENCE_LIMITS.sellerName),
  };
}
