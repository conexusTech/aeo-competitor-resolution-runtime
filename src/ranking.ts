/**
 * Which candidate to spend a product-page probe on next.
 *
 * Probes are the expensive part of a run — measured at 2.70 per row on the
 * handover's own numbers — so the order matters more than the score. Pure.
 */

import type { ParsedCandidate } from "./adapters/types.js";
import { gtinCore } from "./gtin.js";
import { manufacturerItemRef } from "./identity/from-barcode.js";

/**
 * Weights, ported from the handover with its reasoning intact. They are
 * ordinal, not calibrated: nothing here has been fitted, and the only property
 * that has been measured is the outcome split the whole pipeline produces.
 */
export const WEIGHTS = {
  /** The candidate's own model number appears inside the barcode. */
  partNumberInsideBarcode: 15,
  /** The retailer's model field equals a part number we believe in. */
  partNumberExact: 20,
  /** One contains the other — a regional variant, usually. */
  partNumberContains: 8,
  /** Shares a long prefix: `K72337US` against `K72337WW`. */
  partNumberSharedPrefix: 12,
  /** The part number appears somewhere in the listing's text. */
  partNumberInText: 5,
  /** Same brand as the identity. */
  brandMatch: 6,
  /** Per query token found in the listing. */
  queryToken: 2,
  /** Sold by the retailer itself. */
  firstParty: 3,
  inStock: 1,
} as const;

/**
 * Below this a candidate has no part-number-level evidence at all, and the
 * "best" candidate is merely the top hit for a vague phrase.
 *
 * 🔴 Load-bearing. Without it the handover once reported a **$3,727 server** as
 * the match for a **$13 accessory**, from a junk inferred identity. Reporting
 * nothing beats reporting something wrong, because a wrong pairing is
 * indistinguishable from a real one downstream.
 */
export const MIN_EVIDENCE_TO_REPORT = 10;

const sharedPrefixLength = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

export interface ScoreInput {
  readonly candidate: ParsedCandidate;
  /** Part numbers believed for this item, best first. */
  readonly partNumbers: readonly string[];
  readonly brand: string | null;
  readonly barcode: string;
  /** Lowercased tokens from every query tried. */
  readonly queryTokens: readonly string[];
}

export function scoreCandidate(input: ScoreInput): number {
  const { candidate, partNumbers, brand, barcode, queryTokens } = input;
  const haystack =
    `${candidate.title} ${candidate.model ?? ""} ${candidate.brand ?? ""}`.toLowerCase();
  const model = (candidate.model ?? "").toUpperCase();
  let score = 0;

  // The manufacturer encoded its item reference in the barcode, and the
  // retailer's model field carries it — near-conclusive before spending a probe.
  const core = gtinCore(barcode);
  if (core !== "" && model !== "") {
    const digits = model.replace(/\D/g, "");
    if (digits.length >= 4 && core.padStart(12, "0").includes(digits)) {
      score += WEIGHTS.partNumberInsideBarcode;
    }
  }

  for (const partNumber of partNumbers) {
    const p = partNumber.toUpperCase();
    if (model !== "" && model === p) score += WEIGHTS.partNumberExact;
    else if (model !== "" && (model.includes(p) || p.includes(model)))
      score += WEIGHTS.partNumberContains;
    else if (model !== "" && sharedPrefixLength(model, p) >= 5)
      score += WEIGHTS.partNumberSharedPrefix;
    else if (haystack.includes(p.toLowerCase()))
      score += WEIGHTS.partNumberInText;
  }

  // Sibling variants cluster on consecutive barcodes, so once the brand is
  // right the exact item is usually a few probes away — rank the whole family
  // above cross-brand noise.
  if (
    brand !== null &&
    candidate.brand !== null &&
    candidate.brand.toLowerCase() === brand.toLowerCase()
  ) {
    score += WEIGHTS.brandMatch;
  }

  for (const token of queryTokens) {
    if (haystack.includes(token)) score += WEIGHTS.queryToken;
  }

  // 🔴 First-party outranks marketplace, and the reason is whose barcode the
  // page carries: a marketplace listing publishes the SELLER's barcode —
  // observed on a network-switch offer reporting an unrelated one. So a
  // first-party match is strong evidence and a marketplace mismatch is weak.
  // `null` means the retailer does not expose the distinction, and scores
  // nothing rather than being assumed either way.
  if (candidate.isFirstParty === true) score += WEIGHTS.firstParty;
  if (candidate.inStock) score += WEIGHTS.inStock;

  return score;
}

/** Best first. Ties keep their original order, so a run is deterministic. */
export function rankCandidates(
  candidates: readonly ParsedCandidate[],
  input: Omit<ScoreInput, "candidate">,
): { candidate: ParsedCandidate; score: number }[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      score: scoreCandidate({ ...input, candidate }),
      index,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ candidate, score }) => ({ candidate, score }));
}

/**
 * Does the pool already hold something conclusive enough that further searching
 * can only add noise?
 */
export function hasConclusiveCandidate(
  candidates: readonly ParsedCandidate[],
  partNumbers: readonly string[],
  barcode: string,
): boolean {
  const upper = partNumbers.map((p) => p.toUpperCase());
  return candidates.some((candidate) => {
    const model = (candidate.model ?? "").toUpperCase();
    if (model !== "" && upper.includes(model)) return true;
    return (
      scoreCandidate({
        candidate,
        partNumbers: [],
        brand: null,
        barcode,
        queryTokens: [],
      }) >= WEIGHTS.partNumberInsideBarcode
    );
  });
}

/** Probe first-party listings before marketplace ones at equal evidence. */
export function probeOrder(
  ranked: readonly { candidate: ParsedCandidate; score: number }[],
): { candidate: ParsedCandidate; score: number }[] {
  return [...ranked].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aOwn = a.candidate.isFirstParty === true ? 0 : 1;
    const bOwn = b.candidate.isFirstParty === true ? 0 : 1;
    return aOwn - bOwn;
  });
}

/** Exported for the query plan's token set. */
export function tokenise(queries: readonly string[]): string[] {
  const out = new Set<string>();
  for (const query of queries) {
    for (const token of query.toLowerCase().split(/\s+/)) {
      if (token.length >= 2) out.add(token);
    }
  }
  return [...out];
}

export { manufacturerItemRef };
