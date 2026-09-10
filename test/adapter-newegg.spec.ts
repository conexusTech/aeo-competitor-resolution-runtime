import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  extractInitialState,
  neweggAdapter,
  parseProductPage,
  parseSearchResults,
  toPublicItemId,
} from "../src/adapters/newegg.js";
import manifest from "./raw/manifest.json" with { type: "json" };

/**
 * The parsers, against **real captured pages** from the retailer.
 *
 * These seven fixtures are gzipped real HTML — 2.1 MB of it, 369 KB committed —
 * chosen one per parser case rather than at random. Public retailer pages, not
 * customer data. They exist because markup nobody on this team controls is the
 * one thing a hand-written fixture cannot honestly stand in for.
 */

const raw = (name: string): string => {
  const url = new URL(`./raw/${name}.html.gz`, import.meta.url);
  return gunzipSync(readFileSync(fileURLToPath(url))).toString("utf8");
};

describe("the manifest and the fixtures agree", () => {
  it("lists every fixture the spec uses", () => {
    const names = manifest.fixtures.map((f) => f.name);
    for (const needed of [
      "search-many-results",
      "search-no-results",
      "search-warehouse-id-named-seller",
      "pdp-barcode-12",
      "pdp-barcode-13",
      "pdp-barcode-14",
      "pdp-barcode-empty",
    ]) {
      expect(names).toContain(needed);
    }
  });
});

describe("parseSearchResults, on real pages", () => {
  it("reads every candidate off the most populated captured page", () => {
    const candidates = parseSearchResults(raw("search-many-results"));
    expect(candidates).toHaveLength(44);
    // Every candidate must be usable: an id, a fetchable url, a title.
    for (const c of candidates) {
      expect(c.itemId).toBeTruthy();
      expect(c.url).toMatch(/^https:\/\//);
      expect(typeof c.title).toBe("string");
    }
    // Ids are deduplicated — an offer and its parent must not both appear.
    expect(new Set(candidates.map((c) => c.itemId)).size).toBe(
      candidates.length,
    );
  });

  it("🔴 returns [] for a page with state and no results, rather than throwing", () => {
    // The MAJORITY case: 156 of 271 captured search pages carry the embedded
    // state and no Products array. Treating it as a parse failure would turn
    // the retailer's ordinary "nothing matched" into an error on 58% of
    // searches — and an error is a different outcome from a miss.
    const html = raw("search-no-results");
    expect(extractInitialState(html)).not.toBeNull();
    expect(parseSearchResults(html)).toEqual([]);
  });

  it("returns [] for markup carrying no state at all", () => {
    expect(parseSearchResults("<html><body>nope</body></html>")).toEqual([]);
    expect(extractInitialState("<html></html>")).toBeNull();
  });

  it("🔴 calls a warehouse-shaped id with a named seller NOT first-party", () => {
    // The correction to the handover, on the real page that shows it. The spike
    // ranked on the item-id shape alone, which labels this listing first-party;
    // measured across 1,992 listings the two signals disagree on 358 (18%).
    // Ranking only cares because a marketplace listing publishes the SELLER's
    // barcode, so whose barcode it is follows the seller, not the stock.
    const candidates = parseSearchResults(
      raw("search-warehouse-id-named-seller"),
    );
    const offer = candidates.find((c) => c.sellerName !== null);
    expect(offer).toBeDefined();
    expect(offer?.itemId).toMatch(/^N82E168/); // warehouse-shaped, publicly addressed
    expect(offer?.isFirstParty).toBe(false); // and still not first-party
  });

  it("marks a listing with no named seller as first-party", () => {
    const candidates = parseSearchResults(raw("search-many-results"));
    const own = candidates.find((c) => c.sellerName === null);
    expect(own).toBeDefined();
    expect(own?.isFirstParty).toBe(true);
  });

  it("finds both kinds on one real page", () => {
    // A control on the signal itself: if `isFirstParty` were hardcoded either
    // way, one of these would be zero and every ranking assertion downstream
    // would still pass.
    const candidates = parseSearchResults(raw("search-many-results"));
    expect(candidates.filter((c) => c.isFirstParty).length).toBeGreaterThan(0);
    expect(candidates.filter((c) => !c.isFirstParty).length).toBeGreaterThan(0);
  });
});

describe("parseProductPage, on real pages", () => {
  it("reads a 12-digit barcode verbatim", () => {
    expect(parseProductPage(raw("pdp-barcode-12")).barcode).toBe(
      "065030870382",
    );
  });

  it("reads a zero-padded 14-digit barcode verbatim, without normalising it", () => {
    // Verbatim matters: normalising here would discard the evidence of what the
    // retailer actually published. Comparison is the caller's job.
    expect(parseProductPage(raw("pdp-barcode-14")).barcode).toBe(
      "00097855114693",
    );
  });

  it("✅ reads a GENUINE EAN-13 — the retailer does publish them", () => {
    // 🔑 This closes Phase CI-1's one open cross-row dependency. The board
    // recorded that nobody had checked whether the retailer's barcode field
    // carries EAN-13 for an import product, and that if it did not, 1,081 of
    // the client's 8,926 items (12%) would be UNVERIFIABLE by construction.
    //
    // Measured across all 255 captured product pages: 6 distinct genuine
    // EAN-13s, GS1 prefixes 502, 471, 426, 509 and 695 — all non-US, which is
    // exactly the import case in question. This fixture is one of them.
    const barcode = parseProductPage(raw("pdp-barcode-13")).barcode;
    expect(barcode).toBe("5028551561707");
    expect(barcode).toHaveLength(13);
    expect(barcode?.startsWith("0")).toBe(false); // not a padded UPC-A
  });

  it("🔴 reports an EMPTY barcode as null, not as an empty string", () => {
    // 91 of 255 captured pages — 35.7% — publish the key with no value. The
    // spike compared the empty string and got "no match", so "publishes nothing
    // comparable" and "names a different product" collapsed into one outcome.
    // They are different findings: the first is unverifiable, the second is a
    // mismatch. `null` is what lets the pipeline tell them apart.
    expect(parseProductPage(raw("pdp-barcode-empty")).barcode).toBeNull();
  });

  it("reports null for markup with no barcode field at all", () => {
    expect(parseProductPage("<html><body>x</body></html>").barcode).toBeNull();
  });
});

describe("toPublicItemId", () => {
  it("converts a warehouse id to its public form", () => {
    expect(toPublicItemId("42-301-682")).toBe("N82E16842301682");
  });

  it("passes a marketplace id through untouched", () => {
    expect(toPublicItemId("9SIA12345678901")).toBe("9SIA12345678901");
    expect(toPublicItemId("N82E16842301682")).toBe("N82E16842301682");
  });
});

describe("the adapter's own configuration", () => {
  it("names the retailer as data, not as a type", () => {
    expect(neweggAdapter.slug).toBe("newegg");
  });

  it("builds a search url that survives an awkward query", () => {
    expect(neweggAdapter.buildSearchUrl("Allsop 30184")).toBe(
      "https://www.newegg.com/p/pl?d=Allsop%2030184",
    );
    expect(neweggAdapter.buildSearchUrl("CF-08LB & more")).toContain("%26");
  });

  it("carries the measured numeric-query limit", () => {
    expect(neweggAdapter.querySupport.maxNumericQueryDigits).toBe(9);
    expect(neweggAdapter.querySupport.barcodeIsSearchable).toBe(false);
  });
});
