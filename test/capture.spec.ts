import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CaptureBudget } from "../src/capture/budget.js";
import {
  Capturer,
  tallyCaptures,
  type CaptureUploadOutcome,
} from "../src/capture/capturer.js";
import {
  artifactFrom,
  CAPTURE_DISABLED,
  parseCapturePolicy,
  type CaptureArtifact,
  type CapturePolicy,
} from "../src/capture/types.js";
import type { Fetcher } from "../src/fetcher/types.js";
import { FetchFailed } from "../src/fetcher/types.js";
import type { Resolution } from "../src/resolve.js";

/**
 * Evidence: what gets captured, what it costs, and what happens when it fails.
 *
 * 🔴 **The artefact is the page's BYTES, not an image**, and these checks are
 * written against that. This runtime has no browser and cannot get one that
 * works: the proxy exists because the retailer refuses a plain request, so a
 * headless Chromium in a k8s Job would fail on exactly the sites this is for.
 * `png` is in the union and no code path produces it — asserted below.
 *
 * ⚠️ **The gateway seam is faked and that is the boundary, not a shortcut.**
 * Storing the bytes and enforcing the organization's quota belong to
 * `insights-screenshot-library`; what is provable here is that this run
 * captures the right page, keeps to the budget it was handed, and records where
 * the gateway said it went.
 */

const PAGE = "<html><body>a competitor product page</body></html>";

const resolution = (over: Partial<Resolution> = {}): Resolution =>
  ({
    barcode: "649532609635",
    clientSku: "SKU-001",
    outcome: "verified",
    identity: null,
    queriesTried: [],
    candidatesSeen: 1,
    probes: 1,
    requests: 2,
    match: {
      itemId: "N82E16820233852",
      url: "https://www.newegg.com/p/N82E16820233852",
      title: "CyberPower CP1350PFCLCD",
      brand: "CyberPower",
      model: "CP1350PFCLCD",
      priceCents: 18999,
      inStock: true,
      isFirstParty: true,
      sellerName: "Newegg",
      retailerBarcode: "649532609635",
      score: 7,
    },
    failure: null,
    ...over,
  }) as unknown as Resolution;

/** A second listing, for checks that must not be served from the accepted set. */
const otherPage = {
  itemId: "N82E16820233999",
  url: "https://www.newegg.com/p/N82E16820233999",
  title: "Another product",
  brand: "CyberPower",
  model: "CP900",
  priceCents: 9999,
  inStock: true,
  isFirstParty: true,
  sellerName: "Newegg",
  retailerBarcode: "884102021862",
  score: 6,
} as unknown as NonNullable<Resolution["match"]>;

/** A fetcher serving one page, counting how often it was asked. */
function fakeFetcher(
  body: string | Error = PAGE,
): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    liveRequestCount: 0,
    fetch: (url: string) => {
      calls.push(url);
      if (body instanceof Error) return Promise.reject(body);
      // `cached: true` is the ordinary case — the page was fetched moments ago.
      return Promise.resolve({ url, body, cached: true });
    },
  };
}

interface Uploaded {
  clientSku: string;
  barcode: string;
  artifact: CaptureArtifact;
}

function fakeUpload(
  outcome: CaptureUploadOutcome | Error = {
    kind: "stored",
    storageKey: "org/run/abc123",
  },
) {
  const sent: Uploaded[] = [];
  return {
    sent,
    upload: (args: Uploaded): Promise<CaptureUploadOutcome> => {
      sent.push(args);
      if (outcome instanceof Error) return Promise.reject(outcome);
      return Promise.resolve(outcome);
    },
  };
}

const ENABLED: CapturePolicy = {
  enabled: true,
  budget: 10,
  format: "page_html",
};

