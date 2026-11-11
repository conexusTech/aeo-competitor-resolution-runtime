import type {
  CategoryReading,
  ListingPageResult,
  ListingReader,
  ParsedCandidate,
  ParsedProduct,
  QuerySupport,
  RetailerAdapter,
} from "./types.js";
import { ldJsonBlocks } from "../ld-json.js";
import { safeImageUrl } from "./types.js";

/**
 * The Best Buy adapter, read through Best Buy's website only.
 *
 * ⚠️ **Never Best Buy's developer API**: its terms bar this use. Everything
 * here reads pages the website serves, fetched through the vendor.
 *
 * 🔑 **The data is the GraphQL results the page embeds**, one push per streamed
 * chunk:
 *
 *   (window[Symbol.for("ApolloSSRDataTransport")] ??= []).push({...});
 *
 * Each `next` event carries `value.data`. A search page's lives under
 * `data.search`; a product page's is many partial `data.productBySkuId`
 * results for the page's own SKU (each query asks for different fields) plus a
 * few for carousel SKUs. Rendered HTML is read only where the JSON is silent: a
 * search card's title, link and price.
 *
 * ⚠️ **The payload is a JavaScript literal, not strict JSON** — it writes
 * `"nextFetchPolicy":undefined` — so a bare `undefined` value is mapped to
 * `null` before parsing. A chunk that still does not parse is skipped, never
 * guessed at.
 *
 * Ported from the investigation's parser (`meriwether-data-scraper`,
 * `RECON-FINDINGS-BESTBUY.md`) and held to its data contract, not copied: this
 * one answers the runtime's seam, which has two empty answers where the
 * investigation's threw.
 *
 * Pure, and no dependency.
 */

const APOLLO_PUSH =
  '(window[Symbol.for("ApolloSSRDataTransport")] ??= []).push(';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown, key: string): Json | null => {
  if (!isObj(v)) return null;
  const inner = v[key];
  return isObj(inner) ? inner : null;
};
const arr = (v: unknown, key: string): unknown[] => {
  if (!isObj(v)) return [];
  const inner = v[key];
  return Array.isArray(inner) ? inner : [];
};
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const strAt = (v: unknown, key: string): string | null =>
  isObj(v) ? str(v[key]) : null;
/** Dollars as a number -> cents. Never 0: a price that reads 0 is not a price. */
const centsAt = (v: unknown, key: string): number | null => {
  if (!isObj(v)) return null;
  const n = v[key];
  return typeof n === "number" && Number.isFinite(n) && n > 0
    ? Math.round(n * 100)
    : null;
};

/**
 * Every `value.data` object the page's GraphQL transport carries, in page
 * order.
 */
export function extractApolloData(html: string): Json[] {
  const out: Json[] = [];
  let from = 0;
  for (;;) {
    const at = html.indexOf(APOLLO_PUSH, from);
    if (at < 0) break;
    const start = at + APOLLO_PUSH.length;
    const end = html.indexOf("</script>", start);
    if (end < 0) break;
    from = end;
    const literal = html
      .slice(start, end)
      .trim()
      .replace(/\)\s*;?\s*$/, "")
      .replace(/:undefined(?=[,}\]])/g, ":null");
    let chunk: unknown;
    try {
      chunk = JSON.parse(literal);
    } catch {
      continue;
    }
    for (const event of arr(chunk, "events")) {
      if (!isObj(event) || event["type"] !== "next") continue;
      const data = obj(obj(event, "value"), "data");
      if (data !== null) out.push(data);
    }
  }
  return out;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const HOME = "https://www.bestbuy.com/";

/** An absolute Best Buy product url naming this SKU, or `null`. */
function productUrl(raw: string | null, skuId: string): string | null {
  if (raw === null || !raw.startsWith(HOME)) return null;
  // The group url without `/sku/` opens the group's FEATURED SKU, which may
  // be another colour or another seller's offer. Measured on the
  // investigation's 38 product pages: every probe asked for `…/sku/<id>`.
  return raw.includes("/sku/") ? raw : `${raw.replace(/\/$/, "")}/sku/${skuId}`;
}

