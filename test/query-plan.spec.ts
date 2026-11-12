import { describe, expect, it } from "vitest";

import {
  MAX_QUERY_ATTEMPTS,
  planQueries,
  planSearch,
  type QueryPlanInput,
} from "../src/query-plan.js";
import type { QuerySupport } from "../src/adapters/types.js";

const LAUNCH: QuerySupport = {
  maxNumericQueryDigits: 9,
  barcodeIsSearchable: false,
  partNumberNeedsBrand: false,
};

describe("planQueries", () => {
  it("puts the brand-scoped published part number first", () => {
    // A part number is the retailer's strongest key: `?d=TL-SG1005D` returns 2
    // exact results where the product name returns 44.
    const plan = planQueries(
      {
        barcode: "035286301848",
        brand: "Allsop",
        partNumbers: ["30184"],
        phrase: "Allsop Mousepad",
        productName: null,
        clientPartNumber: null,
      },
      LAUNCH,
    );
    expect(plan[0]).toBe("Allsop 30184");
    expect(plan).toContain("30184");
  });

  it("tries the free derivation after the best published candidate, not before", () => {
    // 🔴 The ordering that matters. The derivation is measured right 3 times of
    // 4 and wrong in a way nothing about the answer reveals, so it must not
    // displace a published candidate — only follow it.
    const plan = planQueries(
      {
        barcode: "813810010431", // derives 01043; the real part number is 63005
        brand: "SteelSeries",
        partNumbers: ["63005", "QCK-MINI"],
        phrase: "SteelSeries QcK",
        productName: null,
        clientPartNumber: null,
      },
      LAUNCH,
    );
    expect(plan[0]).toBe("SteelSeries 63005");
    const derived = plan.indexOf("SteelSeries 01043");
    const published = plan.indexOf("SteelSeries 63005");
    expect(derived).toBeGreaterThan(published);
  });

  it("adds a regional stem as an extra candidate, never a replacement", () => {
    const plan = planQueries(
      {
        barcode: "035286301848",
        brand: "Kensington",
        partNumbers: ["K72337WW"],
        phrase: null,
        productName: null,
        clientPartNumber: null,
      },
      LAUNCH,
    );
    expect(plan).toContain("Kensington K72337WW");
    expect(plan).toContain("Kensington K72337");
    expect(plan.indexOf("Kensington K72337WW")).toBeLessThan(
      plan.indexOf("Kensington K72337"),
    );
  });

  it("🔴 never plans a query the retailer is known to refuse", () => {
    // The barcode itself, and anything else numeric past the measured limit.
    // Spending a request to rediscover a known refusal is pure waste.
    const plan = planQueries(
      {
        barcode: "6933337311393",
        brand: null,
        partNumbers: ["6933337311393", "1234567890"],
        phrase: "1234567890123",
        productName: null,
        clientPartNumber: null,
      },
      LAUNCH,
    );
    expect(plan).not.toContain("6933337311393");
    expect(plan).not.toContain("1234567890");
    expect(plan).not.toContain("1234567890123");
  });

  it("still plans a SHORT numeric part number", () => {
    // The other half of that rule: `2960703` is a real 7-digit model number the
    // retailer answers, and it resolved one of the 22 verified rows. Reading
    // the limit as "refuse numeric" would have cost that match.
    const plan = planQueries(
      {
        barcode: "663296413697",
        brand: "Thrustmaster",
        partNumbers: ["2960703"],
        phrase: null,
        productName: null,
        clientPartNumber: null,
      },
      LAUNCH,
    );
    expect(plan).toContain("Thrustmaster 2960703");
    expect(plan).toContain("2960703");
  });

  it("falls back to the phrase when nothing else is known", () => {
    const plan = planQueries(
      {
        barcode: "SQR-WKIT-R2",
        brand: null,
        partNumbers: [],
        phrase: "Squarespace Wall Kit",
        productName: null,
        clientPartNumber: null,
      },
      LAUNCH,
    );
    expect(plan).toEqual(["Squarespace Wall Kit"]);
  });

  it("returns nothing when there is nothing to ask", () => {
    expect(
      planQueries(
        {
          barcode: "SQR-WKIT-R2",
          brand: null,
          partNumbers: [],
          phrase: null,
          productName: null,
          clientPartNumber: null,
        },
        LAUNCH,
      ),
    ).toEqual([]);
  });

  it("deduplicates and caps the attempt list", () => {
    const plan = planQueries(
      {
        barcode: "035286301848",
        brand: "Allsop",
        partNumbers: ["A1", "A1", "B2", "C3", "D4", "E5", "F6", "G7"],
        phrase: "a phrase",
        productName: null,
        clientPartNumber: null,
      },
      LAUNCH,
    );
    expect(plan.length).toBeLessThanOrEqual(MAX_QUERY_ATTEMPTS);
    expect(new Set(plan).size).toBe(plan.length);
  });

  it("works with no brand, using bare part numbers", () => {
    const plan = planQueries(
      {
        barcode: "035286301848",
        brand: null,
        partNumbers: ["30184"],
        phrase: null,
        productName: null,
        clientPartNumber: null,
      },
      LAUNCH,
    );
    expect(plan).toEqual(["30184"]);
  });
});

