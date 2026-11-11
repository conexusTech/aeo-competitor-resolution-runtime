import { gunzipSync } from "node:zlib";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  amazonAdapter,
  parseSearchResults as parseAmazonSearch,
} from "../src/adapters/amazon.js";
import { bestbuyAdapter } from "../src/adapters/bestbuy.js";
import {
  bhAdapter,
  parseSearchResults as parseBhSearch,
} from "../src/adapters/bh.js";
import { costcoAdapter } from "../src/adapters/costco.js";
import {
  neweggAdapter,
  parseSearchResults as parseNeweggSearch,
} from "../src/adapters/newegg.js";
import { neweggBody, rewriteBhCategoryPage } from "./category-bodies.js";
import type {
  CategoryPage,
  CategoryPageResult,
  CategoryReader,
} from "../src/adapters/types.js";

/**
 * One read of a competitor's category page reports the price of every product
 * it lists, and a page that is not a category page is a failure.
 *
 * Every category page here is real — B&H's Mice & Touchpads at pages 1, 2, 15
 * (the last) and 16 (past the end), Newegg's Desktop and Laptop Memory, an
 * Amazon results grid — distilled and proven parse-identical to its raw
 * capture (`scripts/distil-bh.mjs`, `scripts/distil-category.mjs`). The bodies
 * built here are SYNTHETIC and said so where built: no Newegg or Amazon page
 * past the end, and no category-page refusal, has been captured.
 */

const raw = (name: string): string =>
  gunzipSync(
    readFileSync(
      fileURLToPath(new URL(`./raw/${name}.html.gz`, import.meta.url)),
    ),
  ).toString("utf8");

function readerOf(adapter: { categoryReader: CategoryReader | null }) {
  const reader = adapter.categoryReader;
  if (reader === null) throw new Error("expected a category reader");
  return reader;
}
const BH = readerOf(bhAdapter);
const NEWEGG = readerOf(neweggAdapter);
const AMAZON = readerOf(amazonAdapter);

/** The page a body must read as. */
function pageOf(result: CategoryPageResult): CategoryPage {
  if (result.kind !== "page") {
    throw new Error(`expected a page, got ${result.kind}: ${result.detail}`);
  }
  return result.page;
}
const ids = (page: CategoryPage): string[] =>
  page.products.map((p) => p.itemId);

/** What a page refused for, or what it read as. */
const kindOf = (result: CategoryPageResult): string => result.kind;

/** Bodies that are no category page at all, whoever the retailer. */
const REFUSALS: readonly [string, string][] = [
  ["an empty body", ""],
  ["a short body", "<html></html>"],
  [
    "a refusal",
    "<html><head><title>Access Denied</title></head><body>You don't have permission to access this page.</body></html>",
  ],
  [
    "a robot check",
    '<html><body><form action="/errors/validateCaptcha"><h4>Enter the characters you see below</h4></form></body></html>',
  ],
];

// ── B&H ───────────────────────────────────────────────────────────────

const BH_P1 = raw("bh-category-mice-p1");
const BH_P2 = raw("bh-category-mice-p2");
const BH_P15 = raw("bh-category-mice-p15-last");
const BH_P16 = raw("bh-category-mice-p16-past-end");
const BH_CATEGORY =
  "https://www.bhphotovideo.com/c/buy/mice-wireless-bluetooth-usb/ci/18369";

