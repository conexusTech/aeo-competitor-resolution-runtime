/**
 * Distil real Best Buy pages into committable fixtures and a replay corpus.
 *
 * ⚠️ **Why not `distil-corpus.mjs`.** That script is the launch retailer's: it
 * trims Newegg's `window.__initialState__` and recovers urls from the spike's
 * results.csv. Best Buy's data is a different structure — GraphQL results the
 * page streams in `ApolloSSRDataTransport` pushes, plus rendered cards — so it
 * needs its own trim. The rule it keeps is the same one.
 *
 * 🔑 **The distillation is PROVEN equivalent, not asserted.** For every page it
 * runs the committed adapter's three parsers (`parseSearchResults`,
 * `parseProductPage`, `readListingPage`) on the raw body AND on the distilled
 * one and requires identical JSON. A page whose parse differs fails the run.
 *
 * 🔴 **A whitelist, so session values cannot survive.** A raw Best Buy page
 * carries the request it was served for: `x-forwarded-for` with the vendor's
 * egress addresses, the visitor token in several encodings, cookies (`SID`,
 * `CTT`, `__gpi`, `s_ecid`) and analytics ids. Redacting those one by one is a
 * list that is only as complete as whoever wrote it. Keeping only the fields
 * the parser reads removes them by construction, and the run then checks the
 * output for every session marker known anyway.
 *
 * Usage (build first: `npm run build`):
 *   node scripts/distil-bestbuy.mjs fixture <raw.html> <out.html.gz>
 *   node scripts/distil-bestbuy.mjs corpus <cache-dir> <results.json> <out.json.gz>
 *
 * In corpus mode the cache directory holds the investigation's captures, each
 * `<tag>-<hash>.html` beside a `.headers.json` that records its url; the
 * corpus holds every row's barcode search and the product page of every
 * listing that search returned, up to the adapter's probe ceiling.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const repoRoot = path.resolve(import.meta.dirname, "..");
// `pathToFileURL`, not a string path: on Windows an absolute path starts with a
// drive letter, which the ESM loader reads as an unknown URL scheme.
const { bestbuyAdapter, extractApolloData } = await import(
  pathToFileURL(path.join(repoRoot, "dist/adapters/bestbuy.js")).href
);

const APOLLO_PUSH =
  '(window[Symbol.for("ApolloSSRDataTransport")] ??= []).push(';

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
const each = (trim) => (v) => (Array.isArray(v) ? v.map(trim) : trim(v));
const fields = (keys) => (v) => pick(v, keys);

/** What `toCandidate` and `inStockOf` read off a product. */
const searchProduct = fields({
  skuId: true,
  brand: true,
  name: fields({ short: true }),
  price: fields({ customerPrice: true, displayableCustomerPrice: true }),
  url: fields({ skuSpecificUrl: true, pdp: true }),
  seller: fields({ classification: true }),
  primaryImage: fields({ piscesHref: true, href: true }),
  manufacturer: fields({ modelNumber: true }),
  fulfillmentOptions: fields({
    buttonStates: each(fields({ buttonState: true })),
  }),
});

const searchDocument = fields({
  __typename: true,
  isTermMatch: true,
  product: searchProduct,
});

const search = fields({
  numFound: true,
  track: fields({ analyticsData: fields({ recallStrategy: true }) }),
  withBestMedia: fields({
    placements: each(
      fields({
        documentsGridView: fields({
          sponsoredDocuments: each(searchDocument),
        }),
        // Carousel ads, which the adapter does not read — kept so a fixture
        // can prove it does not.
        documents: each(searchDocument),
      }),
    ),
  }),
});

/** Only the UPC rows of a specification group; the key itself is kept. */
const specificationGroups = (groups) =>
  Array.isArray(groups)
    ? groups.map((group) =>
        pick(group, {
          specifications: (specs) =>
            Array.isArray(specs)
              ? specs
                  .filter(
                    (s) =>
                      isObj(s) &&
                      typeof s.displayName === "string" &&
                      s.displayName.trim().toUpperCase() === "UPC",
                  )
                  .map(fields({ displayName: true, value: true }))
              : specs,
        }),
      )
    : groups;

/** What `pageProduct` reads off one partial result. */
const productBySkuId = fields({
  skuId: true,
  upc: true,
  specificationGroups,
  name: fields({ short: true }),
  price: fields({ customerPrice: true, displayableCustomerPrice: true }),
  seller: fields({ classification: true }),
  fulfillmentOptions: fields({
    buttonStates: each(fields({ buttonState: true })),
  }),
});

/** The GraphQL pushes, trimmed to the results the parser reads. */
function distilApollo(html) {
  const events = [];
  for (const data of extractApolloData(html)) {
    const kept = {};
    if (isObj(data.search)) kept.search = search(data.search);
    if (isObj(data.productBySkuId))
      kept.productBySkuId = productBySkuId(data.productBySkuId);
    if (Object.keys(kept).length > 0)
      events.push({ type: "next", value: { data: kept } });
  }
  // One push, so one script; the parser reads every push the same way.
  return `<script>${APOLLO_PUSH}${JSON.stringify({ events })});</script>`;
}

const LD_JSON =
  /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** The JSON-LD Product nodes: the SKU, the UPC properties, the seller. */
function distilLd(html) {
  const out = [];
  for (const m of html.matchAll(LD_JSON)) {
    let parsed;
    try {
      parsed = JSON.parse((m[1] ?? "").trim());
    } catch {
      continue;
    }
    for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!isObj(node) || node["@type"] !== "Product") continue;
      const kept = pick(node, {
        "@type": true,
        sku: true,
        additionalProperty: (props) =>
          Array.isArray(props)
            ? props
                .filter(
                  (p) =>
                    isObj(p) &&
                    typeof p.name === "string" &&
                    p.name.trim().toUpperCase() === "UPC",
                )
                .map(fields({ name: true, value: true }))
            : props,
        offers: each(fields({ seller: fields({ name: true }) })),
      });
      out.push(
        `<script type="application/ld+json">${JSON.stringify(kept)}</script>`,
      );
    }
  }
  return out.join("");
}

