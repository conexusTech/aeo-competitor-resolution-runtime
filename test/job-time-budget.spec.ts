import { describe, expect, it } from "vitest";

import { parseJob } from "../src/gateway/client.js";

/**
 * The job's time budget, as the gateway sends it.
 *
 * 🔑 **Tolerant of absence, strict about type** — the rule every optional
 * field on a job follows. Absent or `null` is a gateway that sets no budget,
 * and the run behaves exactly as before. A zero, a fraction or a string is two
 * builds disagreeing, and reading it as "no budget" would hide that behind a
 * run that never yields.
 */
describe("the job's stopTakingItemsAfterSec on the wire", () => {
  const job = (extra: Record<string, unknown>): Record<string, unknown> => ({
    retailerSlug: "newegg",
    items: [{ barcode: "812348010548", clientSku: "S" }],
    ...extra,
  });

  it("is no budget when an older gateway sends none", () => {
    expect(parseJob(job({}), "r").stopTakingItemsAfterSec).toBeNull();
  });

  it("is no budget when the gateway sends null", () => {
    expect(
      parseJob(job({ stopTakingItemsAfterSec: null }), "r")
        .stopTakingItemsAfterSec,
    ).toBeNull();
  });

  it("carries a whole number of seconds as it was sent", () => {
    expect(
      parseJob(job({ stopTakingItemsAfterSec: 3600 }), "r")
        .stopTakingItemsAfterSec,
    ).toBe(3600);
    expect(
      parseJob(job({ stopTakingItemsAfterSec: 1 }), "r")
        .stopTakingItemsAfterSec,
    ).toBe(1);
  });

  it("refuses a budget that is two builds disagreeing, naming the field", () => {
    for (const bad of [0, -1, 2.5, "3600", true, {}, Number.NaN]) {
      expect(() =>
        parseJob(job({ stopTakingItemsAfterSec: bad }), "r"),
      ).toThrow(
        /'stopTakingItemsAfterSec' that is not a whole number of at least 1/,
      );
    }
  });
});
