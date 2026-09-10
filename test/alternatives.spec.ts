import { describe, expect, it } from "vitest";

import {
  alternativesFor,
  MAX_ALTERNATIVES,
  reasonRankedLower,
  type ProbeOutcome,
} from "../src/alternatives.js";
import { MIN_EVIDENCE_TO_REPORT, type ScoreSignal } from "../src/ranking.js";
import type { ParsedCandidate } from "../src/adapters/types.js";

/**
 * The runners-up a resolution offers instead, and why each ranked lower.
 *
 * 🔴 **The refusals are the interesting half.** "Report the runners-up" reads
 * as *all of them*, and the reviewed screen puts a **swap button** next to
 * every one — so a candidate below the evidence floor is not a runner-up, it is
 * the $3,727-server-for-a-$13-accessory mistake with a control on it.
 *
 * The replay against 534 real captured responses is in
 * `exit-criterion-53-rows.spec.ts`; this is where one input varies at a time.
 */

const candidate = (over: Partial<ParsedCandidate> = {}): ParsedCandidate => ({
  itemId: "N82E00000001",
  url: "https://retailer.test/p/1",
  title: "ACME Widget K72337US 12-pack",
  brand: "ACME",
  model: "K72337US",
  priceCents: 4999,
  inStock: true,
  isFirstParty: true,
  sellerName: "The Retailer",
  ...over,
});

/** The scoring context. A real part number, so evidence is genuine. */
const SCORE_INPUT = {
  partNumbers: ["K72337US"],
  brand: "ACME",
  barcode: "0885370733266",
  queryTokens: ["acme", "widget"],
};

/**
 * 🔑 Asserts rather than casts. `noUncheckedIndexedAccess` is on, and
 * `out[0]!` would silence the compiler while turning an empty list — the exact
 * defect several of these checks are about — into a confusing runtime error
 * instead of a clear failure.
 */
const first = <T>(list: readonly T[], what: string): T => {
  const head = list[0];
  if (head === undefined) throw new Error(`expected at least one ${what}`);
  return head;
};

const ranked = (
  entries: readonly { candidate: ParsedCandidate; score: number }[],
) => entries;

describe("which runners-up are worth offering", () => {
  const chosen = candidate({ url: "https://retailer.test/p/chosen" });

  it("reports the ones that cleared the floor, best first", () => {
    const second = candidate({
      url: "https://retailer.test/p/2",
      itemId: "N82E00000002",
      inStock: false,
    });
    const third = candidate({
      url: "https://retailer.test/p/3",
      itemId: "N82E00000003",
      isFirstParty: false,
      inStock: false,
    });

    const out = alternativesFor({
      ranked: ranked([
        { candidate: chosen, score: 30 },
        { candidate: second, score: 25 },
        { candidate: third, score: 20 },
      ]),
      chosen,
      probed: new Map(),
      scoreInput: SCORE_INPUT,
    });

    expect(out.map((a) => a.url)).toEqual([
      "https://retailer.test/p/2",
      "https://retailer.test/p/3",
    ]);
    expect(first(out, "alternative").score).toBe(25);
  });

  /**
   * 🔴 The refusal the row turns on. `MIN_EVIDENCE_TO_REPORT` exists because
   * the handover once reported a $3,727 server as the match for a $13
   * accessory — and every one of these gets a swap button.
   */
  it("never offers a candidate below the evidence floor", () => {
    const junk = candidate({
      url: "https://retailer.test/p/junk",
      title: "Unrelated thing",
      model: null,
      brand: null,
    });

    const out = alternativesFor({
      ranked: ranked([
        { candidate: chosen, score: 30 },
        { candidate: junk, score: MIN_EVIDENCE_TO_REPORT - 1 },
      ]),
      chosen,
      probed: new Map(),
      scoreInput: SCORE_INPUT,
    });

    expect(out).toHaveLength(0);
  });

  /**
   * 🔴 And the second gate, which is the one the floor alone did not hold:
   * brand + first-party + in-stock totals **exactly** the floor, so a numeric
   * test alone admits a candidate with no part-number evidence at all.
   */
  it("never offers a candidate with no part-number evidence, even at a passing score", () => {
    const sameBrandOnly = candidate({
      url: "https://retailer.test/p/brand-only",
      title: "ACME Something Else",
      model: "ZZ999",
    });

    const out = alternativesFor({
      ranked: ranked([
        { candidate: chosen, score: 30 },
        // Passes the floor on brand + first-party + in-stock alone.
        { candidate: sameBrandOnly, score: MIN_EVIDENCE_TO_REPORT },
      ]),
      chosen,
      probed: new Map(),
      scoreInput: SCORE_INPUT,
    });

    expect(out).toHaveLength(0);
  });

  it("never offers the chosen candidate as an alternative to itself", () => {
    const out = alternativesFor({
      ranked: ranked([
        { candidate: chosen, score: 30 },
        {
          candidate: candidate({ url: "https://retailer.test/p/2" }),
          score: 25,
        },
      ]),
      chosen,
      probed: new Map(),
      scoreInput: SCORE_INPUT,
    });

    expect(out.map((a) => a.url)).not.toContain(chosen.url);
    expect(out).toHaveLength(1);
  });

  it("reports at most the cap", () => {
    const many = Array.from({ length: MAX_ALTERNATIVES + 4 }, (_, i) => ({
      candidate: candidate({
        url: `https://retailer.test/p/${i + 10}`,
        itemId: `N82E0000${i + 10}`,
      }),
      score: 25 - i,
    }));

    const out = alternativesFor({
      ranked: ranked([{ candidate: chosen, score: 30 }, ...many]),
      chosen,
      probed: new Map(),
      scoreInput: SCORE_INPUT,
    });

    expect(out).toHaveLength(MAX_ALTERNATIVES);
  });

  /**
   * 🔴 A `not-found` has no pairing to swap, so a list of things to swap it
   * for would be a screen inventing a decision.
   */
  it("offers nothing when the resolution chose nothing", () => {
    expect(
      alternativesFor({
        ranked: ranked([{ candidate: candidate(), score: 30 }]),
        chosen: null,
        probed: new Map(),
        scoreInput: SCORE_INPUT,
      }),
    ).toHaveLength(0);
  });

  it("offers nothing when only one candidate was ever found", () => {
    expect(
      alternativesFor({
        ranked: ranked([{ candidate: chosen, score: 30 }]),
        chosen,
        probed: new Map(),
        scoreInput: SCORE_INPUT,
      }),
    ).toHaveLength(0);
  });
});