/**
 * `ADD_TO_CART` is in stock and `SOLD_OUT` is not. Anything else — a pre-order,
 * "check stores", a state not seen — is unknown, never assumed either way.
 *
 * 🔴 **`SOLD_OUT` is not hypothetical.** The investigation recorded only
 * `ADD_TO_CART` and called `SOLD_OUT` unseen, yet its own capture of the APC
 * BK350's marketplace listing (SKU 11521676) says `SOLD_OUT`, "Sold Out", on
 * both the search card and the product page.
 */
function inStockOf(product: Json): boolean | null {
  const first = arr(obj(product, "fulfillmentOptions"), "buttonStates")[0];
  const state = strAt(first, "buttonState");
  if (state === "ADD_TO_CART") return true;
  if (state === "SOLD_OUT") return false;
  return null;
}

/**
 * `1P` is sold by Best Buy, `3P` by a marketplace seller. `null` where the
 * card states no seller — an unhydrated card — never assumed first-party.
 */
function firstPartyOf(classification: string | null): boolean | null {
  if (classification === "1P") return true;
  if (classification === "3P") return false;
  return null;
}

/** What a search page's own rendered card says, where its JSON is silent. */
interface HtmlCard {
  readonly title: string | null;
  readonly href: string | null;
  readonly priceCents: number | null;
}

const CARD_START = /<li data-testid="(\d+)" data-product-id="\d+"/g;
const CARD_TITLE = /<h3 class="product-title[^"]*" title="([^"]*)"/;
const CARD_LINK = /<a class="product-list-item-link" href="([^"]*)"/;
const CARD_PRICE =
  /data-testid="price-block-customer-price"[^>]*>\s*<span[^>]*>\$([\d,]+)\.(\d{2})</;

/**
 * The rendered cards (`<li data-product-id>`), by SKU id.
 *
 * Measured by the investigation: only the first ~4 documents of a page are
 * hydrated server-side, so the JSON of the rest carries a SKU and no name or
 * price — while a search page renders every card's title and link, and some of
 * their prices.
 */
function htmlCards(html: string): Map<string, HtmlCard> {
  const out = new Map<string, HtmlCard>();
  const starts: { sku: string; at: number }[] = [];
  CARD_START.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CARD_START.exec(html)) !== null) {
    const sku = m[1];
    if (sku !== undefined) starts.push({ sku, at: m.index });
  }
  starts.forEach((start, i) => {
    if (out.has(start.sku)) return;
    const end = starts[i + 1]?.at ?? start.at + 60_000;
    const cell = html.slice(start.at, end);
    const title = CARD_TITLE.exec(cell)?.[1];
    const href = CARD_LINK.exec(cell)?.[1];
    const price = CARD_PRICE.exec(cell);
    const whole = price?.[1];
    const fraction = price?.[2];
    out.set(start.sku, {
      title: title === undefined ? null : str(decodeEntities(title)),
      href: href === undefined ? null : decodeEntities(href),
      priceCents:
        whole === undefined || fraction === undefined
          ? null
          : Number(whole.replace(/,/g, "")) * 100 + Number(fraction),
    });
  });
  return out;
}

/** The search document as a candidate, or `null` when it cannot be one. */
function toCandidate(
  doc: Json,
  cards: ReadonlyMap<string, HtmlCard>,
): ParsedCandidate | null {
  const product = obj(doc, "product");
  const skuId = strAt(product, "skuId");
  if (product === null || skuId === null) return null;
  const card = cards.get(skuId);

  const urls = obj(product, "url");
  const url =
    productUrl(strAt(urls, "skuSpecificUrl"), skuId) ??
    productUrl(strAt(urls, "pdp"), skuId) ??
    productUrl(card?.href ?? null, skuId);
  const title = strAt(obj(product, "name"), "short") ?? card?.title ?? null;
  // Nothing to probe, or nothing a reviewer could recognise it by.
  if (url === null || title === null) return null;

  const price = obj(product, "price");
  const classification = strAt(obj(product, "seller"), "classification");
  const isFirstParty = firstPartyOf(classification);
  const image = obj(product, "primaryImage");
  return {
    itemId: skuId,
    url,
    // 🔴 `manufacturer.modelNumber` only. The flixcar content url in
    // `operationalAttributes` names a model too, and it is the product
    // GROUP's: SKU 1297054 is 910-001675 while its flixcar url names
    // 910-001917, the blue variant.
    model: strAt(obj(product, "manufacturer"), "modelNumber"),
    title,
    brand: strAt(product, "brand"),
    priceCents:
      centsAt(price, "customerPrice") ??
      centsAt(price, "displayableCustomerPrice") ??
      card?.priceCents ??
      null,
    inStock: inStockOf(product),
    isFirstParty,
    // A search card names Best Buy's own offers but never a marketplace
    // seller — that name is on the product page, and the page that proves the
    // pairing supplies it.
    sellerName: isFirstParty === true ? "Best Buy" : null,
    imageUrl: safeImageUrl(strAt(image, "piscesHref") ?? strAt(image, "href")),
    // 🔑 Best Buy's look-alikes never reach here: a `dvsOnly` page answers
    // `[]` and an `isTermMatch: false` document is dropped.
    partialMatch: false,
  };
}

