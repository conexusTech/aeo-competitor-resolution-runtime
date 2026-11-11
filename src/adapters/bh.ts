import type {
  CategoryCard,
  CategoryPageResult,
  CategoryReader,
  CategoryReading,
  ListingCategory,
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
 * The B&H Photo adapter, read through B&H's public website only, signed out.
 *
 * 🔑 **Every B&H page carries the app's whole initial state as ONE
 * entity-encoded JSON attribute**:
 *
 *   <div class="bh-preloaded-data" data-data="{&quot;CatalogChangeWatcher&quot;:…}">
 *
 * Decode the entities, then parse. A search page's results are
 * `ListingStore.state.response.data`; a product page's item is the one
 * `ServerStateStore.state.entries` entry that queried exactly one item key. A
 * discontinued item's url can instead serve a replacement page, whose entry
 * carries `replacementInfo` and no item.
 *
 * ⚠️ **No search card carries a UPC.** Only a product page does, in up to four
 * places — the overview and specification entries, the JSON-LD Product's
 * `gtin*`, and the rendered "UPC: …" line — all read here, and all equal on
 * every page the investigation read.
 *
 * Ported from the investigation's parser (`meriwether-data-scraper`,
 * `RECON-FINDINGS-BH.md`) and held to its data contract, not copied: this one
 * answers the runtime's seam, which has two empty answers where the
 * investigation's threw, and it never counts a kit's component UPC as the kit's
 * own — which the investigation's did, through the kit page's JSON-LD.
 *
 * Pure, and no dependency. Category pages are read by `bhCategoryReader`,
 * ported from the same investigation's category parser and held to this seam.
 */

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
/** A numeric or string id, as a string. */
const idAt = (v: unknown, key: string): string | null => {
  if (!isObj(v)) return null;
  const id = v[key];
  if (typeof id === "number" && Number.isInteger(id) && id > 0) {
    return String(id);
  }
  return str(id);
};

export const BH_ORIGIN = "https://www.bhphotovideo.com";

/** Named, decimal and hex entities, as B&H writes them inside an attribute. */
function decodeEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    quot: '"',
    amp: "&",
    lt: "<",
    gt: ">",
    apos: "'",
    nbsp: " ",
  };
  return value.replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g,
    (whole, entity: string) => {
      if (entity.startsWith("#")) {
        const code =
          entity[1] === "x" || entity[1] === "X"
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      // 🔴 Only the entities named above: a lookup by `entity` alone would
      // answer `&constructor;` with Object's constructor function.
      return Object.hasOwn(named, entity) ? (named[entity] ?? whole) : whole;
    },
  );
}

const PRELOADED = /class="bh-preloaded-data"\s+data-data="([^"]*)"/;

/**
 * The page's preloaded state, decoded and parsed — or `null` when there is
 * none: an empty body, a vendor error, a refusal, a page that is not B&H's.
 */
export function extractPreloadedData(html: string): Json | null {
  const encoded = PRELOADED.exec(html)?.[1];
  if (encoded === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeEntities(encoded));
  } catch {
    return null;
  }
  return isObj(parsed) ? parsed : null;
}

/** A path B&H writes (`/c/product/…`) as an absolute url on its own host. */
function absolute(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw.startsWith("/") && !raw.startsWith("//")) return `${BH_ORIGIN}${raw}`;
  return raw.startsWith(`${BH_ORIGIN}/`) ? raw : null;
}

/** Dollars as a number -> cents. Never 0: a price that reads 0 is not a price. */
const toCents = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0
    ? Math.round(v * 100)
    : null;

/**
 * `stockInfo.status`, never `statusMessage`.
 *
 * 🔴 **The message lies.** Measured over 887 search cards: `IN_STOCK` items
 * read "Temporarily Out of Stock" (577 of them, the M310 among them, whose
 * page says "In Stock"), "Special Order" and even "Discontinued", so the
 * message says nothing the status does not say better.
 *
 * ⚠️ `DYNAMIC` covers special order, pre-order, "temporarily out of stock" and
 * "currently unavailable" alike, so it is unknown — never assumed either way.
 * `NO_LONGER_AVAILABLE` is B&H's "Discontinued": not in stock.
 */
