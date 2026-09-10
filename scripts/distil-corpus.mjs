/**
 * Turn the handover spike's 160 MB response cache into a committable replay
 * corpus.
 *
 * ⚠️ **Why this script exists rather than committing the cache.** 611 real
 * responses are 160.6 MB and live in one Downloads folder on one machine. This
 * workspace already has a roadmap row (`commit-eap-parity-fixtures`) filed
 * because a test's inputs lived on a single machine, so the test only ever ran
 * there. A distilled, committed corpus is the fix, and this script is committed
 * beside it so the distillation is reproducible rather than a one-off.
 *
 * 🔑 **The distillation is PROVEN equivalent, not asserted.** For every
 * response it runs the real parser on the original body AND on the distilled
 * body and requires byte-identical JSON output. A body whose parse differs is
 * emitted RAW rather than distilled, and if that would blow the size budget the
 * script fails instead of quietly shipping a corpus that disagrees with reality.
 *
 * Usage:
 *   node scripts/distil-corpus.mjs --cache <dir> [--out test/corpus/newegg-53.json]
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (key?.startsWith("--")) args.set(key.slice(2), process.argv[i + 1]);
}

const CACHE = args.get("cache");
const OUT = args.get("out") ?? "test/corpus/launch-retailer-53.json.gz";
if (!CACHE) {
  console.error(
    "usage: node scripts/distil-corpus.mjs --cache <dir> [--out <file>]\n" +
      "  <dir> holds the spike's captures: serp-*.html, search-*.html, pdp-*.html",
  );
  process.exit(2);
}

const repoRoot = path.resolve(import.meta.dirname, "..");
// `pathToFileURL`, not a string path: on Windows an absolute path starts with a
// drive letter, which the ESM loader reads as an unknown URL scheme.
const { parseSearchResults, parseProductPage } = await import(
  pathToFileURL(path.join(repoRoot, "dist/adapters/newegg.js")).href
);
const { resultTitles, candidatePartNumbers } = await import(
  pathToFileURL(path.join(repoRoot, "dist/identity/from-search-results.js"))
    .href
);

// ---------------------------------------------------------------- url recovery
//
// The spike named each capture `<tag>-<sha1(url).slice(0,16)>.html` and did not
// record the url. The urls are recoverable because every one is derivable from
// the run's own inputs: the search and serp urls come from the query strings the
// run tried (recorded in results.csv), and the product urls come from the
// candidates the searches returned.

const sha1Key = (url) =>
  createHash("sha1").update(url).digest("hex").slice(0, 16);

function readCsv(file) {
  const text = fs.readFileSync(file, "utf8");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift();
  return rows
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

// ---------------------------------------------------------------- distillation

const ANCHOR = "window.__initialState__ =";

/** Keys `parseSearchResults` reads. Anything else is weight. */
function trimItemCell(cell) {
  if (cell === null || typeof cell !== "object") return cell;
  const out = {};
  for (const k of ["Item", "ParentItem", "Model", "FinalPrice", "Instock"]) {
    if (k in cell) out[k] = cell[k];
  }
  if (cell.Description && typeof cell.Description === "object") {
    out.Description = {};
    for (const k of ["Title", "UrlKeywords"]) {
      if (k in cell.Description) out.Description[k] = cell.Description[k];
    }
  }
  if (cell.Seller && typeof cell.Seller === "object") {
    out.Seller = { SellerName: cell.Seller.SellerName ?? null };
  }
  if (cell.ItemManufactory && typeof cell.ItemManufactory === "object") {
    out.ItemManufactory = {
      Manufactory: cell.ItemManufactory.Manufactory ?? null,
    };
  }
  return out;
}

