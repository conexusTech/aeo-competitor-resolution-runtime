/**
 * Distil real Costco pages into committable fixtures and a replay corpus.
 *
 * ⚠️ **Why not `distil-bh.mjs`.** Costco's data is a different structure: a
 * product page carries it in the React Server Components flight data
 * (`self.__next_f.push([1,"…"])` chunks) as one `productDetailsData` object,
 * beside a JSON-LD Product; its product index is a sitemap. So it needs its
 * own trim. The rule it keeps is the same one.
 *
 * 🔑 **The distillation is PROVEN equivalent, not asserted.** For every page
 * it runs the committed adapter's parsers (`parseSearchResults`,
 * `parseProductPage`, `readListingPage`, and for a sitemap `parseSitemapIndex`
 * and `parseSitemap`) on the raw body AND on the distilled one and requires
 * identical JSON. A page whose parse differs fails the run.
 *
 * 🔴 **A whitelist, so session values cannot survive.** A raw Costco page
 * carries the sign-in link's `nonce=` and the app's `client_id`, the
 * monitoring agent's `dtTrId`, and a uuid per item (`clientId`). Keeping only
 * the fields the parser reads removes them by construction, and the run then
 * checks the output for every session marker known anyway.
 *
 * Usage (build first: `npm run build`):
 *   node scripts/distil-costco.mjs fixture <raw> <out.gz>
 *   node scripts/distil-costco.mjs corpus <cache-dir> <sitemap.xml> <out.json.gz> <productId>...
 *
 * A sitemap index is kept byte for byte (it is 1,547 bytes and its real size
 * is what the index's own minimum is tested against); a product sitemap keeps
 * each `<url><loc>` and nothing else.
 *
 * In corpus mode the cache directory holds the investigation's captures, each
 * `<tag>-<hash>.html` beside a `.headers.json` that records its url. Each
 * product id is served at the url the product sitemap gives it — the url a
 * run fetches — from whichever cached capture is that product's page, at
 * either of Costco's url forms.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const repoRoot = path.resolve(import.meta.dirname, "..");
const costco = await import(
  pathToFileURL(path.join(repoRoot, "dist/adapters/costco.js")).href
);
const {
  costcoAdapter,
  costcoApp,
  ldProduct,
  parseSitemap,
  parseSitemapIndex,
  productDetails,
} = costco;

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

const FLAGS = { upc: true, isMembershipReqd: true, dispPriceInCartOnly: true };

/** `productDetailsData`, trimmed to what the parser reads. */
const details = fields({
  productData: fields({
    id: true,
    ...FLAGS,
    childCatalogData: each(
      fields({
        id: true,
        ...FLAGS,
        descriptions: each(
          fields({ object: fields({ shortDescription: true }) }),
        ),
      }),
    ),
  }),
  priceInfo: fields({
    id: true,
    displayPrice: fields({ onlinePrice: true, aggregatedDiscountAmt: true }),
  }),
  selectedChildItemNumber: true,
});

const offer = fields({ "@type": true, price: true, sku: true });
const ld = fields({
  "@type": true,
  name: true,
  sku: true,
  url: true,
  offers: each(offer),
});

/** The asset path that says which of Costco's apps served the page. */
function appMarker(html) {
  const m =
    /\/consumer-web\/(?:product|search)\/[a-z]+\/(?:details|catalog)-[a-z0-9-]*/.exec(
      html,
    );
  return m === null ? "" : `<link rel="stylesheet" href="${m[0]}/x.css">`;
}

export function distilPage(html) {
  const product = productDetails(html);
  const node = ldProduct(html);
  const flight =
    product === null
      ? ""
      : `<script>self.__next_f.push([1,${JSON.stringify(
          `"productDetailsData":${JSON.stringify(details(product))}`,
        )}])</script>`;
  const json =
    node === null
      ? ""
      : `<script type="application/ld+json">${JSON.stringify(ld(node))}</script>`;
  return (
    "<!doctype html><!-- distilled Costco page: only the fields the adapter " +
    "reads; see scripts/distil-costco.mjs --><html><head>" +
    appMarker(html) +
    json +
    "</head><body>" +
    flight +
    "</body></html>"
  );
}

const escapeXml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A product sitemap: each `<url><loc>`, and nothing else. */
export function distilSitemap(xml) {
  const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)]
    .filter((m) => !/<ns2:loc>/.test(m[0]))
    .map((m) => m[1]);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    locs
      .map(
        (l) => `<url><loc>${escapeXml(l.replace(/&amp;/g, "&"))}</loc></url>`,
      )
      .join("\n") +
    "</urlset>"
  );
}

