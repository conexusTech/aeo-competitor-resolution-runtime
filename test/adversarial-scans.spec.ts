import { describe, expect, it } from "vitest";

import { parseSitemap, parseSitemapIndex } from "../src/adapters/costco.js";

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
