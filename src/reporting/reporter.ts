/**
 * Streaming a run's findings to the gateway as it goes, and remembering what
 * the gateway accepted.
 *
 * ── The two journals, and why there are two ────────────────────────────
 * `resolutions.jsonl` is what the run **found**, and it is what stops a resumed
 * run re-buying pages. `reported.jsonl` is what the gateway **accepted**, and it
 * is what stops a resumed run re-sending findings it already filed.
 *
 * 🔑 **They are separate because they answer different questions and fail at
 * different moments.** A finding is journalled the instant it exists, before
 * anyone has been told; an acknowledgement exists only after a round trip that
 * may never complete. Merging them would mean either writing "reported" before
 * it was true, or delaying the durable record until the network agreed.
 *
 * ── The ordering is the whole correctness argument ─────────────────────
 * 🔴 The acknowledgement is written **after** the gateway's 200, never before.
 *
 * - Write it **before**, and a container dying in that window loses the finding
 *   permanently: it is journalled, so it is never re-resolved, and it is marked
 *   reported, so it is never re-sent. The client's item stays unresolved with
 *   nothing anywhere explaining why.
 * - Write it **after**, and a death in that window re-sends on resume. The
 *   gateway's `(run_id, watchlist_item_id)` unique index plus
 *   `ON CONFLICT DO NOTHING` makes that a no-op answering `applied: 0`.
 *
 * **At-least-once delivery to an idempotent receiver is the only pair that
 * cannot lose data**, and the gateway was built to be that receiver.
 *
 * ── Reporting never kills a run ────────────────────────────────────────
 * ⚠️ A resolution run spends real money over hours. A gateway outage must not
 * throw that away: the findings are on disk, so a failed report is logged and
 * the run continues. The one exception is the gateway saying the **run itself is
 * gone** — then continuing to spend is pure waste, and the reporter says so.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  MAX_RESOLUTIONS_PER_EVENT,
  type GatewayClient,
  type ReportOutcome,
} from "../gateway/client.js";
import type { Resolution } from "../resolve.js";

/** Filename of the acknowledgement journal, beside the resolution journal. */
export const REPORTED_JOURNAL = "reported.jsonl";

/**
 * Findings buffered before a flush.
 *
 * Below the gateway's cap on purpose, so a flush is never refused for size —
 * and small enough that a killed container re-sends little. The cost of a
 * smaller batch is one more round trip per hundred items, against hours of
 * fetching.
 */
export const FLUSH_AT = 100;

/** One acknowledgement, as a line of the journal. */
interface AckLine {
  readonly clientSku: string;
  readonly at: string;
}

/**
 * The client SKUs the gateway has accepted for this run.
 *
 * A truncated final line is what a killed process leaves behind, and it is
 * skipped rather than fatal — the same rule `readJournal` applies, and the cost
 * of skipping is one re-sent finding that the gateway will drop.
 */
export async function readReported(journalPath: string): Promise<Set<string>> {
  const acknowledged = new Set<string>();
  let text: string;
  try {
    text = await readFile(journalPath, "utf8");
  } catch {
    return acknowledged; // first run
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const ack = JSON.parse(line) as AckLine;
      if (typeof ack.clientSku === "string" && ack.clientSku !== "") {
        acknowledged.add(ack.clientSku);
      }
    } catch {
      continue;
    }
  }
  return acknowledged;
}

export interface ReporterOptions {
  readonly runDir: string;
  /** Flush threshold; the gateway's cap is the ceiling. */
  readonly flushAt?: number;
  readonly log?: (message: string) => void;
}

/**
 * Buffers findings, sends them in batches, and journals what was accepted.
 *
 * Not reusable across runs: the acknowledgement journal is per run directory,
 * which is what makes a resume mean anything.
 */
export class GatewayReporter {
  private readonly buffer: Resolution[] = [];
  private readonly flushAt: number;
  private readonly journalPath: string;
  private readonly log: (message: string) => void;

  /** Set when the gateway refuses in a way retrying cannot fix. */
  private reportingDisabled = false;
  /** Set when the gateway says the run is gone. The caller stops the run. */
  private runGone = false;

  private acknowledged = new Set<string>();
  private sentCount = 0;

  constructor(
    private readonly client: GatewayClient,
    options: ReporterOptions,
  ) {
    this.flushAt = Math.min(
      options.flushAt ?? FLUSH_AT,
      MAX_RESOLUTIONS_PER_EVENT,
    );
    this.journalPath = path.join(options.runDir, REPORTED_JOURNAL);
    this.log = options.log ?? console.warn;
  }

  /** Whether the gateway has said this run no longer exists. */
  get isRunGone(): boolean {
    return this.runGone;
  }

  /** Whether anything is still being sent. */
  get isReporting(): boolean {
    return !this.reportingDisabled && !this.runGone;
  }

  /** Findings the gateway has accepted, this run and any earlier attempt. */
  get acknowledgedCount(): number {
    return this.acknowledged.size;
  }