/**
 * The query's look-alikes-only answer: Best Buy matched nothing in the query's
 * text and filled the page by vector similarity.
 *
 * 🔴 **A full page is not a found product.** A part number nothing matches
 * comes back as `dvsOnly` with 22-50 look-alikes — 18 Filterbuy air filters for
 * a nonsense part number — and 13 of the investigation's 30 part-number
 * queries did. No verification on the 20 rows ever came from such a page.
 */
const LOOKALIKES_ONLY = "dvsOnly";

/**
 * Candidates from a search page: `[]` for a results page that answers with no
 * listing matching the query, and `null` for a body that is not a results page
 * at all — see the seam's contract.
 *
 * A results page is recognised by its `data.search` payload, which every
 * search and listing page carries, the truly empty one ("No results found",
 * `numFound` 0) included, and which an empty body, a vendor error and a
 * product page do not.
 *
 * Organic results first, then the sponsored listings in the results grid (Best
 * Buy Ads), one per SKU. A document Best Buy itself marks as not matching the query's terms
 * (`isTermMatch: false`) is a look-alike and is dropped; a document that says
 * nothing — every hydrated one — is kept for the barcode to decide.
 */
export function parseSearchResults(html: string): ParsedCandidate[] | null {
  const searches: Json[] = [];
  for (const data of extractApolloData(html)) {
    const search = obj(data, "search");
    if (search !== null) searches.push(search);
  }
  if (searches.length === 0) return null;

  const recall =
    searches
      .map((search) =>
        strAt(obj(obj(search, "track"), "analyticsData"), "recallStrategy"),
      )
      .find((value) => value !== null) ?? null;
  if (recall === LOOKALIKES_ONLY) return [];

  const cards = htmlCards(html);
  const organic: ParsedCandidate[] = [];
  const sponsored: ParsedCandidate[] = [];
  const seen = new Set<string>();
  let offered = 0;
  // 🔴 **The results grid only, never a placement's `documents`.** Those are
  // the sponsored carousels: ads for other products beside the results — and,
  // on a page with NO results, a second search result holding a twelve-ad
  // "no results" carousel (a Dell laptop for a UPS's barcode). Measured over
  // every search and listing page the investigation captured: results are
  // always in `documentsGridView.sponsoredDocuments` (organic and in-grid
  // sponsored alike), and `documents` only ever held carousel ads. Reading
  // them would spend a barcode search's probes on adverts.
  const docs = searches.flatMap((search) =>
    arr(obj(search, "withBestMedia"), "placements").flatMap((placement) =>
      arr(obj(placement, "documentsGridView"), "sponsoredDocuments"),
    ),
  );
  for (const doc of docs) {
    if (!isObj(doc)) continue;
    if (doc["isTermMatch"] === false) continue;
    offered++;
    const candidate = toCandidate(doc, cards);
    if (candidate === null || seen.has(candidate.itemId)) continue;
    seen.add(candidate.itemId);
    const typename = str(doc["__typename"]) ?? "";
    (typename.includes("Media") ? sponsored : organic).push(candidate);
  }

  const out = [...organic, ...sponsored];
  // 🔴 Documents that match the query and not one readable: the markup has
  // moved under us. Reading that as `[]` would file every item as not carried
  // the day Best Buy renames a field.
  if (out.length === 0 && offered > 0) return null;
  return out;
}

