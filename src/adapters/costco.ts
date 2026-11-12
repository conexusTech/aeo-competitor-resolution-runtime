import type {
  BarcodePrice,
  CategoryReading,
  ListingPageResult,
  ListingReader,
  ParsedCandidate,
  ParsedProduct,
  ProductIndex,
  ProductIndexEntry,
  ProductIndexQuery,
  QuerySupport,
  RetailerAdapter,
} from "./types.js";
import { ldJsonBlocks } from "../ld-json.js";

/**
 * The Costco adapter, read through Costco's public website only, signed out.
 *
 * ── 🔴 Costco cannot be searched ─────────────────────────────────────
 *
 * Its search (`/s?keyword=…`) and category pages arrive as the Next.js search
 * app's client-rendered shell: the results come from Costco's catalogue API,
 * which only a browser calls. Measured by the investigation on 40 of 40
 * searches — by barcode and by part number — and on 10 of 10 listing pages:
 * 0 products, a search for an item Costco sells looking exactly like a search
 * for nonsense. So this adapter never searches. Its candidates come from
 * Costco's PRODUCT SITEMAP, the only server-side list of what it sells online
 * (about 18,180 products), and the product page proves a pairing by barcode.
 *
 * 🔴 **Never Costco's internal catalogue API** (`gdx-api.costco.com`): it is
 * not the website, and reaching it needs a custom header the website's own
 * browser code sends. Website pages only.
 *
 * ── The product page ─────────────────────────────────────────────────
 *
 * Server-rendered. The data is in the React Server Components flight data —
 * every `self.__next_f.push([1,"…"])` chunk, JSON-string-decoded and
 * concatenated — as one `productDetailsData` object: `productData` (the
 * product: `id` = the url's product id, `upc`), `productData.childCatalogData`
 * (the sellable items: Costco's item number, each item's `upc`, its
 * member-only and price-in-cart flags), and `priceInfo` (the SELECTED item's
 * price). Plus a JSON-LD `Product`.
 *
 * ⚠️ **The parent product's `upc` is often Costco's own number** — `4000001`
 * and the item number, or `49999…` — while the real barcode is on the item.
 * Those are never published as a barcode, so they can never verify.
 *
 * ⚠️ **JSON-LD `availability` is not a stock signal**: it read `OutOfStock`
 * on in-stock items (inventory loads in the browser). Stock is unknown.
 *
 * ⚠️ **A member-only or price-in-cart item shows "Sign In for Price"** to a
 * signed-out visitor, while its page source still holds a price. That price
 * is Costco's choice not to show, so it is never read (the lead's default).
 *
 * Ported from the investigation's parser (`meriwether-data-scraper`,
 * `RECON-FINDINGS-COSTCO.md`) and held to its data contract, not copied: this
 * one answers the runtime's seam. Pure, and no dependency.
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
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Dollars -> cents. Never 0: a price that reads 0 is not a price. */
const toCents = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : num(v);
  return n !== null && Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

export const COSTCO_ORIGIN = "https://www.costco.com";

/** Costco sells every item itself: no page names another seller. */
const SELLER = "Costco";

// ── Page plumbing ──────────────────────────────────────────────────────

const FLIGHT_CHUNK = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;

/** The flight data, every chunk decoded and joined in page order. */
export function extractFlight(html: string): string {
  const out: string[] = [];
  for (const m of html.matchAll(FLIGHT_CHUNK)) {
    try {
      const decoded: unknown = JSON.parse(`"${m[1] ?? ""}"`);
      if (typeof decoded === "string") out.push(decoded);
    } catch {
      // A chunk that is not a plain JSON string carries nothing read here.
    }
  }
  return out.join("");
}

/**
 * The balanced `{…}` starting at `start`, honouring strings, or `null` when
 * the text ends before it closes.
 */
function balancedObject(text: string, start: number): string | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * The first `productDetailsData` object naming a product, parsed.
 *
 * 🔴 **Each character is scanned once.** A scan resumes where the last one
 * ended — after an object that was read and rejected, never just after its
 * opening — and one that ran to the end of the text unclosed ends the search,
 * since every later opening lies inside it. Resuming after each opening made
 * 20,000 unclosed or nested objects take thirteen seconds.
 */
