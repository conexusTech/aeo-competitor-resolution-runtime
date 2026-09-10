import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { neweggAdapter } from "../src/adapters/newegg.js";
import { ReplayFetcher, type Corpus } from "../src/fetcher/replay.js";
import { MAX_ALTERNATIVES } from "../src/alternatives.js";
import { MIN_EVIDENCE_TO_REPORT } from "../src/ranking.js";
import { NotInCorpus } from "../src/fetcher/types.js";
import {
  DEFAULT_OPTIONS,
  resolveItem,
  type Resolution,
} from "../src/resolve.js";
import measured from "./fixtures/measured-run-53.json" with { type: "json" };

/**
 * **The row's exit criterion**: a run over the 53 measured rows reproduces or
 * beats the handover's outcome split, from configuration alone.
 *
 * Run entirely offline against a committed corpus of 534 real responses, so it
 * costs nothing and is deterministic. That is the property that makes this an
 * automated check rather than a paid manual one — and the reason everything
 * above the fetcher is pure.
 *
 * ⚠️ **The two vocabularies differ, deliberately.** The handover had three
 * outcomes; this runtime has four, because 91 of 255 captured product pages
 * publish an empty barcode and "cannot be compared" is a different finding from
 * "disagrees". The mapping used for comparison is stated below and is the
 * conservative one: `unverifiable` counts as the spike's `probable`, since that
 * is where the spike put those rows.
 */

const CORPUS = (): Corpus => {
  const url = new URL("./corpus/launch-retailer-53.json.gz", import.meta.url);
  return JSON.parse(
    gunzipSync(readFileSync(fileURLToPath(url))).toString("utf8"),
  ) as Corpus;
};

interface MeasuredRow {
  readonly barcode: string;
  readonly spikeStatus: string;
  readonly retailerBarcode: string | null;
}

const rows = measured.rows as unknown as MeasuredRow[];

/** This runtime's outcome -> the spike's vocabulary. */
const asSpikeStatus = (outcome: Resolution["outcome"]): string => {
  switch (outcome) {
    case "verified":
      return "upc-verified";
    case "unverifiable":
    case "unconfirmed":
      return "probable";
    case "not-found":
      return "not-found";
  }
};

/** The client's SKU is not in the fixture, and the pipeline only needs it for
 * the catalogue source, which this replay does not use — the spike had none. */
const OPTIONS = { ...DEFAULT_OPTIONS, clientCatalogueUrlTemplate: null };

describe("the measured run's ground truth", () => {
  it("is the 53 rows, with the split the criterion names", () => {
    expect(rows).toHaveLength(53);
    expect(measured.split).toEqual({
      "upc-verified": 22,
      probable: 12,
      "not-found": 14,
      error: 5,
    });
  });
});