function inStockOf(item: Json): boolean | null {
  const status = strAt(obj(item, "stockInfo"), "status");
  if (status === "IN_STOCK") return true;
  if (status === "NO_LONGER_AVAILABLE") return false;
  return null;
}

const isDiscontinued = (item: Json): boolean =>
  strAt(obj(item, "stockInfo"), "status") === "NO_LONGER_AVAILABLE";

/**
 * Whether B&H withholds a price it has: a MAP item ("Add to Cart for Price",
 * shown only in a cart, which needs a session this runtime never creates), or
 * a price and cart section hidden.
 *
 * 🔴 **A withheld price is not a missing one**, and whatever number the state
 * holds beside these flags is never read: a discontinued item's still carries
 * its last price ($99.99 for the Z623), which nobody can buy at.
 */
function priceWithheld(item: Json): boolean {
  const price = obj(item, "priceInfo");
  if (price === null) return false;
  return (
    price["isMapItem"] === true ||
    price["showPrice"] === false ||
    price["hidePriceAndCartSection"] === true
  );
}

/** The price B&H shows, or `null` where it shows none. */
function shownPrice(item: Json): number | null {
  if (isDiscontinued(item) || priceWithheld(item)) return null;
  return toCents(obj(item, "priceInfo")?.["price"]);
}

/**
 * The item's brand: a product page's `brand.name`; on a search card, which has
 * no brand field, the title less the description B&H captions its image with.
 *
 * 🔑 **Measured, not guessed**: on 881 of 887 search cards the image caption
 * (`imageInfo.images[0].note`) is the title, and the caption's
 * `shortDescription` is the title with its leading brand removed — "C2G 100'
 * DisplayPort…" against "100' DisplayPort…". The 6 others were kits whose
 * caption is the title verbatim, and those carry no brand here rather than a
 * guess at one.
 */
function brandOf(item: Json): string | null {
  const named = strAt(obj(item, "brand"), "name");
  if (named !== null) return named;
  const title = strAt(obj(item, "core"), "shortDescription");
  const image = arr(obj(item, "imageInfo"), "images")[0];
  const note = strAt(image, "note");
  const rest = strAt(image, "shortDescription");
  if (title === null || note !== title || rest === null) return null;
  if (!title.endsWith(` ${rest}`)) return null;
  return str(title.slice(0, title.length - rest.length - 1));
}

/** B&H's own photo, or `null` where it shows its "no image" placeholder. */
function imageOf(item: Json): string | null {
  const image = obj(item, "mainImage");
  if (image === null || image["hasMainImage"] === false) return null;
  return safeImageUrl(
    strAt(obj(image, "default"), "url") ??
      strAt(obj(image, "detail"), "url") ??
      strAt(obj(image, "listing"), "url"),
  );
}

/**
 * B&H sells everything it lists itself.
 *
 * 🔑 **No marketplace, measured**: the investigation scanned every key of the
 * preloaded state on all 119 pages it fetched for a seller, vendor, merchant,
 * marketplace or fulfilment name, and found none on any item. Its other offers
 * — used and open-box — are its own stock too.
 */
const SELLER = "B&H Photo";

