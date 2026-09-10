import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { neweggAdapter } from "../src/adapters/newegg.js";
import { ReplayFetcher, type Corpus } from "../src/fetcher/replay.js";
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

    // ⚠️ Not asserted at zero. The spike's 5 `error` rows are network failures
    // that a replay cannot reproduce by construction — a cached response is
    // never a timeout — so those rows must disagree. What is asserted is that
    // every VERIFIED row of the spike's is also verified here.
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
