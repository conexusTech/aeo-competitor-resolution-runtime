import { describe, expect, it } from "vitest";

import { safeImageUrl } from "../src/adapters/types.js";

/**
 * 🔴 **An image url a competitor's page states is rendered into the portal's
 * `<img src>`, and is persisted globally** (`insights_listings.image_url`).
 * Only `https:` is published (security finding 6): a plain `http:` image is
 * mixed content on an https portal, and a request to a host that page chose
 * sent in clear.
 */
describe("safeImageUrl", () => {
  it("publishes an https url, trimmed", () => {
    expect(safeImageUrl(" https://cdn.test/a.jpg ")).toBe(
      "https://cdn.test/a.jpg",
    );
    expect(safeImageUrl("HTTPS://cdn.test/a.jpg")).toBe(
      "HTTPS://cdn.test/a.jpg",
    );
  });

  it("🔴 refuses plain http", () => {
    expect(safeImageUrl("http://cdn.test/a.jpg")).toBeNull();
    expect(safeImageUrl("HTTP://cdn.test/a.jpg")).toBeNull();
  });

  it("refuses every other scheme, a relative path and nothing", () => {
    for (const raw of [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "//cdn.test/a.jpg",
      "/images/a.jpg",
      "ftp://cdn.test/a.jpg",
      "",
      null,
      undefined,
    ]) {
      expect(safeImageUrl(raw), String(raw)).toBeNull();
    }
  });

  it("refuses one past 1,000 characters", () => {
    expect(safeImageUrl(`https://cdn.test/${"a".repeat(1_000)}`)).toBeNull();
  });
});