function toCandidate(
  item: Json,
  /** The page this card is on says it matched only part of the query. */
  partialMatch: boolean,
): ParsedCandidate | null {
  const itemId = idAt(obj(item, "itemKey"), "skuNo");
  const core = obj(item, "core");
  const url = absolute(strAt(core, "detailsUrl"));
  const title = strAt(core, "shortDescription");
  // Nothing to probe, or nothing a reviewer could recognise it by.
  if (itemId === null || url === null || title === null) return null;
  return {
    itemId,
    url,
    // 🔴 The "MFR #". **An equal MFR # is not the same product**: a bare
    // numeric one belongs to another brand's item as often as not — "29538"
    // is a C2G cable as well as an Allsop wrist rest. That is why this
    // adapter's `partNumberNeedsBrand` is true.
    model: strAt(core, "manufacturerCatalogNumber"),
    title,
    brand: brandOf(item),
    priceCents: shownPrice(item),
    inStock: inStockOf(item),
    isFirstParty: true,
    sellerName: SELLER,
    imageUrl: imageOf(item),
    partialMatch,
  };
}

/**
 * Whether B&H answered with a partial match — `PARTIAL_SEARCH` in the
 * listing's `infoMessages`: nothing matched every word, so it filled the page
 * with items matching some of them.
 */
function isPartialSearch(data: Json): boolean {
  return arr(data, "infoMessages").some(
    (m) => strAt(m, "type") === "PARTIAL_SEARCH",
  );
}

/** The listing response of a search or category page, or `null`. */
function listingData(html: string): Json | null {
  const pre = extractPreloadedData(html);
  return obj(obj(obj(obj(pre, "ListingStore"), "state"), "response"), "data");
}

/**
 * Candidates from a search page: `[]` for a results page that holds nothing,
 * `null` for a body that is not a results page at all — see the seam's
 * contract.
 *
 * A results page is recognised by its listing response, which every search
 * page carries — the explicit no-results one included, which states
 * `responseInfo.type` `NO_RESULTS_SEARCH` with no items and no count — and
 * which an empty body, a vendor error and a product page do not.
 *
 * ⚠️ **A partial match is still a results page, and its items are kept.**
 * When nothing matches every word B&H falls back to matching some of them and
 * says so (`PARTIAL_SEARCH`): a nonsense part number came back with 28 screen
 * kits. They are kept for the pipeline to judge — a look-alike has neither the
 * item's MFR # nor its brand, and at B&H a candidate needs both — because a
 * partial page can also hold the item itself.
 */
export function parseSearchResults(html: string): ParsedCandidate[] | null {
  const data = listingData(html);
  if (data === null) return null;

  const items = arr(data, "items");
  const partial = isPartialSearch(data);
  const out: ParsedCandidate[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isObj(item)) continue;
    const candidate = toCandidate(item, partial);
    if (candidate === null || seen.has(candidate.itemId)) continue;
    seen.add(candidate.itemId);
    out.push(candidate);
  }
  // 🔴 Items and not one readable: the markup has moved under us. Reading that
  // as `[]` would file every item as not carried the day B&H renames a field.
  if (out.length === 0 && items.length > 0) return null;
  return out;
}

/** What a product page says about its own item. */
interface PageItem {
  readonly skuNo: string;
  /** Every UPC the page states for its own item, in page order, once each. */
  readonly upcs: readonly string[];
  /**
   * UPCs the page states for OTHER items — a kit's components. 🔴 Never the
   * kit's own, never `additionalBarcodes`, never a match.
   */
  readonly componentUpcs: readonly string[];
  /** The page carries a UPC field at all, even an empty one. */
  readonly hasUpcField: boolean;
  readonly priceCents: number | null;
  /** B&H withholds the price it has (MAP, or price and cart hidden). */
  readonly priceWithheld: boolean;
  readonly discontinued: boolean;
  readonly inStock: boolean | null;
  readonly title: string | null;
  /** The leaf of the item's primary category path, or `null`. */
  readonly category: ListingCategory | null;
}

/**
 * The leaf of an item's primary category path — `categoryInfo.
 * primaryCategoryPath`, root first, so the last entry is the category the
 * item is listed in (Mice & Touchpads, `ci/18369`, for the M310).
 *
 * ⚠️ All three of its id, name and url, or `null`: see `ListingCategory`.
 */