export function productDetails(html: string): Json | null {
  const flight = extractFlight(html);
  const needle = '"productDetailsData":{';
  for (let from = 0; ;) {
    const at = flight.indexOf(needle, from);
    if (at < 0) return null;
    const start = at + needle.length - 1;
    const raw = balancedObject(flight, start);
    if (raw === null) return null;
    from = start + raw.length;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (strAt(obj(parsed, "productData"), "id") !== null && isObj(parsed)) {
        return parsed;
      }
    } catch {
      // Not this one.
    }
  }
}

/** The page's JSON-LD `Product`, or `null`. */
export function ldProduct(html: string): Json | null {
  // 🔴 Through the shared linear scan: see `ldJsonBlocks`.
  for (const block of ldJsonBlocks(html)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
      if (isObj(node) && node["@type"] === "Product") return node;
    }
  }
  return null;
}

/** Which of Costco's Next.js apps served a page, from its asset paths. */
export function costcoApp(html: string): "search" | "product" | "other" {
  if (/\/consumer-web\/search\/[a-z]+\/catalog-/.test(html)) return "search";
  if (/\/consumer-web\/product\/[a-z]+\/details-/.test(html)) return "product";
  return "other";
}

// ── The product page ───────────────────────────────────────────────────

/**
 * Costco's own numbers in a UPC field, stated on the page and never a
 * manufacturer's barcode:
 * - `4` and one of the page's own item numbers, zero-padded to 13 digits —
 *   `4000001939040` for item 1939040, and `4000002037132` for item 2037132;
 * - a 12-digit `49999…` value, UPC number system 4, which GS1 reserves for a
 *   retailer's in-store use.
 *
 * 🔴 **The investigation's rule was `4000001…` only**, and missed the second
 * form: two of the Logitech pages it probed state `4000002037132` and
 * `4000002094503` beside their real UPCs, and it reported both as UPCs.
 * Neither could have matched a client's barcode, but a reviewer reading them
 * as the listing's barcodes would have been told something false.
 *
 * 🔴 **On a page that states no item numbers, the form alone decides**: a
 * 13-digit `4000001…` or `4000002…` value is Costco's own. With no item to
 * spell, such a value would otherwise be published as the listing's barcode,
 * and read as one that DISAGREES with the client's — a mismatch, where the
 * truth is that the page states none (absent). A real EAN-13 from a GS1
 * Germany prefix (`400…`) is not that form: `4006381333931` stays a barcode.
 */
export function isCostcoInternalUpc(
  upc: string,
  itemNumbers: readonly string[],
): boolean {
  if (/^49999\d{7}$/.test(upc)) return true;
  if (itemNumbers.length === 0 && /^400000[12]\d{6}$/.test(upc)) return true;
  return itemNumbers.some(
    (n) => /^\d+$/.test(n) && upc === `4${n.padStart(12, "0")}`,
  );
}

interface Item {
  readonly itemNumber: string;
  readonly upc: string | null;
  readonly title: string | null;
  readonly membershipRequired: boolean;
  readonly priceInCartOnly: boolean;
}

/** How a signed-out visitor is shown the price. */
type PriceVisibility = "shown" | "member-only" | "in-cart-only" | "none";

interface PageItem {
  readonly productId: string;
  /** Every real UPC the page states for its product: the items' first. */
  readonly upcs: readonly string[];
  readonly visibility: PriceVisibility;
  /**
   * The one price every item shows, or `null`: withheld, absent, or not one
   * price across the product's items.
   */
  readonly priceCents: number | null;
  /** Several items whose prices are not all known to be one price. */
  readonly severalPrices: boolean;
  /**
   * Where `severalPrices`, each of `upcs` with its own item's price, or
   * `null` for the barcode where that price is not shown. Absent otherwise:
   * `priceCents` then answers for every barcode.
   */
  readonly barcodePrices: readonly BarcodePrice[] | null;
  readonly title: string | null;
}

function toItem(v: unknown): Item | null {
  const itemNumber = strAt(v, "id");
  if (itemNumber === null) return null;
  const description = obj(arr(v, "descriptions")[0], "object");
  return {
    itemNumber,
    upc: strAt(v, "upc"),
    title: strAt(description, "shortDescription"),
    membershipRequired: isObj(v) && v["isMembershipReqd"] === true,
    priceInCartOnly: isObj(v) && num(v["dispPriceInCartOnly"]) === 1,
  };
}

