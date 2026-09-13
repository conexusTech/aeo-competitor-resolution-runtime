import { describe, expect, it } from "vitest";

import {
  scoreBreakdown,
  scoreCandidate,
  WEIGHTS,
  type ScoreInput,
} from "../src/ranking.js";
import type { ParsedCandidate } from "../src/adapters/types.js";

/**
 * The score, and the signals that explain it.
 *
 * 🔴 **This spec exists because a mutation proved the replay does NOT pin the
 * score.** Adding `score += 1` to the `brandMatch` credit left the 53-row
 * row-by-row check **green**: the replay compares *outcomes*, and a uniform
 * nudge moves no candidate past another, so it changes which listing wins for
 * none of those rows.
 *
 * ⚠️ **The checklist claimed the replay was that pin, and that was false.** The
 * replay pins the outcome split; nothing pinned the arithmetic. So these checks
 * do.
 *
 * 🔑 **They assert against `WEIGHTS` by name, not against literals.** A
 * deliberate reweighting is a decision somebody makes and these stay correct
 * through it; an unnamed `score += 1` — the accident this is for — breaks them
 * immediately.
 */

const candidate = (over: Partial<ParsedCandidate> = {}): ParsedCandidate => ({
  itemId: "N82E00000001",
  url: "https://retailer.test/p/1",
  imageUrl: null,
  title: "ACME Widget K72337US 12-pack",
  brand: "ACME",
  model: "K72337US",
  priceCents: 4999,
  inStock: true,
  isFirstParty: true,
  sellerName: "The Retailer",
  ...over,
});

const input = (over: Partial<ScoreInput> = {}): ScoreInput => ({
  candidate: candidate(),
  partNumbers: ["K72337US"],
  brand: "ACME",
  // ⚠️ A barcode whose core does NOT contain the model's digits, so
  // `partNumberInsideBarcode` stays out of these sums and each check isolates
  // the signals it names.
  barcode: "0885370999991",
  queryTokens: ["acme", "widget"],
  ...over,
});

describe("the score is the sum of the signals that fired", () => {
  it("credits an exact part number, brand, both query tokens, first party and stock", () => {
    const { score, signals } = scoreBreakdown(input());

    expect(score).toBe(
      WEIGHTS.partNumberExact +
        WEIGHTS.brandMatch +
        2 * WEIGHTS.queryToken +
        WEIGHTS.firstParty +
        WEIGHTS.inStock,
    );
    expect([...signals].sort()).toEqual(
      [
        "brandMatch",
        "firstParty",
        "inStock",
        "partNumberExact",
        "queryToken",
      ].sort(),
    );
  });

  it("credits nothing for a candidate that matches nothing", () => {
    const { score, signals } = scoreBreakdown(
      input({
        candidate: candidate({
          title: "Unrelated object",
          brand: "OTHER",
          model: "ZZ999",
          isFirstParty: false,
          inStock: false,
        }),
        queryTokens: ["nothing", "here"],
      }),
    );
    expect(score).toBe(0);
    expect(signals).toEqual([]);
  });

  it("credits a shared prefix rather than an exact match", () => {
    const { score, signals } = scoreBreakdown(
      input({
        candidate: candidate({
          title: "ACME Widget K72337WW",
          model: "K72337WW",
        }),
        queryTokens: ["acme"],
      }),
    );
    expect(score).toBe(
      WEIGHTS.partNumberSharedPrefix +
        WEIGHTS.brandMatch +
        WEIGHTS.queryToken +
        WEIGHTS.firstParty +
        WEIGHTS.inStock,
    );
    expect(signals).toContain("partNumberSharedPrefix");
    expect(signals).not.toContain("partNumberExact");
  });

  /**
   * ⚠️ `queryToken` fires once per hit and the score counts every one; the
   * signal list is a SET, so it names the signal once. A check, because those
   * two facts look like a contradiction until somebody states them.
   */
  it("counts every query token but names the signal once", () => {
    const three = scoreBreakdown(
      input({ queryTokens: ["acme", "widget", "12-pack"] }),
    );
    const one = scoreBreakdown(input({ queryTokens: ["acme"] }));

    expect(three.score - one.score).toBe(2 * WEIGHTS.queryToken);
    expect(three.signals.filter((s) => s === "queryToken")).toHaveLength(1);
  });

  it("lists the signals strongest weight first", () => {
    const { signals } = scoreBreakdown(input());
    const weights = signals.map((s) => WEIGHTS[s]);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);
  });

  /**
   * 🔑 One implementation. Two copies of this arithmetic is how a signal list
   * comes to disagree with the number it explains.
   */
  it("is the same number the plain scorer returns", () => {
    for (const tokens of [[], ["acme"], ["acme", "widget"]]) {
      const i = input({ queryTokens: tokens });
      expect(scoreCandidate(i)).toBe(scoreBreakdown(i).score);
    }
  });
});