/** What the page says about its own product. */
interface PageProduct {
  readonly skuId: string;
  readonly upcs: readonly string[];
  /** The page carries a UPC field at all, even an empty one. */
  readonly hasUpcField: boolean;
  readonly priceCents: number | null;
  readonly inStock: boolean | null;
  readonly title: string | null;
  readonly sellerName: string | null;
  /** `1P` Best Buy, `3P` a marketplace seller, `null` unstated. */
  readonly isFirstParty: boolean | null;
}

/** The page's `schema.org/Product` nodes, in page order. */
function ldProducts(html: string): Json[] {
  const out: Json[] = [];
  // 🔴 Through the shared linear scan: see `ldJsonBlocks`.
  for (const block of ldJsonBlocks(html)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.trim());
    } catch {
      continue;
    }
    for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
      if (isObj(node) && node["@type"] === "Product") out.push(node);
    }
  }
  return out;
}

/**
 * Every barcode a field holds: one value may carry several, split on
 * whitespace, commas, slashes and semicolons. Anything that is not 8-14 digits
 * is not a barcode and is dropped.
 */
function barcodesIn(raw: unknown, into: string[]): void {
  if (typeof raw !== "string") return;
  for (const token of raw.split(/[\s,/;]+/)) {
    if (/^\d{8,14}$/.test(token) && !into.includes(token)) into.push(token);
  }
}

/**
 * The page's own product, merged from its partial results — or `null` when the
 * body carries no product payload: an empty body, a vendor error, a search
 * page, a block.
 *
 * 🔑 **The page's product is the one carrying `upc` or `specificationGroups`.**
 * Carousel SKUs on the same page carry prices and never those, and a search or
 * listing page carries `productBySkuId` results too (carousel prices) and never
 * those either — which is also how a non-product body is refused. Where the
 * page's own JSON-LD names a SKU that is among them, that SKU wins.
 */
function pageProduct(html: string): PageProduct | null {
  const parts: Json[] = [];
  for (const data of extractApolloData(html)) {
    const part = obj(data, "productBySkuId");
    if (part !== null && strAt(part, "skuId") !== null) parts.push(part);
  }
  const core = parts.filter((p) => "upc" in p || "specificationGroups" in p);
  const ld = ldProducts(html);
  const coreSkus = core.map((p) => strAt(p, "skuId"));
  const named = ld
    .map((node) => strAt(node, "sku"))
    .find((sku) => sku !== null && coreSkus.includes(sku));
  const skuId = named ?? coreSkus[0] ?? null;
  if (skuId === null) return null;

  const mine = parts.filter((p) => strAt(p, "skuId") === skuId);
  const first = <T>(read: (p: Json) => T | null): T | null => {
    for (const p of mine) {
      const v = read(p);
      if (v !== null) return v;
    }
    return null;
  };

  // 🔑 Every place the page states a UPC, all of them: Best Buy's own `upc`
  // field, the "UPC" specification row, and the JSON-LD `additionalProperty`
  // named "UPC". Measured equal on all 38 product pages the investigation
  // fetched, but the comparison checks every value, so reading them all costs
  // nothing and a page where they differ cannot hide the client's.
  const upcs: string[] = [];
  let hasUpcField = false;
  for (const p of mine) {
    if ("upc" in p) {
      hasUpcField = true;
      barcodesIn(p["upc"], upcs);
    }
  }
  for (const p of mine) {
    for (const group of arr(p, "specificationGroups")) {
      for (const spec of arr(group, "specifications")) {
        if (strAt(spec, "displayName")?.toUpperCase() !== "UPC") continue;
        hasUpcField = true;
        barcodesIn(isObj(spec) ? spec["value"] : null, upcs);
      }
    }
  }
  const ldNode = ld.find((node) => strAt(node, "sku") === skuId) ?? null;
  for (const prop of arr(ldNode, "additionalProperty")) {
    if (strAt(prop, "name")?.toUpperCase() !== "UPC") continue;
    hasUpcField = true;
    barcodesIn(isObj(prop) ? prop["value"] : null, upcs);
  }

  const offers = ldNode === null ? [] : [ldNode["offers"]].flat();
  const offerSeller =
    offers
      .map((offer) => strAt(obj(offer, "seller"), "name"))
      .find((name) => name !== null) ?? null;
  const classification = first((p) =>
    strAt(obj(p, "seller"), "classification"),
  );

  return {
    skuId,
    upcs,
    hasUpcField,
    priceCents: first(
      (p) =>
        centsAt(obj(p, "price"), "customerPrice") ??
        centsAt(obj(p, "price"), "displayableCustomerPrice"),
    ),
    inStock: first((p) =>
      obj(p, "fulfillmentOptions") === null ? null : inStockOf(p),
    ),
    title: first((p) => strAt(obj(p, "name"), "short")),
    // The offer's seller as the page names it; Best Buy's own offers are
    // "Best Buy" whether or not the JSON-LD says so.
    sellerName:
      offerSeller ??
      (firstPartyOf(classification) === true ? "Best Buy" : null),
    isFirstParty: firstPartyOf(classification),
  };
}