describe("B&H: one category page prices every product it lists", () => {
  it("reads 28 a page, then the 20 on the last, 412 in all", () => {
    const p1 = pageOf(BH.readCategoryPage(BH_P1, 1));
    const p2 = pageOf(BH.readCategoryPage(BH_P2, 2));
    const p15 = pageOf(BH.readCategoryPage(BH_P15, 15));
    expect([p1, p2, p15].map((p) => p.products.length)).toEqual([28, 28, 20]);
    // 14 x 28 + 20 = 412: the count, and the page it puts last.
    for (const p of [p1, p2, p15]) {
      expect(p.total).toBe(412);
      expect(p.lastPage).toBe(15);
    }
    expect(p1.products[0]).toEqual({
      itemId: "1910635",
      priceCents: 11999,
      inStock: true,
    });
    expect(ids(p15).at(-1)).toBe("1858018");
    // Each page its own products: none listed twice across the three.
    const all = [...ids(p1), ...ids(p2), ...ids(p15)];
    expect(new Set(all).size).toBe(76);
  });

  it("🔑 names each product exactly as a search names its listing", () => {
    // The search parse reads the same listing payload: the ids a category
    // read reports are the ids the platform's B&H listings carry.
    for (const [body, n] of [
      [BH_P1, 1],
      [BH_P2, 2],
      [BH_P15, 15],
    ] as const) {
      const fromSearch = (parseBhSearch(body) ?? []).map((c) => c.itemId);
      expect(ids(pageOf(BH.readCategoryPage(body, n)))).toEqual(fromSearch);
    }
  });

  it("🔴 a card whose price B&H withholds reads as no price, never 0", () => {
    // Three MAP items on page 1, one on page 2: "Add to Cart for Price".
    const unpriced = (body: string, n: number): string[] =>
      pageOf(BH.readCategoryPage(body, n))
        .products.filter((p) => p.priceCents === null)
        .map((p) => p.itemId);
    expect(unpriced(BH_P1, 1)).toEqual(["1431406", "1760693", "1849969"]);
    expect(unpriced(BH_P2, 2)).toEqual(["1760694"]);
    for (const [body, n] of [
      [BH_P1, 1],
      [BH_P2, 2],
      [BH_P15, 15],
    ] as const) {
      for (const p of pageOf(BH.readCategoryPage(body, n)).products) {
        expect(p.priceCents === null || p.priceCents > 0).toBe(true);
      }
    }
  });

  it("CONTROL: the MAP card's state holds a number, which is not read", () => {
    // Without this, a page whose cards simply had no price would pass above.
    expect(BH_P1).toMatch(/1431406/);
    expect(BH_P1).toMatch(/isMapItem&quot;:true/);
  });

  it("reads 'dynamic' stock as unknown, not as out of stock", () => {
    const p15 = pageOf(BH.readCategoryPage(BH_P15, 15));
    expect(p15.products.filter((p) => p.inStock === null)).toHaveLength(8);
    expect(p15.products.filter((p) => p.inStock === true)).toHaveLength(12);
  });

  it("🔴 the page past the last is the END of the category, not a failure", () => {
    // B&H answers page 16 of 15 with a search for the url's slug.
    expect(BH.readCategoryPage(BH_P16, 16)).toEqual({
      kind: "end",
      detail: "B&H answered with a search, past the category's last page",
    });
    // A category page naming another page than the one asked, past page 1,
    // is the same answer.
    expect(kindOf(BH.readCategoryPage(BH_P15, 16))).toBe("end");
  });

  it("🔴 but the same answer to page 1 is a failure, never an empty category", () => {
    // A category B&H no longer has answers its first page this way, and
    // "lists nothing" would file every watched listing in it as gone.
    expect(kindOf(BH.readCategoryPage(BH_P16, 1))).toBe("not-a-category-page");
    expect(kindOf(BH.readCategoryPage(BH_P2, 1))).toBe("not-a-category-page");
  });

  it("🔴 a page 1 listing no products is a failure, even where it states a count (SYNTHETIC)", () => {
    // Page 1 of Mice & Touchpads with its items emptied: it still says 412
    // products, 28 a page. Read as the end, the walk would report a valid,
    // empty category and lose the count the 90% rule needs.
    const empty = rewriteBhCategoryPage(BH_P1);
    expect(BH.readCategoryPage(empty, 1)).toEqual({
      kind: "not-a-category-page",
      detail: "page 1 of the category lists no products",
    });
    // Past page 1 an empty page is the end: the walk already has the count.
    const emptyP2 = rewriteBhCategoryPage(BH_P2);
    expect(kindOf(BH.readCategoryPage(emptyP2, 2))).toBe("end");
  });

  it("🔴 a product page, a search page and a refusal are not category pages", () => {
    expect(BH.readCategoryPage(raw("bh-pdp-m310"), 1)).toEqual({
      kind: "not-a-category-page",
      detail: "no listing payload: a product page, or not a listing at all",
    });
    expect(kindOf(BH.readCategoryPage(raw("bh-search-text-m310"), 1))).toBe(
      "not-a-category-page",
    );
    for (const [what, body] of REFUSALS) {
      expect([what, kindOf(BH.readCategoryPage(body, 2))]).toEqual([
        what,
        "not-a-category-page",
      ]);
    }
  });

  it("🔴 a category page cut short is a failure, not a short page", () => {
    // The state is one attribute; a body cut inside it carries no state.
    const cut = BH_P1.slice(0, Math.floor(BH_P1.length / 2));
    expect(kindOf(BH.readCategoryPage(cut, 1))).toBe("not-a-category-page");
  });

  it("builds each page's address from the category's", () => {
    expect(BH.pageUrl(BH_CATEGORY, 1)).toBe(BH_CATEGORY);
    expect(BH.pageUrl(BH_CATEGORY, 16)).toBe(`${BH_CATEGORY}/pn/16`);
    // A page address given as the category's is read back to its category.
    expect(BH.pageUrl(`${BH_CATEGORY}/pn/2`, 3)).toBe(`${BH_CATEGORY}/pn/3`);
    expect(BH.pageUrl(`${BH_CATEGORY}/pn/2`, 1)).toBe(BH_CATEGORY);
  });

  it("🔴 builds no address off B&H's host, off a category, or for no page", () => {
    for (const [url, n] of [
      ["https://evil.example/c/buy/mice/ci/18369", 1],
      ["http://www.bhphotovideo.com/c/buy/mice/ci/18369", 1],
      ["https://www.bhphotovideo.com/c/product/731610-REG/x.html", 1],
      ["not a url", 1],
      [BH_CATEGORY, 0],
      [BH_CATEGORY, 1.5],
    ] as const) {
      expect([url, n, BH.pageUrl(url, n)]).toEqual([url, n, null]);
    }
  });
});

