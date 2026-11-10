import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseProductPage as parseBestBuyPage } from "../src/adapters/bestbuy.js";
import { parseProductPage as parseBhPage } from "../src/adapters/bh.js";
import {
  ldProduct,
  parseSitemap,
  parseSitemapIndex,
  productDetails,
} from "../src/adapters/costco.js";

/**
 * 🔴 **Every scan of a page a competitor controls is linear.**
 *
 * A product page, a search page and a sitemap are bytes from somebody else's
 * server, read through a proxy, and a regular expression that backtracks over
 * them turns one hostile or broken body into a run that never finishes. Each
 * check below feeds the adversarial shape of one scan and requires it to end
 * in well under the time a backtracking one takes.
 */

/** Milliseconds `run` takes. */
function timed(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

const LIMIT_MS = 100;

describe("Costco's sitemap <loc> scan (security finding 1)", () => {
  const unclosed = `<loc>${" ".repeat(50_000)}`;

  it("🔴 an unclosed <loc> of 50,000 spaces is read in under 100 ms", () => {
    expect(
      timed(() => parseSitemap(`<urlset>${unclosed}</urlset>`)),
    ).toBeLessThan(LIMIT_MS);
    expect(
      timed(() => parseSitemapIndex(`<sitemapindex>${unclosed}`)),
    ).toBeLessThan(LIMIT_MS);
  });

  it("CONTROL: a <loc> padded with whitespace still reads, trimmed", () => {
    const body =
      `<sitemapindex xmlns="x"><sitemap><loc>\n  ` +
      `https://www.costco.com/sitemap_lw_p_mod_001.xml  \n</loc></sitemap></sitemapindex>`;
    expect(parseSitemapIndex(body)).toEqual([
      "https://www.costco.com/sitemap_lw_p_mod_001.xml",
    ]);
    expect(
      parseSitemap(
        `<urlset><url><loc> https://www.costco.com/p/-/a-b/100 </loc></url></urlset>`,
      ),
    ).toEqual([
      { itemId: "100", url: "https://www.costco.com/p/-/a-b/100", name: "a b" },
    ]);
  });
});

// ── Security finding 3: the page scans ──────────────────────────────────

const rawPage = (name: string): string =>
  gunzipSync(
    readFileSync(fileURLToPath(new URL(`./raw/${name}.gz`, import.meta.url))),
  ).toString("utf8");

/** Twenty thousand JSON-LD openings, not one closed. */
const UNCLOSED_LD = '<script type="application/ld+json">{'.repeat(20_000);

describe("the JSON-LD scans stop at the first tag with no </script> (security finding 3)", () => {
  it("🔴 Best Buy reads a page ending in 20,000 unclosed JSON-LD tags in under 100 ms", () => {
    const html = rawPage("bestbuy-pdp-m310.html") + UNCLOSED_LD;
    let parsed: ReturnType<typeof parseBestBuyPage> = null;
    expect(timed(() => (parsed = parseBestBuyPage(html)))).toBeLessThan(
      LIMIT_MS,
    );
    // The page's own JSON-LD, before the tail, still reads.
    expect(parsed).toEqual(parseBestBuyPage(rawPage("bestbuy-pdp-m310.html")));
  });

  it("🔴 B&H does too", () => {
    const html = rawPage("bh-pdp-m310.html") + UNCLOSED_LD;
    let parsed: ReturnType<typeof parseBhPage> = null;
    expect(timed(() => (parsed = parseBhPage(html)))).toBeLessThan(LIMIT_MS);
    expect(parsed).toEqual(parseBhPage(rawPage("bh-pdp-m310.html")));
  });

  it("🔴 Costco does too", () => {
    // A page with no Product node, so the scan cannot stop early on one.
    const html = rawPage("costco-search-upc-649532936564.html") + UNCLOSED_LD;
    expect(timed(() => ldProduct(html))).toBeLessThan(LIMIT_MS);
    expect(ldProduct(html)).toBeNull();
  });

  it("CONTROL: a closed JSON-LD block after an unclosed one is not read past it", () => {
    expect(
      ldProduct(
        '<script type="application/ld+json">{"@type":"Product","name":"a"}</script>',
      ),
    ).toEqual({ "@type": "Product", name: "a" });
  });
});

describe("B&H's rendered UPC line (security finding 3)", () => {
  it("🔴 a UPC line of 50,000 spaces with no closing tag reads in under 100 ms", () => {
    const html =
      rawPage("bh-pdp-m310.html") +
      `<span data-selenium="overviewUpcText">UPC:${" ".repeat(50_000)}`;
    expect(timed(() => parseBhPage(html))).toBeLessThan(LIMIT_MS);
  });

  it("CONTROL: a spaced UPC line still reads its value", () => {
    const html = rawPage("bh-pdp-m310.html").replace(
      "</body>",
      '<span data-selenium="overviewUpcText">UPC:   097855066237  </span></body>',
    );
    expect(parseBhPage(html)?.barcode).toBe("097855066237");
  });
});

describe("Costco's productDetailsData scan (security finding 3)", () => {
  const flight = (text: string): string =>
    `<script>self.__next_f.push([1,${JSON.stringify(text)}])</script>`;

  it("🔴 20,000 unclosed productDetailsData objects are read in under 100 ms", () => {
    const html = flight('"productDetailsData":{"a":'.repeat(20_000));
    expect(timed(() => productDetails(html))).toBeLessThan(LIMIT_MS);
    expect(productDetails(html)).toBeNull();
  });

  it("🔴 20,000 nested ones, each balanced and none a product, too", () => {
    const n = 20_000;
    const html = flight(
      `${'"productDetailsData":{"x":'.repeat(n)}1${"}".repeat(n)}`,
    );
    expect(timed(() => productDetails(html))).toBeLessThan(LIMIT_MS);
    expect(productDetails(html)).toBeNull();
  });

  it("CONTROL: a product after a rejected object is still found", () => {
    const html = flight(
      '"productDetailsData":{"productData":{}},' +
        '"productDetailsData":{"productData":{"id":"42"}}',
    );
    expect(productDetails(html)).toEqual({ productData: { id: "42" } });
  });
});
