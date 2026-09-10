import { describe, expect, it } from "vitest";

import {
  identityFromBarcode,
  manufacturerItemRef,
} from "../src/identity/from-barcode.js";

/**
 * The table below is **ground truth, not invention**: each barcode is a real
 * manufacturer barcode, and each `published` value is the manufacturer part
 * number the item's own catalogue page states for it. The handover spike
 * asserted this derivation from a single example; these are the seven rows where
 * it can actually be scored.
 */
const GROUND_TRUTH = [
  {
    barcode: "035286301848",
    published: "30184",
    derived: "30184",
    agrees: true,
  },
  {
    barcode: "649833101746",
    published: "10174",
    derived: "10174",
    agrees: true,
  },
  {
    barcode: "035286296489",
    published: "29648",
    derived: "29648",
    agrees: true,
  },
  {
    barcode: "813810010431",
    published: "63005",
    derived: "01043",
    agrees: false,
  },
  {
    barcode: "812348010548",
    published: "CF-08LB",
    derived: "01054",
    agrees: false,
  },
  {
    barcode: "188218000453",
    published: "CRW-UINB",
    derived: "00045",
    agrees: false,
  },
  {
    barcode: "812348010555",
    published: "CF-012LB",
    derived: "01055",
    agrees: false,
  },
] as const;

describe("manufacturerItemRef", () => {
  it.each(GROUND_TRUTH)(
    "derives $derived from $barcode (published: $published)",
    ({ barcode, derived }) => {
      expect(manufacturerItemRef(barcode)).toBe(derived);
    },
  );

  it("agrees with the published part number for exactly 3 of the 7", () => {
    // 🔑 This number is the whole reason this source is a CORROBORATOR rather
    // than something to stop at. If a change made it 7 of 7 the source would
    // have become authoritative and the pipeline's ordering should change with
    // it — so the count is asserted, not left implicit.
    const agreeing = GROUND_TRUTH.filter(
      (r) => manufacturerItemRef(r.barcode) === r.published,
    );
    expect(agreeing).toHaveLength(3);

    // And every one it gets right is numeric — it cannot produce letters.
    for (const r of agreeing) expect(r.published).toMatch(/^\d+$/);
  });

  it("🔴 gets a numeric part number WRONG for one of the four", () => {
    // The case that forbids "free, so try it first and stop": the derivation
    // yields `01043` where the real part number is `63005`. Both are 5-digit
    // numerics, so nothing about the shape of the answer reveals the error —
    // it would have been searched as if authoritative.
    expect(manufacturerItemRef("813810010431")).toBe("01043");
    expect(manufacturerItemRef("813810010431")).not.toBe("63005");
  });

  it("⚠️ refuses a genuine EAN-13 rather than slicing it", () => {
    // An EAN-13's leading digits are a GS1 country/company prefix, so the same
    // slice yields digits that are nobody's part number. 1,081 of one real
    // client's 8,926 items are genuine EAN-13s — guessing here would
    // manufacture a wrong search key for 12% of a list, and a wrong key
    // produces a confident wrong match rather than an error.
    expect(manufacturerItemRef("6933337311393")).toBeNull();
    expect(manufacturerItemRef("4901990500005")).toBeNull();
  });

  it("handles a UPC-A that lost its leading zero", () => {
    // Two rows of the real client file are 11 digits because a spreadsheet ate
    // the zero. They are still UPC-As and still derivable.
    expect(manufacturerItemRef("37332173249")).toBe("17324");
  });

  it("refuses a value that is not a barcode", () => {
    expect(manufacturerItemRef("SQR-WKIT-R2")).toBeNull();
    expect(manufacturerItemRef("")).toBeNull();
  });
});

describe("identityFromBarcode", () => {
  it("supplies a part number and deliberately no brand or title", () => {
    // The `null`s are load-bearing: the merge falls back per field, so saying
    // "I don't know the brand" lets a lower-authority source supply it without
    // displacing the part number this source won.
    expect(
      identityFromBarcode({ barcode: "035286301848", clientSku: "082081" }),
    ).toEqual({ partNumber: "30184", brand: null, title: null });
  });

  it("declines entirely when nothing can be derived", () => {
    expect(
      identityFromBarcode({ barcode: "6933337311393", clientSku: "1" }),
    ).toBeNull();
  });
});
