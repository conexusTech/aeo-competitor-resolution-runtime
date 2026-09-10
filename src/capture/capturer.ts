/**
 * Capturing the page a resolution was decided on, and saying where it went.
 *
 * ── Per resolution, not per fetch ─────────────────────────────────────
 * 🔑 A run fetches search pages, catalogue pages and candidates it rejects. The
 * evidence worth keeping is the **one page the finding was decided on** —
 * capturing every fetch would spend the whole budget on pages nobody opens.
 *
 * ⚠️ So an outcome with no chosen page captures nothing, and that is correct
 * rather than a gap: there is no competitor page to be evidence of.
 *
 * ── The bytes cost nothing ────────────────────────────────────────────
 * The chosen page was fetched moments ago, so asking the fetcher for it again
 * is a **cache hit** — `LiveFetcher` reads it off disk and does not increment
 * `liveRequestCount`. That is what makes evidence free rather than a second
 * paid request per item.
 *
 * ── A capture failure never changes a finding ─────────────────────────
 * 🔴 The finding is the product; the evidence is a convenience. A run that
 * abandoned a verified pairing because an upload 500'd would trade the thing
 * worth money for the thing worth comfort. Every path here resolves to a
 * record; none throws at the caller.
 *
 * ── Two journals again, for the reason row 5 established ──────────────
 * 🔑 `captures.jsonl` holds what the **gateway accepted**, written after its
 * answer — so a resumed run does not re-post a page already stored. It is the
 * same shape as `reported.jsonl` and exists for the same reason: at-least-once
 * delivery to an idempotent receiver is the only pair that cannot lose data.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { Fetcher } from "../fetcher/types.js";
import type { Resolution } from "../resolve.js";
import { CaptureBudget } from "./budget.js";
import {
  artifactFrom,
  type CapturePolicy,
  type CaptureRecord,
} from "./types.js";

export const CAPTURE_JOURNAL = "captures.jsonl";

/** What the gateway answers when handed a capture. */
export type CaptureUploadOutcome =
  | { readonly kind: "stored"; readonly storageKey: string }
  /** Refused in a way no retry fixes — a shape disagreement, or a full quota. */
  | { readonly kind: "refused"; readonly detail: string }
  /** Could not be reached. The budget is refunded; the record says `failed`. */
  | { readonly kind: "unreachable"; readonly detail: string };

export interface CapturerDeps {
  readonly policy: CapturePolicy;
  readonly fetcher: Fetcher;
  readonly runDir: string;
  readonly upload: (args: {
    readonly clientSku: string;
    readonly barcode: string;
    readonly artifact: ReturnType<typeof artifactFrom>;
  }) => Promise<CaptureUploadOutcome>;
  readonly log?: (message: string) => void;
  readonly now?: () => Date;
}

/**
 * Which pages this run has already had accepted, keyed by url.
 *
 * ⚠️ Keyed on the **url**, not on the item: two items can resolve to one
 * competitor listing, and storing that page twice would charge a quota twice
 * for one artefact.
 */
export async function readCaptureJournal(
  journalPath: string,
): Promise<Map<string, CaptureRecord>> {
  const done = new Map<string, CaptureRecord>();
  let text: string;
  try {
    text = await readFile(journalPath, "utf8");
  } catch {
    return done; // first run
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const record = JSON.parse(line) as CaptureRecord;
      // Only an accepted capture suppresses a retry. A `failed` one is worth
      // another go on a resume; a `skipped_*` one describes a rule, not a page.
      if (record.state === "captured" && record.sourceUrl !== null) {
        done.set(record.sourceUrl, record);
      }
    } catch {
      // A truncated final line is what a killed process leaves. Skipping it
      // costs one re-capture; refusing to start costs the whole run.
      continue;
    }
  }
  return done;
}

export class Capturer {
  private readonly budget: CaptureBudget;
  private readonly journalPath: string;
  private readonly log: (message: string) => void;
  private accepted = new Map<string, CaptureRecord>();
  private loaded = false;

  readonly records: CaptureRecord[] = [];

  constructor(private readonly deps: CapturerDeps) {
    this.budget = new CaptureBudget(deps.policy.budget, deps.policy.enabled);
    this.journalPath = path.join(deps.runDir, CAPTURE_JOURNAL);
    this.log = deps.log ?? console.warn;
  }

  /** Read what a previous attempt already had accepted. */
  async load(): Promise<void> {
    this.accepted = await readCaptureJournal(this.journalPath);
    this.loaded = true;
  }

  get acceptedCount(): number {
    return this.accepted.size;
  }

  get spent(): number {
    return this.budget.spent;
  }

  get remaining(): number {
    return this.budget.remaining;
  }

