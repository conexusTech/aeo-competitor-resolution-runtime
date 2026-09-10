import { describe, expect, it } from "vitest";

import {
  gtinCore,
  gtinMatches,
  gtinVariants,
  isValidGtin,
} from "../src/gtin.js";

/**
 * The four pairs in `the retailer's own field` below are **measured**, not
 * invented: they are the rows of the handover's 53-row run where the retailer's
 * barcode field disagreed byte-for-byte with the client's value while the
 * pairing was genuinely correct. They are the whole reason this module exists,
 * so they are the first thing it is checked against.
 */
describe("gtinCore", () => {
  it("strips leading zeros so every encoding of one barcode agrees", () => {
    expect(gtinCore("012345678905")).toBe("12345678905");
    expect(gtinCore("0012345678905")).toBe("12345678905");
    expect(gtinCore("00012345678905")).toBe("12345678905");
  });

  it("strips non-digits, because a formatted barcode is still that barcode", () => {
    expect(gtinCore("0-12345-67890-5")).toBe("12345678905");
    expect(gtinCore(" 012345678905 ")).toBe("12345678905");
  });

  it("returns empty for a value carrying no digits at all", () => {
    // Three different reasons, all landing on "": a part number whose only
    // digit is mined out ("2"), no digits at all, and a digit run far too
    // short to be any GTIN encoding.
    expect(gtinCore("SQR-WKIT-R2")).toBe("");
    expect(gtinCore("")).toBe("");
    expect(gtinCore("0000")).toBe("");
  });
});

describe("gtinMatches — the retailer's own field, measured", () => {
  it.each([
    // client value      retailer value        what the retailer did
    ["097855114693", "00097855114693", "padded a UPC-A to GTIN-14"],
    ["097855112859", "00097855112859", "padded a UPC-A to GTIN-14"],
    ["619659075538", "0619659075538", "padded a UPC-A to EAN-13"],
    ["663296420732", "0663296420732", "padded a UPC-A to EAN-13"],
  ])("matches %s against %s (%s)", (client, retailer) => {
    expect(gtinMatches(client, retailer)).toBe(true);
    // And the comparison is symmetric — which side arrives first is an
    // accident of the pipeline, not a property of the barcodes.
    expect(gtinMatches(retailer, client)).toBe(true);
  });

  it("agrees byte-for-byte on the ordinary case too", () => {
    // 18 of the 22 measured pairings were already equal; the fix must not
    // break them, which a normalisation that only ever ADDED padding could.
    expect(gtinMatches("649532609635", "649532609635")).toBe(true);
    expect(gtinMatches("663296413697", "663296413697")).toBe(true);
  });

  it("does not match two different products", () => {
    expect(gtinMatches("097855114693", "097855112859")).toBe(false);
  });

  it("🔴 never matches when either side carries no digits", () => {
    // The control that matters. Both of these core to "", so a naive
    // `coreA === coreB` would report them as THE SAME PRODUCT — turning
    // "neither of these is a barcode" into a confident false pairing.
    expect(gtinMatches("SQR-WKIT-R2", "1PZ1ML00050X")).toBe(false);
    expect(gtinMatches("", "")).toBe(false);
    expect(gtinMatches("0000", "000")).toBe(false);
    expect(gtinMatches("097855114693", "")).toBe(false);
  });

  it("keeps a genuine EAN-13 distinct from anything else", () => {
    // A real EAN-13 from the client file with no UPC-A equivalent. It must
    // compare equal to itself and to its GTIN-14 padding, and to nothing else.
    expect(gtinMatches("6933337311393", "6933337311393")).toBe(true);
    expect(gtinMatches("6933337311393", "06933337311393")).toBe(true);
    expect(gtinMatches("6933337311393", "933337311393")).toBe(false);
  });
});

describe("gtinVariants", () => {
  it("offers every width a retailer might publish", () => {
    expect([...gtinVariants("619659075538")].sort()).toEqual(
      ["619659075538", "0619659075538", "00619659075538"].sort(),
    );
  });

  it("never truncates a value longer than a target width", () => {
    // A GTIN-14 padded to 12 would be cut down to something naming a
    // different product. `padStart` cannot shorten — this pins that.
    const variants = gtinVariants("10012345678905");
    expect(variants.has("10012345678905")).toBe(true);
    for (const v of variants) expect(v.length).toBeGreaterThanOrEqual(14);
  });

  it("is empty for a value carrying no digits, so it can match nothing", () => {
    expect(gtinVariants("SQR-WKIT-R2").size).toBe(0);
  });
});

describe("isValidGtin", () => {
  it.each([
    "649532609635", // UPC-A, real, from the measured run
    "663296413697",
    "6933337311393", // EAN-13, real, from the client file
    "00097855114693", // GTIN-14
  ])("accepts %s", (value) => {
    expect(isValidGtin(value)).toBe(true);
  });

  it("rejects a single-digit change", () => {
    // The control. A checker that returned `true` unconditionally would pass
    // every assertion above and nothing else in this file would notice.
    expect(isValidGtin("649532609636")).toBe(false);
    expect(isValidGtin("649532609625")).toBe(false);
  });

  it("rejects a value that is not a barcode at all", () => {
    expect(isValidGtin("SQR-WKIT-R2")).toBe(false);
    expect(isValidGtin("")).toBe(false);
    expect(isValidGtin("1234")).toBe(false);
  });

  it("rejects a formatted value rather than silently accepting it", () => {
    // Validation is deliberately stricter than comparison: `gtinCore` will
    // happily normalise a hyphenated barcode, but a stored value carrying
    // punctuation is a data-entry problem the caller should hear about.
    expect(isValidGtin("0-12345-67890-5")).toBe(false);
  });
});
