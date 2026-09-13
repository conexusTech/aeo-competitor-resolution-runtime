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
 */
export function parseSearchResults(html: string): ParsedCandidate[] {
  const state = extractInitialState(html);
  const products = state?.Products;
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
  };
}

export const neweggAdapter: RetailerAdapter = {
  slug: "newegg",
  querySupport: QUERY_SUPPORT,
  buildSearchUrl: (query) =>
    `https://www.newegg.com/p/pl?d=${encodeURIComponent(query)}`,
  parseSearchResults,
  parseProductPage,
};
