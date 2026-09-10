import { describe, expect, it } from "vitest";

import { identityFromStructuredData } from "../src/identity/from-structured-data.js";
import { manufacturerItemRef } from "../src/identity/from-barcode.js";
import fixture from "./fixtures/client-catalogue-products.json" with { type: "json" };

/**
 * The reader, against **real** structured data.
 *
 * Its own spec uses fixtures I wrote, which can only prove the reader agrees
 * with my idea of the standard. These seven Product nodes came off real client
 * catalogue pages — real key sets, real brand-object shape, real unpadded SKUs,
 * real alphanumeric and numeric part numbers — with only URLs and the client's
 * name replaced.
 *
 * 🔑 **This fixture is committed on purpose.** The raw captures are 160 MB in one
 * Downloads folder on one machine, and this workspace has already learned what
 * that costs: `commit-eap-parity-fixtures` was a row filed because a test's
 * inputs lived on a single machine, so the test only ran there. A distilled,
 * committed corpus is the fix.
 */

interface FixtureProduct {
  readonly clientSku: string;
  readonly barcode: string;
  readonly expected: { readonly partNumber: string; readonly brand: string };
  readonly product: Record<string, unknown>;
}

const products = fixture.products as unknown as FixtureProduct[];

/** Wrap a real Product node back into the markup a publisher emits it in. */
const asPage = (product: Record<string, unknown>): string =>
  `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(
    product,
  )}</script></head><body></body></html>`;

describe("the standards reader, on real client catalogue pages", () => {
  it("has seven real product nodes to check against", () => {
    // If the fixture is ever emptied, every assertion below would vacuously
    // pass. `it.each` over an empty array runs nothing and reports green.
    expect(products).toHaveLength(7);
  });

  it.each(products)(
    "reads sku $clientSku as $expected.partNumber / $expected.brand",
    ({ clientSku, barcode, expected, product }) => {
      const got = identityFromStructuredData({
        barcode,
        clientSku,
        document: asPage(product),
      });
      expect(got).not.toBeNull();
      expect(got?.partNumber).toBe(expected.partNumber);
      expect(got?.brand).toBe(expected.brand);
      expect(got?.title).toBeTruthy();
    },
  );

  it("reads every one of them — no silent partial success", () => {
    const read = products.filter(
      (p) =>
        identityFromStructuredData({
          barcode: p.barcode,
          clientSku: p.clientSku,
          document: asPage(p.product),
        })?.partNumber === p.expected.partNumber,
    );
    expect(read).toHaveLength(products.length);
  });

  it("🔴 and the free derivation agrees with only 3 of the 7", () => {
    // The measurement that makes the authority order what it is, asserted
    // against real published part numbers rather than quoted from a note. If
    // this ever became 7 of 7, the barcode source would have earned promotion
    // and the pipeline's ordering should change with it.
    const agreeing = products.filter(
      (p) => manufacturerItemRef(p.barcode) === p.expected.partNumber,
    );
    expect(agreeing).toHaveLength(3);
  });

  it("⚠️ carries no customer-identifying content", () => {
    // The fixture is derived from a real customer's pages. The generator
    // asserts this before writing; asserting it again here is what stops a
    // hand-edit from quietly reintroducing it.
    const raw = JSON.stringify(fixture);
    expect(raw).not.toMatch(/micro\s*cent(er|re)/i);
    const urls = raw.match(/https?:\\?\/\\?\/[^"]+/g) ?? [];
    for (const url of urls) {
      expect(url).toMatch(/client\.example|schema\.org/);
    }
  });
});
