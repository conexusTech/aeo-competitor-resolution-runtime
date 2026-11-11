import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as amazon from "../src/adapters/amazon.js";
import * as bestbuy from "../src/adapters/bestbuy.js";
import * as bh from "../src/adapters/bh.js";
import * as costco from "../src/adapters/costco.js";
import * as newegg from "../src/adapters/newegg.js";
import type {
  ListingCategory,
  ListingPageResult,
} from "../src/adapters/types.js";

/**
 * A product page names the retailer's own category its product sits in — the
 * deepest level of its breadcrumb — so a watched listing can be placed in a
 * category a category read covers. Read off real product pages; the bodies
 * built here are SYNTHETIC and said so where built.
 */

const raw = (name: string): string =>
  gunzipSync(
    readFileSync(
      fileURLToPath(new URL(`./raw/${name}.html.gz`, import.meta.url)),
    ),
  ).toString("utf8");

const categoryOfReading = (r: ListingPageResult): ListingCategory | null => {
  if (r.kind !== "page") throw new Error(`expected a page, got ${r.kind}`);
  return r.page.category;
};

describe("B&H: the leaf of the product's primary category path", () => {
  it("reads it off each real product page", () => {
    const mice = {
      id: "18369",
      name: "Mice & Touchpads",
      url: "https://www.bhphotovideo.com/c/buy/Mice-Touchpads/ci/18369",
    };
    expect(bh.parseProductPage(raw("bh-pdp-m310"))?.category).toEqual(mice);
    expect(bh.parseProductPage(raw("bh-pdp-kit-components"))?.category).toEqual(
      mice,
    );
    expect(
      bh.parseProductPage(raw("bh-pdp-z623-discontinued"))?.category,
    ).toEqual({
      id: "6565",
      name: "Computer Speakers",
      url: "https://www.bhphotovideo.com/c/buy/Computer-Speakers/ci/6565",
    });
    expect(
      bh.parseProductPage(raw("bh-pdp-bk350-special-order"))?.category,
    ).toEqual({
      id: "12831",
      name: "UPS Backup",
      url: "https://www.bhphotovideo.com/c/buy/UPS-Backup/ci/12831",
    });
    // The read run's reading carries the same.
    expect(categoryOfReading(bh.readListingPage(raw("bh-pdp-m310")))).toEqual(
      mice,
    );
  });

  it("🔑 the category a product page names is one a category read can walk", () => {
    const category = bh.parseProductPage(raw("bh-pdp-m310"))?.category;
    expect(category).toBeDefined();
    expect(bh.bhAdapter.categoryReader?.pageUrl(category?.url ?? "", 2)).toBe(
      "https://www.bhphotovideo.com/c/buy/Mice-Touchpads/ci/18369/pn/2",
    );
  });

  it("is null where the page has no category path (SYNTHETIC)", () => {
    const body = raw("bh-pdp-m310").replace(
      /primaryCategoryPath/g,
      "somethingElse",
    );
    expect(bh.parseProductPage(body)?.category).toBeNull();
    // The rest of the page reads as it did: only the category went.
    expect(bh.parseProductPage(body)?.barcode).toBe("097855066237");
  });
});

describe("Newegg: the deepest category link in the product page's breadcrumb", () => {
  it("reads it off each real product page, never the brand-in-category crumb", () => {
    // Each page's crumb after the subcategory is the same products narrowed
    // to one brand (`BrandSubCat/ID-1762-696`, "STARTECH"): not a category.
    const cases: [string, ListingCategory][] = [
      [
        "pdp-barcode-12",
        {
          id: "696",
          name: "TV Mounts & Install Accessories",
          url: "https://www.newegg.com/TV-Mounts-Install-Accessories/SubCategory/ID-696",
        },
      ],
      [
        "pdp-barcode-13",
        {
          id: "2820",
          name: "Internal Power Cables",
          url: "https://www.newegg.com/Internal-Power-Cables/SubCategory/ID-2820",
        },
      ],
      [
        "pdp-barcode-14",
        {
          id: "3929",
          name: "Driving Simulators",
          url: "https://www.newegg.com/Driving-Simulators/SubCategory/ID-3929",
        },
      ],
      [
        "pdp-barcode-empty",
        {
          id: "3048",
          name: "Audio Video Converters",
          url: "https://www.newegg.com/Audio-Video-Converters/SubCategory/ID-3048",
        },
      ],
    ];
    for (const [name, category] of cases) {
      const html = raw(name);
      expect([name, newegg.parseProductPage(html).category]).toEqual([
        name,
        category,
      ]);
      expect([name, categoryOfReading(newegg.readListingPage(html))]).toEqual([
        name,
        category,
      ]);
    }
  });

  it("CONTROL: the brand crumb is on the page, after the category", () => {
    const html = raw("pdp-barcode-12");
    expect(html).toContain("/BrandSubCat/ID-1762-696");
    expect(html.indexOf("/BrandSubCat/ID-1762-696")).toBeGreaterThan(
      html.indexOf("/SubCategory/ID-696"),
    );
  });

  it("decodes the name's entities, hex ones included (SYNTHETIC)", () => {
    const html =
      '<div class="breadcrumbs"><ol><li><a href="https://www.newegg.com/Ruth-s-Cables/SubCategory/ID-12" title="Ruth&#x27;s Cables &amp; More">x</a></li></ol></div>';
    expect(newegg.breadcrumbCategory(html)).toEqual({
      id: "12",
      name: "Ruth's Cables & More",
      url: "https://www.newegg.com/Ruth-s-Cables/SubCategory/ID-12",
    });
  });

  it("is null where the page has no breadcrumb, or no category in it (SYNTHETIC)", () => {
    expect(newegg.breadcrumbCategory("<html></html>")).toBeNull();
    const homeOnly =
      '<div class="breadcrumbs"><ol><li><a href="https://www.newegg.com/" title="Home">Home</a></li></ol></div>';
    expect(newegg.breadcrumbCategory(homeOnly)).toBeNull();
    // 🔴 Off Newegg's own host, a crumb is not a category.
    const offHost =
      '<div class="breadcrumbs"><ol><li><a href="https://evil.example/x/SubCategory/ID-1" title="X">X</a></li></ol></div>';
    expect(newegg.breadcrumbCategory(offHost)).toBeNull();
  });
});

describe("Amazon: the deepest browse node in the product page's breadcrumb", () => {
  it("reads it off the real product page, as its browse page", () => {
    const memory = {
      id: "172500",
      name: "Memory",
      url: "https://www.amazon.com/b?node=172500",
    };
    const html = raw("amazon-pdp-gtin-labelled");
    expect(amazon.parseProductPage(html).category).toEqual(memory);
    expect(categoryOfReading(amazon.readListingPage(html))).toEqual(memory);
  });

  it("is null where the page has no breadcrumb (SYNTHETIC)", () => {
    expect(amazon.breadcrumbCategory("<html></html>")).toBeNull();
    expect(
      amazon.breadcrumbCategory(
        '<div id="wayfinding-breadcrumbs_feature_div"><ul></ul></div>',
      ),
    ).toBeNull();
  });
});

describe("Best Buy and Costco place no listing in a category", () => {
  it("reads null off their real product pages", () => {
    expect(
      bestbuy.parseProductPage(raw("bestbuy-pdp-m310"))?.category,
    ).toBeNull();
    const sl900 = gunzipSync(
      readFileSync(
        fileURLToPath(
          new URL("./raw/costco-pdp-sl900uc.html.gz", import.meta.url),
        ),
      ),
    ).toString("utf8");
    expect(costco.parseProductPage(sl900)?.category).toBeNull();
  });
});
