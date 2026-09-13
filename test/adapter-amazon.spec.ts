import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  amazonAdapter,
  parseProductPage,
  parseSearchResults,
  splitResultCells,
} from "../src/adapters/amazon.js";
import manifest from "./raw/manifest.json" with { type: "json" };

/**
 * The Amazon parsers, against **real captured pages**.
 *
 * ── 🔴 Why this file is written the way it is ───────────────────────────
 *
 * A reviewer of this repo read the product page below and reported that Amazon
 * publishes no barcode. It publishes a valid EAN-13 — under the label
 * `Global Trade Identification Number`, where the search had looked for `UPC`,
 * `EAN` and `GTIN`. Absence was reported from a search that could not have
 * found it.
 *
 * So the barcode checks here are deliberately paired: one proves the value IS
 * extracted, and one proves the sixteen incidental appearances of the letters
 * `UPC` elsewhere on that same page — `pickupDeliveryBlock`, `makeupCompact`,
 * `signUpForm`, base64 blobs — produce nothing. A parser that returned a
 * barcode from noise and a parser that returned nothing from a real one would
 * otherwise look identical from a passing suite.
 *
 * ⚠️ The fixtures are the handover's own, unmodified and gzipped. The product
 * page is 2.15 MB because that noise is the point; a trimmed capture would
 * prove less than this one does.
 */

const raw = (name: string): string => {
  const url = new URL(`./raw/${name}.html.gz`, import.meta.url);
  return gunzipSync(readFileSync(fileURLToPath(url))).toString("utf8");
};

const SEARCH = raw("amazon-search-results");
const PDP = raw("amazon-pdp-gtin-labelled");

describe("the manifest lists the Amazon fixtures", () => {
  it("names both, so their provenance survives this file", () => {
    const names = manifest.fixtures.map((f) => f.name);
    expect(names).toContain("amazon-search-results");
    expect(names).toContain("amazon-pdp-gtin-labelled");
  });
});

describe("splitResultCells", () => {
  /**
   * 🔴 The boundary is the enclosing `<div`, not the marker attribute. The ASIN
   * sits earlier in the same tag, so a marker-anchored split loses the first
   * cell's identifier into whatever precedes it.
   */
  it("starts each cell at the tag carrying the ASIN", () => {
    const cells = splitResultCells(SEARCH);
    expect(cells).toHaveLength(16);
    for (const cell of cells) {
      expect(cell.startsWith("<div")).toBe(true);
      expect(cell).toMatch(/^<div[^>]*\sdata-asin="[A-Z0-9]{10}"/);
    }
  });

  it("returns nothing for a page with no result cells", () => {
    expect(splitResultCells("<html><body>no results</body></html>")).toEqual(
      [],
    );
  });
});

describe("parseSearchResults against a real search page", () => {
  const candidates = parseSearchResults(SEARCH);

  it("returns every organic result once", () => {
    expect(candidates).toHaveLength(16);
    expect(new Set(candidates.map((c) => c.itemId)).size).toBe(16);
  });

  it("maps the first listing exactly", () => {
    const first = candidates[0];
    expect(first?.itemId).toBe("B0BFGB2D2Z");
    expect(first?.url).toBe("https://www.amazon.com/dp/B0BFGB2D2Z");
    expect(first?.title).toContain("G.SKILL Flare X5 Series DDR5 RAM");
    // The entity is decoded, not carried through as markup.
    expect(first?.title).toContain("AMD EXPO & Intel XMP");
    expect(first?.brand).toBe("G.SKILL");
    expect(first?.priceCents).toBe(47200);
    expect(first?.inStock).toBe(true);
  });

  /**
   * 🔴 The regression this adapter's price regex exists for. This listing
   * carries three `a-offscreen` values: the real $119.99, a loose
   * "List: $129.99", and the struck-through $129.99. Reporting the last of
   * those overstates a competitor's price, which is the single number this
   * product is bought for.
   */
  it("takes the offered price, not the struck-through list price", () => {
    const discounted = candidates.find((c) => c.itemId === "B0GYT7YGLR");
    expect(discounted?.priceCents).toBe(11999);
    expect(discounted?.priceCents).not.toBe(12999);
  });

  /**
   * 🔴 Amazon publishes neither field at the search stage. These must stay
   * null: a guessed model would be ranked as published evidence, and an
   * assumed `isFirstParty: true` would rank a marketplace listing — whose
   * barcode belongs to the SELLER — above a real one.
   */
  it("claims no model and no first-party status, because Amazon states neither", () => {
    for (const candidate of candidates) {
      expect(candidate.model).toBeNull();
      expect(candidate.isFirstParty).toBeNull();
      expect(candidate.sellerName).toBeNull();
    }
  });

  it("reads a brand for every listing, since it is guessed from the title", () => {
    expect(candidates.every((c) => c.brand !== null && c.brand !== "")).toBe(
      true,
    );
  });

  /**
   * 🔴 The check that actually earns the tight price regex.
   *
   * On the captured page the offered price happens to appear FIRST in every
   * cell, so a regex matching any `a-offscreen` gets the right answer there
   * by luck — a break-proof against the real fixture stays green when the
   * pattern is loosened, which is exactly the sort of check that proves
   * nothing. Amazon controls that ordering and we do not, so this case puts
   * the struck-through price first and asserts the offered one is still
   * chosen.
   */
  it("chooses by markup, not by order — list price first still yields the offered one", () => {
    const cell =
      '<div data-asin="B0TESTORDER" data-component-type="s-search-result">' +
      '<h2 aria-label="Widget">Widget</h2>' +
      // struck-through list price, emitted BEFORE the real one
      '<span class="a-price a-text-price" data-a-strike="true">' +
      '<span class="a-offscreen">$129.99</span></span>' +
      '<span class="a-price" data-a-size="xl">' +
      '<span class="a-offscreen">$119.99</span></span>' +
      "</div>";
    const parsed = parseSearchResults(cell);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.priceCents).toBe(11999);
  });

  it("prices every listing on this page — the CONTROL for the price checks", () => {
    // Without this, a regex that matched nothing would satisfy the
    // "not the struck-through price" assertion above perfectly.
    expect(candidates.every((c) => c.priceCents !== null)).toBe(true);
  });

  it("skips a cell with no ASIN rather than throwing", () => {
    const html = `<div ${'data-component-type="s-search-result"'}><h2 aria-label="x">x</h2></div>`;
    expect(parseSearchResults(html)).toEqual([]);
  });

  it("skips a cell with no title rather than inventing one", () => {
    const html = `<div data-asin="B0XXXXXXXX" ${'data-component-type="s-search-result"'}></div>`;
    expect(parseSearchResults(html)).toEqual([]);
  });

  it("returns [] for an unparseable page", () => {
    expect(
      parseSearchResults("<html><body>nothing here</body></html>"),
    ).toEqual([]);
  });
});

