/**
 * Identity read from a page's own structured data — `schema.org/Product` in a
 * JSON-LD block.
 *
 * 🔑 **This is a standards reader, not a scraper for one client, and that is the
 * whole reason it is the primary identity source.** Measured: **7 of 7** captured
 * client product pages publish a `@type: Product` JSON-LD node carrying `sku`,
 * `mpn` and `brand`. A client publishing structured data therefore needs **no
 * code here at all** — only a URL template in configuration. A client that does
 * not publish it falls through to the next source, which is exactly what the
 * authority order is for.
 *
 * That matters against the exit criterion: reading a standard is configuration,
 * whereas parsing one retailer's bespoke markup would be a customer named in a
 * code path.
 */

import type {
  IdentityInput,
  IdentitySource,
  ProductIdentity,
} from "./types.js";

export const structuredDataIdentitySource: IdentitySource = {
  provenance: "client-catalogue",
  requestCost: 1,
};

const LD_JSON_BLOCK =
  /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** A JSON-LD document may be one node, an array of nodes, or a `@graph`. */
function flattenNodes(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed.flatMap(flattenNodes);
  if (parsed !== null && typeof parsed === "object") {
    const graph = (parsed as { "@graph"?: unknown })["@graph"];
    if (Array.isArray(graph)) return [parsed, ...graph.flatMap(flattenNodes)];
    return [parsed];
  }
  return [];
}

function isProduct(node: unknown): node is Record<string, unknown> {
  if (node === null || typeof node !== "object") return false;
  const type = (node as { "@type"?: unknown })["@type"];
  const types = Array.isArray(type) ? type : [type];
  return types.some(
    (t) => typeof t === "string" && t.toLowerCase() === "product",
  );
}

/** A string field, trimmed, or `null` — never the empty string. */
function str(node: Record<string, unknown>, key: string): string | null {
  const value = node[key];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * `brand` is a `Brand` object in the wild ({"@type":"Brand","name":"Allsop"}),
 * and a bare string in the specification's simpler form. Both are valid, and
 * only reading one of them is how a reader works on one site and silently
 * returns nothing on the next.
 */
function brandOf(node: Record<string, unknown>): string | null {
  const brand = node["brand"];
  if (typeof brand === "string" && brand.trim() !== "") return brand.trim();
  if (brand !== null && typeof brand === "object") {
    const name = (brand as { name?: unknown }).name;
    if (typeof name === "string" && name.trim() !== "") return name.trim();
  }
  return null;
}

/** Every `schema.org/Product` node in a page, in document order. */
export function productNodes(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const match of html.matchAll(LD_JSON_BLOCK)) {
    const raw = match[1];
    if (raw === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      // A malformed block is one publisher's mistake, not a reason to abandon
      // the page — a second, valid block may carry the product.
      continue;
    }
    for (const node of flattenNodes(parsed)) {
      if (isProduct(node)) out.push(node);
    }
  }
  return out;
}

/**
 * SKUs are compared on their digit core, because the page and the client's own
 * file disagree about zero padding: the captured pages publish `82081` where
 * the client's row says `082081`. Comparing verbatim would reject the right
 * product on every zero-padded SKU.
 */
function skuMatches(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/^0+/, "").toLowerCase();
  const na = norm(a);
  return na !== "" && na === norm(b);
}

/**
 * Read identity from the client's own product page.
 *
 * 🔴 **Refuses to answer unless a Product node's `sku` matches the SKU asked
 * for.** A catalogue URL built from a template can land on a search page, a
 * "similar products" page, a redirect to a replacement item, or a soft 404 that
 * still returns 200 with *some* product's structured data on it. Reading that
 * page's part number would attach a confidently wrong identity to the row —
 * and a wrong identity produces a wrong *match*, which is indistinguishable
 * from a real one downstream. Returning `null` costs a fallback; guessing costs
 * a false pairing.
 */
export function identityFromStructuredData(
  input: IdentityInput,
): Omit<ProductIdentity, "provenance" | "corroboratedBy"> | null {
  if (input.document === undefined) return null;

  const nodes = productNodes(input.document);
  if (nodes.length === 0) return null;

  const node =
    nodes.find((n) => {
      const sku = str(n, "sku");
      return sku !== null && skuMatches(sku, input.clientSku);
    }) ?? null;

  if (node === null) return null;

  const partNumber = str(node, "mpn") ?? str(node, "productID");
  const brand = brandOf(node);
  const title = str(node, "name");

  // A node that identifies the right product but names nothing useful is not an
  // identity — say so, so the next source is consulted.
  if (partNumber === null && brand === null && title === null) return null;

  return { partNumber, brand, title };
}
