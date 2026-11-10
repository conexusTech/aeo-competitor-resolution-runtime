import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { amazonAdapter } from "../src/adapters/amazon.js";
import { neweggAdapter } from "../src/adapters/newegg.js";
import type {
  ParsedCandidate,
  ParsedProduct,
  RetailerAdapter,
} from "../src/adapters/types.js";
import type { Fetcher, FetchResult } from "../src/fetcher/types.js";
import { GatewayClient } from "../src/gateway/client.js";
import {
  createProbeMemory,
  DEFAULT_OPTIONS,
  resolveItem,
  type Resolution,
} from "../src/resolve.js";

/**
 * The price comes from the page that proved the pairing.
 *
 * 🔑 **Evidence takes the product page's price and stock where it states them,
 * the search result's otherwise.** The page is the fresher of the two, and for
 * a competitor whose search shows no price it is the only one. A listing whose
 * stock neither states is `null` — unknown, stored by the gateway as
 * `unknown` — never guessed in stock or out.
 *
 * ⚠️ **Newegg and Amazon are unchanged**, because neither page parse states a
 * price or stock: proved below over every product page committed for them.
 */

const BARCODE = "812348010548";

const card = (over: Partial<ParsedCandidate> = {}): ParsedCandidate => ({
  itemId: "A",
  url: "https://r.test/p/A",
  model: "CF-08LB",
  title: "Kingwin CF-08LB 80mm Fan",
  brand: "Kingwin",
  priceCents: 899,
  inStock: true,
  isFirstParty: true,
  sellerName: null,
  imageUrl: null,
  ...over,
});

const page = (over: Partial<ParsedProduct> = {}): ParsedProduct => ({
  barcode: BARCODE,
  additionalBarcodes: [],
  priceCents: null,
  inStock: null,
  title: null,
  sellerName: null,
  ...over,
});

function retailer(
  found: ParsedCandidate,
  product: ParsedProduct,
): RetailerAdapter {
  return {
    slug: "fake",
    querySupport: {
      maxNumericQueryDigits: null,
      barcodeIsSearchable: true,
      partNumberNeedsBrand: false,
    },
    pacing: { pagesAtOnce: 3 },
    fetchProfile: { country: null, timeoutMs: null },
    maxProbes: null,
    buildSearchUrl: (q) => `https://r.test/s?q=${encodeURIComponent(q)}`,
    parseSearchResults: () => [found],
    parseProductPage: () => product,
  };
}

class AnyPage implements Fetcher {
  liveRequestCount = 0;
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  fetch(url: string): Promise<FetchResult> {
    this.liveRequestCount++;
    // The search engine names the part number, so identity has one to rank on.
    const body = url.includes("google.com")
      ? `<h3>Kingwin CF-08LB Fan</h3><h3>Kingwin CF-08LB 80mm</h3><p>CF-08LB CF-08LB</p>`
      : "PAGE";
    return Promise.resolve({ url, body, cached: false, attempts: 1 });
  }
}

const resolve = (
  found: ParsedCandidate,
  product: ParsedProduct,
): Promise<Resolution> =>
  resolveItem(
    { barcode: BARCODE, clientSku: "SKU-1" },
    retailer(found, product),
    new AnyPage(),
  );