const CARD_START = /<li data-testid="(\d+)" data-product-id="\d+"/g;
const CARD_TITLE = /<h3 class="product-title[^"]*" title="[^"]*"/;
const CARD_LINK = /<a class="product-list-item-link" href="[^"]*"/;
const CARD_PRICE =
  /data-testid="price-block-customer-price"[^>]*>\s*<span[^>]*>\$[\d,]+\.\d{2}</;

/** Each rendered card, reduced to the three things the parser reads. */
function distilCards(html) {
  const starts = [...html.matchAll(CARD_START)];
  return starts
    .map((m, i) => {
      const end = starts[i + 1]?.index ?? m.index + 60_000;
      const cell = html.slice(m.index, end);
      const link = CARD_LINK.exec(cell)?.[0];
      const title = CARD_TITLE.exec(cell)?.[0];
      const price = CARD_PRICE.exec(cell)?.[0];
      return (
        `${m[0]}>` +
        (link === undefined ? "" : `${link}></a>`) +
        (title === undefined ? "" : `${title}></h3>`) +
        (price === undefined ? "" : `<div ${price}/span></div>`) +
        "</li>"
      );
    })
    .join("");
}

export function distil(html) {
  return (
    "<!doctype html><!-- distilled Best Buy page: only the fields the " +
    "adapter reads; see scripts/distil-bestbuy.mjs --><html><body>" +
    distilApollo(html) +
    distilLd(html) +
    // Last, so the final card's segment holds nothing but itself.
    distilCards(html) +
    "</body></html>"
  );
}

/** Every parse the adapter makes of a body, as one comparable string. */
const parses = (body) =>
  JSON.stringify({
    search: bestbuyAdapter.parseSearchResults(body),
    product: bestbuyAdapter.parseProductPage(body),
    reading: bestbuyAdapter.readListingPage(body),
  });

/**
 * 🔴 Markers of a session or of the vendor, any one of which must not survive.
 * The test that guards the committed files keeps the same list.
 */
const SESSION_MARKERS = [
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/, // an IPv4 address
  /x-forwarded-for/i,
  /visitor(?:Token|Id)/i,
  /"(?:SID|CTT|UT|VT|AT|__gpi|s_ecid|rxVisitor)"/,
  /UID=|MCMID/,
  /brd-customer|hl_[0-9a-f]{6,}|brightdata/i,
  /cookie/i,
];

function proven(raw, url) {
  const body = distil(raw);
  if (parses(body) !== parses(raw)) {
    throw new Error(`distilled page parses differently from the raw: ${url}`);
  }
  for (const marker of SESSION_MARKERS) {
    if (marker.test(body)) {
      throw new Error(`a session marker ${marker} survived in ${url}`);
    }
  }
  return body;
}

const [mode, ...rest] = process.argv.slice(2);

if (mode === "fixture") {
  const [from, out] = rest;
  const raw = fs.readFileSync(from, "utf8");
  const body = proven(raw, from);
  const gz = zlib.gzipSync(body, { level: 9 });
  fs.writeFileSync(out, gz);
  console.log(
    `${out}: ${raw.length} -> ${body.length} bytes, ${gz.length} gzipped`,
  );
} else if (mode === "corpus") {
  const [cache, resultsFile, out] = rest;
  const byUrl = new Map();
  for (const f of fs.readdirSync(cache)) {
    if (!f.endsWith(".headers.json")) continue;
    const { url } = JSON.parse(fs.readFileSync(path.join(cache, f), "utf8"));
    byUrl.set(url, path.join(cache, f.replace(/\.headers\.json$/, ".html")));
  }
  const rows = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
  const urls = [];
  const want = (url) => {
    if (!urls.includes(url)) urls.push(url);
  };
  for (const row of rows) {
    const searchUrl = bestbuyAdapter.buildSearchUrl(row.upc);
    const file = byUrl.get(searchUrl);
    if (file === undefined) throw new Error(`not in the cache: ${searchUrl}`);
    want(searchUrl);
    const candidates =
      bestbuyAdapter.parseSearchResults(fs.readFileSync(file, "utf8")) ?? [];
    for (const c of candidates.slice(0, bestbuyAdapter.maxProbes)) {
      if (byUrl.has(c.url)) want(c.url);
    }
  }
  const entries = urls.map((url) => ({
    url,
    body: proven(fs.readFileSync(byUrl.get(url), "utf8"), url),
  }));
  const corpus = {
    note:
      "Best Buy pages from the investigation's cache (meriwether-data-scraper, " +
      "recon/captures/bestbuy-upc/cache, fetched 2026-11-09 through the vendor " +
      "with country us), distilled by scripts/distil-bestbuy.mjs: each one " +
      "proven to parse identically to the raw page, and carrying no session value.",
    distilledOn: new Date().toISOString().slice(0, 10),
    entries,
  };
  const gz = zlib.gzipSync(JSON.stringify(corpus), { level: 9 });
  fs.writeFileSync(out, gz);
  console.log(`${out}: ${entries.length} pages, ${gz.length} bytes gzipped`);
} else {
  console.error(
    "usage: node scripts/distil-bestbuy.mjs fixture <raw.html> <out.html.gz>\n" +
      "       node scripts/distil-bestbuy.mjs corpus <cache-dir> <results.json> <out.json.gz>",
  );
  process.exit(2);
}
