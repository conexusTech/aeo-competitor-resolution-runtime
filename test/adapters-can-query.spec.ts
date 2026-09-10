import { describe, expect, it } from "vitest";

import { canQuery, type QuerySupport } from "../src/adapters/types.js";

/**
 * The launch retailer's measured constraint, as configuration.
 *
 * Probed directly with a control: a model number returns results, a real
 * 7-digit numeric model returns results, `123456789` returns an empty results
 * page, and `1234567890` and every barcode form return the error page. So the
 * constraint is **a digit count, not "numeric"** — 10 or more digits — and a
 * 9-digit numeric part number IS searchable.
 */
const LAUNCH_RETAILER: QuerySupport = {
  maxNumericQueryDigits: 9,
  barcodeIsSearchable: false,
};

const NO_LIMIT_KNOWN: QuerySupport = {
  maxNumericQueryDigits: null,
  barcodeIsSearchable: false,
};

describe("canQuery", () => {
  it("allows a part number, whatever its length", () => {
    expect(canQuery(LAUNCH_RETAILER, "CP1350PFCLCD")).toBe(true);
    expect(canQuery(LAUNCH_RETAILER, "CF-08LB")).toBe(true);
    expect(canQuery(LAUNCH_RETAILER, "Allsop 30184")).toBe(true);
  });

  it("allows a numeric part number at the measured boundary", () => {
    // 🔑 The half of the rule that is easy to lose. The naive reading is
    // "refuse numeric queries", which would refuse `2960703` — a real 7-digit
    // model number the retailer answers, and the key that resolved one of the
    // 22 verified rows. Refusing it would have cost a real match.
    expect(canQuery(LAUNCH_RETAILER, "2960703")).toBe(true);
    expect(canQuery(LAUNCH_RETAILER, "123456789")).toBe(true);
  });

  it("refuses a numeric query one digit past the boundary", () => {
    expect(canQuery(LAUNCH_RETAILER, "1234567890")).toBe(false);
  });

  it("refuses every barcode form, which is the point", () => {
    // A barcode verifies but does not locate: no barcode form is searchable,
    // so spending a request to discover that again is waste.
    for (const barcode of [
      "37332173249", // 11
      "649532609635", // 12
      "6933337311393", // 13
      "00097855114693", // 14
    ]) {
      expect(canQuery(LAUNCH_RETAILER, barcode)).toBe(false);
    }
  });

  it("refuses an empty or whitespace query", () => {
    expect(canQuery(LAUNCH_RETAILER, "")).toBe(false);
    expect(canQuery(LAUNCH_RETAILER, "   ")).toBe(false);
  });

  it("ignores surrounding whitespace when counting digits", () => {
    expect(canQuery(LAUNCH_RETAILER, " 1234567890 ")).toBe(false);
    expect(canQuery(LAUNCH_RETAILER, " 123456789 ")).toBe(true);
  });

  it("⚠️ allows anything when no limit has been measured", () => {
    // Deliberate: `null` means unmeasured, never unlimited-and-verified. A
    // retailer nobody has probed must not have a guessed cap invented for it —
    // that would silently refuse queries it can actually answer. The honest
    // failure is to spend one request and learn.
    expect(canQuery(NO_LIMIT_KNOWN, "1234567890123")).toBe(true);
  });
});