describe("parseProductPage against a real product page", () => {
  /**
   * 🔴 The label is `Global Trade Identification Number`, not `UPC`. The
   * handover's own findings state that every product page exposes a `UPC` row;
   * the page it shipped does not, and an extractor keyed on `UPC` returns
   * nothing here.
   */
  it("extracts the barcode published under a spelled-out GTIN label", () => {
    expect(parseProductPage(PDP).barcode).toBe("04713294232687");
  });

  it("finds no second barcode on a page whose field holds one value", () => {
    expect(parseProductPage(PDP).additionalBarcodes).toEqual([]);
  });

  /**
   * 🔴 The CONTROL for the check above, and the one that would have caught the
   * original misreading. That page contains the letters `UPC` sixteen times —
   * every one of them inside `pickupDeliveryBlock`, `makeupCompactTwister`,
   * `signUpForm` or a base64 blob. None is a barcode.
   */
  it("returns nothing from the sixteen incidental UPC strings on that page", () => {
    const noise = (PDP.toLowerCase().match(/upc/g) ?? []).length;
    expect(noise).toBeGreaterThanOrEqual(16);
    // The one value found is the GTIN row, not any of them.
    expect(parseProductPage(PDP).barcode).not.toMatch(/pickup|makeup|signup/i);
  });

  it("reports no barcode for a details table that publishes none", () => {
    const html =
      '<th class="prodDetSectionEntry">Brand</th><td class="prodDetAttrValue">G.SKILL</td>';
    const parsed = parseProductPage(html);
    expect(parsed.barcode).toBeNull();
    expect(parsed.additionalBarcodes).toEqual([]);
  });

  /**
   * 🔴 A measured case from the handover: one product page publishes two
   * space-separated barcodes in a single field, and the client's value was one
   * of them. Handing the raw field on is worse than dropping it — the two
   * concatenate to 24 digits, core to nothing, and read to `resolve` as a
   * barcode that DISAGREES rather than as nothing to compare.
   */
  it("splits a field holding more than one barcode", () => {
    const html =
      '<th class="prodDetSectionEntry">UPC</th>' +
      '<td class="prodDetAttrValue">812348010548 191120055664</td>';
    const parsed = parseProductPage(html);
    expect(parsed.barcode).toBe("812348010548");
    expect(parsed.additionalBarcodes).toEqual(["191120055664"]);
  });

  it("accepts the short UPC label too, not only the spelled-out one", () => {
    const html =
      '<th class="prodDetSectionEntry">UPC</th>' +
      '<td class="prodDetAttrValue">812348010548</td>';
    expect(parseProductPage(html).barcode).toBe("812348010548");
  });

  it("leaves the value verbatim, zero padding included", () => {
    // gtinCore reconciles encodings at compare time; normalising here would
    // discard what the retailer actually said.
    expect(parseProductPage(PDP).barcode).toMatch(/^0/);
  });
});

describe("the adapter itself", () => {
  it("is registered under the slug the gateway sends", () => {
    expect(amazonAdapter.slug).toBe("amazon");
  });

  it("builds an encoded search url", () => {
    expect(amazonAdapter.buildSearchUrl("F5-6000J3636F16GX2-FX5")).toBe(
      "https://www.amazon.com/s?k=F5-6000J3636F16GX2-FX5",
    );
    expect(amazonAdapter.buildSearchUrl("G.SKILL 32GB")).toContain(
      "G.SKILL%2032GB",
    );
  });

  /**
   * ⚠️ No numeric-query refusal has been measured on Amazon. A bare five-digit
   * part number is answered, with a page of unrelated products — noise, not a
   * refusal, and `canQuery` can only express a refusal. Claiming a limit here
   * would decline queries the retailer would have served.
   */
  it("claims no numeric query limit, because none has been measured", () => {
    expect(amazonAdapter.querySupport.maxNumericQueryDigits).toBeNull();
  });
});