// ── Newegg ────────────────────────────────────────────────────────────

const NE_P1 = raw("newegg-category-desktop-memory-p1");
const NE_P2 = raw("newegg-category-desktop-memory-p2");
const NE_LAPTOP = raw("newegg-category-laptop-memory-p1");
const NE_CATEGORY = "https://www.newegg.com/Desktop-Memory/SubCategory/ID-147";

const CATEGORY_CRUMBS = [
  { Name: "Memory", StoreId: 17, StoreType: 1 },
  { Name: "Desktop Memory", StoreId: 147, StoreType: 2 },
];
const card = (cell: Record<string, unknown>, extra = {}) => ({
  ItemCell: cell,
  ...extra,
});

describe("Newegg: one category page prices every product it lists", () => {
  it("reads 36 a page, each priced, with the category's count and pages", () => {
    const p1 = pageOf(NEWEGG.readCategoryPage(NE_P1, 1));
    const p2 = pageOf(NEWEGG.readCategoryPage(NE_P2, 2));
    const laptop = pageOf(NEWEGG.readCategoryPage(NE_LAPTOP, 1));
    expect([p1, p2, laptop].map((p) => p.products.length)).toEqual([
      36, 36, 36,
    ]);
    expect([p1.total, p2.total, laptop.total]).toEqual([3564, 3568, 2017]);
    // "Page 1/20": Newegg's browse ceiling, whatever the count says.
    expect([p1.lastPage, p2.lastPage, laptop.lastPage]).toEqual([20, 20, 20]);
    expect(p1.products[0]).toEqual({
      itemId: "N82E16820236991",
      priceCents: 46999,
      inStock: true,
    });
    for (const p of [p1, p2, laptop]) {
      for (const c of p.products) expect(c.priceCents).toBeGreaterThan(0);
    }
    expect(new Set([...ids(p1), ...ids(p2)]).size).toBe(72);
  });

  it("🔑 names each product exactly as the runtime's Newegg listings are named", () => {
    // The search parse is how every Newegg listing the platform holds got its
    // id: ParentItem, else Item, in its public form.
    for (const [body, n] of [
      [NE_P1, 1],
      [NE_P2, 2],
      [NE_LAPTOP, 1],
    ] as const) {
      const fromSearch = (parseNeweggSearch(body) ?? []).map((c) => c.itemId);
      expect(ids(pageOf(NEWEGG.readCategoryPage(body, n)))).toEqual(fromSearch);
    }
    // Warehouse ids in public form, marketplace ids as they are.
    const laptop = ids(pageOf(NEWEGG.readCategoryPage(NE_LAPTOP, 1)));
    expect(laptop[0]).toBe("N82E16820156314");
    expect(laptop.at(-1)).toBe("0RM-005A-000T8");
  });

  it("🔑 names an offer by its product, as a search does (SYNTHETIC)", () => {
    // The offer `9SIA6ZPK9U9854` of product `86-949-047` is the listing a
    // search names `N82E16886949047` — the real pdp-barcode-12 case.
    const body = neweggBody(
      {
        Products: [
          card({
            Item: "9SIA6ZPK9U9854",
            ParentItem: "86-949-047",
            FinalPrice: 71.26,
            Instock: true,
          }),
          card({ Item: "11-222-333", FinalPrice: 5, Instock: true }),
          card({ Item: "COMBO-1", FinalPrice: 99 }, { IsCombo: true }),
        ],
        TotalItemCount: 3,
        Breadcrumbs: CATEGORY_CRUMBS,
      },
      "1<!-- -->/<!-- -->1",
    );
    expect(ids(pageOf(NEWEGG.readCategoryPage(body, 1)))).toEqual([
      "N82E16886949047",
      "N82E16811222333",
    ]);
  });

  it("🔴 never a price of 0: a card priced 0, or with none, shows no price (SYNTHETIC)", () => {
    const body = neweggBody(
      {
        Products: [
          card({ Item: "11-000-001", FinalPrice: 0, Instock: false }),
          card({ Item: "11-000-002", Instock: true }),
          card({ Item: "11-000-003", FinalPrice: 12.5 }),
        ],
        TotalItemCount: 3,
        Breadcrumbs: CATEGORY_CRUMBS,
      },
      "1<!-- -->/<!-- -->1",
    );
    expect(pageOf(NEWEGG.readCategoryPage(body, 1)).products).toEqual([
      { itemId: "N82E16811000001", priceCents: null, inStock: false },
      { itemId: "N82E16811000002", priceCents: null, inStock: true },
      { itemId: "N82E16811000003", priceCents: 1250, inStock: null },
    ]);
  });

  it("🔴 a page 1 listing no products is a failure, even where it states a count (SYNTHETIC)", () => {
    const state = (products: unknown[]) => ({
      Breadcrumbs: CATEGORY_CRUMBS,
      Products: products,
      TotalItemCount: 3564,
    });
    expect(NEWEGG.readCategoryPage(neweggBody(state([]), "1/20"), 1)).toEqual({
      kind: "not-a-category-page",
      detail: "page 1 of the category lists no products",
    });
    // Past page 1, an empty page is the end.
    expect(
      kindOf(NEWEGG.readCategoryPage(neweggBody(state([]), "2/20"), 2)),
    ).toBe("end");
  });

  it("🔴 a page past the last one the category states is the END (SYNTHETIC)", () => {
    // Not captured: what Newegg serves for page 21 of 20. Whatever it serves,
    // a body saying it is page k of 20 for page 21 is past the end.
    expect(kindOf(NEWEGG.readCategoryPage(NE_P1, 21))).toBe("end");
    // A body naming another page WITHIN the category is a failure.
    expect(NEWEGG.readCategoryPage(NE_P1, 2)).toEqual({
      kind: "not-a-category-page",
      detail: "Newegg served page 1 when page 2 was asked",
    });
  });

  it("🔴 a product page, a search page and a hub page are not category pages", () => {
    expect(NEWEGG.readCategoryPage(raw("pdp-barcode-12"), 1)).toEqual({
      kind: "not-a-category-page",
      detail: "a product page",
    });
    // A search carries the same products and pagination; its breadcrumb is
    // the query, not a store of the catalogue.
    expect(NEWEGG.readCategoryPage(raw("search-many-results"), 1)).toEqual({
      kind: "not-a-category-page",
      detail: "a search results page, not a category",
    });
    expect(kindOf(NEWEGG.readCategoryPage(raw("search-no-results"), 1))).toBe(
      "not-a-category-page",
    );
    // SYNTHETIC: a hub page — embedded state, no listing pagination.
    const hub = neweggBody({ Breadcrumbs: CATEGORY_CRUMBS }, null);
    expect(NEWEGG.readCategoryPage(hub, 1)).toEqual({
      kind: "not-a-category-page",
      detail: "no listing pagination: a hub page, or not a listing at all",
    });
    for (const [what, body] of REFUSALS) {
      expect([what, kindOf(NEWEGG.readCategoryPage(body, 1))]).toEqual([
        what,
        "not-a-category-page",
      ]);
    }
  });

  it("🔴 a category page cut short inside its state is a failure", () => {
    const cut = NE_P1.slice(0, Math.floor(NE_P1.length / 2));
    expect(kindOf(NEWEGG.readCategoryPage(cut, 1))).toBe("not-a-category-page");
  });

  it("builds each page's address as its own canonical link does", () => {
    expect(NEWEGG.pageUrl(NE_CATEGORY, 1)).toBe(NE_CATEGORY);
    expect(NEWEGG.pageUrl(NE_CATEGORY, 2)).toBe(`${NE_CATEGORY}/Page-2`);
    expect(NEWEGG.pageUrl(`${NE_CATEGORY}/Page-2`, 3)).toBe(
      `${NE_CATEGORY}/Page-3`,
    );
    expect(
      NEWEGG.pageUrl("https://newegg.com/Desktop-Memory/SubCategory/ID-147", 1),
    ).toBe(NE_CATEGORY);
  });

  it("🔴 builds no address off Newegg's host, off a category, or for no page", () => {
    for (const [url, n] of [
      ["https://evil.example/Desktop-Memory/SubCategory/ID-147", 1],
      ["https://www.newegg.com/p/pl?d=memory", 1],
      ["https://www.newegg.com/p/N82E16820236991", 1],
      [NE_CATEGORY, 0],
      [NE_CATEGORY, -1],
    ] as const) {
      expect([url, n, NEWEGG.pageUrl(url, n)]).toEqual([url, n, null]);
    }
  });
});

