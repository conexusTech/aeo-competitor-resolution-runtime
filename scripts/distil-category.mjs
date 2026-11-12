/**
 * Distil real Newegg and Amazon category pages into committable fixtures.
 *
 * ⚠️ **Why not `distil-bh.mjs`.** Each retailer keeps its products in a
 * different place — Newegg in an embedded `window.__initialState__`, Amazon in
 * result cells of plain markup — so each needs its own trim. The rule is the
 * same one: keep only what the adapter reads, and PROVE it.
 *
 * 🔑 **The distillation is proven equivalent, not asserted.** For every page
 * the committed adapter's parsers run on the raw body AND on the distilled one
 * — the category reader at several page numbers, the search parse, and the
 * product-page parses — and the JSON must be identical, or the run fails.
 *
 * 🔴 **A whitelist, so session values cannot survive.** A raw Amazon page
 * carries the proxy's anonymous session id, anti-CSRF tokens and visitor ids;
 * a raw Newegg page carries tracking script. Rebuilding the page from the
 * fields the parser reads removes them by construction, and the output is then
 * checked for every session marker known anyway.
 *
 * ⚠️ **`amazon-product` distils one Amazon product page, not a grid.** It
 * keeps the page's title marker, its ASIN, the featured buying option's price
 * and availability, the breadcrumb's browse-node links and every row of the
 * product-details table, and is proven by the same parses: the listing reading
 * and the product parse (barcode and model) must come out identical.
 *
 * Usage (build first: `npm run build`):
 *   node scripts/distil-category.mjs newegg <raw.html> <out.html.gz>
 *   node scripts/distil-category.mjs amazon <raw.html> <out.html.gz>
 *   node scripts/distil-category.mjs amazon-product <raw.html> <out.html.gz>
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const repoRoot = path.resolve(import.meta.dirname, "..");
const load = async (file) =>
  import(pathToFileURL(path.join(repoRoot, `dist/adapters/${file}`)).href);
const newegg = await load("newegg.js");
const amazon = await load("amazon.js");

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keep `keys` of `value` that are present, each through its own trim. */
function pick(value, keys) {
  if (!isObj(value)) return value;
  const out = {};
  for (const [key, trim] of Object.entries(keys)) {
    if (!(key in value)) continue;
    out[key] = trim === true ? value[key] : trim(value[key]);
  }
  return out;
}
const fields = (keys) => (v) => pick(v, keys);
const each = (trim) => (v) => (Array.isArray(v) ? v.map(trim) : trim(v));

// ── Newegg ────────────────────────────────────────────────────────────

/** What a search or category card is read for. */
const NEWEGG_PRODUCT = fields({
  IsCombo: true,
  ItemCell: fields({
    Item: true,
    ParentItem: true,
    Model: true,
    FinalPrice: true,
    Instock: true,
    Description: fields({ Title: true, UrlKeywords: true }),
    Seller: fields({ SellerName: true }),
    ItemManufactory: fields({ Manufactory: true }),
    NewImage: fields({ ImageName: true }),
  }),
});

const NEWEGG_PAGINATION =
  /list-tool-pagination-text">Page(?:<!-- -->)?\s*<strong>\d+(?:<!-- -->)?\/(?:<!-- -->)?\d+<\/strong>/;