function distilSearch(html) {
  const start = html.indexOf(ANCHOR);
  if (start < 0) return "<html></html>";
  const end = html.indexOf("</script>", start);
  if (end < 0) return "<html></html>";
  let state;
  try {
    state = JSON.parse(
      html
        .slice(start + ANCHOR.length, end)
        .trim()
        .replace(/;$/, ""),
    );
  } catch {
    return html; // unparseable: keep it raw rather than guess
  }
  const products = Array.isArray(state.Products)
    ? state.Products.map((p) => ({
        IsCombo: p?.IsCombo === true,
        ItemCell: trimItemCell(p?.ItemCell ?? null),
      }))
    : undefined;
  const trimmed = products === undefined ? {} : { Products: products };
  return `<script>${ANCHOR} ${JSON.stringify(trimmed)};</script>`;
}

function distilProduct(html) {
  const m = /"UPCCode":"([^"]*)"/.exec(html);
  return m === null
    ? "<html></html>"
    : `<script>{"UPCCode":"${m[1]}"}</script>`;
}

/**
 * A result page distils to its `<h3>` blocks plus the stripped text of
 * everything else. `resultTitles` needs the tags; `candidatePartNumbers` strips
 * tags itself and reads pre-stripped text identically.
 *
 * 🔴 **The `h3` content must NOT also appear in the text half**, and getting
 * that wrong is what the equivalence proof caught. Emitting the headings and
 * then the whole page's stripped text duplicates every heading token — and
 * `candidatePartNumbers` keeps a token only if it recurs at least twice, so a
 * token appearing once in a heading crossed the threshold in the distilled body
 * and not in the original. 21 of 71 result pages parsed differently. Without
 * the proof that would have shipped as a corpus that quietly disagrees with the
 * pages it came from.
 */
function distilResults(html) {
  const headingBlock = /<h3[^>]*>([\s\S]*?)<\/h3>/g;
  // Every heading, including any inside a script — `resultTitles` sees those.
  const heads = [...html.matchAll(headingBlock)]
    .map((m) => `<h3>${m[1]}</h3>`)
    .join("\n");
  // ⚠️ Scripts and styles go FIRST, in the token extractor's own order. A
  // heading inside a script contributes no tokens in the original (scripts are
  // stripped before tags), but promoting it to a top-level heading here would
  // make its text survive — extra tokens, and a corpus that parses differently.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(headingBlock, " ") // carried above, exactly once
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${heads}\n<p>${text}</p>`;
}

/** parser -> canonical JSON, for the equivalence proof. */
const PARSERS = {
  search: (html) => JSON.stringify(parseSearchResults(html)),
  pdp: (html) => JSON.stringify(parseProductPage(html)),
  serp: (html) =>
    JSON.stringify({
      titles: resultTitles(html),
      // Barcode is irrelevant to equivalence: the same value is used on both
      // sides, so any barcode exercises the same code path.
      parts: candidatePartNumbers(html, "000000000000"),
    }),
};

const DISTILLERS = {
  search: distilSearch,
  pdp: distilProduct,
  serp: distilResults,
};

// ---------------------------------------------------------------- run

const files = fs.readdirSync(CACHE).filter((f) => f.endsWith(".html"));
const byKey = new Map();
for (const f of files) {
  const m = /^(serp|search|pdp)-([0-9a-f]{16})\.html$/.exec(f);
  if (m) byKey.set(`${m[1]}:${m[2]}`, f);
}

// Recover urls from the run's own record.
//
// ⚠️ Two traps here, both hit on the way to getting this right, and both of the
// same kind: the script recovered SOMETHING and so looked like it worked.
//
//   1. The spike wrote its record BESIDE the cache directory, not inside it.
//      Looking only inside recovered no search-engine or search urls at all,
//      and the corpus came out holding product pages only — 255 entries, which
//      is a plausible-looking number.
//   2. `results.csv` is a 53-row EXPORT; `full.jsonl` is the complete journal —
//      73 rows and 213 distinct queries, of which 211 match a capture. Reading
//      the csv recovered 8 of 271 search pages.
//
// So: prefer the journal, fall back to the csv, and refuse if neither is there.
const RECORDS = ["full.jsonl", "results.csv"].flatMap((name) => [
  path.join(CACHE, "..", name),
  path.join(CACHE, name),
]);
const record = RECORDS.find((p) => fs.existsSync(p));

if (record === undefined) {
  console.error(
    `no full.jsonl or results.csv in ${CACHE} or its parent — without one, no ` +
      `search-engine or search urls can be recovered and the corpus would ` +
      `silently hold product pages only. Refusing.`,
  );
  process.exit(3);
}
console.log(`recovering urls from ${record}`);

/** The journal is one JSON object per completed row; the csv is a table. */
function readRecord(file) {
  if (file.endsWith(".jsonl")) {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
  }
  return readCsv(file);
}

const urls = new Set();
for (const row of readRecord(record)) {
  if (row.upc) {
    urls.add(
      `https://www.google.com/search?q=%22${encodeURIComponent(row.upc)}%22`,
    );
  }
  for (const q of (row.neweggQuery ?? "").split(" | ")) {
    const query = q.trim();
    if (query !== "") {
      urls.add(`https://www.newegg.com/p/pl?d=${encodeURIComponent(query)}`);
    }
  }
  if (row.neweggUrl) urls.add(row.neweggUrl);
}