  /**
   * Offer one resolution's page.
   *
   * Returns the record for the caller's own accounting; it is also appended to
   * `records`, and — when accepted — journalled.
   */
  async offer(resolution: Resolution): Promise<CaptureRecord> {
    const at = (this.deps.now?.() ?? new Date()).toISOString();
    const url = resolution.match?.url ?? null;

    // No chosen page: nothing to be evidence of. Recorded as disabled rather
    // than failed — nothing went wrong.
    if (url === null) {
      return this.remember({
        clientSku: resolution.clientSku,
        barcode: resolution.barcode,
        state: "skipped_disabled",
        sourceUrl: null,
        storageKey: null,
        byteSize: null,
        sha256: null,
        failureReason: null,
        at,
      });
    }

    // Already stored by an earlier attempt of this run.
    const already = this.accepted.get(url);
    if (already !== undefined) {
      return this.remember({ ...already, clientSku: resolution.clientSku, at });
    }

    // 🔑 The budget is taken here — before the page is read and before anything
    // is posted. Asked afterwards it would be a report rather than a budget.
    const answer = this.budget.request();
    if (answer.kind !== "allowed") {
      return this.remember({
        clientSku: resolution.clientSku,
        barcode: resolution.barcode,
        state:
          answer.kind === "disabled" ? "skipped_disabled" : "skipped_quota",
        sourceUrl: url,
        storageKey: null,
        byteSize: null,
        sha256: null,
        failureReason: null,
        at,
      });
    }

    let body: string;
    try {
      // A cache hit in every ordinary case — the page was fetched moments ago.
      const fetched = await this.deps.fetcher.fetch(url);
      body = fetched.body;
    } catch (error) {
      // The page cannot be re-read. The budget is handed back: nothing was
      // stored, so nothing should be charged.
      this.budget.refund();
      return this.remember({
        clientSku: resolution.clientSku,
        barcode: resolution.barcode,
        state: "failed",
        sourceUrl: url,
        storageKey: null,
        byteSize: null,
        sha256: null,
        failureReason: `could not re-read the page: ${describe(error)}`,
        at,
      });
    }

    const artifact = artifactFrom({
      sourceUrl: url,
      body,
      format: this.deps.policy.format,
      ...(this.deps.now === undefined ? {} : { now: this.deps.now }),
    });

    let outcome: CaptureUploadOutcome;
    try {
      outcome = await this.deps.upload({
        clientSku: resolution.clientSku,
        barcode: resolution.barcode,
        artifact,
      });
    } catch (error) {
      // ⚠️ The upload seam is allowed to throw; a capture is not allowed to
      // take the run down with it. See the module docblock.
      outcome = { kind: "unreachable", detail: describe(error) };
    }

    if (outcome.kind !== "stored") {
      this.budget.refund();
      this.log(
        `capture failed for ${resolution.clientSku} (${url}): ` +
          `${outcome.detail}`,
      );
      return this.remember({
        clientSku: resolution.clientSku,
        barcode: resolution.barcode,
        state: "failed",
        sourceUrl: url,
        storageKey: null,
        byteSize: artifact.byteSize,
        sha256: artifact.sha256,
        failureReason: outcome.detail,
        at,
      });
    }

    const record: CaptureRecord = {
      clientSku: resolution.clientSku,
      barcode: resolution.barcode,
      state: "captured",
      sourceUrl: url,
      storageKey: outcome.storageKey,
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
      failureReason: null,
      at,
    };

    // Journalled only now — after the gateway's answer. Written before it, a
    // container dying in the window would mark a page stored that never was,
    // and a resume would skip evidence nobody holds.
    await this.journal(record);
    this.accepted.set(url, record);
    return this.remember(record);
  }

  private remember(record: CaptureRecord): CaptureRecord {
    this.records.push(record);
    return record;
  }

  private async journal(record: CaptureRecord): Promise<void> {
    if (!this.loaded) {
      // A journal written before it was read would be appended to a file whose
      // existing contents this run has never seen — so a resume's suppression
      // set would be wrong in exactly the direction that re-posts pages.
      throw new Error("Capturer.load() must be called before offering a page");
    }
    await mkdir(this.deps.runDir, { recursive: true });
    await appendFile(this.journalPath, `${JSON.stringify(record)}\n`, "utf8");
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A tally an operator can read, and the shape the run's summary carries. */
export function tallyCaptures(
  records: readonly CaptureRecord[],
): Record<CaptureRecord["state"], number> {
  const tally: Record<CaptureRecord["state"], number> = {
    captured: 0,
    failed: 0,
    skipped_quota: 0,
    skipped_disabled: 0,
  };
  for (const record of records) tally[record.state] += 1;
  return tally;
}
