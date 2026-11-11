/**
 * The launch retailer's adapter. Everything site-specific lives here and
 * nothing above this file knows the retailer's name.
 *
 * Listing and search pages embed their whole product set as JSON in a
 * `window.__initialState__ = {…}` script, which is more complete than the
 * rendered cells (those lose slots to ad units). Product pages embed the
 * barcode as `"UPCCode":"…"`.
 *
 * Measured across the 271 captured search pages and 255 product pages, so the
 * shapes below are observed rather than assumed.
 */

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
import { safeImageUrl } from "./types.js";

const INITIAL_STATE_ANCHOR = "window.__initialState__ =";

/**
 * Warehouse-stocked item ids look like `42-301-682` and are addressed publicly
 * as `N82E16842301682`; marketplace ids are already public and pass through.
 */
const WAREHOUSE_ITEM_ID = /^\d{2}-\d{3}-\d{3}$/;
const PUBLIC_ID_PREFIX = "N82E168";

const BARCODE_FIELD = /"UPCCode":"([^"]*)"/;

/**
 * Measured by probing with a control: a model number returns results, a real
 * 7-digit numeric model returns results, `123456789` returns an empty results
 * page, and `1234567890` and every barcode form return the error page.
 *
 * 🔑 So the constraint is **a digit count, not "numeric"** — and a 9-digit
 * numeric part number IS searchable. Reading it as "refuse numeric queries"
 * would refuse `2960703`, a real model number that resolved one of the 22
 * verified rows.
 */
const QUERY_SUPPORT: QuerySupport = {
  maxNumericQueryDigits: 9,
  barcodeIsSearchable: false,
  partNumberNeedsBrand: false,
};

interface InitialState {
  readonly Products?: unknown;
}

