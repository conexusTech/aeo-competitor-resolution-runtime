/**
 * Product identity: what the thing on the client's list actually *is*, so the
 * retailer can be asked for it by name.
 *
 * 🔑 **This is a first-class, provenanced input rather than a hidden step, and
 * that is a deliberate departure from the handover spike.** There, identity was
 * inferred inside the pipeline from search-engine `<h3>` titles and the result
 * carried no record of where it came from. That inference is the one §8
 * rejected, it is the origin of **every observed mis-resolution**, and it once
 * matched a $3,727 server to a $13 accessory.
 *
 * An item paired through an inferred identity deserves different treatment from
 * one paired through the client's own published part number. Nothing downstream
 * can make that distinction unless identity says where it came from — so it does.
 */

/**
 * How an identity was obtained, in descending authority.
 *
 * ⚠️ **A union here is correct, where a union of retailers would not be.** The
 * adapter seam deliberately types a retailer as a plain string, because
 * retailers are data and adding one must not touch code. These are *our own
 * mechanisms*: adding a new kind of evidence is a genuine code change, and
 * every consumer that weighs evidence should be forced to say what it does with
 * a new kind. The compiler pointing at those call sites is the feature here and
 * the coupling there.
 */
export type IdentityProvenance =
  /** The client's own catalogue states it. Authoritative. */
  | "client-catalogue"
  /** Derived from the barcode's manufacturer item reference. Free, no request. */
  | "barcode-derived"
  /** Inferred from search-engine results. Weakest; last resort. */
  | "search-inference";

/** Authority order, highest first. The pipeline tries sources in this order. */
export const PROVENANCE_BY_AUTHORITY: readonly IdentityProvenance[] = [
  "client-catalogue",
  "barcode-derived",
  "search-inference",
] as const;

export interface ProductIdentity {
  /**
   * The manufacturer part number, as published or derived. `null` when no
   * source could supply one — which is **ordinary, not exceptional**: that
   * every client SKU publishes an MPN is unmeasured (7 of 8,926 observed).
   */
  readonly partNumber: string | null;
  readonly brand: string | null;
  readonly title: string | null;

  /** Which source produced `partNumber`. */
  readonly provenance: IdentityProvenance;

  /**
   * Other sources that independently produced the **same** part number.
   *
   * 🔑 Not bookkeeping. Two independent derivations agreeing is stronger
   * evidence than either alone — measured: the barcode-derived item reference
   * reproduces the client's published part number exactly for 3 of the 4
   * numeric ones. When they agree, that is corroboration; when they disagree,
   * the authoritative one wins and the disagreement is worth recording rather
   * than discarding.
   */
  readonly corroboratedBy: readonly IdentityProvenance[];
}

/**
 * A source of identity. Pure: given what is already known, produce an identity
 * or say it cannot.
 *
 * `fetch`-shaped work happens above this, in the pipeline, so every source
 * stays testable offline and the whole engine can be replayed from a corpus.
 */
export interface IdentitySource {
  readonly provenance: IdentityProvenance;

  /**
   * Requests this source needs the pipeline to make before it can answer.
   * `0` means it can answer from what it already has — which is why a free
   * source is still worth consulting even when a paid one is preferred.
   */
  readonly requestCost: 0 | 1;
}

/** What every source is given. */
export interface IdentityInput {
  /** The client's barcode for this item, verbatim from the watchlist. */
  readonly barcode: string;
  /** The client's own SKU, used to confirm a fetched page is the right product. */
  readonly clientSku: string;
  /** Body of a page this source asked for, when it asked for one. */
  readonly document?: string | undefined;
}

/**
 * Merge what several sources found into one identity.
 *
 * The highest-authority source that produced a part number wins; every other
 * source producing the *same* part number is recorded as corroboration. Brand
 * and title fall back down the authority order independently, because a source
 * can know the brand without knowing the part number.
 *
 * Returns `null` only when no source produced anything at all.
 */
export function mergeIdentities(
  found: ReadonlyMap<
    IdentityProvenance,
    Omit<ProductIdentity, "provenance" | "corroboratedBy">
  >,
): ProductIdentity | null {
  const ordered = PROVENANCE_BY_AUTHORITY.filter((p) => found.has(p));
  if (ordered.length === 0) return null;

  const primary = ordered.find((p) => found.get(p)?.partNumber != null);
  const winner = primary ?? ordered[0];
  if (winner === undefined) return null;

  const win = found.get(winner);
  if (win === undefined) return null;

  const corroboratedBy =
    win.partNumber == null
      ? []
      : ordered.filter(
          (p) => p !== winner && found.get(p)?.partNumber === win.partNumber,
        );

  // Brand and title need not come from the same source as the part number: the
  // barcode yields a part number and no brand, a catalogue page yields both.
  const firstNonNull = <K extends "brand" | "title">(key: K): string | null => {
    for (const p of ordered) {
      const value = found.get(p)?.[key];
      if (value != null && value !== "") return value;
    }
    return null;
  };

  return {
    partNumber: win.partNumber,
    brand: firstNonNull("brand"),
    title: firstNonNull("title"),
    provenance: winner,
    corroboratedBy,
  };
}
