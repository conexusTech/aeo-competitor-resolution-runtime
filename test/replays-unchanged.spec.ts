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
