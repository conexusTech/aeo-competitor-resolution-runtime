/**
 * Evidence: the page a resolution was decided on.
 *
 * ── 🔴 What this captures, and what it does not ────────────────────────
 * **The page's bytes, not a picture of it.** This runtime has zero runtime
 * dependencies — no browser, no image library — and adding one would not help:
 * the reason `LiveFetcher` posts to a proxy is that the retailer refuses a
 * plain request, so a headless browser inside a k8s Job makes exactly the
 * request the proxy exists to avoid. It would fail on precisely the sites this
 * runtime is for.
 *
 * The two artefacts are different things rather than better and worse:
 *
 * | | page bytes | an image |
 * |---|---|---|
 * | proves what the parse read | **exactly, byte for byte** | approximately |
 * | settles "your matcher is wrong" | **yes** — it can be re-parsed | no |
 * | shows a person a price they recognise | no | **yes** |
 * | costs | **nothing, already fetched** | a second request and a new vendor |
 *
 * ⚠️ **`png` is in the union and no code path produces it.** The same
 * precedent `insights-derived-reads` set for `match_went_stale`: the vocabulary
 * admits it, nothing emits it, and the capability says so rather than leaving a
 * reader to find out. Delivering one is a spend decision — see the roadmap row
 * `resolution-runtime-captures-images`.
 */

import { createHash } from "node:crypto";

export const CAPTURE_FORMATS = ["page_html", "png"] as const;
export type CaptureFormat = (typeof CAPTURE_FORMATS)[number];

/**
 * How a capture ended.
 *
 * ⚠️ **Two values the frontend contract lacks** — it
 * names `captured`, `failed`, `pending` and `skipped_quota`. A retailer whose
 * registry capability is off, or a job that asked for no captures, is neither a
 * failure nor a quota refusal, and reporting it as either would be a lie about
 * which knob to turn. Same call `insights-run-orchestration` made for
 * `MatchMethod`'s fifth value: the runtime reports the truth and the type
 * catches up in `insights-frontend-live-data`.
 *
 * 🔴 **`skipped_unselected` is the sixth, and it is a DIFFERENT answer from
 * `skipped_quota`.** No rule chose the item, so nothing ran out — reporting it
 * as a quota refusal would send an operator to raise a budget that was never
 * the reason. It is recorded before the budget is touched for exactly that
 * reason: a rule is not a quota.
 */
export const CAPTURE_STATES = [
  "captured",
  "failed",
  "skipped_quota",
  "skipped_disabled",
  "skipped_unselected",
] as const;
export type CaptureState = (typeof CAPTURE_STATES)[number];

/** What the run is asked to capture, handed over with the job. */
export interface CapturePolicy {
  /**
   * Off unless the gateway says otherwise.
   *
   * 🔑 **Absent means disabled, never enabled.** The gateway computes this from
   * the retailer's registry capability, the organization's remaining quota and
   * the selection rules — so a job from a gateway that predates any of that
   * carries nothing, and defaulting to on would spend a budget nobody set.
   */
  readonly enabled: boolean;
  /**
   * Captures this run may make. `0` with `enabled` is legal and means the
   * organization's quota is already spent — which is why the two are separate
   * fields rather than one nullable number: "not asked for" and "asked for and
   * none left" are different answers to an operator.
   */
  readonly budget: number;
  readonly format: CaptureFormat;
}

export const CAPTURE_DISABLED: CapturePolicy = {
  enabled: false,
  budget: 0,
  format: "page_html",
};

/** One captured page, ready to be posted. */
export interface CaptureArtifact {
  readonly format: CaptureFormat;
  /** The page the resolution was decided on. */
  readonly sourceUrl: string;
  /** The bytes, verbatim — base64 so the transport cannot mangle them. */
  readonly contentBase64: string;
  readonly byteSize: number;
  /**
   * Over the **bytes**, not over the base64.
   *
   * 🔑 The hash is what lets the gateway store one copy of a page two items
   * resolved to, and what lets a reviewer prove the stored evidence is the page
   * the run read rather than a later fetch of the same url.
   */
  readonly sha256: string;
  readonly capturedAt: string;
}

/** What happened, per resolution, recorded whatever the outcome. */
export interface CaptureRecord {
  readonly clientSku: string;
  readonly barcode: string;
  readonly state: CaptureState;
  /** The url captured, or the one that would have been. `null` when there was none. */
  readonly sourceUrl: string | null;
  /** Where the gateway put it. `null` unless `state` is `captured`. */
  readonly storageKey: string | null;
  readonly byteSize: number | null;
  readonly sha256: string | null;
  /** Why, when `state` is `failed`. */
  readonly failureReason: string | null;
  readonly at: string;
}

/** Bytes in, artefact out. Pure, so the hash is testable without a network. */
export function artifactFrom(args: {
  readonly sourceUrl: string;
  /**
   * The artefact. A `string` is decoded as UTF-8 — a page's markup; a
   * `Uint8Array` is taken verbatim — a PNG.
   *
   * 🔴 **The distinction is load-bearing, not a convenience.** Reading image
   * bytes through `Buffer.from(str, "utf8")` replaces every byte outside the
   * ASCII range with U+FFFD, so the stored artefact would be a corrupt PNG
   * whose sha256 the gateway verifies happily — evidence that proves nothing,
   * with a valid-looking hash on it.
   */
  readonly body: string | Uint8Array;
  readonly format?: CaptureFormat;
  readonly now?: () => Date;
}): CaptureArtifact {
  const bytes =
    typeof args.body === "string"
      ? Buffer.from(args.body, "utf8")
      : Buffer.from(args.body);
  return {
    format: args.format ?? "page_html",
    sourceUrl: args.sourceUrl,
    contentBase64: bytes.toString("base64"),
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    capturedAt: (args.now?.() ?? new Date()).toISOString(),
  };
}

/**
 * Read the capture policy off a job, refusing a shape that would overspend.
 *
 * ⚠️ Tolerant of absence and strict about presence. A missing block is an older
 * gateway and means disabled; a **malformed** block is two builds disagreeing
 * about a budget, and quietly reading that as "no captures" would hide a real
 * mismatch behind a plausible default.
 */
export function parseCapturePolicy(raw: unknown, runId: string): CapturePolicy {
  if (raw === undefined || raw === null) return CAPTURE_DISABLED;
  if (typeof raw !== "object") {
    throw new Error(`the capture policy for run ${runId} is not an object`);
  }
  const block = raw as Record<string, unknown>;
  const enabled = block["enabled"];
  const budget = block["budget"];
  const format = block["format"] ?? "page_html";

  if (typeof enabled !== "boolean") {
    throw new Error(
      `the capture policy for run ${runId} has no boolean 'enabled'`,
    );
  }
  if (typeof budget !== "number" || !Number.isInteger(budget) || budget < 0) {
    throw new Error(
      `the capture budget for run ${runId} must be a non-negative integer, ` +
        `and it is ${JSON.stringify(budget)} — a run that cannot tell how many ` +
        `captures it may make must not guess`,
    );
  }
  if (!isCaptureFormat(format)) {
    throw new Error(
      `the capture policy for run ${runId} asks for format ` +
        `${JSON.stringify(format)}, which this runtime does not know`,
    );
  }
  return { enabled, budget, format };
}

function isCaptureFormat(value: unknown): value is CaptureFormat {
  return (
    typeof value === "string" &&
    (CAPTURE_FORMATS as readonly string[]).includes(value)
  );
}