/** The embedded state, or `null` when the page carries none we can read. */
export function extractInitialState(html: string): InitialState | null {
  const start = html.indexOf(INITIAL_STATE_ANCHOR);
  if (start < 0) return null;
  const end = html.indexOf("</script>", start);
  if (end < 0) return null;
  const json = html
    .slice(start + INITIAL_STATE_ANCHOR.length, end)
    .trim()
    .replace(/;$/, "");
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function toPublicItemId(itemId: string): string {
  return WAREHOUSE_ITEM_ID.test(itemId)
    ? `${PUBLIC_ID_PREFIX}${itemId.replace(/-/g, "")}`
    : itemId;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Candidates from a search page. `[]` for a page with no results — which is the
 * **majority case**: 156 of 271 captured search pages carry the embedded state
 * and no `Products` array at all. Treating that as a parse failure would turn
 * the retailer's ordinary "nothing matched" into an error on 58% of searches.
 *
 * 🔴 **`null` only when the page carries no embedded state at all** — a block
 * page, an error page, a truncated body. Every one of the 211 search pages in
 * the committed 53-row corpus carries the state, so this changes no measured
 * outcome; what it changes is that a page that is not a results page can no
 * longer be read as "the retailer does not carry this".
 */
export function parseSearchResults(html: string): ParsedCandidate[] | null {
  const state = extractInitialState(html);
  if (state === null) return null;
  const products = state.Products;
  if (!Array.isArray(products)) return [];

  const out: ParsedCandidate[] = [];
  const seen = new Set<string>();

  for (const entry of products) {
    const product = asRecord(entry);
    if (product === null) continue;
    // A combo bundle is not a single product, so its barcode is nobody's.
    if (product["IsCombo"] === true) continue;

    const cell = asRecord(product["ItemCell"]);
    if (cell === null) continue;
    const rawId = str(cell["Item"]);
    if (rawId === null) continue;

    // 1,606 of 1,992 observed listings carry a ParentItem, and it is the
    // canonical product — an offer's own id addresses the offer, not the item.
    const canonical = str(cell["ParentItem"]) ?? rawId;
    const itemId = toPublicItemId(canonical);
    if (seen.has(itemId)) continue;
    seen.add(itemId);

    const description = asRecord(cell["Description"]);
    const urlKeywords =
      description === null ? null : str(description["UrlKeywords"]);
    const seller = asRecord(cell["Seller"]);
    const sellerName = seller === null ? null : str(seller["SellerName"]);
    const manufactory = asRecord(cell["ItemManufactory"]);

    /**
     * The product thumbnail.
     *
     * 🔑 **Newegg publishes a FILENAME, not a URL** — `"ImageName":
     * "26-197-401-10.jpg"` — so the CDN prefix is ours to supply. `nb300`
     * is the 300px box; the same file exists at other sizes under sibling
     * prefixes, and a list row wants the small one.
     *
     * ⚠️ Built rather than trusted: the filename is scraped, so it goes
     * through the same guard as a scraped absolute URL, and a name carrying a
     * slash or a scheme cannot smuggle a different host past the prefix.
     */
    const newImage = asRecord(cell["NewImage"]);
    const imageName = newImage === null ? null : str(newImage["ImageName"]);
    const imageUrl =
      imageName === null || /[\\/:?#]/.test(imageName)
        ? null
        : safeImageUrl(
            `https://c1.neweggimages.com/productimage/nb300/${imageName}`,
          );

    out.push({
      itemId,
      imageUrl,
      // Newegg marks no result as a partial answer.
      partialMatch: false,
      url:
        urlKeywords === null
          ? `https://www.newegg.com/p/${itemId}`
          : `https://www.newegg.com/${urlKeywords}/p/${itemId}`,
      model: str(cell["Model"]),
      title: (description === null ? null : str(description["Title"])) ?? "",
      brand: manufactory === null ? null : str(manufactory["Manufactory"]),
      priceCents:
        typeof cell["FinalPrice"] === "number"
          ? Math.round(cell["FinalPrice"] * 100)
          : null,
      inStock: cell["Instock"] === true,
      // 🔴 Decided on the SELLER field, not on the item-id shape, and that is a
      // correction to the handover rather than a restatement of it. Measured
      // across 1,992 listings, the two signals disagree on **358 (18%)**:
      //
      //   warehouse id + no seller   288   first-party
      //   warehouse id + a seller    260   <- the disagreement
      //   other id     + a seller  1,346   marketplace
      //   other id     + no seller    98   <- and the other half of it
      //
      // The spike ranked on the id shape alone, which labels those 260 offers
      // first-party. But the ONLY reason ranking cares is whose barcode the
      // page carries — a marketplace listing publishes the seller's barcode,
      // observed on a network-switch offer reporting an unrelated one. Whose
      // barcode it is follows the seller, not where the stock sits. A named
      // third-party seller therefore means not first-party, whatever the id
      // looks like.
      isFirstParty: sellerName === null,
      sellerName,
    });
  }

  return out;
}

/**
 * The fields resolution needs from a product page.
 *
 * 🔴 **An empty barcode is a different answer from an absent one, and from a
 * disagreeing one.** Measured: all 255 captured product pages carry the
 * `UPCCode` key and **91 of them publish it EMPTY — 36% of everything the spike
 * probed.** The spike compared the empty string and got "no match", so "this
 * retailer publishes nothing comparable" and "this retailer names a different
 * product" collapsed into one outcome. They are not the same finding: the first
 * makes an item *unverifiable*, the second is a mismatch. `null` here is what
 * lets the pipeline tell them apart.
 */
export function parseProductPage(html: string): ParsedProduct {
  const match = BARCODE_FIELD.exec(html);
  const raw = match?.[1] ?? null;
  return {
    // Verbatim — the retailer zero-pads inconsistently and normalising here
    // would discard the evidence of what it actually said.
    barcode: raw === null || raw.trim() === "" ? null : raw.trim(),
    additionalBarcodes: [],
    priceCents: null,
    inStock: null,
    title: null,
    sellerName: null,
    // Not read from the page: the search cell's answer stands.
    isFirstParty: null,
    unverifiableReason: null,
    category: breadcrumbCategory(html),
  };
}

/** Named, decimal and hex entities, as Newegg writes them in an attribute. */
function decodeEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    quot: '"',
    amp: "&",
    lt: "<",
    gt: ">",
    apos: "'",
    nbsp: " ",
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
      // Only the entities named above: never a lookup on Object's prototype.
      return Object.hasOwn(named, entity) ? (named[entity] ?? whole) : whole;
    },
  );
}

/**
 * The product page's breadcrumb, as rendered. Bounded, so a page with no
 * closing tag cannot make the match run to the end of a megabyte.
 */
const BREADCRUMBS = /class="breadcrumbs"><ol>([\s\S]{0,8000}?)<\/ol>/;

/**
 * A breadcrumb link to a category: `…/SubCategory/ID-696` or
 * `…/Category/ID-358`, its title the category's name.
 *
 * ⚠️ **A brand-in-category link is not the category.** The crumb after the
 * subcategory is `…/BrandSubCat/ID-1762-696`, "STARTECH" — the same products
 * narrowed to one brand. Its id is two numbers, so `ID-(\d+)"` cannot match it.
 */