describe("the capture budget", () => {
  it("allows up to its limit and refuses after it", () => {
    const budget = new CaptureBudget(2, true);
    expect(budget.request().kind).toBe("allowed");
    expect(budget.request().kind).toBe("allowed");
    expect(budget.request()).toEqual({ kind: "exhausted", limit: 2 });
    expect(budget.spent).toBe(2);
    expect(budget.remaining).toBe(0);
  });

  /**
   * 🔑 "Never asked for" and "asked for and none left" are different answers to
   * an operator — one is a switch, the other is a quota.
   */
  it("tells a disabled budget apart from an exhausted one", () => {
    expect(new CaptureBudget(10, false).request()).toEqual({
      kind: "disabled",
    });
    expect(new CaptureBudget(0, true).request()).toEqual({
      kind: "exhausted",
      limit: 0,
    });
  });

  it("hands a capture back when it never happened", () => {
    const budget = new CaptureBudget(1, true);
    expect(budget.request().kind).toBe("allowed");
    budget.refund();
    // 🔑 Without the refund, a bad half-hour of gateway 500s would silently eat
    // a whole organization's quota and skip evidence for everything after.
    expect(budget.request().kind).toBe("allowed");
  });

  it("cannot be refunded below zero", () => {
    const budget = new CaptureBudget(1, true);
    budget.refund();
    budget.refund();
    expect(budget.spent).toBe(0);
    expect(budget.request().kind).toBe("allowed");
    expect(budget.request().kind).toBe("exhausted");
  });

  it("reports nothing remaining when disabled, whatever the limit", () => {
    expect(new CaptureBudget(50, false).remaining).toBe(0);
  });
});

describe("the capture artefact", () => {
  it("hashes the bytes, not the base64", () => {
    const artifact = artifactFrom({ sourceUrl: "u", body: PAGE });
    const expected = createHash("sha256")
      .update(Buffer.from(PAGE, "utf8"))
      .digest("hex");
    expect(artifact.sha256).toBe(expected);
    expect(artifact.byteSize).toBe(Buffer.byteLength(PAGE, "utf8"));
  });

  it("round-trips the page byte for byte", () => {
    const artifact = artifactFrom({ sourceUrl: "u", body: PAGE });
    expect(Buffer.from(artifact.contentBase64, "base64").toString("utf8")).toBe(
      PAGE,
    );
  });

  /** A hash that did not move with the bytes would let a changed page pass as the stored one. */
  it("changes when the bytes change", () => {
    const a = artifactFrom({ sourceUrl: "u", body: PAGE });
    const b = artifactFrom({ sourceUrl: "u", body: `${PAGE} ` });
    expect(a.sha256).not.toBe(b.sha256);
  });

  it("counts bytes rather than characters", () => {
    // Two characters, four bytes. A `.length` would report 2 and the gateway
    // would size its storage against a number that is not the payload.
    const artifact = artifactFrom({ sourceUrl: "u", body: "€€" });
    expect(artifact.byteSize).toBe(6);
  });
});

describe("reading the capture policy off a job", () => {
  it("treats an absent block as disabled", () => {
    expect(parseCapturePolicy(undefined, "r")).toEqual(CAPTURE_DISABLED);
    expect(parseCapturePolicy(null, "r")).toEqual(CAPTURE_DISABLED);
    expect(CAPTURE_DISABLED.enabled).toBe(false);
  });

  it("reads a well-formed block", () => {
    expect(parseCapturePolicy({ enabled: true, budget: 25 }, "r")).toEqual({
      enabled: true,
      budget: 25,
      format: "page_html",
    });
  });

  /**
   * ⚠️ Tolerant of absence, strict about presence. A malformed block is two
   * builds disagreeing about a budget, and reading it as "no captures" would
   * hide a real mismatch behind a plausible default.
   */
  it("refuses a malformed block rather than defaulting it away", () => {
    expect(() => parseCapturePolicy({ budget: 5 }, "r")).toThrow(
      /no boolean 'enabled'/,
    );
    expect(() =>
      parseCapturePolicy({ enabled: true, budget: -1 }, "r"),
    ).toThrow(/non-negative integer/);
    expect(() =>
      parseCapturePolicy({ enabled: true, budget: 1.5 }, "r"),
    ).toThrow(/non-negative integer/);
    expect(() => parseCapturePolicy("yes", "r")).toThrow(/not an object/);
  });

  it("accepts a zero budget, which is not the same as disabled", () => {
    expect(parseCapturePolicy({ enabled: true, budget: 0 }, "r")).toEqual({
      enabled: true,
      budget: 0,
      format: "page_html",
    });
  });

  /**
   * 🔴 **This check asserted the OPPOSITE until 2026-09-13, and was right to
   * go red.** It read "refuses a png request, because no code path produces
   * one", pinning a refusal whose stated reason was that the runtime "holds no
   * browser". It does not need one: the proxy renders the page on its own
   * side for one extra field on the request already being made. Measured on a
   * real Amazon page — 2,994,302 bytes, 1529 × 10,621.
   *
   * Kept as an ACCEPTANCE rather than deleted, so the reversal is visible to
   * whoever reads this file next.
   */
  it("accepts a png request, which the proxy renders", () => {
    expect(
      parseCapturePolicy({ enabled: true, budget: 1, format: "png" }, "r"),
    ).toMatchObject({ enabled: true, budget: 1, format: "png" });
  });

  it("refuses a format it does not know", () => {
    expect(() =>
      parseCapturePolicy({ enabled: true, budget: 1, format: "pdf" }, "r"),
    ).toThrow(/does not know/);
  });
});