function distilNewegg(html) {
  const state = newegg.extractInitialState(html);
  if (state === null) throw new Error("no embedded state");
  const kept = pick(state, {
    Products: each(NEWEGG_PRODUCT),
    TotalItemCount: true,
    Breadcrumbs: each(fields({ Name: true, StoreId: true, StoreType: true })),
  });
  const pagination = NEWEGG_PAGINATION.exec(html)?.[0] ?? "";
  // The state is JSON, so `</script>` cannot occur inside it once escaped.
  const json = JSON.stringify(kept).replace(/<\//g, "<\\/");
  return (
    "<!doctype html><!-- distilled Newegg page: only the fields the adapter " +
    "reads; see scripts/distil-category.mjs --><html><head><script>" +
    `window.__initialState__ = ${json};</script></head><body>` +
    // The marker starts inside its element's class attribute, so it is
    // reopened there: `<div class="list-tool-pagination-text">Page …</strong>`.
    (pagination === "" ? "" : `<div class="${pagination}</div>`) +
    "</body></html>"
  );
}

const neweggParses = (body) =>
  JSON.stringify({
    category: [1, 2, 3, 20, 21].map((n) => newegg.readCategoryPage(body, n)),
    search: newegg.parseSearchResults(body),
    reading: newegg.readListingPage(body),
    product: newegg.parseProductPage(body),
  });

// ── Amazon ────────────────────────────────────────────────────────────

const RESULTS_CONTAINER = 'data-component-type="s-search-results"';
const NO_RESULTS_WIDGET = "widgetId=messaging-messages-no-results";
const ASIN = /^<div[^>]*\sdata-asin="([^"]*)"/;
const TITLE = /<h2[^>]*\saria-label="([^"]*)"/;
const IMAGE = /<img[^>]*\sclass="[^"]*\bs-image\b[^"]*"[^>]*\ssrc="([^"]+)"/;
const PRICE =
  /<span class="a-price"[^>]*>\s*<span class="a-offscreen">([^<]*)</;
const SHOWN_PAGE = /aria-current="page" aria-label="Page (\d+)"/;

function distilAmazon(html) {
  if (!html.includes(RESULTS_CONTAINER)) throw new Error("no results grid");
  const cells = amazon.splitResultCells(html).map((cell) => {
    const asin = ASIN.exec(cell)?.[1] ?? "";
    const title = TITLE.exec(cell)?.[1];
    const image = IMAGE.exec(cell)?.[1];
    const price = PRICE.exec(cell)?.[1];
    return (
      `<div data-asin="${asin}" data-component-type="s-search-result">` +
      (title === undefined ? "" : `<h2 aria-label="${title}"></h2>`) +
      (image === undefined ? "" : `<img class="s-image" src="${image}">`) +
      (price === undefined
        ? ""
        : `<span class="a-price"><span class="a-offscreen">${price}</span></span>`) +
      (cell.includes("Currently unavailable")
        ? "<span>Currently unavailable</span>"
        : "") +
      "</div>"
    );
  });
  const shown = SHOWN_PAGE.exec(html)?.[1];
  return (
    "<!doctype html><!-- distilled Amazon results grid: only the fields the " +
    "adapter reads; see scripts/distil-category.mjs --><html><body>" +
    `<span ${RESULTS_CONTAINER}></span>` +
    (html.includes(NO_RESULTS_WIDGET)
      ? `<div ${NO_RESULTS_WIDGET}></div>`
      : "") +
    cells.join("") +
    (shown === undefined
      ? ""
      : `<span aria-current="page" aria-label="Page ${shown}">${shown}</span>`) +
    "</body></html>"
  );
}

