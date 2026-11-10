import { gunzipSync } from "node:zlib";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  extractInitialState,
  neweggAdapter,
  parseProductPage,
  parseSearchResults,
  toPublicItemId,
} from "../src/adapters/newegg.js";
import type { ParsedCandidate } from "../src/adapters/types.js";
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

/** The candidates on a page that must be a results page. */
const candidatesOn = (html: string): ParsedCandidate[] => {
  const parsed = parseSearchResults(html);
  if (parsed === null) throw new Error("expected a results page, got null");
  return parsed;
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
    const candidates = candidatesOn(raw("search-many-results"));
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

  it("🔴 returns null for markup carrying no state at all — not a results page", () => {
    // A block page, an error page, a truncated body: none of them is the
    // retailer saying "nothing matched", and `[]` would let the pipeline file
    // the item as not carried. `null` makes it an unanswered search instead.
    expect(parseSearchResults("<html><body>nope</body></html>")).toBeNull();
    expect(extractInitialState("<html></html>")).toBeNull();
  });

  it("keeps [] and null apart on the same real page — the CONTROL", () => {
    // Without this, a parser returning null for everything would satisfy the
    // check above while turning the majority case into an error.
    expect(parseSearchResults(raw("search-no-results"))).toEqual([]);
    expect(parseSearchResults(raw("search-many-results"))?.length).toBe(44);
  });

  it("🔴 calls a warehouse-shaped id with a named seller NOT first-party", () => {
    // The correction to the handover, on the real page that shows it. The spike
    // ranked on the item-id shape alone, which labels this listing first-party;
    // measured across 1,992 listings the two signals disagree on 358 (18%).
    // Ranking only cares because a marketplace listing publishes the SELLER's
    // barcode, so whose barcode it is follows the seller, not the stock.
    const candidates = candidatesOn(raw("search-warehouse-id-named-seller"));
    const offer = candidates.find((c) => c.sellerName !== null);
    expect(offer).toBeDefined();
    expect(offer?.itemId).toMatch(/^N82E168/); // warehouse-shaped, publicly addressed
    expect(offer?.isFirstParty).toBe(false); // and still not first-party
  });

  it("marks a listing with no named seller as first-party", () => {
    const candidates = candidatesOn(raw("search-many-results"));
    const own = candidates.find((c) => c.sellerName === null);
    expect(own).toBeDefined();
    expect(own?.isFirstParty).toBe(true);
  });

  it("finds both kinds on one real page", () => {
    // A control on the signal itself: if `isFirstParty` were hardcoded either
    // way, one of these would be zero and every ranking assertion downstream
    // would still pass.
    const candidates = candidatesOn(raw("search-many-results"));
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

/** `src/<rel>`, as text. */
const source = (rel: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../src/${rel}`, import.meta.url)),
    "utf8",
  );

/** Every source file under `src`, relative to it. */
const sourceFiles = (): string[] =>
  readdirSync(fileURLToPath(new URL("../src/", import.meta.url)), {
    recursive: true,
    encoding: "utf8",
  })
    .map((f) => f.split("\\").join("/"))
    .filter((f) => f.endsWith(".ts"));

/**
 * Each adapter file, by the slug it states — read from the files, so the next
 * adapter is covered without anyone adding it here.
 */
const adapterFiles = (): { file: string; slug: string; name: string }[] =>
  sourceFiles()
    .filter((f) => f.startsWith("adapters/") && f !== "adapters/types.ts")
    .map((file) => {
      const text = source(file);
      const slug = /^\s*slug: "([^"]+)",/m.exec(text)?.[1];
      const name = /export const (\w+Adapter)\b/.exec(text)?.[1];
      if (slug === undefined || name === undefined) {
        throw new Error(`${file} states no slug or exports no adapter`);
      }
      return { file, slug, name };
    });

describe("the adapter's own configuration", () => {
  /**
   * 🔴 **A grep, and the weakest check here** — it proves no line names a
   * retailer or compares a slug, not that no code behaves differently per
   * retailer. Widened with the third adapter: every adapter's slug, every
   * source file, and each adapter naming no retailer but its own.
   */
  it("names the retailer as data, not as a type", () => {
    expect(neweggAdapter.slug).toBe("newegg");

    const adapters = adapterFiles();
    // Not vacuous: Newegg, Amazon, Best Buy and B&H at least.
    expect(adapters.map((a) => a.slug)).toEqual(
      expect.arrayContaining(["newegg", "amazon", "bestbuy", "bh"]),
    );
    const named = new RegExp(
      `["'\`](?:${adapters.map((a) => a.slug).join("|")}|bh|costco)["'\`]`,
    );
    const offending: string[] = [];
    for (const file of sourceFiles()) {
      const own = adapters.find((a) => a.file === file)?.slug;
      for (const [n, line] of source(file).split("\n").entries()) {
        // Prose is not a code path: a comment may quote the union the seam
        // exists to refuse.
        if (/^\s*(?:\*|\/\*|\/\/)/.test(line)) continue;
        // A comparison against a slug literal, either way round. A `typeof`
        // test is a type check on the field, not a retailer.
        const compares =
          (!/typeof/.test(line) &&
            /[sS]lug\s*[!=]==?\s*["'`][^"'`]+["'`]/.test(line)) ||
          /["'`][^"'`]+["'`]\s*[!=]==?\s*\w*[sS]lug\b/.test(line);
        // A retailer named as a literal — anywhere but its own `slug:` line.
        const ownSlugLine =
          own !== undefined && line.includes(`slug: "${own}"`);
        if (compares || (named.test(line) && !ownSlugLine)) {
          offending.push(`src/${file}:${n + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });

  it("CONTROL: the grep finds a slug compared or named where one is", () => {
    const named = /["'`](?:newegg|amazon|bestbuy|bh|costco)["'`]/;
    const compares = /[sS]lug\s*[!=]==?\s*["'`][^"'`]+["'`]/;
    expect(compares.test('if (adapter.slug === "bestbuy") {')).toBe(true);
    expect(named.test('const fallback = "bestbuy";')).toBe(true);
  });

  it("🔴 the image carries every adapter, each keyed by its own slug", () => {
    const main = source("main.ts");
    for (const { name } of adapterFiles()) {
      expect(main, `${name} is not registered`).toContain(
        `[${name}.slug]: ${name},`,
      );
    }
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

/**
 * The listing's product photo.
 *
 * 🔴 **Newegg publishes a FILENAME, not a URL** — `"ImageName":
 * "26-197-401-10.jpg"` — so the CDN prefix is the adapter's to supply. The
 * column this feeds had never been written by anything: 0 of 50 stored Newegg
 * listings carried an image before this.
 */
describe("a candidate carries the retailer's product image", () => {
  const results = candidatesOn(raw("search-many-results"));

  it("builds the CDN url from the published filename", () => {
    const withImage = results.filter((c) => c.imageUrl !== null);
    expect(withImage.length).toBeGreaterThan(0);
    for (const c of withImage) {
      expect(c.imageUrl).toMatch(
        /^https:\/\/c1\.neweggimages\.com\/productimage\/nb300\/[^/]+$/,
      );
    }
  });

  it("covers most of the page — the CONTROL", () => {
    // Without this, a pattern that found one image on a page of many would
    // satisfy the check above.
    expect(results.length).toBeGreaterThan(5);
    const withImage = results.filter(
      (c) =>
        typeof c.imageUrl === "string" && c.imageUrl.startsWith("https://"),
    );
    expect(withImage.length / results.length).toBeGreaterThan(0.8);
  });
});