describe("53 rows, replayed offline", () => {
  let resolutions: { row: MeasuredRow; resolution: Resolution | null }[] = [];
  let fetcher: ReplayFetcher;

  beforeAll(async () => {
    fetcher = new ReplayFetcher(CORPUS());
    resolutions = [];
    for (const row of rows) {
      try {
        const resolution = await resolveItem(
          { barcode: row.barcode, clientSku: "" },
          neweggAdapter,
          fetcher,
          OPTIONS,
        );
        resolutions.push({ row, resolution });
      } catch (error) {
        // A corpus gap, not a pipeline failure. Recorded as un-replayable
        // rather than counted as a miss — counting it would land on the
        // spike's own `error` rows and look like a faithful reproduction.
        if (error instanceof NotInCorpus)
          resolutions.push({ row, resolution: null });
        else throw error;
      }
    }
  }, 120_000);

  it("serves most rows from the corpus", () => {
    const served = resolutions.filter((r) => r.resolution !== null);
    // Reported rather than asserted at a high bar: the corpus holds what the
    // spike happened to fetch, and this pipeline asks slightly different
    // questions. What must not happen is a silent collapse to nothing.
    expect(served.length).toBeGreaterThan(rows.length / 2);
  });

  it("🔴 reproduces or beats the measured verified count on the rows it can replay", () => {
    const served = resolutions.filter(
      (r): r is { row: MeasuredRow; resolution: Resolution } =>
        r.resolution !== null,
    );

    const spikeVerified = served.filter(
      (r) => r.row.spikeStatus === "upc-verified",
    ).length;
    const oursVerified = served.filter(
      (r) => r.resolution.outcome === "verified",
    ).length;

    console.log(
      `replayed ${served.length}/${rows.length} rows: ` +
        `verified ${oursVerified} vs spike ${spikeVerified}`,
    );

    expect(oursVerified).toBeGreaterThanOrEqual(spikeVerified);
  });

  it("agrees with the measured run row by row, not just in total", () => {
    // 🔑 The count alone is satisfiable by getting different rows right and
    // wrong in equal measure. This compares per row, in the spike's own
    // vocabulary, and reports how many disagree.
    const served = resolutions.filter(
      (r): r is { row: MeasuredRow; resolution: Resolution } =>
        r.resolution !== null,
    );

    const disagreements = served.filter(
      (r) => asSpikeStatus(r.resolution.outcome) !== r.row.spikeStatus,
    );

    console.log(
      `row-by-row: ${served.length - disagreements.length}/${served.length} agree; ` +
        `disagreements: ${disagreements
          .map(
            (d) =>
              `${d.row.barcode} spike=${d.row.spikeStatus} ours=${d.resolution.outcome}`,
          )
          .slice(0, 8)
          .join("; ")}`,
    );

    // ⚠️ Not asserted at zero, and the reasons are asserted instead.
    //
    // The spike's 5 `error` rows are network failures a replay cannot
    // reproduce by construction — a cached response is never a timeout.
    //
    // 🔴 And this pipeline is deliberately STRICTER on one class of row. The
    // spike's reporting floor was reachable with no part-number evidence at
    // all (brand + first-party + in-stock totals exactly the threshold), so it
    // reported same-brand in-stock listings as `probable` against its own
    // stated rule — "no model-level evidence, report nothing". This pipeline
    // requires the evidence explicitly, which turns 4 of those rows into
    // `not-found`. Reporting nothing beats reporting something unproven, so
    // that is the criterion being beaten rather than missed.
    //
    // Every disagreement must be one of those two kinds. An unexplained one
    // fails here.
    for (const d of disagreements) {
      const ours = d.resolution.outcome;
      const theirs = d.row.spikeStatus;
      const strictness = theirs === "probable" && ours === "not-found";
      const unreproducibleError = theirs === "error";
      expect(
        strictness || unreproducibleError,
        `unexplained disagreement on ${d.row.barcode}: spike=${theirs} ours=${ours}`,
      ).toBe(true);
    }

    // What is asserted absolutely: no verification is ever lost.
    const lostVerifications = served.filter(
      (r) =>
        r.row.spikeStatus === "upc-verified" &&
        r.resolution.outcome !== "verified",
    );
    expect(lostVerifications).toEqual([]);
  });

  it("never claims verified without a barcode that actually agrees", () => {
    // The property that matters more than the count. A verified outcome must
    // carry the retailer's own barcode, and it must compare equal.
    for (const { resolution } of resolutions) {
      if (resolution?.outcome !== "verified") continue;
      expect(resolution.match).not.toBeNull();
      expect(resolution.match?.retailerBarcode).toBeTruthy();
    }
  });

  it("agrees with the measured run on which barcode the retailer published", () => {
    // Independent of outcome names: where both found a barcode, they must be
    // the same barcode. This is what would catch a pipeline that reaches the
    // right totals by matching the wrong products.
    let compared = 0;
    for (const { row, resolution } of resolutions) {
      if (row.retailerBarcode === null) continue;
      if (resolution?.outcome !== "verified") continue;
      compared++;
      expect(resolution.match?.retailerBarcode).toBe(row.retailerBarcode);
    }
    expect(compared).toBeGreaterThan(0);
  });

  it("🔴 distinguishes unverifiable from unconfirmed", () => {
    // The four-outcome model earning its keep: at least one row must land on
    // `unverifiable` — the retailer published a listing and no barcode. If
    // none did, the distinction is untested and the extra state is decoration.
    const unverifiable = resolutions.filter(
      (r) => r.resolution?.outcome === "unverifiable",
    );

    console.log(
      `unverifiable ${unverifiable.length}, ` +
        `unconfirmed ${resolutions.filter((r) => r.resolution?.outcome === "unconfirmed").length}, ` +
        `not-found ${resolutions.filter((r) => r.resolution?.outcome === "not-found").length}`,
    );
    expect(unverifiable.length).toBeGreaterThan(0);
    for (const { resolution } of unverifiable) {
      expect(resolution?.match?.retailerBarcode).toBeNull();
    }
  });

  it("spends nothing", () => {
    expect(fetcher.liveRequestCount).toBe(0);
  });

  /**
   * 🔑 **On real pages, not a fixture.** `alternativesFor` is pure and unit
   * tested, but whether a real run has runners-up worth offering at all is a
   * property of the corpus — a pipeline that reported one candidate per item
   * would satisfy every unit test and leave the swap control dead.
   */
  it("offers runners-up on the real corpus, and only above the floor", () => {
    const reported = resolutions.filter(
      ({ resolution }) => resolution?.match != null,
    );
    expect(reported.length).toBeGreaterThan(0);

    const withAlternatives = reported.filter(
      ({ resolution }) => (resolution?.alternatives.length ?? 0) > 0,
    );
    // Not every item has a plausible second candidate, and that is honest —
    // but if NONE did, this row would have changed nothing observable.
    expect(withAlternatives.length).toBeGreaterThan(0);

    for (const { resolution } of reported) {
      for (const alt of resolution?.alternatives ?? []) {
        // 🔴 The floor the chosen candidate had to clear.
        expect(alt.score).toBeGreaterThanOrEqual(MIN_EVIDENCE_TO_REPORT);
        // 🔴 And never the chosen listing itself.
        expect(alt.url).not.toBe(resolution?.match?.url);
        // Every one says what is known about its barcode, and says why.
        expect(["disagreed", "absent", "unprobed"]).toContain(alt.barcodeState);
        expect(alt.reasonRankedLower.length).toBeGreaterThan(0);
      }
      // Ordered best first, by the same ranking.
      const scores = (resolution?.alternatives ?? []).map((a) => a.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
      expect(scores.length).toBeLessThanOrEqual(MAX_ALTERNATIVES);
    }
  });

  /**
   * 🔴 A `not-found` has no pairing to swap, so offering a list of things to
   * swap it for would be a screen inventing a decision.
   */
  /**
   * 🔴 **This check exists because a mutation proved the one above did not
   * cover it.** Deleting the line that records what each probe published left
   * that check green — it asserted only that `barcodeState` was one of three
   * values, and `unprobed` is one of three.
   *
   * Measured on this corpus before being asserted: **71 alternatives across
   * 18 rows — 12 `disagreed`, 6 `absent`, 53 `unprobed`**. So all three
   * states genuinely occur here and all three can be required.
   *
   * ⚠️ Asserted as *at least one of each* rather than the exact counts: the
   * counts are a property of this corpus and would make a legitimate ranking
   * change look like a regression, while nought `disagreed` means the probe
   * recording is gone.
   */
  it("records what each probe published, on real pages", () => {
    const states = { disagreed: 0, absent: 0, unprobed: 0 };
    for (const { resolution } of resolutions) {
      for (const alt of resolution?.alternatives ?? []) {
        states[alt.barcodeState] += 1;
      }
    }

    // 🔴 A probed alternative whose barcode disagreed. Nought here means
    // nothing is recording probe outcomes, and every alternative is claiming
    // nobody looked.
    expect(states.disagreed).toBeGreaterThan(0);
    // 🔴 And a probed one that published none — the distinction that would
    // otherwise collapse into a mismatch. 91 of 255 captured pages are like
    // this.
    expect(states.absent).toBeGreaterThan(0);
    // 🔑 And most are unprobed, which is the honest shape: probes are the
    // expensive part, measured at 2.70 per row against a ceiling of eight.
    expect(states.unprobed).toBeGreaterThan(states.disagreed + states.absent);

    // A probed alternative carries the barcode it published; an unprobed one
    // carries none, because nothing was read.
    for (const { resolution } of resolutions) {
      for (const alt of resolution?.alternatives ?? []) {
        if (alt.barcodeState === "disagreed") {
          expect(alt.retailerBarcode).not.toBeNull();
        } else {
          expect(alt.retailerBarcode).toBeNull();
        }
      }
    }
  });

  it("offers nothing on a row that resolved nothing", () => {
    const misses = resolutions.filter(
      ({ resolution }) => resolution != null && resolution.match === null,
    );
    expect(misses.length).toBeGreaterThan(0);
    for (const { resolution } of misses) {
      expect(resolution?.alternatives).toEqual([]);
    }
  });

  it("records identity provenance on every resolution that has an identity", () => {
    for (const { resolution } of resolutions) {
      if (resolution?.identity == null) continue;
      expect([
        "client-catalogue",
        "barcode-derived",
        "search-inference",
      ]).toContain(resolution.identity.provenance);
    }
  });
});
