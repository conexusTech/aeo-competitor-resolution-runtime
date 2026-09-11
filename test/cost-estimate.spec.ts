import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COST, estimateRun } from "../src/run.js";

/**
 * The estimate, derived from the data it claims to be measured from.
 *
 * 🔴 **`requestsPerItemDerivedIdentity` was 4.70 and the true figure is 6.68 —
 * 42% low — because nothing ever recomputed it from the fixture.** Its own note
 * gave the arithmetic away: "one Google resolve + ONE Newegg search + 2.70
 * product-page probes". The fixture records **2.98 queries per row**. A row
 * whose first query misses tries the next variant, up to six.
 *
 * 🔑 **This is the fix, not the new number.** A constant that agrees with a
 * document is worth nothing; a constant recomputed from committed data cannot
 * drift silently. The value is shown to a client before they authorise spend —
 * on the one real 8,926-row export the error was ~$42 quoted against ~$60
 * actual.
 */

interface MeasuredRow {
  readonly queriesTried: readonly string[];
  readonly probes: number;
}

const measured = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "measured-run-53.json"), "utf8"),
) as { readonly rows: readonly MeasuredRow[] };

describe("what a row costs, derived from the measured run", () => {
  it("matches the constant the product quotes", () => {
    const rows = measured.rows;
    expect(rows.length).toBe(53);

    const queries = rows.reduce((n, r) => n + r.queriesTried.length, 0);
    const probes = rows.reduce((n, r) => n + r.probes, 0);

    // One search-engine lookup per row to work out what the item is, then
    // the retailer searches, then the product pages those searches turned up.
    const perRow = 1 + queries / rows.length + probes / rows.length;

    // 🔑 Rounded to the constant's own precision — one decimal — because
    // the constant is a published figure, not a float.
    expect(Number(perRow.toFixed(1))).toBe(COST.requestsPerItemDerivedIdentity);
  });

  it("is not satisfied by the value it replaced", () => {
    // ⚠️ A control. Without this, a future edit back to 4.7 would have to
    // also break the derivation above to go green — but stating the refused
    // value makes the regression legible rather than arithmetic.
    expect(COST.requestsPerItemDerivedIdentity).not.toBe(4.7);
    expect(COST.requestsPerItemDerivedIdentity).toBeGreaterThan(6);
  });

  it("assumes MORE than one retailer search per row, which is where 4.7 went wrong", () => {
    const rows = measured.rows;
    const perRow =
      rows.reduce((n, r) => n + r.queriesTried.length, 0) / rows.length;
    // The old arithmetic used 1. If this ever really is 1, the constant
    // should come down — and this check says so out loud.
    expect(perRow).toBeGreaterThan(1);
  });

  it("leaves the with-part-number figure alone, because nothing measures it", () => {
    // ⚠️ The 53 rows carry NO part numbers, so every one took the derived
    // path. Bumping this alongside its sibling would launder an unmeasured
    // number into a measured-looking one.
    expect(COST.requestsPerItemWithPartNumber).toBe(2);
  });

  it("prices a mixed list from both figures rather than a blended rate", () => {
    // 10 items, 4 with a part number: 4*2 + 6*6.7 = 8 + 40.2 = 48.2
    const { requests } = estimateRun(10, 4);
    expect(requests).toBeCloseTo(48.2, 5);
  });
});