/** The product page's own product, or `null` when the body is not one. */
function pageItem(html: string): PageItem | null {
  const details = productDetails(html);
  const product = obj(details, "productData");
  const productId = strAt(product, "id");
  if (details === null || product === null || productId === null) return null;

  const items = arr(product, "childCatalogData")
    .map(toItem)
    .filter((i): i is Item => i !== null);

  // 🔑 The items' UPCs first: the parent's is often Costco's own number,
  // and where it is real it is one of the items' anyway.
  const itemNumbers = items.map((i) => i.itemNumber);
  const upcs: string[] = [];
  for (const upc of [...items.map((i) => i.upc), strAt(product, "upc")]) {
    if (
      upc === null ||
      isCostcoInternalUpc(upc, itemNumbers) ||
      upcs.includes(upc)
    ) {
      continue;
    }
    upcs.push(upc);
  }

  const priceInfo = obj(details, "priceInfo");
  const display = obj(priceInfo, "displayPrice");
  const online = toCents(display?.["onlinePrice"]);
  const discount = toCents(display?.["aggregatedDiscountAmt"]) ?? 0;
  const ld = ldProduct(html);
  const ldOffer = obj(ld, "offers");
  const fromPriceInfo = online !== null && online - discount > 0;
  const source = fromPriceInfo
    ? online - discount
    : toCents(ldOffer?.["price"]);

  const memberOnly =
    items.some((i) => i.membershipRequired) ||
    product["isMembershipReqd"] === true;
  const inCart =
    items.some((i) => i.priceInCartOnly) ||
    num(product["dispPriceInCartOnly"]) === 1;
  const visibility: PriceVisibility =
    source === null
      ? "none"
      : memberOnly
        ? "member-only"
        : inCart
          ? "in-cart-only"
          : "shown";

  // 🔴 **A price only when every item shows the same one.** `priceInfo`
  // prices the SELECTED item; a barcode that matched another item of the
  // same product says nothing about that item's price. Each item's price is
  // known only from `priceInfo` and a JSON-LD offer naming it.
  const known = new Map<string, number>();
  const priced = strAt(priceInfo, "id");
  // 🔴 A JSON-LD price is `priceInfo`'s item's only where the JSON-LD names
  // that item, or names none: one naming another sku prices another item.
  const ldSku = strAt(ld, "sku");
  const sourceIsPriced = fromPriceInfo || ldSku === null || ldSku === priced;
  if (priced !== null && source !== null && sourceIsPriced) {
    known.set(priced, source);
  }
  for (const offer of arr(ld, "offers")) {
    const sku = strAt(offer, "sku");
    const cents = toCents(isObj(offer) ? offer["price"] : null);
    if (sku !== null && cents !== null && !known.has(sku)) {
      known.set(sku, cents);
    }
  }
  const itemPrices = items.map((i) => known.get(i.itemNumber) ?? null);
  const onePrice =
    items.length <= 1
      ? source
      : itemPrices.every((p) => p !== null && p === itemPrices[0])
        ? (itemPrices[0] ?? null)
        : null;

  const severalPrices = visibility === "shown" && onePrice === null;

  // 🔴 **Each barcode its own item's price, never a sibling's.** A barcode
  // only an unpriced item carries — or the parent's, which names no item —
  // has none; one two items carry is priced only where both show one price.
  // Withheld prices never reach here: `severalPrices` needs them shown.
  const priceOf = (upc: string): number | null => {
    const prices = items
      .filter((i) => i.upc === upc)
      .map((i) => known.get(i.itemNumber) ?? null);
    const first = prices[0] ?? null;
    return prices.every((p) => p === first) ? first : null;
  };

  return {
    productId,
    upcs,
    visibility,
    priceCents: visibility === "shown" ? onePrice : null,
    severalPrices,
    barcodePrices: severalPrices
      ? upcs.map((barcode) => ({ barcode, priceCents: priceOf(barcode) }))
      : null,
    title: strAt(ld, "name") ?? items[0]?.title ?? null,
  };
}

/**
 * Raw product-page body -> what resolution reads, or `null` when it is not a
 * product page: the product app with no product in it, a search shell, a
 * refusal, an empty body.
 */