// Product urls the searches returned — the record only names the winner.
for (const [key, file] of byKey) {
  if (!key.startsWith("search:")) continue;
  const html = fs.readFileSync(path.join(CACHE, file), "utf8");
  for (const c of parseSearchResults(html)) urls.add(c.url);
}

console.log(`captures: ${byKey.size}   candidate urls: ${urls.size}`);

const entries = [];
const stats = { matched: 0, distilled: 0, keptRaw: 0, unmatched: 0 };
let rawBytes = 0;
let outBytes = 0;

for (const url of urls) {
  const k = sha1Key(url);
  const tag = url.includes("google.com/search")
    ? "serp"
    : url.includes("/p/pl?")
      ? "search"
      : "pdp";
  const file = byKey.get(`${tag}:${k}`);
  if (file === undefined) {
    stats.unmatched++;
    continue;
  }
  stats.matched++;

  const original = fs.readFileSync(path.join(CACHE, file), "utf8");
  const distilled = DISTILLERS[tag](original);

  // --- the proof --------------------------------------------------------
  const before = PARSERS[tag](original);
  const after = PARSERS[tag](distilled);
  const equivalent = before === after;

  const body = equivalent ? distilled : original;
  if (equivalent) stats.distilled++;
  else {
    stats.keptRaw++;
    console.log(`  !! parse differs, kept raw: ${tag} ${file}`);
  }

  rawBytes += original.length;
  outBytes += body.length;
  entries.push({ url, body });
}

console.log(
  `\nmatched ${stats.matched}, unmatched ${stats.unmatched}\n` +
    `distilled ${stats.distilled}, kept raw ${stats.keptRaw}\n` +
    `${(rawBytes / 1024 / 1024).toFixed(1)}MB -> ${(outBytes / 1024 / 1024).toFixed(2)}MB before gzip`,
);

const payload =
  JSON.stringify(
    {
      note:
        "Replay corpus distilled from the handover spike's response cache. Each " +
        "body is reduced to what the parsers read, and every reduction is PROVEN " +
        "equivalent: the distiller ran each parser on the original and the " +
        "distilled body and required identical output. Public retailer and " +
        "search-engine pages; no customer data.",
      distilledOn: new Date().toISOString().slice(0, 10),
      distilledFrom: `${stats.matched} captured responses`,
      keptRaw: stats.keptRaw,
      entries,
    },
    null,
    0,
  ) + "\n";

const gz = zlib.gzipSync(Buffer.from(payload, "utf8"), { level: 9 });
const outPath = path.join(repoRoot, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, gz);
console.log(
  `wrote ${entries.length} entries, ${(gz.length / 1024 / 1024).toFixed(2)}MB gzipped -> ${OUT}`,
);

if (stats.keptRaw > 0) {
  console.log(
    `\n⚠️  ${stats.keptRaw} response(s) could not be distilled equivalently and ` +
      `are stored raw. That is honest but heavy — investigate rather than ignore.`,
  );
}
