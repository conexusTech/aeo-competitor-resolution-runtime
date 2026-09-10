/**
 * The runners-up a resolution rejected, and why each ranked lower.
 *
 * ── 🔑 Why this exists ─────────────────────────────────────────────────
 * The reviewed screen offers *use this listing instead*, and the control was
 * dead: a resolution reported one `match` and the rest of the ranking went out
 * of scope. Nothing here fetches anything — this is about not discarding what
 * a run already computed.
 *
 * ── 🔴 An alternative must clear the SAME floor the chosen one did ─────
 * The natural reading of "report the runners-up" is *all of them*, and that
 * would be wrong. `MIN_EVIDENCE_TO_REPORT` exists because the handover once
 * reported a **$3,727 server** as the match for a **$13 accessory**; a
 * candidate below it is *the top hit for a vague phrase*. Offering one as an
 * alternative puts that exact mistake in a list **with a swap button next to
 * it**, and a wrong pairing is indistinguishable from a real one downstream.
 *
 * So both gates apply, the same two the chosen candidate had to pass: the
 * numeric floor **and** `hasPartNumberEvidence`, because brand + first-party +
 * in-stock totals exactly the floor on its own.
 *
 * ── 🔴 Every alternative says whether anybody LOOKED ──────────────────
 * Probes are the expensive part — measured at 2.70 per row against a ceiling
 * of eight — so most ranked candidates are scored from search-result text and
 * never opened. "Its barcode disagrees with the client's" and "nobody has
 * checked this one" are different risks, and a reviewer choosing between them
 * is choosing which risk to take on. The same distinction `Outcome` already
 * draws between `unconfirmed` and `unverifiable`.
 *
 * ── The reason is DERIVED, never composed ─────────────────────────────
 * ⚠️ The weights are ordinal and unfitted — `ranking.ts` says so itself — so
 * "scored eight lower" is noise dressed as information. The reason names the
 * strongest signal the chosen candidate had that this one lacks, from the same
 * breakdown the scorer produced. When nothing differs it says so, because a
 * tie broken by discovery order is the truth and inventing a difference is
 * worse than admitting one.
 */

import type { ParsedCandidate } from "./adapters/types.js";
import {
  hasPartNumberEvidence,
  MIN_EVIDENCE_TO_REPORT,
  scoreBreakdown,
  WEIGHTS,
  type ScoreInput,
  type ScoreSignal,
} from "./ranking.js";

/**
 * How much is known about an alternative's barcode.
 *
 * 🔑 Three states rather than a nullable string, because `null` would collapse
 * the two that matter: a listing we opened and found no barcode on, and one
 * nobody opened at all.
 */
export type AlternativeBarcodeState =
  /** Probed; it published a barcode and it did not match the client's. */
  | "disagreed"
  /** Probed; it published no barcode to compare. */
  | "absent"
  /** Never opened — scored from search-result text only. */
  | "unprobed";

export interface ResolutionAlternative {
  readonly itemId: string;
  readonly url: string;
  readonly title: string;
  readonly brand: string | null;
  readonly model: string | null;
  readonly priceCents: number | null;
  readonly inStock: boolean;
  readonly isFirstParty: boolean | null;
  readonly sellerName: string | null;
  /** The barcode this listing published, when anybody looked. */
  readonly retailerBarcode: string | null;
  readonly barcodeState: AlternativeBarcodeState;
  readonly score: number;
  /** One sentence, derived from the signals — never composed copy. */
  readonly reasonRankedLower: string;
}

/**
 * How many to report.
 *
 * ⚠️ **A product judgement about a screen, not a property of the data**, and
 * recorded as such. Beyond a handful the list is unprobed candidates a
 * reviewer cannot act on confidently — the probe ceiling is eight and the
 * measured count is 2.70, so five is already past what a run usually opened.
 */
export const MAX_ALTERNATIVES = 5;

/** What a probe learned about one candidate, keyed by its url. */
export interface ProbeOutcome {
  readonly retailerBarcode: string | null;
}

export interface AlternativesInput {
  /** Every candidate the run ranked, best first. */
  readonly ranked: readonly { candidate: ParsedCandidate; score: number }[];
  /** The one reported as the match, or null when nothing was reported. */
  readonly chosen: ParsedCandidate | null;
  /** What each probed url published. Absent means never probed. */
  readonly probed: ReadonlyMap<string, ProbeOutcome>;
  /** The scoring context, so signals are derived rather than re-guessed. */
  readonly scoreInput: Omit<ScoreInput, "candidate">;
}

