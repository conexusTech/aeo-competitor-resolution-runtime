import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReportOutcome } from "../src/gateway/client.js";
import {
  FLUSH_AT,
  GatewayReporter,
  REPORTED_JOURNAL,
  readReported,
} from "../src/reporting/reporter.js";
import type { Resolution } from "../src/resolve.js";

/**
 * Streaming findings, and remembering what was accepted.
 *
 * 🔴 **The ordering is the whole correctness argument, so it is what these
 * check.** The acknowledgement is written only after the gateway's 200:
 *
 * - Written **before**, a container dying in that window loses the finding
 *   permanently — journalled so never re-resolved, marked reported so never
 *   re-sent, and the client's item stays unresolved with nothing explaining it.
 * - Written **after**, a death in that window re-sends on resume, which the
 *   gateway's unique index turns into a no-op.
 *
 * At-least-once delivery to an idempotent receiver is the only pair that cannot
 * lose data. Everything below is one half of that pair.
 *
 * ⚠️ Real files in a real temp directory. A journal is the thing under test, and
 * a mocked filesystem would only prove the calls were made.
 */

const applied: ReportOutcome = { kind: "applied" };
const unreachable: ReportOutcome = {
  kind: "unreachable",
  detail: "ECONNRESET",
};
const refused: ReportOutcome = { kind: "refused", status: 400, detail: "bad" };
const runGone: ReportOutcome = { kind: "run-gone", detail: "cancelled" };

const resolution = (clientSku: string): Resolution =>
  ({
    barcode: "649532609635",
    clientSku,
    outcome: "verified",
    identity: null,
    queriesTried: [],
    candidatesSeen: 1,
    probes: 1,
    requests: 2,
    match: null,
    failure: null,
  }) as unknown as Resolution;

/** A gateway double that records what it was asked and answers as told. */
function fakeGateway(answers: ReportOutcome[] = []) {
  const sent: string[][] = [];
  const events: string[] = [];
  let i = 0;
  const next = (): ReportOutcome =>
    answers[Math.min(i++, answers.length - 1)] ?? applied;

  return {
    sent,
    events,
    client: {
      reportResolutions: (batch: readonly Resolution[]) => {
        sent.push(batch.map((r) => r.clientSku));
        return Promise.resolve(next());
      },
      reportProgress: () => {
        events.push("progress");
        return Promise.resolve(next());
      },
      reportCompleted: () => {
        events.push("completed");
        return Promise.resolve(applied);
      },
      reportError: () => {
        events.push("error");
        return Promise.resolve(applied);
      },
    },
  };
}

const makeReporter = (
  dir: string,
  answers: ReportOutcome[] = [],
  flushAt = 2,
) => {
  const gateway = fakeGateway(answers);
  const reporter = new GatewayReporter(gateway.client as never, {
    runDir: dir,
    flushAt,
    log: () => {},
  });
  return { gateway, reporter };
};