describe("capturing a resolution's page", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(path.join(tmpdir(), "capture-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const build = async (
    over: {
      policy?: CapturePolicy;
      fetcher?: ReturnType<typeof fakeFetcher>;
      upload?: ReturnType<typeof fakeUpload>;
      isSelected?: (clientSku: string) => boolean;
    } = {},
  ) => {
    const fetcher = over.fetcher ?? fakeFetcher();
    const upload = over.upload ?? fakeUpload();
    const capturer = new Capturer({
      policy: over.policy ?? ENABLED,
      // Selected unless a check says otherwise: these are checks about the
      // MECHANISM. Which items a rule chooses is the gateway's, and the
      // unselected path has its own checks below.
      isSelected: over.isSelected ?? (() => true),
      fetcher,
      runDir,
      upload: upload.upload,
      log: () => undefined,
    });
    await capturer.load();
    return { capturer, fetcher, upload };
  };

  const journal = async (): Promise<Record<string, unknown>[]> => {
    const text = await readFile(
      path.join(runDir, "captures.jsonl"),
      "utf8",
    ).catch(() => "");
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  it("captures the page the resolution was decided on, once", async () => {
    const { capturer, fetcher, upload } = await build();
    const record = await capturer.offer(resolution());

    expect(record.state).toBe("captured");
    expect(record.sourceUrl).toBe("https://www.newegg.com/p/N82E16820233852");
    expect(record.storageKey).toBe("org/run/abc123");
    expect(upload.sent).toHaveLength(1);
    expect(fetcher.calls).toEqual(["https://www.newegg.com/p/N82E16820233852"]);
  });

  it("posts the bytes the run actually read", async () => {
    const { capturer, upload } = await build();
    await capturer.offer(resolution());

    const sent = upload.sent[0];
    expect(sent).toBeDefined();
    expect(
      Buffer.from(sent!.artifact.contentBase64, "base64").toString("utf8"),
    ).toBe(PAGE);
    expect(sent!.artifact.format).toBe("page_html");
    expect(sent!.clientSku).toBe("SKU-001");
  });

  /**
   * 🔑 An outcome with no chosen page has nothing to be evidence OF. Recorded
   * as skipped rather than failed, because nothing went wrong.
   */
  it("captures nothing for an outcome with no chosen page", async () => {
    const { capturer, fetcher, upload } = await build();
    const record = await capturer.offer(
      resolution({ match: null, outcome: "not-found" }),
    );

    expect(record.state).toBe("skipped_disabled");
    expect(record.sourceUrl).toBeNull();
    expect(fetcher.calls).toEqual([]);
    expect(upload.sent).toEqual([]);
    expect(capturer.spent).toBe(0);
  });

  it("captures nothing when the job asked for none", async () => {
    const { capturer, fetcher, upload } = await build({
      policy: CAPTURE_DISABLED,
    });
    const record = await capturer.offer(resolution());

    expect(record.state).toBe("skipped_disabled");
    // 🔑 The url is still recorded — a reviewer can see WHICH page would have
    // been kept, which is what makes "turn captures on" an actionable answer.
    expect(record.sourceUrl).toBe("https://www.newegg.com/p/N82E16820233852");
    expect(fetcher.calls).toEqual([]);
    expect(upload.sent).toEqual([]);
  });

  /**
   * 🔑 **The budget is taken before the page is read and before anything is
   * posted.** Checked afterwards it would be a report, not a budget — the page
   * would already be fetched, posted and stored.
   */
  it("refuses over budget before reading or posting anything", async () => {
    const { capturer, fetcher, upload } = await build({
      policy: { ...ENABLED, budget: 1 },
    });

    const first = await capturer.offer(resolution({ clientSku: "SKU-001" }));
    // ⚠️ A DIFFERENT page, deliberately. Offering the same url twice is served
    // from the accepted set and never reaches the budget at all — which is
    // correct behaviour and made this check pass on a `captured` record the
    // first time it was written.
    const second = await capturer.offer(
      resolution({ clientSku: "SKU-002", match: otherPage }),
    );

    expect(first.state).toBe("captured");
    expect(second.state).toBe("skipped_quota");
    expect(second.storageKey).toBeNull();
    // The refusal spent nothing: one fetch, one upload.
    expect(fetcher.calls).toHaveLength(1);
    expect(upload.sent).toHaveLength(1);
  });

  it("keeps to a zero budget", async () => {
    const { capturer, upload } = await build({
      policy: { ...ENABLED, budget: 0 },
    });
    const record = await capturer.offer(resolution());
    expect(record.state).toBe("skipped_quota");
    expect(upload.sent).toEqual([]);
  });

  /** The url is the key, because two items can resolve to one listing. */
  it("stores one page once when two items resolve to it", async () => {
    const { capturer, upload } = await build();
    await capturer.offer(resolution({ clientSku: "SKU-001" }));
    const second = await capturer.offer(resolution({ clientSku: "SKU-002" }));

    expect(second.state).toBe("captured");
    expect(second.storageKey).toBe("org/run/abc123");
    expect(upload.sent).toHaveLength(1);
    // And the second item did not pay for it.
    expect(capturer.spent).toBe(1);
  });

  it("records where the gateway put it, in the journal", async () => {
    const { capturer } = await build();
    await capturer.offer(resolution());

    const lines = await journal();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      state: "captured",
      storageKey: "org/run/abc123",
      sourceUrl: "https://www.newegg.com/p/N82E16820233852",
    });
    expect(lines[0]!["sha256"]).toBeTypeOf("string");
  });

  /**
   * ⚠️ Journalled AFTER the gateway's answer. Written before it, a container
   * dying in the window would mark a page stored that never was, and a resume
   * would skip evidence nobody holds.
   */
  it("journals nothing for a capture the gateway did not accept", async () => {
    const { capturer } = await build({
      upload: fakeUpload({ kind: "refused", detail: "quota exhausted" }),
    });
    const record = await capturer.offer(resolution());

    expect(record.state).toBe("failed");
    expect(record.failureReason).toBe("quota exhausted");
    expect(await journal()).toEqual([]);
  });

  it("records a failure when the gateway cannot be reached, and refunds", async () => {
    const { capturer } = await build({
      policy: { ...ENABLED, budget: 1 },
      upload: fakeUpload({ kind: "unreachable", detail: "ECONNRESET" }),
    });

    const first = await capturer.offer(resolution({ clientSku: "SKU-001" }));
    expect(first.state).toBe("failed");
    expect(first.failureReason).toBe("ECONNRESET");
    // 🔑 Refunded: nothing was stored, so the next item still gets its chance.
    // Without this a gateway blip would silently consume a whole quota.
    const second = await capturer.offer(resolution({ clientSku: "SKU-002" }));
    expect(second.state).toBe("failed");
    expect(capturer.spent).toBe(0);
  });

  /** ⚠️ The upload seam may throw; a capture may not take the run down. */
  it("survives an upload that throws", async () => {
    const { capturer } = await build({
      upload: fakeUpload(new Error("the socket exploded")),
    });
    const record = await capturer.offer(resolution());
    expect(record.state).toBe("failed");
    expect(record.failureReason).toContain("the socket exploded");
  });

  it("records a failure when the page cannot be re-read", async () => {
    const { capturer, upload } = await build({
      fetcher: fakeFetcher(new FetchFailed("https://x.invalid")),
    });
    const record = await capturer.offer(resolution());

    expect(record.state).toBe("failed");
    expect(record.failureReason).toMatch(/could not re-read the page/);
    expect(upload.sent).toEqual([]);
    // The page was never stored, so the budget is handed back.
    expect(capturer.spent).toBe(0);
  });

  /**
   * 🔴 The finding is the product; the evidence is a convenience. Every path
   * above returns a record and none throws — asserted as one property, because
   * a single path that threw would abandon a paid finding.
   */
  it("never throws, whatever fails", async () => {
    const cases: (() => Promise<unknown>)[] = [
      async () => {
        const { capturer } = await build({
          upload: fakeUpload(new Error("boom")),
        });
        return capturer.offer(resolution());
      },
      async () => {
        const { capturer } = await build({
          fetcher: fakeFetcher(new Error("no page")),
        });
        return capturer.offer(resolution());
      },
      async () => {
        const { capturer } = await build({
          upload: fakeUpload({ kind: "refused", detail: "400" }),
        });
        return capturer.offer(resolution());
      },
    ];
    for (const run of cases) {
      await expect(run()).resolves.toBeDefined();
    }
  });

  /** A journal written before it was read would have a wrong suppression set. */
  it("refuses to offer before its journal has been read", async () => {
    const capturer = new Capturer({
      policy: ENABLED,
      isSelected: () => true,
      fetcher: fakeFetcher(),
      runDir,
      upload: fakeUpload().upload,
      log: () => undefined,
    });
    await expect(capturer.offer(resolution())).rejects.toThrow(
      /load\(\) must be called/,
    );
  });

  /**
   * 🔴 A budget says HOW MANY; only the rules say WHICH. A run with a budget
   * and no per-item answer captures the first budget-many findings it happens
   * to make — exactly the "whatever the run happened to do" that selection
   * rules exist to replace.
   */
  it("captures nothing for an item no rule chose", async () => {
    const { capturer, fetcher, upload } = await build({
      isSelected: (sku) => sku === "SKU-999",
    });
    const record = await capturer.offer(resolution({ clientSku: "SKU-001" }));

    expect(record.state).toBe("skipped_unselected");
    expect(record.sourceUrl).toBe("https://www.newegg.com/p/N82E16820233852");
    expect(fetcher.calls).toEqual([]);
    expect(upload.sent).toEqual([]);
  });

  /**
   * 🔴 An unselected item is a DIFFERENT answer from an exhausted budget, and
   * it must not consume one: reporting it as a quota refusal would send an
   * operator to raise a budget that was never the reason.
   */
  it("does not charge the budget for an item no rule chose", async () => {
    const { capturer, upload } = await build({
      policy: { ...ENABLED, budget: 1 },
      isSelected: (sku) => sku !== "SKU-001",
    });

    const skipped = await capturer.offer(resolution({ clientSku: "SKU-001" }));
    const kept = await capturer.offer(
      resolution({ clientSku: "SKU-002", match: otherPage }),
    );

    expect(skipped.state).toBe("skipped_unselected");
    expect(kept.state).toBe("captured");
    expect(capturer.spent).toBe(1);
    expect(upload.sent).toHaveLength(1);
  });

  it("tallies what happened, by state", async () => {
    const { capturer } = await build({ policy: { ...ENABLED, budget: 1 } });
    await capturer.offer(resolution({ clientSku: "A" }));
    await capturer.offer(
      resolution({ clientSku: "B", match: null, outcome: "not-found" }),
    );
    await capturer.offer(resolution({ clientSku: "C" }));

    expect(tallyCaptures(capturer.records)).toEqual({
      // A stored the page; C resolved to the SAME page, so it is served from
      // the accepted set — captured, and without paying a second time.
      captured: 2,
      failed: 0,
      // ⚠️ Zero even though the budget was 1, precisely because C cost nothing.
      skipped_quota: 0,
      // B had no chosen page, so there was nothing to be evidence of.
      skipped_disabled: 1,
      skipped_unselected: 0,
    });
    expect(capturer.spent).toBe(1);
  });
  /**
   * A `png` policy takes a picture instead of keeping the markup.
   *
   * 🔴 **This branch was a `throw` until 2026-09-13**, on the reasoning that the
   * runtime holds no browser. It does not need one: the proxy renders the page
   * on its own side for one extra field on the request already being made. The
   * Screenshots screen had been drawing a MOCK of a page beside real stored
   * bytes, which is worse than showing nothing.
   */
  describe("a png capture", () => {
    const PNG_BYTES = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9,
    ]);

    /** A fetcher that can also be asked for a picture. */
    const shotFetcher = () => {
      const shots: string[] = [];
      const pages: string[] = [];
      return {
        shots,
        pages,
        // The builder's type expects a `calls` array. A png run makes no
        // page reads, so it stays empty — which the CONTROL below asserts.
        calls: pages,
        liveRequestCount: 0,
        fetch: (url: string) => {
          pages.push(url);
          return Promise.resolve({ url, body: PAGE, cached: true });
        },
        fetchScreenshot: (url: string) => {
          shots.push(url);
          return Promise.resolve(PNG_BYTES);
        },
      };
    };

    it("asks for a screenshot and never re-reads the markup", async () => {
      const fetcher = shotFetcher();
      const { capturer, upload } = await build({
        policy: { ...ENABLED, format: "png" },
        fetcher,
      });
      await capturer.offer(resolution());

      expect(fetcher.shots).toHaveLength(1);
      // 🔴 The page read would be a second paid request for bytes we discard.
      expect(fetcher.pages).toHaveLength(0);
      expect(upload.sent).toHaveLength(1);
      expect(upload.sent[0]?.artifact.format).toBe("png");
    });

    /**
     * 🔴 The check that matters most. Decoding image bytes as UTF-8 replaces
     * every byte outside ASCII with U+FFFD, so the artefact would be a CORRUPT
     * png carrying a sha256 the gateway verifies happily — evidence that proves
     * nothing, with a valid-looking hash on it.
     */
    it("stores the bytes verbatim, not through a utf-8 decode", async () => {
      const { capturer, upload } = await build({
        policy: { ...ENABLED, format: "png" },
        fetcher: shotFetcher(),
      });
      await capturer.offer(resolution());

      const stored = Buffer.from(
        upload.sent[0]!.artifact.contentBase64,
        "base64",
      );
      expect(Array.from(stored)).toEqual(Array.from(PNG_BYTES));
      expect(upload.sent[0]?.artifact.byteSize).toBe(PNG_BYTES.length);
    });

    it("still keeps the markup when the policy asks for html — the CONTROL", async () => {
      // Without this, a capturer hard-wired to screenshots would pass both
      // checks above while silently ending html capture for everyone.
      const fetcher = shotFetcher();
      const { capturer, upload } = await build({ policy: ENABLED, fetcher });
      await capturer.offer(resolution());

      expect(fetcher.shots).toHaveLength(0);
      expect(fetcher.pages).toHaveLength(1);
      expect(upload.sent[0]?.artifact.format).toBe("page_html");
    });
  });
});