/** Every parse the adapter makes of a body, as one comparable string. */
const parses = (body) =>
  JSON.stringify({
    search: costcoAdapter.parseSearchResults(body),
    product: costcoAdapter.parseProductPage(body),
    reading: costcoAdapter.readListingPage(body),
    app: costcoApp(body),
    listing: parseSitemapIndex(body),
    sitemap: parseSitemap(body),
  });

/**
 * 🔴 Markers of a session or of the vendor, any one of which must not survive.
 * The test that guards the committed files keeps the same list.
 */
const SESSION_MARKERS = [
  /nonce=|client_id=|clientId/i,
  /dtTrId|dtSInfo|dtRpid/,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // a uuid
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/, // an IPv4 address
  /x-forwarded-for/i,
  /brd-customer|hl_[0-9a-f]{6,}|brightdata/i,
  // A header or a script reading one; Costco sells cookies, so not the word.
  /set-cookie|cookie:|document\.cookie/i,
];

function proven(raw, name) {
  const kind = raw.includes("<sitemapindex")
    ? "index"
    : raw.includes("<urlset")
      ? "sitemap"
      : "page";
  const body =
    kind === "index"
      ? raw
      : kind === "sitemap"
        ? distilSitemap(raw)
        : distilPage(raw);
  if (parses(body) !== parses(raw)) {
    throw new Error(`distilled body parses differently from the raw: ${name}`);
  }
  for (const marker of SESSION_MARKERS) {
    if (marker.test(body)) {
      throw new Error(`a session marker ${marker} survived in ${name}`);
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
  const [cache, sitemapFile, out, ...ids] = rest;
  const sitemap = parseSitemap(fs.readFileSync(sitemapFile, "utf8")) ?? [];
  const byId = new Map();
  for (const f of fs.readdirSync(cache)) {
    if (!f.endsWith(".headers.json")) continue;
    const { url } = JSON.parse(fs.readFileSync(path.join(cache, f), "utf8"));
    const id =
      /\/p\/-\/[^/]+\/(\d+)$/.exec(url)?.[1] ??
      /\.product\.(\d+)\.html$/.exec(url)?.[1];
    if (id === undefined) continue;
    const file = path.join(cache, f.replace(/\.headers\.json$/, ".html"));
    // A capture at the sitemap's own url form wins over the older form.
    if (!byId.has(id) || url.includes("/p/-/")) byId.set(id, { url, file });
  }
  const entries = ids.map((id) => {
    const at = sitemap.find((e) => e.itemId === id);
    if (at === undefined) throw new Error(`${id} is not in the sitemap`);
    const cached = byId.get(id);
    if (cached === undefined) throw new Error(`${id} is not in the cache`);
    const raw = fs.readFileSync(cached.file, "utf8");
    const body = proven(raw, cached.url);
    // The page must be the product the sitemap names at that url.
    const page = costcoAdapter.readListingPage(body);
    if (page.kind !== "page" || page.page.pageItemId !== id) {
      throw new Error(`${cached.url} is not product ${id}'s page`);
    }
    return { url: at.url, fetchedAs: cached.url, body };
  });
  const corpus = {
    note:
      "Costco product pages from the investigation's cache " +
      "(meriwether-data-scraper, recon/captures/costco-upc/cache, fetched " +
      "2026-11-10 through the vendor with country us), distilled by " +
      "scripts/distil-costco.mjs: each one proven to parse identically to " +
      "the raw page, and carrying no session value. Each is served at the " +
      "url Costco's product sitemap gives it; `fetchedAs` is the url it was " +
      "captured at, which for one page is Costco's older url form for the " +
      "same product (its JSON-LD url is the sitemap's).",
    distilledOn: new Date().toISOString().slice(0, 10),
    entries,
  };
  const gz = zlib.gzipSync(JSON.stringify(corpus), { level: 9 });
  fs.writeFileSync(out, gz);
  console.log(`${out}: ${entries.length} pages, ${gz.length} bytes gzipped`);
} else {
  console.error(
    "usage: node scripts/distil-costco.mjs fixture <raw> <out.gz>\n" +
      "       node scripts/distil-costco.mjs corpus <cache-dir> <sitemap.xml> <out.json.gz> <productId>...",
  );
  process.exit(2);
}