function categoryOf(item: Json): ListingCategory | null {
  const path = arr(obj(item, "categoryInfo"), "primaryCategoryPath");
  const leaf = path[path.length - 1];
  const id = idAt(leaf, "id");
  const name = strAt(leaf, "name");
  const url = absolute(strAt(leaf, "url"));
  if (id === null || name === null || url === null) return null;
  return { id, name, url };
}

/**
 * Every barcode a value holds: one value may carry several, split on
 * whitespace, commas, slashes, semicolons and bars. Anything that is not 8-14
 * digits is not a barcode and is dropped.
 */
function barcodesIn(raw: unknown, into: string[]): void {
  if (typeof raw !== "string") return;
  for (const token of raw.split(/[\s,/;|]+/)) {
    if (/^\d{8,14}$/.test(token) && !into.includes(token)) into.push(token);
  }
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
 * A rendered "UPC:" line, its value trimmed by the caller.
 *
 * 🔴 **One run of non-`<` characters after "UPC:", nothing before it.** A
 * leading `\s*` shared that run with `[^<]*`, so a line of 50,000 spaces with
 * no closing tag took three and a half seconds.
 */
const UPC_LINE = /data-selenium="overviewUpcText"[^>]*>\s*UPC:([^<]*)</g;

/** The entry that queried exactly one item, and its item. */
function productEntries(pre: Json | null): Json[] {
  const entries = obj(obj(obj(pre, "ServerStateStore"), "state"), "entries");
  if (entries === null) return [];
  const out: Json[] = [];
  for (const entry of Object.values(entries)) {
    if (arr(obj(entry, "query"), "itemKeys").length !== 1) continue;
    const item = arr(entry, "data")[0];
    if (isObj(item) && obj(item, "core") !== null) out.push(item);
  }
  return out;
}

/**
 * The page's own item, or `null` when the body is not a product page: an
 * empty body, a refusal, a search page, a discontinued item's replacement
 * page.
 */
function pageItem(html: string): PageItem | null {
  const pre = extractPreloadedData(html);
  const candidates = productEntries(pre);
  const ld = ldProducts(html);
  // One single-item entry on every product page the investigation read. Were
  // there several, the one the JSON-LD's own url names wins.
  const ldSku = ld
    .map((node) => /\/c\/product\/(\d+)-/.exec(strAt(node, "url") ?? "")?.[1])
    .find((sku) => sku !== undefined);
  const item =
    candidates.find(
      (c) => idAt(obj(c, "itemKey"), "skuNo") === (ldSku ?? null),
    ) ??
    candidates[0] ??
    null;
  const skuNo = idAt(obj(item, "itemKey"), "skuNo");
  if (item === null || skuNo === null) return null;
  const core = obj(item, "core");

  // 🔴 **A kit's page states its COMPONENTS' UPCs, and none of them is the
  // kit's.** Measured on a real one (a Logitech G mouse-and-charging-pad kit,
  // skuNo 1882239): its overview entries are keyed to the two components'
  // own items, and its JSON-LD `gtin12` and both rendered "UPC:" lines repeat
  // those two values. The investigation's parser filed the JSON-LD value as
  // the kit's own, so a client's mouse would have verified against the kit.
  // On a kit only an entry keyed to the kit itself is the kit's.
  const isKit =
    core?.["isBHKit"] === true ||
    core?.["isJKit"] === true ||
    core?.["isMfrBundle"] === true;
  const own: string[] = [];
  const others: string[] = [];
  let hasUpcField = false;
  for (const group of ["overview", "specifications"]) {
    for (const entry of arr(obj(item, group), "items")) {
      if (!isObj(entry) || !("upc" in entry)) continue;
      hasUpcField = true;
      const key = idAt(obj(obj(entry, "item"), "itemKey"), "skuNo");
      const mine = key === skuNo || (key === null && !isKit);
      barcodesIn(entry["upc"], mine ? own : others);
    }
  }
  for (const node of ld) {
    const url = strAt(node, "url");
    if (url !== null && !url.includes(`/${skuNo}-`)) continue;
    for (const field of ["gtin", "gtin8", "gtin12", "gtin13", "gtin14"]) {
      if (!(field in node)) continue;
      hasUpcField = true;
      barcodesIn(node[field], isKit ? others : own);
    }
  }
  UPC_LINE.lastIndex = 0;
  let line: RegExpExecArray | null;
  while ((line = UPC_LINE.exec(html)) !== null) {
    hasUpcField = true;
    barcodesIn((line[1] ?? "").trim(), isKit ? others : own);
  }

  return {
    skuNo,
    upcs: own,
    componentUpcs: others.filter((upc) => !own.includes(upc)),
    hasUpcField,
    priceCents: shownPrice(item),
    priceWithheld: !isDiscontinued(item) && priceWithheld(item),
    discontinued: isDiscontinued(item),
    inStock: inStockOf(item),
    title: strAt(core, "shortDescription"),
    category: categoryOf(item),
  };
}

/**
 * Raw product-page body -> what resolution reads, or `null` when it is not a
 * product page: a replacement page, an empty body, a refusal, a search page.
 *
 * 🔑 Every UPC the page states for its own item is published — the first as
 * `barcode`, the rest as `additionalBarcodes` — and a kit's component UPCs are
 * never among them.
 */
export function parseProductPage(html: string): ParsedProduct | null {
  const page = pageItem(html);
  if (page === null) return null;
  return {
    // Verbatim, as published; `gtinCore` reconciles widths at compare time.
    barcode: page.upcs[0] ?? null,
    additionalBarcodes: page.upcs.slice(1),
    // The page that proves the pairing is the freshest statement of the
    // price; `null` where B&H withholds it or no longer sells the item.
    priceCents: page.priceCents,
    inStock: page.inStock,
    title: page.title,
    sellerName: SELLER,
    // 🔑 `true`, not `null`: B&H has no marketplace (see `SELLER`), so the
    // page that names B&H as the seller states that the offer is its own.
    isFirstParty: true,
    // A discontinued item's page says why it publishes no barcode.
    unverifiableReason:
      page.upcs.length === 0 && page.discontinued ? DISCONTINUED_NO_UPC : null,
    category: page.category,
  };
}

/**
 * Why a B&H listing publishes no barcode, where its page says.
 *
 * 🔑 **Jody's rule, applied by the lead on 2026-11-10: a candidate without a
 * barcode match goes to a person.** Of 39 product pages the investigation
 * read, 10 stated no UPC, and 6 of those were items B&H lists as Discontinued
 * — with no current price, and with nothing a barcode could ever be compared
 * against. Such a listing is `unverifiable`, never verified and never "not
 * carried", and this is the reason a reviewer needs beside it.
 *
 * 🔑 **On the wire as the evidence's `unverifiableReason`**, through
 * `parseProductPage`, which states it for exactly the page this function
 * names it for.
 */
export const DISCONTINUED_NO_UPC = "discontinued at B&H, no UPC published";

export function noBarcodeReason(html: string): string | null {
  return parseProductPage(html)?.unverifiableReason ?? null;
}

/** What a listing's own page says, for a read run. */
export function readListingPage(html: string): ListingPageResult {
  const page = pageItem(html);
  if (page === null) {
    return {
      kind: "not-a-product-page",
      detail:
        extractPreloadedData(html) === null
          ? "no preloaded state"
          : "no product item: a search page, or a discontinued item's replacement page",
    };
  }
  // 🔴 A price B&H shows and this build cannot read is markup that moved. A
  // price it WITHHOLDS (MAP) or no longer has (discontinued) is not: it is
  // the page's answer, and it reads as no price rather than a failed reading.
  if (page.priceCents === null && !page.priceWithheld && !page.discontinued) {
    return {
      kind: "unreadable-offer",
      detail: "a price B&H shows could not be read",
    };
  }
  return {
    kind: "page",
    page: {
      pageItemId: page.skuNo,
      barcode: page.upcs[0] ?? (page.hasUpcField ? "" : null),
      additionalBarcodes: page.upcs.slice(1),
      priceCents: page.priceCents,
      inStock: page.inStock,
      category: page.category,
    },
  };
}

/**
 * The response type B&H's app states for a category page. A search page
 * states `/api/navigation/search`.
 */
const CATEGORY_RESPONSE = "/api/navigation/category";
const SEARCH_RESPONSE = "/api/navigation/search";

/**
 * Page `n` of a B&H category: the category's own path, then `/pn/<n>` past
 * the first — the page's own pagination link (fetched for pages 2, 15 and 16
 * of Mice & Touchpads).
 *
 * 🔴 **Only a `/ci/<id>` path on B&H's own host.** Anything else is not a
 * category address, and a walk must not buy it.
 */
export function bhCategoryPageUrl(
  categoryUrl: string,
  n: number,
): string | null {
  if (!Number.isInteger(n) || n < 1) return null;
  let url: URL;
  try {
    url = new URL(categoryUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.host !== "www.bhphotovideo.com") {
    return null;
  }
  const path = url.pathname.replace(/\/pn\/\d+\/?$/, "").replace(/\/$/, "");
  if (!/\/ci\/\d+(?:\/|$)/.test(path)) return null;
  return `${BH_ORIGIN}${path}${n === 1 ? "" : `/pn/${n}`}${url.search}`;
}

/** A category card: the listing's id, the price B&H shows, its stock. */
function toCategoryCard(item: Json): CategoryCard | null {
  const itemId = idAt(obj(item, "itemKey"), "skuNo");
  if (itemId === null) return null;
  // 🔑 The same rules as a search card's, so a category read and a search
  // never disagree about one card: a MAP item's price is withheld (`null`),
  // never the number the state holds beside the flag.
  return { itemId, priceCents: shownPrice(item), inStock: inStockOf(item) };
}

/**
 * One page of a B&H category.
 *
 * ── 🔴 Past the last page B&H answers with a SEARCH ────────────────────
 * Measured on Mice & Touchpads (412 products, 28 a page, 15 pages): page 16
 * does not come back empty. B&H answers with a search for the url's slug —
 * 115 unrelated results, `responseType` `/api/navigation/search`. So a search
 * payload, or a category payload naming a different page than the one asked
 * for, is the END of the category past page 1.
 *
 * ⚠️ **On page 1 the same answer is a failure, not an empty category.** A
 * category B&H no longer has would answer its first page the same way, and
 * reading that as "the category lists nothing" would file every watched
 * listing in it as no longer listed.
 *
 * Everything else that is not a category payload — an empty body, a refusal,
 * a product page — is `not-a-category-page`.
 */
export function readCategoryPage(html: string, n: number): CategoryPageResult {
  const pre = extractPreloadedData(html);
  if (pre === null) {
    return { kind: "not-a-category-page", detail: "no preloaded state" };
  }
  const data = obj(
    obj(obj(obj(pre, "ListingStore"), "state"), "response"),
    "data",
  );
  if (data === null) {
    return {
      kind: "not-a-category-page",
      detail: "no listing payload: a product page, or not a listing at all",
    };
  }
  const type = strAt(data, "responseType");
  const pageNumber = data["pageNumber"];
  // A category payload that does not say which page it is, is the one asked.
  const samePage = typeof pageNumber !== "number" || pageNumber === n;
  if (type === SEARCH_RESPONSE || (type === CATEGORY_RESPONSE && !samePage)) {
    const what =
      type === SEARCH_RESPONSE
        ? "B&H answered with a search"
        : `B&H answered with page ${String(pageNumber)}`;
    return n > 1
      ? { kind: "end", detail: `${what}, past the category's last page` }
      : { kind: "not-a-category-page", detail: `${what} for page 1` };
  }
  if (type !== CATEGORY_RESPONSE) {
    return {
      kind: "not-a-category-page",
      detail: `a listing of type ${type ?? "unknown"}, not a category`,
    };
  }

  const items = arr(data, "items");
  if (items.length === 0) {
    return { kind: "end", detail: "the category page lists no products" };
  }
  const products: CategoryCard[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isObj(item)) continue;
    const card = toCategoryCard(item);
    if (card === null || seen.has(card.itemId)) continue;
    seen.add(card.itemId);
    products.push(card);
  }
  // 🔴 Products and not one readable: the markup moved under us. Reading that
  // as a page of nothing would end the walk on a parse.
  if (products.length === 0) {
    return {
      kind: "not-a-category-page",
      detail: "a category page whose products could not be read",
    };
  }
  const count = data["count"];
  const perPage = data["itemsPerPage"];
  const total =
    typeof count === "number" && Number.isInteger(count) && count >= 0
      ? count
      : null;
  const lastPage =
    total !== null &&
    typeof perPage === "number" &&
    Number.isInteger(perPage) &&
    perPage > 0
      ? Math.max(1, Math.ceil(total / perPage))
      : null;
  return { kind: "page", page: { products, total, lastPage } };
}

export const bhCategoryReader: CategoryReader = {
  pageUrl: bhCategoryPageUrl,
  readCategoryPage,
};

/**
 * 🔑 **B&H answers a barcode search**, measured on the 20-row sample: a
 * 12-digit UPC returned exactly the item for all 8 verified rows, whose
 * product page stated that UPC (8 of 8), and an explicit no-results page for
 * the other 12. No digit limit is known.
 *
 * 🔴 **A part number needs the brand.** The MFR # is exact, and the product is
 * often another brand's: "29538" is a C2G cable, "10174" an Aquatech housing,
 * "63005" a SIG SAUER scope, "30206" an Aquatica port — each the MFR # of a
 * row the investigation found B&H does not carry. And B&H's search requires
 * every word, so the client's brand spelling narrows an exact part number to
 * nothing or to a partial match: brand-scoped queries found none of the items
 * in 9 asked, where the bare MFR # found all 11 B&H carries.
 *
 * ⚠️ **Where the item's brand is unknown, the brand half of that rule cannot
 * run, and is left so deliberately** (review finding 12, the lead). Nothing
 * refutes a listing's brand, so a listing with the item's part number is a
 * candidate whatever brand it is — the C2G cable under Allsop's "29538"
 * included. It is still never verified without a barcode that agrees (Jody's
 * rule: never verify without the competitor's own barcode), so the worst it
 * becomes is a proposal: `unconfirmed` where its page's UPC disagrees,
 * `unverifiable` where it states none — and either goes to a person (Jody's
 * rule: a candidate without a barcode match goes to a person), never filed as
 * a match. Pinned in `part-number-needs-brand.spec.ts`.
 */
const QUERY_SUPPORT: QuerySupport = {
  maxNumericQueryDigits: null,
  barcodeIsSearchable: true,
  partNumberNeedsBrand: true,
};

export const bhAdapter: RetailerAdapter & ListingReader & CategoryReading = {
  slug: "bh",
  querySupport: QUERY_SUPPORT,
  // Jody's politeness rule of two to four pages at once, at its top: the
  // registry's figure arrives with the job and wins over this.
  pacing: { pagesAtOnce: 4 },
  // B&H answered in seconds and only 1 attempt in 120 failed; 150 s per
  // attempt, as Best Buy, is generous rather than tight.
  fetchProfile: { country: "us", timeoutMs: 150_000 },
  // The investigation probed at most three product pages per row.
  maxProbes: 3,
  // It answers a search, so its candidates come from searching.
  productIndex: null,
  buildSearchUrl: (query) =>
    `${BH_ORIGIN}/c/search?q=${encodeURIComponent(query)}`,
  parseSearchResults,
  parseProductPage,
  hosts: ["www.bhphotovideo.com"],
  readListingPage,
  categoryReader: bhCategoryReader,
};