export function parseProductPage(html: string): ParsedProduct | null {
  const page = pageItem(html);
  if (page === null) return null;
  return {
    barcode: page.upcs[0] ?? null,
    additionalBarcodes: page.upcs.slice(1),
    // Withheld (member-only, price in cart) or not one price: `null`.
    priceCents: page.priceCents,
    // 🔑 Not one price: each barcode's own, for the comparison to pick.
    ...(page.barcodePrices === null
      ? {}
      : { barcodePrices: page.barcodePrices }),
    // Costco's page states no stock this build can trust.
    inStock: null,
    title: page.title,
    sellerName: SELLER,
    // 🔑 `true`, not `null`: Costco sells every item itself (see `SELLER`),
    // so its page states that the offer is its own.
    isFirstParty: true,
    // A Costco page says nothing about why it publishes no barcode.
    unverifiableReason: null,
    // Costco has no category reads (see `categoryReader`).
    category: null,
  };
}

/** What a listing's own page says, for a read run. */
export function readListingPage(html: string): ListingPageResult {
  const page = pageItem(html);
  if (page === null) {
    const app = costcoApp(html);
    return {
      kind: "not-a-product-page",
      detail:
        app === "product"
          ? "Costco's product app with no product in it"
          : app === "search"
            ? "Costco's search app: a search or category shell"
            : "not a Costco product page",
    };
  }
  // 🔴 Several items with no barcode to carry each one's price: the shown
  // price cannot be tied to an item, so the offer is unreadable — never a
  // page read with no price.
  if (page.severalPrices && page.upcs.length === 0) {
    return {
      kind: "unreadable-offer",
      detail: "several items, not all at one price this build can read",
    };
  }
  // 🔴 A price Costco WITHHOLDS from a signed-out visitor is the page's
  // answer, not a failed reading: no price, and a page.
  if (page.visibility === "none") {
    return {
      kind: "unreadable-offer",
      detail: "a product page showing no price this build can read",
    };
  }
  return {
    kind: "page",
    page: {
      pageItemId: page.productId,
      barcode: page.upcs[0] ?? null,
      additionalBarcodes: page.upcs.slice(1),
      // Several items not all at one price: `null`, and each barcode's own
      // price below — the read job names no barcode, so the gateway picks.
      priceCents: page.priceCents,
      ...(page.barcodePrices === null
        ? {}
        : { barcodePrices: page.barcodePrices }),
      inStock: null,
      category: null,
    },
  };
}

/**
 * 🔴 Costco answers no search with a result (see the module docblock), so
 * this is `null` for every body — a search nobody answered, never "not
 * carried". Resolution never calls it: Costco has a product index.
 */
export function parseSearchResults(_html: string): ParsedCandidate[] | null {
  return null;
}

// ── The product index: Costco's sitemap ───────────────────────────────

export const SITEMAP_INDEX = `${COSTCO_ORIGIN}/sitemap_lw_index.xml`;

/**
 * One `<loc>`, its text trimmed by the caller.
 *
 * 🔴 **One run of non-`<` characters, nothing either side of it.** The form
 * this replaced, `<loc>\s*([^<]+?)\s*<\/loc>`, let three quantifiers share
 * one run of whitespace: an unclosed `<loc>` of 2,000 spaces took 4 s and of
 * 4,000 took 34 s — a broken or hostile sitemap holding a run forever.
 */
const LOC = /<loc>([^<]*)<\/loc>/g;

const decodeXml = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/**
 * The product files the sitemap index lists, or `null` if it is no index.
 *
 * 🔑 **Only the `/p/-/` product sitemaps** (`sitemap_lw_p_mod_NNN.xml`). The
 * index also lists the same products in Costco's older url form
 * (`sitemap_lw_p_001.xml`) and with images (`sitemap_lw_i_mod_001.xml`) —
 * measured as the same ~18,180 products three times — and reading all of
 * them would buy each product's name three times over.
 */
export function parseSitemapIndex(body: string): string[] | null {
  if (!body.includes("<sitemapindex")) return null;
  const files: string[] = [];
  for (const m of body.matchAll(LOC)) {
    const url = decodeXml((m[1] ?? "").trim());
    if (/^https:\/\/www\.costco\.com\/sitemap_lw_p_mod_\d+\.xml$/.test(url)) {
      files.push(url);
    }
  }
  return files;
}

