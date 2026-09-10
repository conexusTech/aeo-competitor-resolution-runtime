import { describe, expect, it } from "vitest";

import {
  identityFromStructuredData,
  productNodes,
} from "../src/identity/from-structured-data.js";

/**
 * These fixtures are the **shapes the standard permits**, not one site's
 * markup — which is the point of reading a standard rather than scraping a
 * customer. The key set mirrors what was observed on 7 of 7 real client pages
 * (`@type, @id, name, image, description, brand, sku, mpn, offers,
 * aggregateRating, review`), with neutral values.
 */
const page = (ld: unknown, extra = ""): string =>
  `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
${extra}</head><body>x</body></html>`;

const product = (over: Record<string, unknown> = {}) => ({
  "@type": "Product",
  "@id": "https://example.test/p/1",
  name: "Widget Mousepad XL",
  image: "https://example.test/i/1.jpg",
  description: "A widget.",
  brand: { "@type": "Brand", name: "Acme" },
  sku: "82081",
  mpn: "30184",
  offers: { "@type": "Offer", price: "17.99", priceCurrency: "USD" },
  aggregateRating: { "@type": "AggregateRating", ratingValue: "4.5" },
  ...over,
});

describe("productNodes", () => {
  it("finds a Product in a bare node", () => {
    expect(productNodes(page(product()))).toHaveLength(1);
  });

  it("finds a Product inside an array of nodes", () => {
    expect(
      productNodes(page([{ "@type": "BreadcrumbList" }, product()])),
    ).toHaveLength(1);
  });

  it("finds a Product inside a @graph", () => {
    expect(
      productNodes(
        page({
          "@context": "https://schema.org",
          "@graph": [{ "@type": "WebPage" }, product()],
        }),
      ),
    ).toHaveLength(1);
  });

  it("accepts @type as an array, which the standard permits", () => {
    expect(
      productNodes(
        page(product({ "@type": ["Product", "IndividualProduct"] })),
      ),
    ).toHaveLength(1);
  });

  it("survives a malformed block and still reads a valid one", () => {
    // ⚠️ One publisher's broken block must not abandon the page. A second,
    // valid block may carry the product — and on a real site the broken one is
    // usually an analytics blob nobody tests.
    const html =
      `<script type="application/ld+json">{ this is not json </script>` +
      page(product());
    expect(productNodes(html)).toHaveLength(1);
  });

  it("finds nothing on a page with no structured data", () => {
    expect(productNodes("<html><body>nothing here</body></html>")).toEqual([]);
  });
});

describe("identityFromStructuredData", () => {
  it("reads the part number, brand and title", () => {
    expect(
      identityFromStructuredData({
        barcode: "035286301848",
        clientSku: "082081",
        document: page(product()),
      }),
    ).toEqual({
      partNumber: "30184",
      brand: "Acme",
      title: "Widget Mousepad XL",
    });
  });

  it("matches a zero-padded client SKU against an unpadded published one", () => {
    // Measured on the real pages: they publish `82081` where the client's own
    // row says `082081`. A verbatim comparison would reject the right product
    // on every zero-padded SKU — which is most of them.
    expect(
      identityFromStructuredData({
        barcode: "035286301848",
        clientSku: "082081",
        document: page(product({ sku: "82081" })),
      })?.partNumber,
    ).toBe("30184");
  });

  it("reads a bare-string brand as well as a Brand object", () => {
    // Both are valid schema.org. Reading only one is how a reader works on one
    // site and silently returns nothing on the next.
    expect(
      identityFromStructuredData({
        barcode: "035286301848",
        clientSku: "82081",
        document: page(product({ brand: "Acme" })),
      })?.brand,
    ).toBe("Acme");
  });

  it("🔴 refuses a page whose Product is a DIFFERENT product", () => {
    // The check that matters most here. A catalogue URL built from a template
    // can land on a search page, a "similar items" page, a redirect to a
    // replacement, or a soft 404 that still returns 200 with some other
    // product's structured data. Reading that page's part number attaches a
    // confidently wrong identity — and a wrong identity produces a wrong
    // MATCH, indistinguishable from a real one downstream.
    expect(
      identityFromStructuredData({
        barcode: "035286301848",
        clientSku: "082081",
        document: page(product({ sku: "999999", mpn: "WRONG-1" })),
      }),
    ).toBeNull();
  });

  it("refuses a Product node with no sku at all", () => {
    expect(
      identityFromStructuredData({
        barcode: "035286301848",
        clientSku: "082081",
        document: page(product({ sku: undefined })),
      }),
    ).toBeNull();
  });

  it("picks the right Product when a page carries several", () => {
    // Cross-sell blocks are Products too. The sku check is what stops the
    // first one on the page from winning.
    const html = page([
      product({ sku: "111111", mpn: "OTHER-A" }),
      product({ sku: "82081", mpn: "30184" }),
      product({ sku: "222222", mpn: "OTHER-B" }),
    ]);
    expect(
      identityFromStructuredData({
        barcode: "035286301848",
        clientSku: "082081",
        document: html,
      })?.partNumber,
    ).toBe("30184");
  });

  it("returns a partial identity when the part number is absent", () => {
    // ⚠️ Ordinary, not exceptional: that every client SKU publishes an mpn is
    // unmeasured (7 of 8,926 observed). A brand and a title are still worth
    // having — they make a searchable phrase — so this must not be null.
    expect(
      identityFromStructuredData({
        barcode: "035286301848",
        clientSku: "82081",
        document: page(product({ mpn: undefined })),
      }),
    ).toEqual({ partNumber: null, brand: "Acme", title: "Widget Mousepad XL" });
  });

  it("falls back to productID when mpn is absent", () => {
    expect(
      identityFromStructuredData({
        barcode: "035286301848",
        clientSku: "82081",
        document: page(product({ mpn: undefined, productID: "PID-9" })),
      })?.partNumber,
    ).toBe("PID-9");
  });

  it("declines when the right product names nothing useful", () => {
    expect(
      identityFromStructuredData({
        barcode: "035286301848",
        clientSku: "82081",
        document: page(
          product({ mpn: undefined, brand: undefined, name: undefined }),
        ),
      }),
    ).toBeNull();
  });

  it("declines when no document was fetched", () => {
    expect(
      identityFromStructuredData({
        barcode: "035286301848",
        clientSku: "82081",
      }),
    ).toBeNull();
  });

  it("treats an empty-string field as absent, not as a value", () => {
    expect(
      identityFromStructuredData({
        barcode: "035286301848",
        clientSku: "82081",
        document: page(product({ mpn: "   " })),
      })?.partNumber,
    ).toBeNull();
  });
});