/**
 * The runners-up worth offering, best first.
 *
 * 🔴 Returns `[]` for a resolution that chose nothing: a `not-found` has no
 * pairing to swap, so a list of things to swap it for would be a screen
 * inventing a decision.
 */
export function alternativesFor(
  input: AlternativesInput,
): readonly ResolutionAlternative[] {
  const { ranked, chosen, probed, scoreInput } = input;
  if (chosen === null) return [];

  const chosenSignals = new Set(
    scoreBreakdown({ ...scoreInput, candidate: chosen }).signals,
  );

  const out: ResolutionAlternative[] = [];
  for (const entry of ranked) {
    if (out.length >= MAX_ALTERNATIVES) break;
    // 🔴 Never the chosen candidate itself. An off-by-one here puts the
    // approved pairing in the list of things to replace it with.
    if (entry.candidate.url === chosen.url) continue;

    const scored = { ...scoreInput, candidate: entry.candidate };
    // Both gates, the same two the chosen candidate had to pass.
    if (entry.score < MIN_EVIDENCE_TO_REPORT) continue;
    if (!hasPartNumberEvidence(scored)) continue;

    const probe = probed.get(entry.candidate.url);
    const barcodeState: AlternativeBarcodeState =
      probe === undefined
        ? "unprobed"
        : probe.retailerBarcode === null
          ? "absent"
          : "disagreed";

    out.push({
      itemId: entry.candidate.itemId,
      url: entry.candidate.url,
      title: entry.candidate.title,
      brand: entry.candidate.brand,
      model: entry.candidate.model,
      priceCents: entry.candidate.priceCents,
      inStock: entry.candidate.inStock,
      isFirstParty: entry.candidate.isFirstParty,
      sellerName: entry.candidate.sellerName,
      retailerBarcode: probe?.retailerBarcode ?? null,
      barcodeState,
      score: entry.score,
      reasonRankedLower: reasonRankedLower(
        chosenSignals,
        scoreBreakdown(scored).signals,
        barcodeState,
      ),
    });
  }
  return out;
}

/**
 * What each signal means when the chosen candidate had it and this one did not.
 *
 * ⚠️ Phrased as a fact about **this listing**, not as a comparison of scores.
 * A reviewer can check every one of these against the page in front of them,
 * which a score gap does not let them do.
 */
const MISSING_SIGNAL_READS: Record<ScoreSignal, string> = {
  partNumberInsideBarcode:
    "its model number is not encoded in the client's barcode, and the chosen listing's is",
  partNumberExact:
    "its model number is not the client's part number, and the chosen listing's is",
  partNumberContains:
    "its model number neither contains nor is contained by the client's part number",
  partNumberSharedPrefix:
    "its model number does not share a long prefix with the client's part number",
  partNumberInText:
    "the client's part number does not appear in its listing text",
  brandMatch: "it is a different brand from the one identified for this item",
  queryToken: "fewer of the search terms appear in its listing",
  firstParty:
    "it is a marketplace listing rather than sold by the retailer itself",
  inStock: "it is out of stock",
};

/**
 * One sentence saying why this ranked below the chosen listing.
 *
 * 🔑 The **strongest** differing signal, by weight — not every difference. A
 * reviewer needs the reason that decided it, and a list of nine clauses is a
 * reason nobody reads.
 */
export function reasonRankedLower(
  chosenSignals: ReadonlySet<ScoreSignal>,
  theseSignals: readonly ScoreSignal[],
  barcodeState: AlternativeBarcodeState,
): string {
  const mine = new Set(theseSignals);
  const missing = [...chosenSignals]
    .filter((signal) => !mine.has(signal))
    .sort((a, b) => WEIGHTS[b] - WEIGHTS[a]);

  const strongest = missing[0];
  const head =
    strongest !== undefined
      ? MISSING_SIGNAL_READS[strongest]
      : // ⚠️ No difference in signals means the ranking was a tie, broken by
        // the order candidates were discovered in. Saying "it scored lower"
        // here would be inventing a distinction the scorer did not make.
        "it matched the same signals as the chosen listing and lost a tie on discovery order";

  // 🔴 And the barcode state, because it changes what a swap costs. Appended
  // rather than folded in: the signal reason is why the RANKING put it here,
  // and the barcode is what a reviewer takes on if they swap.
  const tail =
    barcodeState === "disagreed"
      ? " — and the barcode it publishes disagrees with the client's"
      : barcodeState === "absent"
        ? " — it publishes no barcode, so a swap cannot be verified either"
        : " — its page was never opened, so nothing about its barcode is known";

  return `${head}${tail}`;
}