describe("resuming a run that already captured", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(path.join(tmpdir(), "capture-resume-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const capturerIn = async (upload: ReturnType<typeof fakeUpload>) => {
    const capturer = new Capturer({
      policy: ENABLED,
      isSelected: () => true,
      fetcher: fakeFetcher(),
      runDir,
      upload: upload.upload,
      log: () => undefined,
    });
    await capturer.load();
    return capturer;
  };

  /**
   * 🔑 The same at-least-once-to-an-idempotent-receiver shape the findings use.
   * Without the journal a resumed run re-posts every page it already stored.
   */
  it("does not re-post a page the gateway already accepted", async () => {
    const first = fakeUpload();
    const one = await capturerIn(first);
    await one.offer(resolution());
    expect(first.sent).toHaveLength(1);

    const second = fakeUpload();
    const two = await capturerIn(second);
    expect(two.acceptedCount).toBe(1);
    const record = await two.offer(resolution());

    expect(record.state).toBe("captured");
    expect(record.storageKey).toBe("org/run/abc123");
    expect(second.sent).toEqual([]);
    // And it did not charge the resumed run's budget for it either.
    expect(two.spent).toBe(0);
  });

  /**
   * ⚠️ A FAILED capture is worth another go on a resume — only an accepted one
   * suppresses a retry. Otherwise a gateway outage would permanently lose the
   * evidence for every item resolved during it.
   */
  it("retries a capture that failed the first time", async () => {
    const failing = fakeUpload({ kind: "unreachable", detail: "down" });
    const one = await capturerIn(failing);
    await one.offer(resolution());

    const working = fakeUpload();
    const two = await capturerIn(working);
    expect(two.acceptedCount).toBe(0);
    const record = await two.offer(resolution());

    expect(record.state).toBe("captured");
    expect(working.sent).toHaveLength(1);
  });
});
