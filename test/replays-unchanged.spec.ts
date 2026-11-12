import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import {
  recordPath,
  replay,
  REPLAYS,
  type ReplayedRow,
} from "./replay-drivers.js";

/**
 * 🔴 **Every committed replay, field for field, against its record.**
 *
 * The records in `fixtures/replay-records/` were taken on `748c11c`, before
 * the client's part number and brand reached the pipeline, and they hold every
 * resolution in full — outcome, identity, every query in order, every
 * alternative and its reason, the evidence, every count — plus every url the
 * row asked for. A run that sends neither field must reproduce them exactly.
 *
 * ⚠️ **A record changes only with a named reason**, written beside the change
 * that made it: an outcome comparison against an investigation, which is what
 * the exit-criterion specs do, passes a reordered plan or a probe spent
 * differently, and this is the check that does not.
 *
 * Changed records, and why:
 * - `insights-monitor-by-category-where-cheaper` added `match.priceSource`
 *   to every match: 47 lines, each that one field and nothing else. The
 *   records were regenerated only after the new replays, with the field
 *   removed, were shown equal to the old records: 24 Newegg prices from the
 *   search card (its product pages state none); 11 Best Buy, 8 B&H and 1
 *   Costco price from the product page; and 3 B&H matches with no price and
 *   no source.
 * - `insights-query-trail-reports-no-candidates` added `queryTrail` beside
 *   every `queriesTried`: 914 lines, every one inside that field and nothing
 *   else. The records were regenerated only after the new replays, with the
 *   field removed, were shown equal to the old records. Of its 184 entries,
 *   104 are a results page or index lookup listing nothing (`0`) and 80
 *   list something; none is `null`, because every corpus page answered.
 */

const recorded = (name: (typeof REPLAYS)[number]): ReplayedRow[] =>
  JSON.parse(readFileSync(recordPath(name), "utf8")) as ReplayedRow[];

describe.each(REPLAYS)("the %s replay", (name) => {
  let rows: ReplayedRow[] = [];
  beforeAll(async () => {
    // Through JSON, as the record was written: `undefined` fields drop out on
    // both sides, so an absent field and a missing one compare equal.
    rows = JSON.parse(JSON.stringify(await replay(name))) as ReplayedRow[];
  }, 120_000);

  it("replays every row its record holds, in order", () => {
    expect(rows.map((r) => r.barcode)).toEqual(
      recorded(name).map((r) => r.barcode),
    );
  });

  it("reproduces every row exactly", () => {
    const record = recorded(name);
    for (const [i, row] of rows.entries()) {
      expect(row, `row ${row.barcode}`).toEqual(record[i]);
    }
  });
});
