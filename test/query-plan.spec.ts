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
        productName: null,
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
        productName: null,
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
        productName: null,
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
        productName: null,
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
        productName: null,
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
        productName: null,
      },
      LAUNCH,
    );
    expect(plan).toEqual(["Squarespace Wall Kit"]);
  });

  it("returns nothing when there is nothing to ask", () => {
    expect(
      planQueries(
        {
          barcode: "SQR-WKIT-R2",
          brand: null,
          partNumbers: [],
          phrase: null,
          productName: null,
        },
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
        productName: null,
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
        productName: null,
      },
      LAUNCH,
    );
    expect(plan).toEqual(["30184"]);
  });
});

/**
 * 🔴 The client's own description, which the plan never tried.
 *
 * The PO's case, measured on 2026-09-15. `X870 TAICHI CREATOR` (ASRock, no
 * part number supplied) spent seven requests across six attempts —
 * `ASRock X870`, `X870`, `ASRock A0UAYZ`, `A0UAYZ`, `ASRock HTTPS`, `HTTPS` —
 * every one a no-result, and then proposed an unrelated A620AM board from a
 * derived part number. Newegg's own search box returns the product on the
 * first page for its name.
 *
 * His ask, verbatim: "add an instruction to try the full description as a
 * query without the brand as one of the options".
 */
describe("planQueries and the client's description", () => {
  it("tries the description when nothing was published — the PO's case", () => {
    const plan = planQueries(
      {
        barcode: "4711581492066",
        brand: "ASRock",
        // Nothing published: the client supplied no part number and the
        // search inference found none either.
        partNumbers: [],
        phrase: null,
        productName: "X870 TAICHI CREATOR",
      },
      LAUNCH,
    );

    expect(plan).toContain("X870 TAICHI CREATOR");
  });

  it("does NOT prefix the brand onto it", () => {
    // ⚠️ A client name usually carries the brand already, and doubling it
    // ("ASRock ASRock X870 Taichi") is a query no catalogue answers.
    const plan = planQueries(
      {
        barcode: "4711581492066",
        brand: "ASRock",
        partNumbers: [],
        phrase: null,
        productName: "ASRock X870 Taichi Creator",
      },
      LAUNCH,
    );

    expect(plan).not.toContain("ASRock ASRock X870 Taichi Creator");
    expect(plan).toContain("ASRock X870 Taichi Creator");
  });

  it("stays a FALLBACK — a published part number is still asked first", () => {
    // The control on the change: a name is a phrase that returns a page of
    // near-misses, a part number is an exact key. Promoting the name would
    // trade a precise first attempt for a vague one on every item.
    const plan = planQueries(
      {
        barcode: "035286301848",
        brand: "Allsop",
        partNumbers: ["30184"],
        phrase: null,
        productName: "Mousepad Pro XL",
      },
      LAUNCH,
    );

    expect(plan[0]).toBe("Allsop 30184");
    expect(plan.indexOf("Mousepad Pro XL")).toBeGreaterThan(
      plan.indexOf("30184"),
    );
  });

  it("prefers the client's description over an inferred phrase", () => {
    // 🔑 One is what the customer says the product is; the other is assembled
    // from somebody else's result titles.
    const plan = planQueries(
      {
        barcode: "4711581492066",
        brand: null,
        partNumbers: [],
        phrase: "motherboard atx amd",
        productName: "X870 TAICHI CREATOR",
      },
      LAUNCH,
    );

    expect(plan.indexOf("X870 TAICHI CREATOR")).toBeLessThan(
      plan.indexOf("motherboard atx amd"),
    );
  });

  it("asks nothing extra when the list carried no name", () => {
    const plan = planQueries(
      {
        barcode: "035286301848",
        brand: "Allsop",
        partNumbers: ["30184"],
        phrase: null,
        productName: null,
      },
      LAUNCH,
    );

    // The WHOLE plan, not a subset: a name-less item must cost exactly what
    // it cost before this change. Two attempts, because 035286301848 derives
    // the item reference 30184 — the published part number itself — so the
    // brand-scoped derivation dedups rather than adding a third request.
    expect(plan).toEqual(["Allsop 30184", "30184"]);
  });
});