// ── Amazon ────────────────────────────────────────────────────────────

const AM_P1 = raw("amazon-grid-desktop-memory-p1");
const AM_P2 = raw("amazon-grid-desktop-memory-p2");
const CONTAINER = '<span data-component-type="s-search-results"></span>';
/** SYNTHETIC: one result cell. */
const amazonCell = (asin: string, inner: string): string =>
  `<div data-asin="${asin}" data-component-type="s-search-result">${inner}</div>`;
const price = (text: string): string =>
  `<span class="a-price"><span class="a-offscreen">${text}</span></span>`;

describe("Amazon: one results grid page prices every product it lists", () => {
  it("reads every cell, priced as the offer, and states no count", () => {
    const p1 = pageOf(AMAZON.readCategoryPage(AM_P1, 1));
    const p2 = pageOf(AMAZON.readCategoryPage(AM_P2, 2));
    expect([p1.products.length, p2.products.length]).toEqual([16, 16]);
    expect(p1.products[0]).toEqual({
      itemId: "B0BFGB2D2Z",
      priceCents: 47200,
      inStock: null,
    });
    // "Over 2,000 results" on one page and "over 1,000" on the next: an
    // estimate, so no count and no last page.
    expect([p1.total, p1.lastPage]).toEqual([null, null]);
    for (const [body, n] of [
      [AM_P1, 1],
      [AM_P2, 2],
    ] as const) {
      const fromSearch = (parseAmazonSearch(body) ?? []).map((c) => c.itemId);
      expect(ids(pageOf(AMAZON.readCategoryPage(body, n)))).toEqual(fromSearch);
    }
  });

  it("🔴 an unpriced card reads as no price, never 0", () => {
    const p2 = pageOf(AMAZON.readCategoryPage(AM_P2, 2));
    expect(p2.products.filter((p) => p.priceCents === null)).toEqual([
      { itemId: "B0D2P1CVQD", priceCents: null, inStock: null },
    ]);
    // SYNTHETIC: a card showing $0.00 is not a free product.
    const zero = `<html>${CONTAINER}${amazonCell("B000000001", price("$0.00"))}${amazonCell("B000000002", `${price("$12.34")}<span>Currently unavailable</span>`)}</html>`;
    expect(pageOf(AMAZON.readCategoryPage(zero, 1)).products).toEqual([
      { itemId: "B000000001", priceCents: null, inStock: null },
      { itemId: "B000000002", priceCents: 1234, inStock: false },
    ]);
  });

  it("🔴 a grid Amazon says is empty is the END (SYNTHETIC)", () => {
    const empty = `<html>${CONTAINER}<div widgetId=messaging-messages-no-results>No results.</div></html>`;
    expect(kindOf(AMAZON.readCategoryPage(empty, 3))).toBe("end");
    // On page 1 it is a failure: a category the walk was sent to is never
    // read as an empty one.
    expect(AMAZON.readCategoryPage(empty, 1)).toEqual({
      kind: "not-a-category-page",
      detail: "page 1 of the category lists no products",
    });
  });

  it("🔴 a grid with no cells and no such word is a failure: cut short or moved", () => {
    expect(AMAZON.readCategoryPage(`<html>${CONTAINER}</html>`, 3)).toEqual({
      kind: "not-a-category-page",
      detail: "a results grid with no cells and no word that it is empty",
    });
  });

  it("🔴 a body naming another page is a failure, not that page", () => {
    expect(AMAZON.readCategoryPage(AM_P2, 1)).toEqual({
      kind: "not-a-category-page",
      detail: "Amazon served page 2 when page 1 was asked",
    });
  });

  it("🔴 a product page, a robot check and a refusal are not category pages", () => {
    expect(AMAZON.readCategoryPage(raw("amazon-pdp-gtin-labelled"), 1)).toEqual(
      { kind: "not-a-category-page", detail: "no results grid" },
    );
    for (const [what, body] of REFUSALS) {
      expect([what, kindOf(AMAZON.readCategoryPage(body, 1))]).toEqual([
        what,
        "not-a-category-page",
      ]);
    }
  });

  it("builds each page's address on Amazon's own host only", () => {
    const grid = "https://www.amazon.com/s?k=desktop+memory+ddr5";
    expect(AMAZON.pageUrl(grid, 1)).toBe(grid);
    expect(AMAZON.pageUrl(grid, 2)).toBe(`${grid}&page=2`);
    expect(AMAZON.pageUrl(`${grid}&page=2`, 1)).toBe(grid);
    expect(AMAZON.pageUrl("https://evil.example/s?k=x", 2)).toBeNull();
    expect(AMAZON.pageUrl(grid, 0)).toBeNull();
  });
});