describe("the reporter", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "resolution-reporter-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const journal = () => path.join(dir, REPORTED_JOURNAL);

  // ── Streaming ───────────────────────────────────────────────────────

  it("batches up to the flush threshold and sends once", async () => {
    const { gateway, reporter } = makeReporter(dir, [], 3);
    await reporter.load();
    await reporter.offer(resolution("A"));
    await reporter.offer(resolution("B"));
    expect(gateway.sent).toHaveLength(0); // still buffered
    await reporter.offer(resolution("C"));
    expect(gateway.sent).toEqual([["A", "B", "C"]]);
  });

  it("never buffers past the gateway's own cap, whatever it is asked for", async () => {
    // A caller asking for 10,000 would produce a batch the gateway answers with
    // a non-retryable 400 — losing every finding in it.
    const { reporter } = makeReporter(dir, [], 10_000);
    await reporter.load();
    expect(FLUSH_AT).toBeLessThanOrEqual(250);
    // Offering 251 must have flushed at least once by now rather than holding
    // them all.
    const gateway = fakeGateway();
    const bounded = new GatewayReporter(gateway.client as never, {
      runDir: dir,
      flushAt: 10_000,
      log: () => {},
    });
    await bounded.load();
    for (let i = 0; i < 251; i++) await bounded.offer(resolution(`S-${i}`));
    expect(gateway.sent.length).toBeGreaterThan(0);
    expect(Math.max(...gateway.sent.map((b) => b.length))).toBeLessThanOrEqual(
      250,
    );
  });

  it("flushes the remainder on demand", async () => {
    const { gateway, reporter } = makeReporter(dir, [], 100);
    await reporter.load();
    await reporter.offer(resolution("A"));
    await reporter.flush();
    expect(gateway.sent).toEqual([["A"]]);
  });

  // ── The ordering that cannot lose data ──────────────────────────────

  it("records an acknowledgement ONLY after the gateway accepts", async () => {
    const { reporter } = makeReporter(dir, [applied], 1);
    await reporter.load();
    await reporter.offer(resolution("A"));
    const lines = (await readFile(journal(), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ clientSku: "A" });
  });

  it("records NOTHING when the gateway could not be reached", async () => {
    // 🔴 The case that would lose data if the order were reversed. Not
    // acknowledged means a resumed run re-sends, which the gateway drops.
    const { gateway, reporter } = makeReporter(dir, [unreachable], 1);
    await reporter.load();
    await reporter.offer(resolution("A"));
    expect(gateway.sent).toEqual([["A"]]); // it tried
    await expect(readFile(journal(), "utf8")).rejects.toThrow(); // and recorded nothing
    expect(reporter.wasReported("A")).toBe(false);
  });

  it("records nothing when the gateway refused the batch", async () => {
    const { reporter } = makeReporter(dir, [refused], 1);
    await reporter.load();
    await reporter.offer(resolution("A"));
    expect(reporter.wasReported("A")).toBe(false);
  });

  // ── Resume ──────────────────────────────────────────────────────────

  it("re-reports nothing the gateway already accepted", async () => {
    // The exit criterion's second half. A first run files A and B; a resumed run
    // over the same list must send neither.
    const first = makeReporter(dir, [applied], 1);
    await first.reporter.load();
    await first.reporter.offer(resolution("A"));
    await first.reporter.offer(resolution("B"));
    expect(first.gateway.sent).toEqual([["A"], ["B"]]);

    const second = makeReporter(dir, [applied], 1);
    await second.reporter.load();
    expect(second.reporter.acknowledgedCount).toBe(2);
    await second.reporter.offer(resolution("A"));
    await second.reporter.offer(resolution("B"));
    expect(second.gateway.sent).toEqual([]);
  });

  it("DOES re-report a finding that was journalled but never accepted", async () => {
    // 🔑 The other side, and the one that makes the first safe. Dropping these
    // too would mean a gateway outage silently lost every finding made during
    // it — which is exactly the data loss the ordering exists to prevent.
    const first = makeReporter(dir, [unreachable], 1);
    await first.reporter.load();
    await first.reporter.offer(resolution("A"));

    const second = makeReporter(dir, [applied], 1);
    await second.reporter.load();
    expect(second.reporter.acknowledgedCount).toBe(0);
    await second.reporter.offer(resolution("A"));
    expect(second.gateway.sent).toEqual([["A"]]);
  });

  it("sends only the unacknowledged half of a mixed resume", async () => {
    await writeFile(
      journal(),
      `${JSON.stringify({ clientSku: "A", at: "2026-09-10T00:00:00Z" })}\n`,
      "utf8",
    );
    const { gateway, reporter } = makeReporter(dir, [applied], 5);
    await reporter.load();
    await reporter.offer(resolution("A"));
    await reporter.offer(resolution("B"));
    await reporter.flush();
    expect(gateway.sent).toEqual([["B"]]);
  });

  it("survives a truncated final line, which is what a kill leaves behind", async () => {
    // The same rule `readJournal` applies, and the cost of skipping is one
    // re-sent finding the gateway drops — against refusing to start at all.
    await writeFile(
      journal(),
      `${JSON.stringify({ clientSku: "A", at: "z" })}\n{"clientSku":"B"`,
      "utf8",
    );
    const acknowledged = await readReported(journal());
    expect([...acknowledged]).toEqual(["A"]);
  });

  it("reads an absent journal as an empty set, not as an error", async () => {
    expect((await readReported(path.join(dir, "nope.jsonl"))).size).toBe(0);
  });

  // ── Reporting never kills a run ─────────────────────────────────────

  it("keeps going after the gateway becomes unreachable", async () => {
    const { gateway, reporter } = makeReporter(dir, [unreachable], 1);
    await reporter.load();
    await reporter.offer(resolution("A"));
    // ⚠️ Still reporting: an outage is transient by definition, and the next
    // batch may land.
    expect(reporter.isReporting).toBe(true);
    await reporter.offer(resolution("B"));
    expect(gateway.sent).toEqual([["A"], ["B"]]);
  });

  it("stops reporting after a refusal, and keeps the run alive", async () => {
    // A 400 says the shapes disagree; no retry fixes that, and continuing to
    // post is noise. But the run keeps journalling, so a later resume re-sends
    // once the two builds agree.
    const { gateway, reporter } = makeReporter(dir, [refused], 1);
    await reporter.load();
    await reporter.offer(resolution("A"));
    expect(reporter.isReporting).toBe(false);
    await reporter.offer(resolution("B"));
    expect(gateway.sent).toEqual([["A"]]);
    expect(reporter.isRunGone).toBe(false);
  });

  it("says the run is gone so the caller can stop spending", async () => {
    const { reporter } = makeReporter(dir, [runGone], 1);
    await reporter.load();
    await reporter.offer(resolution("A"));
    expect(reporter.isRunGone).toBe(true);
    expect(reporter.isReporting).toBe(false);
  });

  it("does not throw into the run when the client throws", async () => {
    const throwing = {
      reportResolutions: () => Promise.reject(new Error("a programming error")),
      reportProgress: () => Promise.resolve(applied),
      reportCompleted: () => Promise.resolve(applied),
      reportError: () => Promise.resolve(applied),
    };
    const reporter = new GatewayReporter(throwing as never, {
      runDir: dir,
      flushAt: 1,
      log: () => {},
    });
    await reporter.load();
    await expect(reporter.offer(resolution("A"))).resolves.toBeUndefined();
  });

  it("treats a lost progress tick as a convenience, not a failure", async () => {
    const { reporter } = makeReporter(dir, [unreachable], 1);
    await reporter.load();
    await reporter.reportProgress({ itemsReported: 25, requestsSpent: 60 });
    // Losing a tick costs a stale number on a screen; disabling reporting over
    // it would cost the findings.
    expect(reporter.isReporting).toBe(true);
  });

  // ── Closing out ─────────────────────────────────────────────────────

  it("flushes before saying the run completed", async () => {
    // 🔑 The gateway's terminal guard DROPS a data event that arrives after a
    // terminal one, so a `completed` sent first would discard the last batch.
    const { gateway, reporter } = makeReporter(dir, [applied], 100);
    await reporter.load();
    await reporter.offer(resolution("A"));
    expect(gateway.sent).toHaveLength(0);
    await reporter.reportCompleted(4211);
    expect(gateway.sent).toEqual([["A"]]);
    expect(gateway.events).toEqual(["completed"]);
  });

  it("flushes before saying the run failed", async () => {
    // A crash after 4,000 items should file those 4,000 first — they were paid
    // for, and the gateway drops them once a terminal event has landed.
    const { gateway, reporter } = makeReporter(dir, [applied], 100);
    await reporter.load();
    await reporter.offer(resolution("A"));
    await reporter.reportError("boom");
    expect(gateway.sent).toEqual([["A"]]);
    expect(gateway.events).toEqual(["error"]);
  });

  it("still reports an error after a refusal disabled findings reporting", async () => {
    // ⚠️ Deliberately not gated on that: a 400 on a findings batch says the
    // resolutions disagree about their shape, which says nothing about whether
    // an error event can be delivered — and a run that dies silently is worse
    // than one that dies loudly.
    const { gateway, reporter } = makeReporter(dir, [refused], 1);
    await reporter.load();
    await reporter.offer(resolution("A"));
    expect(reporter.isReporting).toBe(false);
    await reporter.reportError("boom");
    expect(gateway.events).toContain("error");
  });

  it("does not report an error to a run the gateway says is gone", async () => {
    const { gateway, reporter } = makeReporter(dir, [runGone], 1);
    await reporter.load();
    await reporter.offer(resolution("A"));
    await reporter.reportError("boom");
    expect(gateway.events).not.toContain("error");
  });
});
