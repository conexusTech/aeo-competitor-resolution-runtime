/**
 * Distil real B&H pages into committable fixtures and a replay corpus.
 *
 * ⚠️ **Why not `distil-bestbuy.mjs`.** B&H's data is a different structure: the
 * app's whole initial state as ONE entity-encoded JSON attribute
 * (`<div class="bh-preloaded-data" data-data="…">`), plus the JSON-LD Product
 * and the rendered "UPC: …" line. So it needs its own trim. The rule it keeps
 * is the same one.
 *
 * 🔑 **The distillation is PROVEN equivalent, not asserted.** For every page it
 * runs the committed adapter's parsers (`parseSearchResults`,
 * `parseProductPage`, `readListingPage`, `noBarcodeReason`) on the raw body
 * AND on the distilled one and requires identical JSON. A page whose parse
 * differs fails the run.
 *
 * 🔴 **A whitelist, so session values cannot survive.** A raw B&H page carries
 * the request it was served for: `bhTraceId`, `ssrReqId` and `qasAuthToken` in
 * its state, Cloudflare's per-request `__CF$cv$params` and challenge `ray=`,
 * and the watchdog beacon's `reqId=`. Keeping only the fields the parser reads
 * removes them by construction, and the run then checks the output for every
 * session marker known anyway.
 *
 * Usage (build first: `npm run build`):
 *   node scripts/distil-bh.mjs fixture <raw.html> <out.html.gz>
 *   node scripts/distil-bh.mjs corpus <cache-dir> <results.json> <out.json.gz>
 *
 * In corpus mode the cache directory holds the investigation's captures, each
 * `<tag>-<hash>.html` beside a `.headers.json` that records its url; the
 * corpus holds every search each row asked and the product page of every
 * listing it probed.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const repoRoot = path.resolve(import.meta.dirname, "..");
// `pathToFileURL`, not a string path: on Windows an absolute path starts with a
// drive letter, which the ESM loader reads as an unknown URL scheme.
const { bhAdapter, extractPreloadedData, noBarcodeReason } = await import(
  pathToFileURL(path.join(repoRoot, "dist/adapters/bh.js")).href
);

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

const itemKey = fields({ skuNo: true, itemSource: true });

/** What a search card, or a product page's item, is read for. */
const ITEM = {
  itemKey,
  core: fields({
    shortDescription: true,
    manufacturerCatalogNumber: true,
    detailsUrl: true,
    isBHKit: true,
    isJKit: true,
    isMfrBundle: true,
  }),
  brand: fields({ name: true }),
  imageInfo: fields({
    images: (images) =>
      Array.isArray(images)
        ? images.slice(0, 1).map(fields({ note: true, shortDescription: true }))
        : images,
  }),
  mainImage: fields({
    hasMainImage: true,
    default: fields({ url: true }),
    detail: fields({ url: true }),
    listing: fields({ url: true }),
  }),
  priceInfo: fields({
    price: true,
    showPrice: true,
    isMapItem: true,
    hidePriceAndCartSection: true,
  }),
  // The message is kept although nothing reads it: a fixture proves it is
  // NOT read, which needs the lie in the file.
  stockInfo: fields({ status: true, statusMessage: true }),
};
const card = fields(ITEM);

/** Only the UPC of each overview / specification entry, and whose it is. */
const upcEntries = fields({
  items: each(
    fields({ upc: true, item: fields({ itemKey: fields({ skuNo: true }) }) }),
  ),
});
const productItem = fields({
  ...ITEM,
  overview: upcEntries,
  specifications: upcEntries,
});

/** The preloaded state, trimmed to the stores the parser reads. */
function distilState(pre) {
  const kept = {};
  const data = pre?.ListingStore?.state?.response?.data;
  if (isObj(data)) {
    kept.ListingStore = {
      state: {
        response: {
          data: pick(data, {
            responseType: true,
            pageNumber: true,
            count: true,
            searchTerm: true,
            responseInfo: fields({ type: true, status: true }),
            infoMessages: each(fields({ type: true })),
            items: each(card),
          }),
        },
      },
    };
  }
  const entries = pre?.ServerStateStore?.state?.entries;
  if (isObj(entries)) {
    const out = {};
    let n = 0;
    for (const entry of Object.values(entries)) {
      if (!isObj(entry)) continue;
      // Entry keys are content hashes; renumbered, in page order.
      if (isObj(entry.data) && isObj(entry.data.replacementInfo)) {
        out[`e${n++}`] = {
          data: {
            replacementInfo: pick(entry.data.replacementInfo, {
              originalItem: fields({ itemKey }),
            }),
          },
        };
      } else if (
        Array.isArray(entry.query?.itemKeys) &&
        entry.query.itemKeys.length === 1 &&
        Array.isArray(entry.data) &&
        isObj(entry.data[0])
      ) {
        out[`e${n++}`] = {
          query: { itemKeys: entry.query.itemKeys.map(itemKey) },
          data: [productItem(entry.data[0])],
        };
      }
    }
    kept.ServerStateStore = { state: { entries: out } };
  }
  return kept;
}