const CATEGORY_CRUMB =
  /href="(https:\/\/www\.newegg\.com\/[^"]*\/(?:SubCategory|Category)\/ID-(\d+))"[^>]*title="([^"]*)"/g;

/**
 * The deepest category a product page's breadcrumb names — `TV Mounts &
 * Install Accessories` (`SubCategory/ID-696`) on the 12-digit page — ported
 * from the investigation's `neweggLeafCategory`.
 */
export function breadcrumbCategory(html: string): ListingCategory | null {
  const crumbs = BREADCRUMBS.exec(html)?.[1];
  if (crumbs === undefined) return null;
  let leaf: ListingCategory | null = null;
  for (const link of crumbs.matchAll(CATEGORY_CRUMB)) {
    const url = link[1];
    const id = link[2];
    const name = decodeEntities(link[3] ?? "").trim();
    if (url === undefined || id === undefined || name === "") continue;
    leaf = { id, name, url };
  }
  return leaf;
}

/**
 * What a listing's own page says, for a read run.
 *
 * 🔑 **A product page is recognised by `ItemDetail` in the embedded state.**
 * All four captured product pages carry it, and the three captured search pages
 * carry the same embedded state with no `ItemDetail` at all — so a search page
 * the retailer redirected to, a block page and a body cut short inside the
 * state are all `not-a-product-page`.
 *
 * 🔑 **The page's identity is derived exactly as a search derives a listing's
 * id** — `ParentItem` when there is one, else `Item`, in its public form. A
 * product page can show a marketplace seller's offer: `pdp-barcode-12` shows
 * offer `9SIA6ZPK9U9854` of product `86-949-047`, and a search names that
 * listing `N82E16886949047`. Reporting the offer's own id would make every
 * such reading look like a different product.
 *
 * ⚠️ **The barcode comes from the same field the resolution parse reads**, so
 * a reading and the pairing it is checked against never disagree about which
 * field was meant. It is trimmed, and an empty field stays `""`.
 *
 * Price is `ItemDetail.FinalPrice`, the offered price (the 14-digit page shows
 * 299.99 struck through and offers 199.99), and stock is `ItemDetail.Instock`.
 */
export function readListingPage(html: string): ListingPageResult {
  const state = asRecord(extractInitialState(html));
  const detail = state === null ? null : asRecord(state["ItemDetail"]);
  if (detail === null) {
    return {
      kind: "not-a-product-page",
      detail: "no product detail in the page's embedded state",
    };
  }

  const canonical = str(detail["ParentItem"]) ?? str(detail["Item"]);
  const raw = BARCODE_FIELD.exec(html)?.[1];
  const price = detail["FinalPrice"];
  const priceCents =
    typeof price === "number" && Number.isFinite(price) && price > 0
      ? Math.round(price * 100)
      : null;
  const stock = detail["Instock"];
  const inStock = typeof stock === "boolean" ? stock : null;

  // 🔴 An offer in stock always has a price, and a product page always says
  // something about its offer. Either gap is markup that moved, and filing it
  // as "no price" would be a claim about the retailer made on our own parse.
  if (priceCents === null && inStock !== false) {
    return {
      kind: "unreadable-offer",
      detail:
        inStock === true
          ? "in stock with no readable price"
          : "neither a price nor an availability could be read",
    };
  }

  return {
    kind: "page",
    page: {
      pageItemId: canonical === null ? null : toPublicItemId(canonical),
      barcode: raw === undefined ? null : raw.trim(),
      additionalBarcodes: [],
      priceCents,
      inStock,
      category: breadcrumbCategory(html),
    },
  };
}

/**
 * A listing page's pagination, "Page 1/20", as React renders it — with comment
 * separators between the numbers (`<strong>1<!-- -->/<!-- -->20</strong>`).
 * Present on every subcategory listing captured and absent from a hub page.
 */
const PAGINATION =
  /list-tool-pagination-text">Page(?:<!-- -->)?\s*<strong>(\d+)(?:<!-- -->)?\/(?:<!-- -->)?(\d+)<\/strong>/;

/**
 * Page `n` of a Newegg category: the category's path, then `/Page-<n>` past
 * the first — the form its own canonical link takes for page 2.
 *
 * 🔴 **Only a `SubCategory` or `Category` id path on Newegg's own hosts.**
 */
export function neweggCategoryPageUrl(
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
  if (
    url.protocol !== "https:" ||
    (url.host !== "www.newegg.com" && url.host !== "newegg.com")
  ) {
    return null;
  }
  const path = url.pathname.replace(/\/Page-\d+\/?$/, "").replace(/\/$/, "");
  if (!/\/(?:SubCategory|Category)\/ID-\d+$/.test(path)) return null;
  return `https://www.newegg.com${path}${n === 1 ? "" : `/Page-${n}`}${url.search}`;
}

/**
 * Whether the embedded state is a category listing's: its breadcrumb ends in
 * a store of the catalogue (Desktop Memory is `StoreId` 147). A search page
 * carries the same `Products` and pagination, and its one breadcrumb is the
 * query, `StoreId` -1 — measured on the committed search pages.
 */
function isCategoryState(state: Record<string, unknown>): boolean {
  const crumbs = state["Breadcrumbs"];
  if (!Array.isArray(crumbs)) return false;
  const last = asRecord(crumbs[crumbs.length - 1]);
  const store = last === null ? null : last["StoreId"];
  return typeof store === "number" && Number.isInteger(store) && store > 0;
}

/**
 * One page of a Newegg category, read off the embedded state — 36 products a
 * page, measured on Desktop Memory and Laptop Memory.
 *
 * 🔑 **A card's id is derived exactly as a search derives a listing's** —
 * `ParentItem` when there is one, else `Item`, in its public form — so a card
 * finds the listing the platform already watches. A combo is skipped, as a
 * search skips it: it is not a single product.
 *
 * ⚠️ **The end of a category is read off the page's own "Page k/M".** A page
 * past M has not been captured, so what Newegg serves there is unmeasured;
 * whatever it serves, a body saying it is page k of M, for a page n past M,
 * is the end. A body naming another page within M is a failure.
 */
export function readCategoryPage(html: string, n: number): CategoryPageResult {
  const state = asRecord(extractInitialState(html));
  if (state === null) {
    return { kind: "not-a-category-page", detail: "no embedded state" };
  }
  if (asRecord(state["ItemDetail"]) !== null) {
    return { kind: "not-a-category-page", detail: "a product page" };
  }
  const pagination = PAGINATION.exec(html);
  if (pagination === null) {
    return {
      kind: "not-a-category-page",
      detail: "no listing pagination: a hub page, or not a listing at all",
    };
  }
  if (!isCategoryState(state)) {
    return {
      kind: "not-a-category-page",
      detail: "a search results page, not a category",
    };
  }
  const shown = Number(pagination[1]);
  const lastPage = Number(pagination[2]);
  if (shown !== n) {
    return n > lastPage
      ? { kind: "end", detail: `page ${n} is past the last page, ${lastPage}` }
      : {
          kind: "not-a-category-page",
          detail: `Newegg served page ${shown} when page ${n} was asked`,
        };
  }

  const raw = state["Products"];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { kind: "end", detail: "the category page lists no products" };
  }
  const products: CategoryCard[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const product = asRecord(entry);
    if (product === null || product["IsCombo"] === true) continue;
    const cell = asRecord(product["ItemCell"]);
    if (cell === null) continue;
    const rawId = str(cell["Item"]);
    if (rawId === null) continue;
    const itemId = toPublicItemId(str(cell["ParentItem"]) ?? rawId);
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    const price = cell["FinalPrice"];
    const stock = cell["Instock"];
    products.push({
      itemId,
      // 🔴 Never 0: a card whose price reads 0 shows no price.
      priceCents:
        typeof price === "number" && Number.isFinite(price) && price > 0
          ? Math.round(price * 100)
          : null,
      inStock: typeof stock === "boolean" ? stock : null,
    });
  }
  // 🔴 Products and not one readable: the markup moved under us.
  if (products.length === 0) {
    return {
      kind: "not-a-category-page",
      detail: "a category page whose products could not be read",
    };
  }
  const count = state["TotalItemCount"];
  return {
    kind: "page",
    page: {
      products,
      total:
        typeof count === "number" && Number.isInteger(count) && count >= 0
          ? count
          : null,
      lastPage,
    },
  };
}

export const neweggCategoryReader: CategoryReader = {
  pageUrl: neweggCategoryPageUrl,
  readCategoryPage,
};

export const neweggAdapter: RetailerAdapter & ListingReader & CategoryReading =
  {
    slug: "newegg",
    querySupport: QUERY_SUPPORT,
    // Three, as before the registry carried a figure (the lead, 2026-11-10).
    pacing: { pagesAtOnce: 3 },
    // The vendor's defaults: no country, no client timeout — as before profiles
    // existed, so the request body is byte for byte what it was.
    fetchProfile: { country: null, timeoutMs: null },
    // The run's default, as before the limit was per competitor.
    maxProbes: null,
    // It answers a search, so its candidates come from searching.
    productIndex: null,
    buildSearchUrl: (query) =>
      `https://www.newegg.com/p/pl?d=${encodeURIComponent(query)}`,
    parseSearchResults,
    parseProductPage,
    hosts: ["newegg.com", "www.newegg.com"],
    readListingPage,
    categoryReader: neweggCategoryReader,
  };
