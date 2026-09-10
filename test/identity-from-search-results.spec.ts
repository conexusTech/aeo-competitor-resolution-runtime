import { describe, expect, it } from "vitest";

import {
  candidatePartNumbers,
  identityFromSearchResults,
  inferBrand,
  inferPhrase,
  partNumberStem,
  resultTitles,
} from "../src/identity/from-search-results.js";

/**
 * ⚠️ **These fixtures are synthetic, and that is a gap rather than a choice.**
 *
 * All 71 real search-engine captures were lost when the handover spike's
 * response cache vanished from the machine it lived on — the only copy. The
 * retailer's own parsers are checked against 7 real captured pages because
 * those were committed an hour earlier; this source has none, so what is
 * asserted below is that the extraction rules behave as specified, not that
 * they behave correctly on a real result page.
 *
 * 🔑 That distinction matters more here than anywhere else in this repo,
 * because this is the source §8 rejected and the origin of every observed
 * mis-resolution. Its real-page behaviour is exactly the thing that most needs
 * evidence and currently has none.
 */

const serp = (titles: string[], body = ""): string =>
  `<html><body>${titles.map((t) => `<h3><span>${t}</span></h3>`).join("")}<div>${body}</div></body></html>`;

describe("resultTitles", () => {
  it("strips markup and entities out of each title", () => {
    const html = serp([
      "Acme WIDGET-1 &amp; Mount",
      "Acme &#39;Widget&#39; XL",
    ]);
    expect(resultTitles(html)).toEqual([
      "Acme WIDGET-1 & Mount",
      "Acme Widget XL",
    ]);
  });

  it("ignores empty headings", () => {
    expect(resultTitles("<h3></h3><h3>  </h3><h3>Real</h3>")).toEqual(["Real"]);
  });
});

describe("candidatePartNumbers", () => {
  it("🔑 keeps only tokens that recur across sellers", () => {
    // The whole idea: a real part number appears in every seller's listing,
    // while each seller's private SKU appears once. A one-off token searched
    // as a part number finds nothing, or worse, the wrong thing.
    const html = serp(
      ["Acme CF-08LB Fan", "Acme CF-08LB 80mm", "Acme CF-08LB case fan"],
      "SELLER-ONLY-9999 CF-08LB",
    );
    const parts = candidatePartNumbers(html, "812348010548");
    expect(parts).toContain("CF-08LB");
    expect(parts).not.toContain("SELLER-ONLY-9999");
  });

  it("drops specs, standards and units that look like part numbers", () => {
    const html = serp(
      ["USB3 HDMI 120MM DDR4 fan", "USB3 HDMI 120MM DDR4 cooler"],
      "USB3 HDMI 120MM DDR4",
    );
    expect(candidatePartNumbers(html, "812348010548")).toEqual([]);
  });

  it("drops retail boilerplate shaped like a part number", () => {
    const html = serp(
      ["30-DAY returns 2-YEAR warranty 4-PACK", "30-DAY returns 2-YEAR 4-PACK"],
      "30-DAY 2-YEAR 4-PACK",
    );
    expect(candidatePartNumbers(html, "812348010548")).toEqual([]);
  });

  it("never returns the barcode itself", () => {
    const html = serp(
      ["Widget 812348010548 fan", "Widget 812348010548 cooler"],
      "812348010548 812348010548",
    );
    expect(candidatePartNumbers(html, "812348010548")).not.toContain(
      "812348010548",
    );
  });

  it("ignores markup, scripts and entity names", () => {
    // Entity NAMES tokenise as part numbers ("quot") if not removed first.
    const html =
      `<script>var x = "AB-123";</script><h3>Acme QX-9 thing</h3>` +
      `<h3>Acme QX-9 other</h3><p>&quot;QX-9&quot; &amp; QX-9</p>`;
    const parts = candidatePartNumbers(html, "000000000000");
    expect(parts).toContain("QX-9");
    expect(parts).not.toContain("AB-123"); // inside a script
    expect(parts).not.toContain("QUOT");
  });
});

describe("partNumberStem", () => {
  it("strips a regional suffix", () => {
    // A manufacturer ships K72337WW where the retailer stocks K72337US under
    // the same barcode; the stem finds the sibling the literal misses.
    expect(partNumberStem("K72337WW")).toBe("K72337");
    expect(partNumberStem("K72337US")).toBe("K72337");
  });

  it("returns null when there is no suffix to strip", () => {
    expect(partNumberStem("CF-08LB")).toBeNull();
    expect(partNumberStem("30184")).toBeNull();
  });

  it("refuses to strip down to something too short to search", () => {
    expect(partNumberStem("K1US")).toBeNull();
  });
});

describe("inferBrand and inferPhrase", () => {
  it("takes the brand from the first word of the first title", () => {
    expect(inferBrand(["Allsop Accutrack Slimline Mousepad"])).toBe("Allsop");
  });

  it("refuses a numeric first word as a brand", () => {
    expect(inferBrand(["12345 Widget"])).toBeNull();
    expect(inferBrand([])).toBeNull();
  });

  it("builds a phrase from words shared across titles", () => {
    const phrase = inferPhrase([
      "Allsop Accutrack Slimline Mousepad XL",
      "Allsop Accutrack Slimline Mousepad - Best Price",
      "Allsop Accutrack Slimline Mousepad Buy Online",
    ]);
    expect(phrase).toContain("Allsop");
    expect(phrase).toContain("Accutrack");
    // Commerce boilerplate must not survive into the query.
    expect(phrase?.toLowerCase()).not.toContain("buy");
    expect(phrase?.toLowerCase()).not.toContain("price");
  });

  it("prefers ascii titles when any exist", () => {
    const phrase = inferPhrase([
      "マウスパッド アクトラック",
      "Allsop Accutrack Mousepad",
      "Allsop Accutrack Slimline",
    ]);
    expect(phrase).toContain("Allsop");
  });

  it("falls back to the first title when no word is shared", () => {
    expect(inferPhrase(["A totally unique heading"])).toBe(
      "A totally unique heading",
    );
  });
});

describe("identityFromSearchResults", () => {
  it("returns the best part number, the brand, a title and every candidate", () => {
    const html = serp(
      [
        "Kingwin CF-08LB 80mm Fan",
        "Kingwin CF-08LB Long Life",
        "Kingwin CF-08LB",
      ],
      "CF-08LB CF-08LB",
    );
    const got = identityFromSearchResults({
      barcode: "812348010548",
      clientSku: "531814",
      document: html,
    });
    expect(got?.partNumber).toBe("CF-08LB");
    expect(got?.brand).toBe("Kingwin");
    expect(got?.title).toBe("Kingwin CF-08LB 80mm Fan");
    expect(got?.partNumberCandidates).toContain("CF-08LB");
  });

  it("adds a regional stem as an extra candidate", () => {
    const html = serp(
      ["Kensington K72337WW Mouse", "Kensington K72337WW Wired"],
      "K72337WW K72337WW",
    );
    const got = identityFromSearchResults({
      barcode: "085896723370",
      clientSku: "1",
      document: html,
    });
    expect(got?.partNumberCandidates).toEqual(
      expect.arrayContaining(["K72337WW", "K72337"]),
    );
  });

  it("declines when there is nothing on the page", () => {
    expect(
      identityFromSearchResults({
        barcode: "812348010548",
        clientSku: "1",
        document: "<html><body>no results</body></html>",
      }),
    ).toBeNull();
  });

  it("declines when no page was fetched", () => {
    expect(
      identityFromSearchResults({ barcode: "812348010548", clientSku: "1" }),
    ).toBeNull();
  });
});