describe("what is known about an alternative's barcode", () => {
  const chosen = candidate({ url: "https://retailer.test/p/chosen" });
  const other = candidate({
    url: "https://retailer.test/p/other",
    itemId: "N82E00000002",
  });

  const withProbe = (probe: ProbeOutcome | undefined) =>
    first(
      alternativesFor({
        ranked: ranked([
          { candidate: chosen, score: 30 },
          { candidate: other, score: 25 },
        ]),
        chosen,
        probed: probe === undefined ? new Map() : new Map([[other.url, probe]]),
        scoreInput: SCORE_INPUT,
      }),
      "alternative",
    );

  it("says its barcode disagreed when one was published and did not match", () => {
    const alt = withProbe({ retailerBarcode: "0000000000000" });
    expect(alt.barcodeState).toBe("disagreed");
    expect(alt.retailerBarcode).toBe("0000000000000");
    expect(alt.reasonRankedLower).toContain("disagrees");
  });

  /**
   * 🔴 Not a mismatch. 91 of 255 captured product pages publish an empty
   * barcode — the same distinction `Outcome` draws between `unconfirmed` and
   * `unverifiable`, and collapsing it here would tell a reviewer a swap is
   * riskier than it is.
   */
  it("says it published no barcode when one was probed and had none", () => {
    const alt = withProbe({ retailerBarcode: null });
    expect(alt.barcodeState).toBe("absent");
    expect(alt.retailerBarcode).toBeNull();
    expect(alt.reasonRankedLower).toContain("publishes no barcode");
  });

  /**
   * 🔑 The state most alternatives are in: probes are the expensive part, and
   * the measured count is 2.70 per row. Implying it was checked would be the
   * screen making a promise the run never made.
   */
  it("says nobody looked when it was never probed", () => {
    const alt = withProbe(undefined);
    expect(alt.barcodeState).toBe("unprobed");
    expect(alt.retailerBarcode).toBeNull();
    expect(alt.reasonRankedLower).toContain("never opened");
  });
});

describe("why it ranked lower", () => {
  const signals = (...s: ScoreSignal[]) => new Set<ScoreSignal>(s);

  /**
   * 🔑 The STRONGEST differing signal, by weight — not every difference. A
   * reviewer needs the reason that decided it, and nine clauses is a reason
   * nobody reads.
   */
  it("names the strongest signal the chosen listing had and this one lacks", () => {
    const reason = reasonRankedLower(
      signals("partNumberExact", "brandMatch", "inStock"),
      ["brandMatch", "inStock"],
      "unprobed",
    );
    expect(reason).toContain(
      "its model number is not the client's part number",
    );
    // And not the weaker difference, which is also true but not why.
    expect(reason).not.toContain("out of stock");
  });

  it("prefers a stronger missing signal over a weaker one", () => {
    const reason = reasonRankedLower(
      signals("partNumberExact", "firstParty"),
      [],
      "unprobed",
    );
    // partNumberExact is 20, firstParty is 3.
    expect(reason).toContain("model number is not the client's part number");
  });

  it("describes a marketplace listing when that is the difference", () => {
    const reason = reasonRankedLower(
      signals("partNumberExact", "firstParty"),
      ["partNumberExact"],
      "unprobed",
    );
    expect(reason).toContain("marketplace listing");
  });

  /**
   * 🔴 **A tie says it was a tie.** The weights are ordinal and unfitted, so
   * inventing a difference the scorer did not make would be worse than
   * admitting there is none — and "it scored lower" is not true when the
   * signals are identical and only discovery order separated them.
   */
  it("admits a tie rather than inventing a difference", () => {
    const reason = reasonRankedLower(
      signals("partNumberExact", "brandMatch"),
      ["partNumberExact", "brandMatch"],
      "unprobed",
    );
    expect(reason).toContain("lost a tie on discovery order");
  });

  it("always says what is known about the barcode, whatever the signal reason", () => {
    for (const state of ["disagreed", "absent", "unprobed"] as const) {
      const reason = reasonRankedLower(signals("brandMatch"), [], state);
      expect(reason).toMatch(/barcode|never opened/);
    }
  });
});
