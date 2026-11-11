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

import { SYSTEM_CLOCK, type Clock } from "../clock.js";
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

/**
 * The longest a finding waits in the buffer before it is sent.
 *
 * 🔴 **Measured in production, 2026-11-11:** a 20-row run was evicted after
 * about seven minutes with every finding still buffered — 0 of 20 reported —
 * because a short list never reaches `FLUSH_AT`. Lost findings are bought
 * again by the next container, and a container that reported nothing cannot
 * be told apart from one that made no progress. A minute bounds both at the
 * cost of at most one small request a minute.
 */
export const FLUSH_EVERY_MS = 60_000;

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
  /**
   * What the run has bought so far, read **at send time**.
   *
   * 🔑 A thunk rather than a number, because the reporter outlives any
   * single reading: a batch is sent after the pages that produced it were
   * bought, and a captured value would be stale by exactly the amount the last
   * batch cost. Omitted, no counter is sent and the gateway falls back to
   * summing the per-item figures.
   */
  readonly requestsSpent?: () => number;
  /**
   * Of those, the pages the vendor delivered, read at send time like
   * `requestsSpent`. Omitted, no `pages_delivered` is sent.
   */
  readonly pagesDelivered?: () => number;
  /** What `flushEveryMs` is measured on. The system clock unless a check says. */
  readonly clock?: Clock;
  /** The longest a finding waits before it is sent. `FLUSH_EVERY_MS` unless a check says. */
  readonly flushEveryMs?: number;
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
  private readonly requestsSpent: (() => number) | null;
  private readonly pagesDelivered: (() => number) | null;
  private readonly clock: Clock;
  private readonly flushEveryMs: number;

  /** Cancels the timed send armed for the oldest waiting finding, if any. */
  private cancelTimedFlush: (() => void) | null = null;
  /**
   * The sends so far, one after another.
   *
   * 🔴 **Serialised, because a timed send can be in flight when the run
   * ends.** A terminal report flushes first; if that flush ran beside a timed
   * send still waiting on its 200, the terminal event could land first and
   * the gateway would drop the batch behind it. Every flush waits its turn.
   */
  private sending: Promise<void> = Promise.resolve();
  /**
   * Set when the run's end has been decided — `completed`, `yielded` or
   * `error`. From then on nothing new is accepted or sent but the terminal
   * event itself.
   *
   * 🔴 **Found in review, 2026-11-11.** After SIGTERM an item abandoned in
   * flight can finish while `yielded` is on its way. Filed then, it lands
   * after `yielded`: reported twice — here and by the next container, which
   * was given it as unfinished — with its pages missing from the spend
   * `yielded` carried. Dropped instead; the next container buys it again.
   */
  private sealed = false;
  /** Progress ticks not yet answered: a terminal event waits for them. */
  private readonly ticking = new Set<Promise<void>>();

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
    this.requestsSpent = options.requestsSpent ?? null;
    this.pagesDelivered = options.pagesDelivered ?? null;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.flushEveryMs = options.flushEveryMs ?? FLUSH_EVERY_MS;
  }

  /** Whether the gateway has said this run no longer exists. */
  get isRunGone(): boolean {
    return this.runGone;
  }

  /**
   * Whether the run's end has been decided, so nothing more is filed for it.
   * A caller holding a late finding drops everything that goes with it.
   */
  get isSealed(): boolean {
    return this.sealed;
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
    if (this.sealed || !this.isReporting) return;
    if (this.acknowledged.has(resolution.clientSku)) return;
    this.buffer.push(resolution);
    if (this.buffer.length >= this.flushAt) {
      await this.flush();
      return;
    }
    this.armTimedFlush();
  }

  /**
   * Send the buffer `flushEveryMs` from now, unless something sends it first.
   *
   * ⚠️ **Armed once, by the oldest waiting finding, and never pushed back.**
   * Re-arming on every offer would let a steady trickle of findings wait for
   * ever.
   */
  private armTimedFlush(): void {
    if (this.cancelTimedFlush !== null) return;
    this.cancelTimedFlush = this.clock.after(this.flushEveryMs, () => {
      this.cancelTimedFlush = null;
      // Not awaited: nothing waits on a timer. `flush` is total, so this
      // cannot become an unhandled rejection.
      void this.flush();
    });
  }

  /**
   * Send whatever is buffered, after any send already in flight. Total:
   * never throws into the run.
   *
   * 🔑 Cancels the timed send first, so a finished run is never kept alive
   * for a minute by a timer with nothing left to send.
   */
  flush(): Promise<void> {
    this.cancelTimedFlush?.();
    this.cancelTimedFlush = null;
    // After the end is decided, the terminal report's own send is the last.
    if (this.sealed) return Promise.resolve();
    return this.queueSend();
  }

  private queueSend(): Promise<void> {
    const next = this.sending.then(() => this.sendBuffered());
    this.sending = next;
    return next;
  }

  /**
   * Decide the end: accept nothing more, send what was buffered (after any
   * send in flight), and wait for every progress tick still on its way — so
   * the terminal event that follows is the last thing the gateway hears.
   */
  private async closeOut(): Promise<void> {
    this.sealed = true;
    this.cancelTimedFlush?.();
    this.cancelTimedFlush = null;
    await this.queueSend();
    await Promise.all([...this.ticking]);
  }

  private async sendBuffered(): Promise<void> {
    if (this.buffer.length === 0 || !this.isReporting) return;
    const batch = this.buffer.splice(0, this.buffer.length);

    let outcome: ReportOutcome;
    try {
      outcome = await this.client.reportResolutions(
        batch,
        this.requestsSpent?.(),
        this.pagesDelivered?.(),
      );
    } catch (error) {
      // A throw here is a programming error rather than a network one — the
      // client only throws on an over-cap batch, which this cannot produce.
      // 🔴 An over-long field is never a throw: the client sends it held to
      // the gateway's limit, so one item's string cannot lose this batch.
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
    readonly pagesDelivered?: number;
  }): Promise<void> {
    if (this.sealed || !this.isReporting) return;
    // 🔑 Tracked until answered, because the run does not await a tick and a
    // terminal event must not overtake one — see `closeOut`.
    const tick = this.sendProgress(args);
    this.ticking.add(tick);
    try {
      await tick;
    } finally {
      this.ticking.delete(tick);
    }
  }

  private async sendProgress(args: {
    readonly itemsReported: number;
    readonly requestsSpent: number;
    readonly pagesDelivered?: number;
  }): Promise<void> {
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
   * summarises — the gateway's terminal guard would drop them. Seals the
   * reporter first of all: see `sealed`.
   */
  async reportCompleted(
    requestsSpent: number,
    pagesDelivered?: number,
  ): Promise<void> {
    await this.closeOut();
    if (!this.isReporting) return;
    await this.client.reportCompleted(requestsSpent, pagesDelivered);
  }

  /**
   * Hand the run back unfinished: the time budget is spent, or the cluster
   * told this container to stop.
   *
   * 🔴 **Flushes first, for a reason beyond `completed`'s.** The gateway works
   * out the next container's items from the findings it holds when this
   * arrives — every item in the run with no finding yet. A finding still in
   * the buffer would be bought again by the next container.
   *
   * ⚠️ Not sent when reporting is off, exactly as `completed` is not: the
   * gateway then learns how this container ended from the queue.
   */
  async reportYielded(
    requestsSpent: number,
    pagesDelivered?: number,
  ): Promise<void> {
    await this.closeOut();
    if (!this.isReporting) return;
    await this.client.reportYielded(requestsSpent, pagesDelivered);
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
    await this.closeOut();
    if (this.runGone) return;
    // Deliberately NOT gated on `reportingDisabled`: a 400 on a findings batch
    // says the resolutions disagree about their shape, which says nothing about
    // whether an error event can be delivered — and a run that dies silently is
    // worse than one that dies loudly.
    await this.client.reportError(
      message,
      context,
      this.requestsSpent?.(),
      this.pagesDelivered?.(),
    );
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