const PRODUCT_URL = /^https:\/\/www\.costco\.com\/p\/-\/([^/?#]+)\/(\d+)$/;

/** A product sitemap's entries, or `null` if the body is no sitemap. */
export function parseSitemap(body: string): ProductIndexEntry[] | null {
  if (!body.includes("<urlset")) return null;
  const entries: ProductIndexEntry[] = [];
  for (const m of body.matchAll(LOC)) {
    const url = decodeXml((m[1] ?? "").trim());
    const parts = PRODUCT_URL.exec(url);
    if (parts === null) continue;
    let slug: string;
    try {
      slug = decodeURIComponent(parts[1] ?? "");
    } catch {
      slug = parts[1] ?? "";
    }
    entries.push({
      itemId: parts[2] ?? "",
      url,
      name: words(slug).join(" "),
    });
  }
  return entries;
}

/** Lower-case letter-and-digit words. */
const words = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");

/** How many of an index's names use each word, computed once per index. */
interface IndexStats {
  readonly size: number;
  readonly uses: ReadonlyMap<string, number>;
  /** How many of the names BEGIN with each word. */
  readonly leads: ReadonlyMap<string, number>;
}
const STATS = new WeakMap<readonly ProductIndexEntry[], IndexStats>();
function statsOf(entries: readonly ProductIndexEntry[]): IndexStats {
  const known = STATS.get(entries);
  if (known !== undefined) return known;
  const uses = new Map<string, number>();
  const leads = new Map<string, number>();
  for (const e of entries) {
    const own = words(e.name);
    for (const w of new Set(own)) uses.set(w, (uses.get(w) ?? 0) + 1);
    const lead = own[0];
    if (lead !== undefined) leads.set(lead, (leads.get(lead) ?? 0) + 1);
  }
  const stats = { size: entries.length, uses, leads };
  STATS.set(entries, stats);
  return stats;
}

/**
 * Words that name what a product IS, rather than describe it.
 *
 * 🔑 **Measured off the index itself, not a stop list.** A word in more than
 * one name in a hundred is a colour, a size or a feature — "black" is in 286
 * of Costco's 18,180 names, "with" in 2,421, "wireless" in 95, "mouse" in 13,
 * "headset" in 9 — so it is common enough to say nothing about which product
 * this is. A number on its own is a spec, never the product.
 */
const DISTINCTIVE_SHARE = 1 / 100;
/**
 * 🔴 **A product line is a word that leads Costco's names, by either of two
 * tests.**
 *
 * - **Rare** (`LINE_SHARE`): in at most one name in a thousand (18 of 18,180),
 *   anywhere in the client's name. "archer", "galaxy" (18 names, leading 1) and
 *   "ecotank" are lines by this and by nothing else, and master found them.
 * - **Popular** (`LINE_LEAD_SHARE`): distinctive (`DISTINCTIVE_SHARE`, at most
 *   182 names) AND leading at least a quarter of the names it is in, AND one
 *   of the first `LINE_NAME_POSITIONS` words of the client's name once the
 *   brand is set aside. "ipad" leads 43 of its 77 names, "macbook" 29 of 35
 *   and "mac" 25 of 36 (measured 2026-11-12 on the 18,180-entry sitemap
 *   fixture): the rare test dropped every one, so an iPad or MacBook row never
 *   reached its page and ended "not carried".
 *
 * The lead share separates a line from a feature: "memory" is in 171 names and
 * leads 1 (0.01), "black" 10 of 286, "smart" 6 of 456. "true" is the case no
 * count settles — it is in 39 names (over the rare test's 18) and leads 20
 * (0.51), as a line does — so what keeps it out is where it stands in the
 * CLIENT'S name: "Apple AirPods 4 … True Wireless" opens with "airpods", never
 * "true".
 */
const LINE_SHARE = 1 / 1000;
const LINE_LEAD_SHARE = 1 / 4;
/** A popular line is one of the first two words of the client's name after its brand. */
const LINE_NAME_POSITIONS = 2;

/** Equal, or the same word in two forms ("cancelling", "cancellation"). */
const sameWord = (a: string, b: string): boolean =>
  a === b ||
  (a.length >= 6 && b.length >= 6 && a.slice(0, 6) === b.slice(0, 6));

/**
 * The sizes a name states, in two kinds: a DISPLAY size ("11-inch", `11"`,
 * "11in", "34 class") and a CAPACITY ("128gb", "1tb"), each once. Other
 * numbers ("10-core", "m5") are not sizes: Costco's long names carry
 * several, and counting them rewards the longest name rather than the right
 * one.
 *
 * 🔑 **Read from the raw text, because a client writes `34"` and `13.6"`**,
 * which `words` strips to a bare number. Costco's slugs drop the decimal point
 * (`8.3` → `83`, `13.6` → `136`), so a display size is kept that way; a
 * decimal also stands as its whole part (`13.6` is sold as "13-inch").
 * "2-in-1" and "4 in 1" are a form factor, never a size in inches.
 *
 * A capacity is kept in gigabytes, so "1tb" and "1000gb" are one size.
 * `memory` holds the capacities the name itself LABELS as memory, by the word
 * right after it ("24gb memory", "16gb ram", "32gb ddr5", "16gb lpddr5x",
 * "24gb unified memory", and on the client's side "16gb of ram"); they are
 * also in `capacity`, which stays the one comparison (see `sizeScore`).
 */
interface Sizes {
  readonly display: ReadonlySet<string>;
  readonly capacity: ReadonlySet<string>;
  readonly memory: ReadonlySet<string>;
}

/** The words that, right after a capacity, label it memory. */
const MEMORY_WORD = /^(?:memory|ram|unified|(?:lp)?ddr\d*x?)$/;

const gigabytes = (n: string, unit: string): string =>
  `${unit.toLowerCase() === "tb" ? Number(n) * 1000 : Number(n)}gb`;

function clientSizes(text: string): Sizes {
  const display = new Set<string>();
  const capacity = new Set<string>();
  const memory = new Set<string>();
  const d =
    /(\d+)(?:\.(\d+))?\s*-?\s*(?:["\u2033\u201d]|inch(?:es)?\b|in\b(?!\s*-?\s*1\b)|class\b)/gi;
  for (const m of text.matchAll(d)) {
    display.add(`${m[1]}${m[2] ?? ""}`);
    if (m[2] !== undefined) display.add(m[1] ?? "");
  }
  for (const m of text.matchAll(/(\d+)\s*-?\s*(gb|tb)\b/gi)) {
    const size = gigabytes(m[1] ?? "", m[2] ?? "");
    capacity.add(size);
    const after = text.slice((m.index ?? 0) + m[0].length).toLowerCase();
    const next = /^[\s-]*(?:of\s+)?([a-z0-9]+)/.exec(after)?.[1];
    if (next !== undefined && MEMORY_WORD.test(next)) memory.add(size);
  }
  return { display, capacity, memory };
}

/** The same kinds, from a sitemap name's words ("11 inch", "24gb memory"). */
function entrySizes(ws: readonly string[]): Sizes {
  const display = new Set<string>();
  const capacity = new Set<string>();
  const memory = new Set<string>();
  ws.forEach((w, i) => {
    const cap = /^(\d+)(gb|tb)$/.exec(w);
    if (cap) {
      const size = gigabytes(cap[1] ?? "", cap[2] ?? "");
      capacity.add(size);
      if (MEMORY_WORD.test(ws[i + 1] ?? "")) memory.add(size);
    } else if (
      /^\d+$/.test(w) &&
      (ws[i + 1] === "inch" || ws[i + 1] === "class")
    ) {
      display.add(w);
    }
  });
  return { display, capacity, memory };
}

/**
 * How well an entry's sizes agree with the client's, counted only within a
 * kind the client stated (a kind it left out is neutral, never a demotion):
 * +1 for each size shared, and -8 for each size the entry states that the
 * client did not. 🔑 **A conflict outweighs any run of matches**: the 15-inch
 * MacBook Air at 8GB shares "512gb" and is still the wrong product, and an
 * entry that states no size at all (`ipad-128gb-wi-fi-a16-chip`, for a client
 * asking for an 11-inch iPad at 128GB) is not in conflict with anything.
 *
 * 🔴 **A capacity the entry labels as memory conflicts only with a client
 * that labelled its own.** "Apple MacBook Pro 14\" M5 Pro 1TB SSD" says
 * nothing about memory, and Costco's `…-24gb-memory-1tb-ssd-…` is its
 * product: counting "24gb" against it put that entry 4th, behind entries
 * that state no memory, and Costco reads only the first three. Such a
 * capacity still matches (+1) when the client stated that size. A client that
 * did label its memory ("24GB RAM", "32GB DDR5", "16GB of RAM") is compared
 * as before, every capacity against every capacity — and so is one that
 * named a capacity the entry does not state: "MacBook Air 13.6\" 16GB 512GB
 * SSD" named a size the `…-8gb-memory-512gb-…` entries lack, and their "8gb"
 * stays the conflict that keeps them behind the 16GB model. So, too, is an
 * entry whose name shares nothing with the client's but a capacity
 * (`sharesName`): "Apple iPad 128GB" shares only "128gb" with
 * `apple-macbook-air-133-…-8gb-memory-128gb-ssd`, which is another product,
 * and relaxed it tied the iPad and put it 5th.
 */
function sizeScore(client: Sizes, entry: Sizes, sharesName: boolean): number {
  // The client said nothing about memory: it labelled none, and the entry
  // states every capacity it did name — and is otherwise the same product
  // by name, not merely the same size.
  const silentOnMemory =
    sharesName &&
    client.memory.size === 0 &&
    [...client.capacity].every((w) => entry.capacity.has(w));
  let score = 0;
  for (const kind of ["display", "capacity"] as const) {
    if (client[kind].size === 0) continue;
    for (const w of entry[kind]) {
      if (client[kind].has(w)) score += 1;
      else if (kind === "capacity" && silentOnMemory && entry.memory.has(w)) {
        continue;
      } else score -= 8;
    }
  }
  return score;
}

const compact = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The index entries worth probing for an item, best first.
 *
 * ── 🔑 Which entries are candidates ─────────────────────────────────
 *
 * Costco's product name, as its url spells it, leads with the brand
 * (`cyberpower-900va450w-…`) or, where the brand is not in it, with the
 * product line (`airpods-4-with-active-noise-cancellation` — no "apple").
 * So an entry is a candidate when its name LEADS with the item's brand, or
 * with a product-line word of the client's own name for the item, AND shares
 * at least one more distinctive word with that name (or names one of its
 * part numbers).
 *
 * 🔴 **Leading, never merely containing.** A brand later in a name is a
 * component (Costco has 87 names mentioning AMD, every one a PC or a
 * monitor), and `cyberpowerpc-…` is another company. And a name that only
 * shares a word with the item's is another brand's product: H390 headset and
 * AirPods share "noise cancellation".
 *
 * 🔴 **The brand is set only where the name led with it** — never read into
 * a name that does not say it.
 *
 * ── Order ────────────────────────────────────────────────────────────
 *
 * A name that spells a part number first, then the one sharing the most of the
 * sizes and capacities the client states ("11" from "11-inch", "128gb" — the
 * numbers `distinctive` ignores, which are exactly what tells an iPad Air
 * 11-inch from the 13-inch), then by how much of the entry's
 * name is the client's: shared distinctive words over all of its distinctive
 * words. `airpods-4-with-active-noise-cancellation` is all AirPods 4 ANC;
 * `apple-airpods-pro-3-…-hearing-aid-feature-…` shares more words and is
 * mostly something else. A url is listed once.
 */
export function indexCandidates(
  entries: readonly ProductIndexEntry[],
  query: ProductIndexQuery,
): ParsedCandidate[] {
  const stats = statsOf(entries);
  const uses = (w: string): number => stats.uses.get(w) ?? 0;
  const distinctive = (w: string): boolean =>
    w.length >= 2 &&
    !/^\d+$/.test(w) &&
    uses(w) <= Math.max(stats.size * DISTINCTIVE_SHARE, 2);
  // Rare: the rule as it was. Popular: it leads names; the caller adds where
  // the word stands in the client's name.
  const isRareLine = (w: string): boolean =>
    distinctive(w) && uses(w) <= Math.max(stats.size * LINE_SHARE, 1);
  const isPopularLine = (w: string): boolean =>
    distinctive(w) && (stats.leads.get(w) ?? 0) >= uses(w) * LINE_LEAD_SHARE;

  const brandWords = words(query.brand ?? "");
  const brandWord = brandWords[0] ?? null;
  const nameWords = [
    ...new Set(words(query.productName ?? "").filter(distinctive)),
  ].filter((w) => w !== brandWord);
  // The words the client's name opens with once the brand is set aside: a
  // product line stands there, a feature ("true wireless") does not.
  const opening = words(query.productName ?? "")
    .filter((w) => !brandWords.includes(w) && !/^\d+$/.test(w))
    .slice(0, LINE_NAME_POSITIONS);
  const sizes = clientSizes(query.productName ?? "");
  const partNumbers = query.partNumbers
    .map(compact)
    .filter((p) => p.length >= 4);

  const scored: {
    entry: ProductIndexEntry;
    byBrand: boolean;
    namesPart: boolean;
    share: number;
    shared: number;
    sizeShared: number;
    order: number;
  }[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, order) => {
    const own = words(entry.name);
    const lead = own[0];
    if (lead === undefined || seen.has(entry.url)) return;
    const byBrand = brandWord !== null && lead === brandWord;
    const byLine =
      !byBrand &&
      nameWords.some((w) => sameWord(w, lead)) &&
      (isRareLine(lead) ||
        (isPopularLine(lead) && opening.some((w) => sameWord(w, lead))));
    if (!byBrand && !byLine) return;

    const rest = [...new Set(own.slice(1).filter(distinctive))].filter(
      (w) => !sameWord(w, lead),
    );
    const shared = rest.filter((w) => nameWords.some((n) => sameWord(n, w)));
    const namesPart = partNumbers.some((p) => compact(entry.name).includes(p));
    if (shared.length === 0 && !namesPart) return;
    seen.add(entry.url);
    scored.push({
      entry,
      byBrand,
      namesPart,
      // The lead counts on both sides: it is the word that matched.
      share: (shared.length + 1) / (rest.length + 1),
      shared: shared.length,
      // A distinctive word beyond the lead, not a capacity ("128gb").
      sizeShared: sizeScore(
        sizes,
        entrySizes(own),
        shared.some((w) => !/^\d+(gb|tb)$/.test(w)),
      ),
      order,
    });
  });

  return scored
    .sort(
      (a, b) =>
        Number(b.namesPart) - Number(a.namesPart) ||
        b.sizeShared - a.sizeShared ||
        b.share - a.share ||
        b.shared - a.shared ||
        a.order - b.order,
    )
    .map(({ entry, byBrand }): ParsedCandidate => ({
      itemId: entry.itemId,
      url: entry.url,
      // The sitemap states no model; the product page is what proves it.
      model: null,
      title: entry.name,
      brand: byBrand ? query.brand : null,
      priceCents: null,
      inStock: null,
      isFirstParty: true,
      sellerName: SELLER,
      imageUrl: null,
      // The index lists products; it answers no query, partially or not.
      partialMatch: false,
    }));
}

/**
 * Costco's product index: the sitemap index robots.txt names, then each
 * product sitemap it lists.
 */
export const COSTCO_PRODUCT_INDEX: ProductIndex = {
  urls: [SITEMAP_INDEX],
  // The real index is 1,547 bytes for 15 files; a 200 shorter than a third
  // of that is a vendor's error document, not the list.
  minListBytes: 500,
  parseListing: parseSitemapIndex,
  // 18,180 products when measured (2026-11-10); a read with fewer than
  // 10,000 is a file cut short, and would make every item it lost look not
  // carried.
  minEntries: 10_000,
  // One `/p/-/` product file when measured (2026-11-10), each about 2 MB:
  // five is room for the catalogue to grow, and a list naming more is not
  // the index this was built against.
  maxFiles: 5,
  parse: parseSitemap,
  candidates: indexCandidates,
};

/**
 * 🔑 **Neither a barcode nor a part number is searchable at Costco**: both
 * return the same empty shell (40 of 40). The index stands in for search.
 */
const QUERY_SUPPORT: QuerySupport = {
  maxNumericQueryDigits: null,
  barcodeIsSearchable: false,
  partNumberNeedsBrand: false,
};

export const costcoAdapter: RetailerAdapter & ListingReader & CategoryReading =
  {
    slug: "costco",
    querySupport: QUERY_SUPPORT,
    // Jody's politeness rule of two to four pages at once, at its top: the
    // registry's figure arrives with the job and wins over this.
    pacing: { pagesAtOnce: 4 },
    // 🔴 Product pages take 60-150 s through the vendor, which waits out a
    // 60-second timer for an element of Costco's previous page design before
    // answering; 280 s per attempt, as the investigation settled on after
    // 150 s timed out.
    fetchProfile: { country: "us", timeoutMs: 280_000 },
    // The investigation probed at most three product pages per row.
    maxProbes: 3,
    productIndex: COSTCO_PRODUCT_INDEX,
    buildSearchUrl: (query) =>
      `${COSTCO_ORIGIN}/s?keyword=${encodeURIComponent(query)}`,
    parseSearchResults,
    parseProductPage,
    hosts: ["www.costco.com"],
    readListingPage,
    // 🔴 **No category reads.** Costco's category pages arrive as the same
    // client-rendered shell as its searches — no product in the body a
    // server-side read can see.
    categoryReader: null,
  };
