import { describe, expect, it } from "vitest";

import { MAX_QUERY_ATTEMPTS, planQueries } from "../src/query-plan.js";
import type { QuerySupport } from "../src/adapters/types.js";

const LAUNCH: QuerySupport = {
  maxNumericQueryDigits: 9,
  barcodeIsSearchable: false,
};

describe("planQueries", () => {
  it("puts the brand-scoped published part number first", () => {
    // A part number is the retailer's strongest key: `?d=TL-SG1005D` returns 2
    // exact results where the product name returns 44.
    const plan = planQueries(
      {
        barcode: "035286301848",
        brand: "Allsop",
        partNumbers: ["30184"],
        phrase: "Allsop Mousepad",
      },
      LAUNCH,
    );
    expect(plan[0]).toBe("Allsop 30184");
    expect(plan).toContain("30184");
  });

  it("tries the free derivation after the best published candidate, not before", () => {
    // 🔴 The ordering that matters. The derivation is measured right 3 times of
    // 4 and wrong in a way nothing about the answer reveals, so it must not
    // displace a published candidate — only follow it.
    const plan = planQueries(
      {
        barcode: "813810010431", // derives 01043; the real part number is 63005
        brand: "SteelSeries",
        partNumbers: ["63005", "QCK-MINI"],
        phrase: "SteelSeries QcK",
      },
      LAUNCH,
    );
    expect(plan[0]).toBe("SteelSeries 63005");
    const derived = plan.indexOf("SteelSeries 01043");
    const published = plan.indexOf("SteelSeries 63005");
    expect(derived).toBeGreaterThan(published);
  });

  it("adds a regional stem as an extra candidate, never a replacement", () => {
    const plan = planQueries(
      {
        barcode: "035286301848",
        brand: "Kensington",
        partNumbers: ["K72337WW"],
        phrase: null,
      },
      LAUNCH,
    );
    expect(plan).toContain("Kensington K72337WW");
    expect(plan).toContain("Kensington K72337");
    expect(plan.indexOf("Kensington K72337WW")).toBeLessThan(
      plan.indexOf("Kensington K72337"),
    );
  });

  it("🔴 never plans a query the retailer is known to refuse", () => {
    // The barcode itself, and anything else numeric past the measured limit.
    // Spending a request to rediscover a known refusal is pure waste.
    const plan = planQueries(
      {
        barcode: "6933337311393",
        brand: null,
        partNumbers: ["6933337311393", "1234567890"],
        phrase: "1234567890123",
      },
      LAUNCH,
    );
    expect(plan).not.toContain("6933337311393");
    expect(plan).not.toContain("1234567890");
    expect(plan).not.toContain("1234567890123");
  });

  it("still plans a SHORT numeric part number", () => {
    // The other half of that rule: `2960703` is a real 7-digit model number the
    // retailer answers, and it resolved one of the 22 verified rows. Reading
    // the limit as "refuse numeric" would have cost that match.
    const plan = planQueries(
      {
        barcode: "663296413697",
        brand: "Thrustmaster",
        partNumbers: ["2960703"],
        phrase: null,
      },
      LAUNCH,
    );
    expect(plan).toContain("Thrustmaster 2960703");
    expect(plan).toContain("2960703");
  });

  it("falls back to the phrase when nothing else is known", () => {
    const plan = planQueries(
      {
        barcode: "SQR-WKIT-R2",
        brand: null,
        partNumbers: [],
        phrase: "Squarespace Wall Kit",
      },
      LAUNCH,
    );
    expect(plan).toEqual(["Squarespace Wall Kit"]);
  });

  it("returns nothing when there is nothing to ask", () => {
    expect(
      planQueries(
        { barcode: "SQR-WKIT-R2", brand: null, partNumbers: [], phrase: null },
        LAUNCH,
      ),
    ).toEqual([]);
  });

  it("deduplicates and caps the attempt list", () => {
    const plan = planQueries(
      {
        barcode: "035286301848",
        brand: "Allsop",
        partNumbers: ["A1", "A1", "B2", "C3", "D4", "E5", "F6", "G7"],
        phrase: "a phrase",
      },
      LAUNCH,
    );
    expect(plan.length).toBeLessThanOrEqual(MAX_QUERY_ATTEMPTS);
    expect(new Set(plan).size).toBe(plan.length);
  });

  it("works with no brand, using bare part numbers", () => {
    const plan = planQueries(
      {
        barcode: "035286301848",
        brand: null,
        partNumbers: ["30184"],
        phrase: null,
      },
      LAUNCH,
    );
    expect(plan).toEqual(["30184"]);
  });
});