// ── Every adapter states its answer ───────────────────────────────────

describe("which competitors' categories can be read", () => {
  it("🔴 Best Buy and Costco have no category reader", () => {
    expect(bestbuyAdapter.categoryReader).toBeNull();
    expect(costcoAdapter.categoryReader).toBeNull();
  });

  it("B&H, Newegg and Amazon each have one", () => {
    for (const adapter of [bhAdapter, neweggAdapter, amazonAdapter]) {
      expect([adapter.slug, adapter.categoryReader === null]).toEqual([
        adapter.slug,
        false,
      ]);
    }
  });
});

// ── The committed pages carry no session value ────────────────────────

/** The list `scripts/distil-category.mjs` refuses to emit past. */
const SESSION_MARKERS: readonly RegExp[] = [
  /session-id|session-token|ubid-main|csrf/i,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // a uuid
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/, // an IPv4 address
  /x-forwarded-for/i,
  /brd-customer|hl_[0-9a-f]{6,}|brightdata/i,
  /cookie/i,
];
const leaks = (body: string): string[] =>
  SESSION_MARKERS.filter((m) => m.test(body)).map(String);

describe("the committed Newegg and Amazon category pages", () => {
  const names = readdirSync(fileURLToPath(new URL("./raw/", import.meta.url)))
    .filter((n) => /^(newegg-category|amazon-grid)-/.test(n))
    .map((n) => n.replace(/\.html\.gz$/, ""));

  it("🔴 carry no session value", () => {
    expect(names).toHaveLength(5);
    for (const name of names)
      expect([name, leaks(raw(name))]).toEqual([name, []]);
  });

  it("CONTROL: the markers find session values where they are (SYNTHETIC samples)", () => {
    for (const sample of [
      'name="session-id" value="000-0000000-0000000"',
      "anti-csrftoken-a2z",
      "22222222-2222-4222-8222-222222222222",
      "192.0.2.1",
      "document.cookie",
    ]) {
      expect([sample, leaks(sample).length > 0]).toEqual([sample, true]);
    }
  });
});
