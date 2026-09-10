import { describe, expect, it } from "vitest";

import {
  mergeIdentities,
  PROVENANCE_BY_AUTHORITY,
  type IdentityProvenance,
} from "../src/identity/types.js";

type Partial_ = {
  partNumber: string | null;
  brand: string | null;
  title: string | null;
};

const found = (
  entries: [IdentityProvenance, Partial<Partial_>][],
): Map<IdentityProvenance, Partial_> =>
  new Map(
    entries.map(([p, v]) => [
      p,
      { partNumber: null, brand: null, title: null, ...v },
    ]),
  );

describe("mergeIdentities", () => {
  it("prefers the authoritative source over the free one", () => {
    // 🔴 The case that forbids "free, so use it first". The barcode derives
    // `01043`; the client's catalogue publishes `63005`. Both are 5-digit
    // numerics, so nothing about the answer's shape reveals which is right —
    // only its provenance does.
    const merged = mergeIdentities(
      found([
        ["barcode-derived", { partNumber: "01043" }],
        ["client-catalogue", { partNumber: "63005", brand: "SteelSeries" }],
      ]),
    );
    expect(merged?.partNumber).toBe("63005");
    expect(merged?.provenance).toBe("client-catalogue");
    expect(merged?.corroboratedBy).toEqual([]);
  });

  it("records agreement between independent sources as corroboration", () => {
    // Measured on 3 of 7 real rows: the barcode-derived reference reproduces
    // the published part number exactly. Two independent derivations agreeing
    // is stronger evidence than either alone, and discarding that is what the
    // handover did.
    const merged = mergeIdentities(
      found([
        ["client-catalogue", { partNumber: "30184", brand: "Allsop" }],
        ["barcode-derived", { partNumber: "30184" }],
      ]),
    );
    expect(merged?.partNumber).toBe("30184");
    expect(merged?.provenance).toBe("client-catalogue");
    expect(merged?.corroboratedBy).toEqual(["barcode-derived"]);
  });

  it("does not corroborate on a different part number", () => {
    const merged = mergeIdentities(
      found([
        ["client-catalogue", { partNumber: "63005" }],
        ["barcode-derived", { partNumber: "01043" }],
        ["search-inference", { partNumber: "63005" }],
      ]),
    );
    expect(merged?.corroboratedBy).toEqual(["search-inference"]);
  });

  it("falls back per field, not per source", () => {
    // A barcode yields a part number and no brand; an inference yields a brand
    // and a title. Taking the whole record from one source would throw away
    // half of what is known.
    const merged = mergeIdentities(
      found([
        ["barcode-derived", { partNumber: "30184" }],
        ["search-inference", { brand: "Allsop", title: "Widget XL" }],
      ]),
    );
    expect(merged).toEqual({
      partNumber: "30184",
      brand: "Allsop",
      title: "Widget XL",
      provenance: "barcode-derived",
      corroboratedBy: [],
    });
  });

  it("uses a lower-authority part number when the higher one has none", () => {
    // A catalogue page can identify the right product and publish no part
    // number — ordinary, since that every client SKU publishes one is
    // unmeasured. The brand still comes from the authoritative source.
    const merged = mergeIdentities(
      found([
        [
          "client-catalogue",
          { partNumber: null, brand: "Kingwin", title: "Fan" },
        ],
        ["search-inference", { partNumber: "CF-08LB", brand: "Kingwin Inc" }],
      ]),
    );
    expect(merged?.partNumber).toBe("CF-08LB");
    expect(merged?.provenance).toBe("search-inference");
    // Brand still prefers the authoritative source's spelling.
    expect(merged?.brand).toBe("Kingwin");
  });

  it("returns an identity with no part number rather than nothing", () => {
    // A brand and a title are still a searchable phrase. Returning null here
    // would discard the only thing known about the item.
    const merged = mergeIdentities(
      found([["client-catalogue", { brand: "Allsop", title: "Widget XL" }]]),
    );
    expect(merged).toEqual({
      partNumber: null,
      brand: "Allsop",
      title: "Widget XL",
      provenance: "client-catalogue",
      corroboratedBy: [],
    });
  });

  it("returns null only when nothing was found at all", () => {
    expect(mergeIdentities(found([]))).toBeNull();
  });

  it("treats an empty string as absent", () => {
    const merged = mergeIdentities(
      found([
        ["client-catalogue", { brand: "", title: "" }],
        ["search-inference", { brand: "Acme", title: "Thing" }],
      ]),
    );
    expect(merged?.brand).toBe("Acme");
  });

  it("pins the authority order, because everything above depends on it", () => {
    expect([...PROVENANCE_BY_AUTHORITY]).toEqual([
      "client-catalogue",
      "barcode-derived",
      "search-inference",
    ]);
  });
});
