import { describe, expect, it } from "vitest";

import type {
  ParsedCandidate,
  ParsedProduct,
  RetailerAdapter,
} from "../src/adapters/types.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchResult,
} from "../src/fetcher/types.js";
import { isOwnHostUrl } from "../src/own-hosts.js";
import { DEFAULT_OPTIONS, resolveItem } from "../src/resolve.js";

/**
 * 🔴 **A page is fetched through a paid proxy only on the competitor's own
 * hosts, by the gateway's own rule** (security finding 5): `https:` only, no
 * userinfo, no port, the exact host — as `isReadableListingUrl` in
 * `aeo-backend` decides which listings may be read at all.
 *
 * A product url comes from a page the competitor controls, and the match's url
 * is persisted globally and rendered as a link, so a url off the retailer's
 * hosts is neither probed nor proposed.
 */

const HOSTS = ["www.retailer.test", "retailer.test"];

describe("isOwnHostUrl", () => {
  it("accepts https on an exact own host", () => {
    expect(isOwnHostUrl("https://www.retailer.test/p/1", HOSTS)).toBe(true);
    expect(isOwnHostUrl("https://retailer.test/p/1?x=1#y", HOSTS)).toBe(true);
    // A url's host is lower-case once parsed.
    expect(isOwnHostUrl("https://WWW.Retailer.TEST/p/1", HOSTS)).toBe(true);
  });

  it("🔴 refuses http, userinfo, a port and a look-alike host", () => {
    for (const raw of [
      "http://www.retailer.test/p/1",
      "https://user@www.retailer.test/p/1",
      "https://user:secret@www.retailer.test/p/1",
      "https://:secret@www.retailer.test/p/1",
      "https://www.retailer.test:8443/p/1",
      "https://www.retailer.test:443.evil.test/p/1",
      "https://www.retailer.test.evil.test/p/1",
      "https://evilretailer.test/p/1",
      "https://shop.retailer.test/p/1",
      "javascript:alert(1)",
      "not a url",
      "",
    ]) {
      expect(isOwnHostUrl(raw, HOSTS), raw).toBe(false);
    }
  });
});

const BARCODE = "812348010548";

const card = (itemId: string, url: string): ParsedCandidate => ({
  itemId,
  url,
  model: "CF-08LB",
  title: "Kingwin CF-08LB 80mm Fan",
  brand: "Kingwin",
  priceCents: 899,
  inStock: true,
  isFirstParty: true,
  sellerName: null,
  imageUrl: null,
  partialMatch: false,
});

const PRODUCT: ParsedProduct = {
  barcode: BARCODE,
  additionalBarcodes: [],
  priceCents: null,
  inStock: null,
  title: null,
  sellerName: null,
  isFirstParty: null,
  unverifiableReason: null,
  category: null,
};

function resolveAmong(found: readonly ParsedCandidate[]) {
  const asked: string[] = [];
  const adapter: RetailerAdapter = {
    slug: "fake",
    querySupport: {
      maxNumericQueryDigits: null,
      barcodeIsSearchable: true,
      partNumberNeedsBrand: false,
    },
    pacing: { pagesAtOnce: 3 },
    fetchProfile: { country: null, timeoutMs: null },
    maxProbes: null,
    productIndex: null,
    hosts: HOSTS,
    buildSearchUrl: (q) =>
      `https://www.retailer.test/s?q=${encodeURIComponent(q)}`,
    parseSearchResults: () => [...found],
    // Every product page proves the pairing: only the host can refuse one.
    parseProductPage: () => PRODUCT,
  };
  const fetcher: Fetcher = {
    liveRequestCount: 0,
    pagesDelivered: 0,
    fetch(url: string): Promise<FetchResult> {
      asked.push(url);
      if (url.startsWith("https://catalogue.test/"))
        return Promise.reject(new FetchFailed(url, undefined, 404, 1));
      return Promise.resolve({ url, body: "PAGE", cached: true, attempts: 0 });
    },
  };
  return {
    asked,
    result: resolveItem(
      { barcode: BARCODE, clientSku: "SKU-1" },
      adapter,
      fetcher,
      {
        ...DEFAULT_OPTIONS,
        clientCatalogueUrlTemplate: "https://catalogue.test/{sku}",
      },
    ),
  };
}

describe("🔴 resolution never probes, or proposes, a listing off the competitor's hosts", () => {
  const foreign = [
    card("A", "http://www.retailer.test/p/A"),
    card("B", "https://user@www.retailer.test/p/B"),
    card("C", "https://www.retailer.test:8443/p/C"),
    card("D", "https://www.retailer.test.evil.test/p/D"),
  ];

  it("none is fetched, and none becomes the match", async () => {
    const { asked, result } = resolveAmong(foreign);
    const r = await result;
    for (const c of foreign) expect(asked, c.url).not.toContain(c.url);
    expect(r.match).toBeNull();
    expect(r.outcome).not.toBe("verified");
    expect(r.alternatives).toEqual([]);
  });

  it("CONTROL: an own-host listing beside them is probed and verifies", async () => {
    const own = card("E", "https://www.retailer.test/p/E");
    const { asked, result } = resolveAmong([...foreign, own]);
    const r = await result;
    expect(r.outcome).toBe("verified");
    expect(r.match?.url).toBe(own.url);
    for (const c of foreign) expect(asked).not.toContain(c.url);
  });
});