/**
 * Raw product-page body -> what resolution reads, or `null` when it is not a
 * product page. See `pageProduct`.
 */
export function parseProductPage(html: string): ParsedProduct | null {
  const product = pageProduct(html);
  if (product === null) return null;
  return {
    // Verbatim, as published; `gtinCore` reconciles widths at compare time.
    barcode: product.upcs[0] ?? null,
    additionalBarcodes: product.upcs.slice(1),
    // 🔑 Read here, unlike Newegg and Amazon: a card past the first few on a
    // page arrives unpriced, so the page that proves the pairing is often the
    // only place the price is stated. The investigation found the two agree
    // wherever both show one (11 of 11).
    priceCents: product.priceCents,
    inStock: product.inStock,
    title: product.title,
    sellerName: product.sellerName,
    // The page's `seller.classification`, which an unhydrated card lacks.
    isFirstParty: product.isFirstParty,
    unverifiableReason: null,
    // Best Buy has no category reads (see `categoryReader`), so no listing is
    // placed in a category.
    category: null,
  };
}

/** What a listing's own page says, for a read run. */
export function readListingPage(html: string): ListingPageResult {
  const product = pageProduct(html);
  if (product === null) {
    return { kind: "not-a-product-page", detail: "no product payload" };
  }
  // 🔴 An offer in stock always has a price, and a product page always says
  // something about its offer. Either gap is markup that moved, not a listing
  // with no price.
  if (product.priceCents === null && product.inStock !== false) {
    return {
      kind: "unreadable-offer",
      detail:
        product.inStock === true
          ? "in stock with no readable price"
          : "neither a price nor an availability could be read",
    };
  }
  return {
    kind: "page",
    page: {
      pageItemId: product.skuId,
      barcode: product.upcs[0] ?? (product.hasUpcField ? "" : null),
      additionalBarcodes: product.upcs.slice(1),
      priceCents: product.priceCents,
      inStock: product.inStock,
      category: null,
    },
  };
}

/**
 * 🔑 **Best Buy answers a barcode search**, measured on the 20-row sample: a
 * 12-digit UPC returned 1 or 2 text-matched results for 11 rows, and the first
 * product page probed published that UPC in 11 of 11; it returned 0 for the
 * other 9. So the barcode is asked first, and no digit limit is known — a cap
 * below 12 digits would refuse the barcode query locally.
 */
const QUERY_SUPPORT: QuerySupport = {
  maxNumericQueryDigits: null,
  barcodeIsSearchable: true,
  partNumberNeedsBrand: false,
};

export const bestbuyAdapter: RetailerAdapter & ListingReader & CategoryReading =
  {
    slug: "bestbuy",
    querySupport: QUERY_SUPPORT,
    // Jody's politeness rule of two to four pages at once, at its top: the
    // registry's figure arrives with the job and wins over this.
    pacing: { pagesAtOnce: 4 },
    // A delivered page took one to three minutes, and about a third of attempts
    // failed inside the vendor; 150 s per attempt is what the investigation ran.
    fetchProfile: { country: "us", timeoutMs: 150_000 },
    // The investigation probed at most three product pages per row.
    maxProbes: 3,
    // It answers a search, so its candidates come from searching.
    productIndex: null,
    buildSearchUrl: (query) =>
      `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(query)}`,
    parseSearchResults,
    parseProductPage,
    hosts: ["www.bestbuy.com", "bestbuy.com"],
    readListingPage,
    // 🔴 **No category reads.** A category page hydrates only its first few
    // cards: the committed Wireless & Bluetooth Mice page states 947 products
    // and carries 4 readable listings (`bestbuy-category-sponsored`). A read of
    // it would report a handful of prices for a page of 18 products.
    categoryReader: null,
  };