/**
 * 🔴 The client's own description, which the plan never tried.
 *
 * The PO's case, measured on 2026-09-15. `X870 TAICHI CREATOR` (ASRock, no
 * part number supplied) spent seven requests across six attempts —
 * `ASRock X870`, `X870`, `ASRock A0UAYZ`, `A0UAYZ`, `ASRock HTTPS`, `HTTPS` —
 * every one a no-result, and then proposed an unrelated A620AM board from a
 * derived part number. Newegg's own search box returns the product on the
 * first page for its name.
 *
 * His ask, verbatim: "add an instruction to try the full description as a
 * query without the brand as one of the options".
 */
describe("planQueries and the client's description", () => {
  it("tries the description when nothing was published — the PO's case", () => {
    const plan = planQueries(
      {
        barcode: "4711581492066",
        brand: "ASRock",
        // Nothing published: the client supplied no part number and the
        // search inference found none either.
        partNumbers: [],
        phrase: null,
        productName: "X870 TAICHI CREATOR",
        clientPartNumber: null,
      },
      LAUNCH,
    );

    expect(plan).toContain("X870 TAICHI CREATOR");
  });

  it("does NOT prefix the brand onto it", () => {
    // ⚠️ A client name usually carries the brand already, and doubling it
    // ("ASRock ASRock X870 Taichi") is a query no catalogue answers.
    const plan = planQueries(
      {
        barcode: "4711581492066",
        brand: "ASRock",
        partNumbers: [],
        phrase: null,
        productName: "ASRock X870 Taichi Creator",
        clientPartNumber: null,
      },
      LAUNCH,
    );

    expect(plan).not.toContain("ASRock ASRock X870 Taichi Creator");
    expect(plan).toContain("ASRock X870 Taichi Creator");
  });

  it("stays a FALLBACK — a published part number is still asked first", () => {
    // The control on the change: a name is a phrase that returns a page of
    // near-misses, a part number is an exact key. Promoting the name would
    // trade a precise first attempt for a vague one on every item.
    const plan = planQueries(
      {
        barcode: "035286301848",
        brand: "Allsop",
        partNumbers: ["30184"],
        phrase: null,
        productName: "Mousepad Pro XL",
        clientPartNumber: null,
      },
      LAUNCH,
    );

    expect(plan[0]).toBe("Allsop 30184");
    expect(plan.indexOf("Mousepad Pro XL")).toBeGreaterThan(
      plan.indexOf("30184"),
    );
  });

  it("prefers the client's description over an inferred phrase", () => {
    // 🔑 One is what the customer says the product is; the other is assembled
    // from somebody else's result titles.
    const plan = planQueries(
      {
        barcode: "4711581492066",
        brand: null,
        partNumbers: [],
        phrase: "motherboard atx amd",
        productName: "X870 TAICHI CREATOR",
        clientPartNumber: null,
      },
      LAUNCH,
    );

    expect(plan.indexOf("X870 TAICHI CREATOR")).toBeLessThan(
      plan.indexOf("motherboard atx amd"),
    );
  });

  it("asks nothing extra when the list carried no name", () => {
    const plan = planQueries(
      {
        barcode: "035286301848",
        brand: "Allsop",
        partNumbers: ["30184"],
        phrase: null,
        productName: null,
        clientPartNumber: null,
      },
      LAUNCH,
    );

    // The WHOLE plan, not a subset: a name-less item must cost exactly what
    // it cost before this change. Two attempts, because 035286301848 derives
    // the item reference 30184 — the published part number itself — so the
    // brand-scoped derivation dedups rather than adding a third request.
    expect(plan).toEqual(["Allsop 30184", "30184"]);
  });
});