const encodeAttribute = (text) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const LD_JSON =
  /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const GTIN = {
  gtin: true,
  gtin8: true,
  gtin12: true,
  gtin13: true,
  gtin14: true,
};

/** The JSON-LD Product nodes: their url and every gtin field. */
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
      const kept = pick(node, { "@type": true, url: true, mpn: true, ...GTIN });
      out.push(
        `<script type="application/ld+json">${JSON.stringify(kept)}</script>`,
      );
    }
  }
  return out.join("");
}

const UPC_LINE = /data-selenium="overviewUpcText"[^>]*>\s*UPC:\s*([^<]*)</g;

/** Each rendered "UPC: …" line, as the parser reads it. */
function distilUpcLines(html) {
  return [...html.matchAll(UPC_LINE)]
    .map(
      (m) =>
        `<span data-selenium="overviewUpcText">UPC: ${(m[1] ?? "").trim()}</span>`,
    )
    .join("");
}

export function distil(html) {
  const pre = extractPreloadedData(html);
  const state =
    pre === null
      ? ""
      : `<div class="bh-preloaded-data" data-data="${encodeAttribute(
          JSON.stringify(distilState(pre)),
        )}"></div>`;
  return (
    "<!doctype html><!-- distilled B&H page: only the fields the adapter " +
    "reads; see scripts/distil-bh.mjs --><html><body>" +
    state +
    distilLd(html) +
    distilUpcLines(html) +
    "</body></html>"
  );
}

/** Every parse the adapter makes of a body, as one comparable string. */
const parses = (body) =>
  JSON.stringify({
    search: bhAdapter.parseSearchResults(body),
    product: bhAdapter.parseProductPage(body),
    reading: bhAdapter.readListingPage(body),
    noBarcode: noBarcodeReason(body),
  });

/**
 * 🔴 Markers of a session or of the vendor, any one of which must not survive.
 * The test that guards the committed files keeps the same list.
 */
const SESSION_MARKERS = [
  /bhTraceId|ssrReqId|qasAuthToken/i,
  /__CF\$cv\$params|challenge-platform/,
  /[?&](?:reqId|ray)=/,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // a uuid
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/, // an IPv4 address
  /x-forwarded-for/i,
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
  const need = (url) => {
    const file = byUrl.get(url);
    if (file === undefined) throw new Error(`not in the cache: ${url}`);
    return file;
  };
  const rows = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
  const urls = [];
  const want = (url) => {
    if (!urls.includes(url)) urls.push(url);
  };
  for (const row of rows) {
    // Every search the investigation asked for this row, and the product page
    // of every listing it probed — found on those searches, by its own url.
    const listings = new Map();
    for (const query of row.queries) {
      const searchUrl = bhAdapter.buildSearchUrl(query);
      want(searchUrl);
      const found =
        bhAdapter.parseSearchResults(
          fs.readFileSync(need(searchUrl), "utf8"),
        ) ?? [];
      for (const c of found) listings.set(c.itemId, c.url);
    }
    for (const probe of row.probed) {
      const url = listings.get(probe.skuNo);
      if (url === undefined) {
        throw new Error(`${row.upc}: probed ${probe.skuNo}, on no search`);
      }
      need(url);
      want(url);
    }
  }
  const entries = urls.map((url) => ({
    url,
    body: proven(fs.readFileSync(byUrl.get(url), "utf8"), url),
  }));
  const corpus = {
    note:
      "B&H pages from the investigation's cache (meriwether-data-scraper, " +
      "recon/captures/bh-upc/cache, fetched 2026-11-10 through the vendor " +
      "with country us), distilled by scripts/distil-bh.mjs: each one proven " +
      "to parse identically to the raw page, and carrying no session value.",
    distilledOn: new Date().toISOString().slice(0, 10),
    entries,
  };
  const gz = zlib.gzipSync(JSON.stringify(corpus), { level: 9 });
  fs.writeFileSync(out, gz);
  console.log(`${out}: ${entries.length} pages, ${gz.length} bytes gzipped`);
} else {
  console.error(
    "usage: node scripts/distil-bh.mjs fixture <raw.html> <out.html.gz>\n" +
      "       node scripts/distil-bh.mjs corpus <cache-dir> <results.json> <out.json.gz>",
  );
  process.exit(2);
}