  /** Load the acknowledgement journal. Call once, before the run starts. */
  async load(): Promise<void> {
    await mkdir(path.dirname(this.journalPath), { recursive: true });
    this.acknowledged = await readReported(this.journalPath);
  }

  /** Whether a finding has already been filed. */
  wasReported(clientSku: string): boolean {
    return this.acknowledged.has(clientSku);
  }

  /**
   * Offer one finding.
   *
   * ⚠️ Already-acknowledged findings are dropped here rather than sent and
   * deduped by the gateway. That is the difference the exit criterion asks for:
   * relying on the receiver's idempotency is *safe*, but it still re-sends —
   * and a resumed run over 8,926 items would re-post every finding it had
   * already filed.
   */
  async offer(resolution: Resolution): Promise<void> {
    if (!this.isReporting) return;
    if (this.acknowledged.has(resolution.clientSku)) return;
    this.buffer.push(resolution);
    if (this.buffer.length >= this.flushAt) await this.flush();
  }

  /** Send whatever is buffered. Total: never throws into the run. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.isReporting) return;
    const batch = this.buffer.splice(0, this.buffer.length);

    let outcome: ReportOutcome;
    try {
      outcome = await this.client.reportResolutions(batch);
    } catch (error) {
      // A throw here is a programming error rather than a network one — the
      // client only throws on an over-cap batch, which this cannot produce.
      // Logged and swallowed regardless: a reporting defect must not end a run.
      this.log(
        `could not report ${batch.length} finding(s): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    switch (outcome.kind) {
      case "applied":
        // 🔴 Only now. See the module docblock on why this ordering is the
        // whole correctness argument.
        await this.recordAcknowledged(batch);
        this.sentCount += batch.length;
        return;
      case "refused":
        this.reportingDisabled = true;
        this.log(
          `the gateway refused a findings batch with status ${outcome.status} ` +
            `and no retry can fix that (${outcome.detail}). Reporting is off ` +
            `for the rest of this run; the findings stay journalled, so a ` +
            `resumed run re-sends them once the shapes agree.`,
        );
        return;
      case "run-gone":
        this.runGone = true;
        this.log(
          `the gateway says this run is gone (${outcome.detail}) — stopping ` +
            `rather than spending more on findings nobody will accept`,
        );
        return;
      case "unreachable":
        // Not acknowledged, so a resume re-sends. Already logged by the client.
        return;
    }
  }

  async reportProgress(args: {
    readonly itemsReported: number;
    readonly requestsSpent: number;
  }): Promise<void> {
    if (!this.isReporting) return;
    const outcome = await this.client.reportProgress(args);
    if (outcome.kind === "run-gone") {
      this.runGone = true;
      this.log(`the gateway says this run is gone (${outcome.detail})`);
    }
    // A refused or unreachable progress tick is deliberately NOT fatal and does
    // not disable reporting: progress is a convenience, and the findings are
    // what matter. Losing one tick costs a stale number on a screen.
  }

  /**
   * Close the run out.
   *
   * Flushes first, so a `completed` never arrives before the findings it
   * summarises — the gateway's terminal guard would drop them.
   */
  async reportCompleted(requestsSpent: number): Promise<void> {
    await this.flush();
    if (!this.isReporting) return;
    await this.client.reportCompleted(requestsSpent);
  }

  /**
   * Report that the run could not finish.
   *
   * ⚠️ Flushes first as well. A crash after 4,000 items should file those 4,000
   * before saying it failed — they were paid for, and the gateway drops a data
   * event that arrives after a terminal one.
   */
  async reportError(
    message: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    await this.flush();
    if (this.runGone) return;
    // Deliberately NOT gated on `reportingDisabled`: a 400 on a findings batch
    // says the resolutions disagree about their shape, which says nothing about
    // whether an error event can be delivered — and a run that dies silently is
    // worse than one that dies loudly.
    await this.client.reportError(message, context);
  }

  private async recordAcknowledged(
    batch: readonly Resolution[],
  ): Promise<void> {
    const at = new Date().toISOString();
    const lines = batch
      .map((r) => JSON.stringify({ clientSku: r.clientSku, at }))
      .join("\n");
    try {
      await appendFile(this.journalPath, `${lines}\n`, "utf8");
      for (const r of batch) this.acknowledged.add(r.clientSku);
    } catch (error) {
      // The gateway has the findings; only our note of that failed. Re-sending
      // on a resume is harmless because the receiver is idempotent, so this is
      // logged rather than fatal — but the in-memory set is deliberately NOT
      // updated, so this run stops treating them as filed either. One truth.
      this.log(
        `could not record ${batch.length} acknowledgement(s) to ` +
          `${this.journalPath}: ${
            error instanceof Error ? error.message : String(error)
          }. A resumed run will re-send them, which the gateway drops.`,
      );
    }
  }
}