/**
 * 🔴 **A row with no part number was searched by a name its retailer could not
 * answer.** Measured in production on 2026-11-12: 25 of Micro Center's 227
 * motherboard rows were filed `not_carried` at Newegg after ONE query and no
 * candidate — the name as written, unbranded and in Micro Center's shorthand.
 * Newegg's search needs every word: `MAG X870E TOMAHAWK MAX WF` answers 0,
 * `MSI MAG X870E TOMAHAWK MAX WIFI` answers 6, the product first.
 *
 * ⚠️ **A fallback, after the name as written** — 220 of the 227 names differ
 * when spelled out, so asking it first would buy ~220 searches a run that the
 * name as written already answers. The plan marks it as asked only when that
 * name answered an empty page; `spelled-out-fallback.spec.ts` checks resolve
 * keeps to it.
 */
describe("planSearch spells out the client's name, as a fallback", () => {
  const nameOnly = (
    brand: string | null,
    productName: string,
  ): QueryPlanInput => ({
    barcode: "not-a-barcode",
    brand,
    partNumbers: [],
    clientPartNumber: null,
    phrase: null,
    productName,
  });

  it("plans the name spelled out, brand first and shorthand expanded, right after the name as written", () => {
    const plan = planSearch(
      nameOnly("MSI", "MAG X870E TOMAHAWK MAX WF"),
      LAUNCH,
    );

    expect(plan.queries).toEqual([
      "MAG X870E TOMAHAWK MAX WF",
      "MSI MAG X870E TOMAHAWK MAX WIFI",
    ]);
    expect(
      planQueries(nameOnly("MSI", "MAG X870E TOMAHAWK MAX WF"), LAUNCH),
    ).toEqual(plan.queries);
  });

  it("🔑 marks it as asked only when the name as written found nothing", () => {
    const plan = planSearch(
      nameOnly("MSI", "MAG X870E TOMAHAWK MAX WF"),
      LAUNCH,
    );

    expect([...plan.askedOnlyIfEmpty]).toEqual([
      ["MSI MAG X870E TOMAHAWK MAX WIFI", "MAG X870E TOMAHAWK MAX WF"],
    ]);
  });

  it("never prefixes a brand the name already leads with", () => {
    expect(
      planQueries(nameOnly("ASUS", "ASUS TUF GAM A520M-PLUS"), LAUNCH),
    ).toEqual(["ASUS TUF GAM A520M-PLUS", "ASUS TUF GAMING A520M-PLUS"]);
    // Whatever the case either is written in.
    expect(planQueries(nameOnly("ASRock", "ASROCK B850M-C"), LAUNCH)).toEqual([
      "ASROCK B850M-C",
    ]);
  });

  it("🔴 reads the brand off the name as written, before anything is expanded", () => {
    // A brand that is itself shorthand-shaped: `AOR` leads `AOR AR-DV1`, so
    // nothing is prefixed and the brand is not rewritten into `AORUS`.
    expect(planSearch(nameOnly("AOR", "AOR AR-DV1"), LAUNCH).queries).toEqual([
      "AOR AR-DV1",
    ]);
  });

  it("adds only the brand to a name with no shorthand", () => {
    expect(
      planQueries(nameOnly("ASRock", "X870 TAICHI CREATOR"), LAUNCH),
    ).toEqual(["X870 TAICHI CREATOR", "ASRock X870 TAICHI CREATOR"]);
  });

  it("expands the shorthand alone where no brand is known", () => {
    expect(planQueries(nameOnly(null, "Z890 UD WF6E"), LAUNCH)).toEqual([
      "Z890 UD WF6E",
      "Z890 UD WIFI6E",
    ]);
  });

  it("expands ASUS's XHAIR to CROSSHAIR", () => {
    expect(
      planQueries(nameOnly("ASUS", "ROG XHAIR X870E ED20 AIO"), LAUNCH),
    ).toEqual([
      "ROG XHAIR X870E ED20 AIO",
      "ASUS ROG CROSSHAIR X870E ED20 AIO",
    ]);
  });

  it("🔑 plans nothing extra when the spelled-out name is the name as written", () => {
    // The cost guard: no brand, no shorthand, one query.
    const plan = planSearch(nameOnly(null, "X870 TAICHI CREATOR"), LAUNCH);
    expect(plan.queries).toEqual(["X870 TAICHI CREATOR"]);
    expect(plan.askedOnlyIfEmpty.size).toBe(0);
  });

  it("🔑 plans nothing extra when the two differ only in spacing", () => {
    expect(planQueries(nameOnly(null, "ROG  STRIX\tB850-A"), LAUNCH)).toEqual([
      "ROG  STRIX\tB850-A",
    ]);
    expect(
      planQueries(nameOnly("ASUS", "  ASUS   ROG  STRIX B850-A "), LAUNCH),
    ).toEqual(["ASUS   ROG  STRIX B850-A"]);
  });

  it("expands whole words only, never a word that merely contains a shorthand", () => {
    expect(
      planQueries(nameOnly(null, "WFH AORUSX GAMX MASTRO WF-7"), LAUNCH),
    ).toEqual(["WFH AORUSX GAMX MASTRO WF-7"]);
  });

  it("🔴 leaves real product words alone", () => {
    // Each of these is shorthand-shaped and also a word in somebody's real
    // product name, so none of them may be rewritten.
    const name = "B760M-A AX D4 MATX PRO ICE MAX ATX II WS EEB";
    expect(planQueries(nameOnly(null, name), LAUNCH)).toEqual([name]);
  });

  it("🔴 keeps a row whose CLIENT supplied a part number on the plan it always had", () => {
    // A part number is the exact key; the name is a fallback. An item the
    // client gave one is asked exactly what it was asked before.
    const allsop: QueryPlanInput = {
      barcode: "035286301848",
      brand: "Allsop",
      partNumbers: ["30184"],
      clientPartNumber: "30184",
      phrase: null,
      productName: "Mousepad Pro XL WF",
    };
    const plan = planSearch(allsop, LAUNCH);
    expect(plan.queries).toEqual([
      "Allsop 30184",
      "30184",
      "Mousepad Pro XL WF",
    ]);
    expect(plan.askedOnlyIfEmpty.size).toBe(0);

    const steelSeries: QueryPlanInput = {
      barcode: "813810010431",
      brand: "SteelSeries",
      partNumbers: ["63005", "QCK-MINI", "QCK-MINI-2", "QCK-HEAVY"],
      clientPartNumber: "63005",
      phrase: "SteelSeries QcK",
      productName: "QcK Mini GAM",
    };
    // The whole plan, exactly as before the spelled-out name existed.
    const full = planSearch(steelSeries, LAUNCH);
    expect(full.queries).toEqual([
      "SteelSeries 63005",
      "63005",
      "SteelSeries 01043",
      "SteelSeries QCK-MINI",
      "QCK-MINI",
      "SteelSeries QCK-MINI-2",
    ]);
    expect(full.askedOnlyIfEmpty.size).toBe(0);
  });

  /** What `planSearch` would ask with every fallback left unasked. */
  const unconditional = (plan: ReturnType<typeof planSearch>): string[] =>
    plan.queries.filter((q) => !plan.askedOnlyIfEmpty.has(q));

  it("🔴 takes no slot from the plan — the fallback goes beyond the cap, as the barcode does", () => {
    // The review's probe: four part-number attempts, the name and the phrase
    // fill the six. Counted among them, the fallback cut the phrase, so the
    // row was asked one question fewer than before whenever it went unasked.
    const plan = planSearch(
      {
        barcode: "not-a-barcode",
        brand: "MSI",
        partNumbers: ["ZQ-9000", "ZQ-9100"],
        clientPartNumber: null,
        phrase: "MSI MAG Board",
        productName: "MAG X870E TOMAHAWK MAX WF",
      },
      LAUNCH,
    );
    expect(plan.queries).toEqual([
      "MSI ZQ-9000",
      "ZQ-9000",
      "MSI ZQ-9100",
      "ZQ-9100",
      "MAG X870E TOMAHAWK MAX WF",
      "MSI MAG Board",
      "MSI MAG X870E TOMAHAWK MAX WIFI",
    ]);
    expect(plan.queries).toHaveLength(MAX_QUERY_ATTEMPTS + 1);
    expect([...plan.askedOnlyIfEmpty]).toEqual([
      ["MSI MAG X870E TOMAHAWK MAX WIFI", "MAG X870E TOMAHAWK MAX WF"],
    ]);
  });

  it("🔑 is not conditional where the plan already asks the same query", () => {
    // The phrase IS the spelled-out name: it is asked anyway, so nothing is
    // added and nothing is made to wait on the name's answer.
    const plan = planSearch(
      {
        barcode: "not-a-barcode",
        brand: "MSI",
        partNumbers: [],
        clientPartNumber: null,
        phrase: "MSI MAG X870E TOMAHAWK MAX WIFI",
        productName: "MAG X870E TOMAHAWK MAX WF",
      },
      LAUNCH,
    );
    expect(plan.queries).toEqual([
      "MAG X870E TOMAHAWK MAX WF",
      "MSI MAG X870E TOMAHAWK MAX WIFI",
    ]);
    expect(plan.askedOnlyIfEmpty.size).toBe(0);
  });

  /**
   * 🔴 The plan without its fallback, for each input, exactly as `6c1368d`
   * (before the spelled-out name) planned it — computed by running that
   * commit's `planQueries` on these inputs. With and without the client's own
   * part number, and with 0, 2 and 5 inferred ones.
   */
  const BEFORE: readonly {
    client: string | null;
    inferred: readonly string[];
    plan: readonly string[];
  }[] = [
    {
      client: null,
      inferred: [],
      plan: ["MAG X870E TOMAHAWK MAX WF", "MSI MAG Board"],
    },
    {
      client: null,
      inferred: ["ZQ-9000", "ZQ-9100"],
      plan: [
        "MSI ZQ-9000",
        "ZQ-9000",
        "MSI ZQ-9100",
        "ZQ-9100",
        "MAG X870E TOMAHAWK MAX WF",
        "MSI MAG Board",
      ],
    },
    {
      client: null,
      inferred: ["ZQ-9000", "ZQ-9100", "ZQ-9200", "ZQ-9300", "ZQ-9400"],
      plan: [
        "MSI ZQ-9000",
        "ZQ-9000",
        "MSI ZQ-9100",
        "ZQ-9100",
        "MSI ZQ-9200",
        "ZQ-9200",
      ],
    },
    {
      client: "7E59-001R",
      inferred: [],
      plan: [
        "MSI 7E59-001R",
        "7E59-001R",
        "MAG X870E TOMAHAWK MAX WF",
        "MSI MAG Board",
      ],
    },
    {
      client: "7E59-001R",
      inferred: ["ZQ-9000", "ZQ-9100"],
      plan: [
        "MSI 7E59-001R",
        "7E59-001R",
        "MSI ZQ-9000",
        "ZQ-9000",
        "MSI ZQ-9100",
        "ZQ-9100",
      ],
    },
    {
      client: "7E59-001R",
      inferred: ["ZQ-9000", "ZQ-9100", "ZQ-9200", "ZQ-9300", "ZQ-9400"],
      plan: [
        "MSI 7E59-001R",
        "7E59-001R",
        "MSI ZQ-9000",
        "ZQ-9000",
        "MSI ZQ-9100",
        "ZQ-9100",
      ],
    },
  ];

  it.each(BEFORE)(
    "asks unconditionally exactly what it asked before (client $client, inferred $inferred)",
    ({ client, inferred, plan }) => {
      const now = planSearch(
        {
          barcode: "4006381333931",
          brand: "MSI",
          partNumbers: client === null ? inferred : [client, ...inferred],
          clientPartNumber: client,
          phrase: "MSI MAG Board",
          productName: "MAG X870E TOMAHAWK MAX WF",
        },
        LAUNCH,
      );
      expect(unconditional(now)).toEqual(plan);
      // Anything beyond it is the fallback, and only where it can be opened.
      const extra = now.queries.slice(plan.length);
      expect(extra).toEqual(
        client === null && plan.includes("MAG X870E TOMAHAWK MAX WF")
          ? ["MSI MAG X870E TOMAHAWK MAX WIFI"]
          : [],
      );
    },
  );

  it("🔴 still plans it where the part numbers were only INFERRED — the HTTPS case", () => {
    // A search-engine page yields part-number candidates that are often not
    // the product's at all (`HTTPS`, measured). Only the client's own part
    // number takes the fallback away.
    const plan = planSearch(
      {
        barcode: "not-a-barcode",
        brand: "ASRock",
        partNumbers: ["HTTPS"],
        clientPartNumber: null,
        phrase: null,
        productName: "X870 TAICHI CREATR",
      },
      LAUNCH,
    );
    expect(plan.queries).toEqual([
      "ASRock HTTPS",
      "HTTPS",
      "X870 TAICHI CREATR",
      "ASRock X870 TAICHI CREATOR",
    ]);
    expect(plan.askedOnlyIfEmpty.get("ASRock X870 TAICHI CREATOR")).toBe(
      "X870 TAICHI CREATR",
    );
  });

  /**
   * Every Micro Center row Newegg filed `not_carried` on 2026-11-12, with the
   * brand the client sent and what its spelled-out search must be.
   */
  const NEWEGG_MISSES: readonly (readonly [string, string, string])[] = [
    ["MSI", "MPG B850I EDGE TI ITX WF", "MSI MPG B850I EDGE TI ITX WIFI"],
    ["ASUS", "ROG STRIX B650A GAMING WF", "ASUS ROG STRIX B650A GAMING WIFI"],
    [
      "Gigabyte",
      "X870E AOR XTRM X3D AI TOP",
      "Gigabyte X870E AORUS XTREME X3D AI TOP",
    ],
    ["MSI", "PRO B760-P WIFI D4 ATX", "MSI PRO B760-P WIFI D4 ATX"],
    ["Gigabyte", "A620M S2H AM5 MATX D5", "Gigabyte A620M S2H AM5 MATX D5"],
    [
      "Gigabyte",
      "X870 AORUS ELITE WF7 ICE",
      "Gigabyte X870 AORUS ELITE WIFI7 ICE",
    ],
    [
      "Gigabyte",
      "X870 AORUS ELITE WF7 AM5",
      "Gigabyte X870 AORUS ELITE WIFI7 AM5",
    ],
    [
      "Gigabyte",
      "X870E AORUS ELITE WF7 AM5",
      "Gigabyte X870E AORUS ELITE WIFI7 AM5",
    ],
    ["MSI", "MPG X870E CARBON WF", "MSI MPG X870E CARBON WIFI"],
    ["ASRock", "X870 STEEL LEGEND WF", "ASRock X870 STEEL LEGEND WIFI"],
    ["ASRock", "X870 RIPTIDE WF", "ASRock X870 RIPTIDE WIFI"],
    ["Gigabyte", "Z890 UD WF6E", "Gigabyte Z890 UD WIFI6E"],
    ["ASUS", "ROG STRIX B850-A GAM WF", "ASUS ROG STRIX B850-A GAMING WIFI"],
    ["ASUS", "TUF GAMING B860M-PLUS WF", "ASUS TUF GAMING B860M-PLUS WIFI"],
    ["ASUS", "B650E MAX GAMING WF", "ASUS B650E MAX GAMING WIFI"],
    ["ASUS", "PRIME X299- A II", "ASUS PRIME X299- A II"],
    ["MSI", "PRO Z890P WF", "MSI PRO Z890P WIFI"],
    [
      "Gigabyte",
      "X870E AORUS MASTR X3D ICE",
      "Gigabyte X870E AORUS MASTER X3D ICE",
    ],
    [
      "ASUS",
      "ROG STRIX X870E-E GAM WF7",
      "ASUS ROG STRIX X870E-E GAMING WIFI7",
    ],
    ["ASUS", "B850M-PLUS TUF GAMING WF7", "ASUS B850M-PLUS TUF GAMING WIFI7"],
    ["ASUS", "PRO WS W890-E SAGE SE EEB", "ASUS PRO WS W890-E SAGE SE EEB"],
    ["ASUS", "ASUS TUF GAM A520M-PLUS", "ASUS TUF GAMING A520M-PLUS"],
    ["ASUS", "PRIME B860MA WF CSM", "ASUS PRIME B860MA WIFI CSM"],
    ["ASRock", "ASROCK B850M-C", "ASROCK B850M-C"],
    ["MSI", "MAG X870E TOMAHAWK MAX WF", "MSI MAG X870E TOMAHAWK MAX WIFI"],
  ];

  it("covers all 25 of Newegg's misses", () => {
    expect(NEWEGG_MISSES).toHaveLength(25);
  });

  it.each(NEWEGG_MISSES)(
    "%s %s is searched as written, then as %s if that finds nothing",
    (brand, name, spelledOut) => {
      const plan = planSearch(nameOnly(brand, name), LAUNCH);
      if (spelledOut === name) {
        expect(plan.queries).toEqual([name]);
        expect(plan.askedOnlyIfEmpty.size).toBe(0);
      } else {
        expect(plan.queries).toEqual([name, spelledOut]);
        expect(plan.askedOnlyIfEmpty.get(spelledOut)).toBe(name);
      }
    },
  );
});