describe("evidence from the page that proved the pairing", () => {
  it("🔑 takes the page's price and stock over the search result's", async () => {
    const r = await resolve(
      card({ priceCents: 899, inStock: true }),
      page({ priceCents: 1299, inStock: false }),
    );
    expect(r.outcome).toBe("verified");
    expect(r.match?.priceCents).toBe(1299);
    expect(r.match?.inStock).toBe(false);
  });

  it("🔑 names the seller the page names, where the search result names none", async () => {
    // Best Buy's search card names Best Buy's own offers and never a
    // marketplace seller; the product page does.
    const r = await resolve(
      card({ isFirstParty: false, sellerName: null }),
      page({ sellerName: "IPC-STORE" }),
    );
    expect(r.match?.sellerName).toBe("IPC-STORE");
  });

  it("keeps the search result's seller where the page names none", async () => {
    const r = await resolve(card({ sellerName: "Newegg" }), page());
    expect(r.match?.sellerName).toBe("Newegg");
  });

  it("falls back to the search result where the page states neither", async () => {
    const r = await resolve(card({ priceCents: 899, inStock: true }), page());
    expect(r.match?.priceCents).toBe(899);
    expect(r.match?.inStock).toBe(true);
  });

  it("is unknown, not guessed, where neither states the stock", async () => {
    const r = await resolve(
      card({ priceCents: null, inStock: null }),
      page({ priceCents: 9997 }),
    );
    expect(r.match?.priceCents).toBe(9997);
    expect(r.match?.inStock).toBeNull();
  });

  it("an unverifiable listing's price comes from its page too", async () => {
    const r = await resolve(
      card({ priceCents: 899 }),
      page({ barcode: null, priceCents: 1099 }),
    );
    expect(r.outcome).toBe("unverifiable");
    expect(r.match?.priceCents).toBe(1099);
  });

  it("CONTROL: a pairing proven from the run's memory, with no page read, keeps the search result's", async () => {
    const memory = createProbeMemory();
    memory.remember("A", [BARCODE]);
    const r = await resolveItem(
      { barcode: BARCODE, clientSku: "SKU-1" },
      retailer(card({ priceCents: 899 }), page({ priceCents: 1299 })),
      new AnyPage(),
      DEFAULT_OPTIONS,
      memory,
    );
    expect(r.outcome).toBe("verified");
    expect(r.probes).toBe(0);
    expect(r.match?.priceCents).toBe(899);
  });
});

describe("Newegg and Amazon are unchanged", () => {
  const raw = (name: string): string =>
    gunzipSync(
      readFileSync(fileURLToPath(new URL(`./raw/${name}`, import.meta.url))),
    ).toString("utf8");

  const corpus = (): { url: string; body: string }[] => {
    const parsed: unknown = JSON.parse(
      gunzipSync(
        readFileSync(
          fileURLToPath(
            new URL("./corpus/launch-retailer-53.json.gz", import.meta.url),
          ),
        ),
      ).toString("utf8"),
    );
    const entries: unknown =
      parsed !== null && typeof parsed === "object"
        ? Reflect.get(parsed, "entries")
        : [];
    if (!Array.isArray(entries)) return [];
    const list: readonly unknown[] = entries;
    return list.flatMap((e) => {
      const url: unknown =
        e !== null && typeof e === "object" ? Reflect.get(e, "url") : null;
      const body: unknown =
        e !== null && typeof e === "object" ? Reflect.get(e, "body") : null;
      return typeof url === "string" && typeof body === "string"
        ? [{ url, body }]
        : [];
    });
  };

  it("🔴 Newegg's page parse states no price and no stock on any committed product page", () => {
    const pages = corpus().filter((e) => e.url.includes("newegg.com/p/"));
    const fixtures = readdirSync(
      fileURLToPath(new URL("./raw/", import.meta.url)),
    ).filter((n) => n.startsWith("pdp-"));
    // Not vacuous: there are real pages here, and each parsed to a page.
    expect(pages.length + fixtures.length).toBeGreaterThan(50);
    for (const body of [...pages.map((p) => p.body), ...fixtures.map(raw)]) {
      const parsed = neweggAdapter.parseProductPage(body);
      expect(parsed).not.toBeNull();
      expect(parsed?.priceCents).toBeNull();
      expect(parsed?.inStock).toBeNull();
      expect(parsed?.sellerName).toBeNull();
    }
  });

  it("🔴 Amazon's page parse states no price and no stock on its committed product page", () => {
    const parsed = amazonAdapter.parseProductPage(
      raw("amazon-pdp-gtin-labelled.html.gz"),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.barcode).not.toBeNull();
    expect(parsed?.priceCents).toBeNull();
    expect(parsed?.inStock).toBeNull();
    expect(parsed?.sellerName).toBeNull();
  });
});

describe("an unknown stock on the wire", () => {
  it("is sent as null, not dropped and not false", async () => {
    const bodies: string[] = [];
    const client = new GatewayClient(
      { baseUrl: "https://gw.test", user: "u", password: "p" },
      { runId: "r", tenantId: "t", organizationId: "o" },
      {
        fetch: (_input, init) => {
          bodies.push(typeof init?.body === "string" ? init.body : "");
          return Promise.resolve(new Response("{}", { status: 200 }));
        },
        sleep: () => Promise.resolve(),
        log: () => {},
      },
    );
    const r = await resolve(card({ inStock: null }), page());
    await client.reportResolutions([r], 2, 2);

    expect(r.match?.inStock).toBeNull();
    expect(bodies[0]).toContain(`"inStock":null`);
  });
});