/** What `parseProductPage` and `readListingPage` read off a product page. */
const PRODUCT_TITLE = /<span[^>]*\sid="productTitle"[^>]*>([^<]*)</;
const ASIN_INPUT = /<input\b[^>]*\bid="ASIN"[^>]*>/;
const VALUE_ATTRIBUTE = /\bvalue="([^"]*)"/;
const BUYBOX = 'id="buybox"';
const PRICE_TO_PAY = /class="a-price\b[^"]*\bapex-pricetopay-value\b[^"]*"/;
const OFFSCREEN = /<span class="a-offscreen">([^<]*)</;
const AVAILABILITY = /primary-availability-message[^>]*>([^<]*)</;
const NO_FEATURED_OFFER = />\s*No featured offers available\s*</i;
const DETAIL_ROW =
  /prodDetSectionEntry"[^>]*>([\s\S]{0,160}?)<\/th>[\s\S]{0,240}?prodDetAttrValue"[^>]*>([\s\S]{0,160}?)</g;
const BREADCRUMB_MARKER = "wayfinding-breadcrumbs_feature_div";
const NODE_LINK = /href="[^"]*[?&](?:amp;)?node=(\d+)[^"]*"[^>]*>([^<]*)</g;

function distilAmazonProduct(html) {
  const title = PRODUCT_TITLE.exec(html)?.[1];
  if (title === undefined) throw new Error("no product title");
  const asinTag = ASIN_INPUT.exec(html)?.[0];
  const asin =
    asinTag === undefined ? undefined : VALUE_ATTRIBUTE.exec(asinTag)?.[1];

  // The featured option's own figures, each read after the buy box opens:
  // the proof below fails the run if they are not the ones the parser takes.
  const box = html.indexOf(BUYBOX);
  let offer = "";
  if (box >= 0) {
    const tail = html.slice(box);
    const at = tail.search(PRICE_TO_PAY);
    const price =
      at < 0 ? undefined : OFFSCREEN.exec(tail.slice(at, at + 1200))?.[1];
    const availability = AVAILABILITY.exec(tail)?.[1];
    offer =
      `<div id="buybox"><div data-a-accordion-row-name="featured">` +
      (price === undefined
        ? ""
        : `<span class="a-price apex-pricetopay-value"><span class="a-offscreen">${price}</span></span>`) +
      (availability === undefined
        ? ""
        : `<span class="primary-availability-message">${availability}</span>`) +
      "</div></div>";
  }

  const crumbsAt = html.indexOf(BREADCRUMB_MARKER);
  const crumbs =
    crumbsAt < 0
      ? ""
      : `<div id="${BREADCRUMB_MARKER}">` +
        [...html.slice(crumbsAt, crumbsAt + 6000).matchAll(NODE_LINK)]
          .map((l) => `<a href="/b?node=${l[1]}">${l[2]}</a>`)
          .join("") +
        "</div>";

  const rows = [...html.matchAll(DETAIL_ROW)]
    .map(
      (r) =>
        `<tr><th class="prodDetSectionEntry">${r[1]}</th>` +
        `<td class="prodDetAttrValue">${r[2]}</td></tr>`,
    )
    .join("");

  return (
    "<!doctype html><!-- distilled Amazon product page: only the fields the " +
    "adapter reads; see scripts/distil-category.mjs --><html><body>" +
    crumbs +
    `<span id="productTitle">${title}</span>` +
    (asin === undefined
      ? ""
      : `<input type="hidden" id="ASIN" value="${asin}">`) +
    offer +
    (NO_FEATURED_OFFER.test(html)
      ? "<span>No featured offers available</span>"
      : "") +
    `<table>${rows}</table>` +
    "</body></html>"
  );
}

const amazonParses = (body) =>
  JSON.stringify({
    category: [1, 2, 3].map((n) => amazon.readCategoryPage(body, n)),
    search: amazon.parseSearchResults(body),
    reading: amazon.readListingPage(body),
    product: amazon.parseProductPage(body),
  });

// ── Proof ─────────────────────────────────────────────────────────────

/**
 * 🔴 Markers of a session or of the vendor, any one of which must not survive.
 * `test/category-fixtures.spec.ts` keeps the same list.
 */
const SESSION_MARKERS = [
  /session-id|session-token|ubid-main|csrf/i,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // a uuid
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/, // an IPv4 address
  /x-forwarded-for/i,
  /brd-customer|hl_[0-9a-f]{6,}|brightdata/i,
  /cookie/i,
];

const RETAILERS = {
  newegg: { distil: distilNewegg, parses: neweggParses },
  amazon: { distil: distilAmazon, parses: amazonParses },
  "amazon-product": { distil: distilAmazonProduct, parses: amazonParses },
};

const [retailer, from, out] = process.argv.slice(2);
const chosen = RETAILERS[retailer ?? ""];
if (chosen === undefined || from === undefined || out === undefined) {
  console.error(
    "usage: node scripts/distil-category.mjs <newegg|amazon|amazon-product> <raw.html> <out.html.gz>",
  );
  process.exit(2);
}
const raw = fs.readFileSync(from, "utf8");
const body = chosen.distil(raw);
if (chosen.parses(body) !== chosen.parses(raw)) {
  throw new Error(`distilled page parses differently from the raw: ${from}`);
}
for (const marker of SESSION_MARKERS) {
  if (marker.test(body)) {
    throw new Error(`a session marker ${marker} survived in ${from}`);
  }
}
const gz = zlib.gzipSync(body, { level: 9 });
fs.writeFileSync(out, gz);
console.log(
  `${out}: ${raw.length} -> ${body.length} bytes, ${gz.length} gzipped`,
);
