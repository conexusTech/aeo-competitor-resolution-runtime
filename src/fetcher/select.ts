/**
 * Which fetcher a run uses, and how a replayed run stays identifiable.
 *
 * ── Why this file exists ──────────────────────────────────────────────
 * The replay fetcher has existed since this repo's first row: it serves a
 * committed corpus of 534 real responses, it is what the 53-row exit criterion
 * replays, and it costs nothing. 🔴 **But `main.ts` built `liveFetcherFromEnv()`
 * on BOTH paths — the queue path and the file path — so nothing in the
 * container could select it.** A dispatched run therefore required
 * `BRIGHTDATA_API_KEY`, and the whole queue-to-gateway path was unexercisable
 * anywhere it was not set.
 *
 * Found by writing the local end-to-end playbook rather than by reading the
 * code: the playbook had to name the step that could not be performed.
 *
 * ── The safety property, and why a log line is not it ─────────────────
 * 🔴 **A replayed run must be identifiable after the fact, not while it is
 * running.** Findings from a replay are real findings about real pages — they
 * are simply not fresh, and nobody paid for them. A run that reported them
 * indistinguishably from a paid sweep would put prices in front of a customer
 * with no way for anyone to later ask "was that measured today?".
 *
 * So the mode is stamped into `runtime_version`, which the gateway **persists**
 * on the run row (`insights_runs.runtime_version`, varchar 120). A log line
 * would be gone by the time the question is asked; a column is not.
 *
 * 🔑 **And the stamp is centralised here because it was read in three places.**
 * `main.ts` and two separate bodies in `gateway/client.ts` each read
 * `RESOLUTION_BUILD_VERSION` independently — so a stamp added to one of them
 * would leave a replayed capture upload, or a replayed terminal event,
 * reporting a clean version. One accessor, so the three cannot disagree.
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { liveFetcherFromEnv } from "./live.js";
import { type Corpus, ReplayFetcher } from "./replay.js";
import type { Fetcher } from "./types.js";

/** Set this to a corpus path to replay. Absent means a live run. */
export const REPLAY_CORPUS_ENV = "RESOLUTION_REPLAY_CORPUS";

/** Where the image keeps the committed corpus, so the env var can name it. */
export const BUNDLED_CORPUS_PATH = "/app/corpus/launch-retailer-53.json.gz";

/**
 * Appended to the reported build version by a replayed run.
 *
 * ⚠️ A suffix rather than a replacement, so the underlying build is still
 * traceable to a pushed commit — "which image was this" and "was it paid for"
 * are different questions and both get an answer.
 */
export const REPLAY_VERSION_SUFFIX = "+replay";

/** True when the environment selects a replay. */
export function isReplaying(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[REPLAY_CORPUS_ENV];
  return value != null && value !== "";
}

/**
 * The version every report carries.
 *
 * ⚠️ **Read at call time, never at module load.** A sibling runtime in this
 * workspace shipped a bug where a top-level `const` captured `undefined`
 * because nothing had loaded the environment yet, and then served its default
 * forever.
 */
export function buildVersion(env: NodeJS.ProcessEnv = process.env): string {
  const base = env["RESOLUTION_BUILD_VERSION"] ?? "unknown";
  return isReplaying(env) ? `${base}${REPLAY_VERSION_SUFFIX}` : base;
}

/** Read a corpus from disk. `.gz` or plain JSON, decided by the bytes. */
export function loadCorpus(path: string): Corpus {
  const raw = readFileSync(path);
  // 🔑 The gzip magic number, not the file extension. A corpus copied without
  // its suffix is a mistake worth surviving; a `.json` holding gzip is not.
  const gzipped = raw.length > 1 && raw[0] === 0x1f && raw[1] === 0x8b;
  const text = (gzipped ? gunzipSync(raw) : raw).toString("utf8");
  const corpus = JSON.parse(text) as Corpus;
  if (!Array.isArray(corpus.entries)) {
    throw new Error(
      `${path} is not a corpus: no \`entries\` array. A run that replayed ` +
        `an empty corpus would report every item as not-found, which is a ` +
        `plausible answer and the wrong one.`,
    );
  }
  return corpus;
}

/**
 * Pick the fetcher, refusing up front rather than mid-run.
 *
 * 🔴 **Live is the default, and that direction is load-bearing.** A replay
 * silently preferred in production would report findings nobody paid for as
 * though they were fresh, on the one screen a customer is most likely to quote
 * back. So the live path is what an absent variable gets, and a check asserts
 * it.
 */
export function fetcherFromEnv(env: NodeJS.ProcessEnv = process.env): Fetcher {
  if (!isReplaying(env)) return liveFetcherFromEnv();

  const path = env[REPLAY_CORPUS_ENV] as string;
  const corpus = loadCorpus(path);
  // Loud as well as stamped. The stamp is what survives; this is what a
  // person watching the logs sees.
  console.warn(
    `*** REPLAY MODE *** serving ${corpus.entries.length} committed ` +
      `responses from ${path}. No requests are bought and nothing is ` +
      `fetched live. Findings are real but NOT fresh, and every report ` +
      `from this run is stamped "${REPLAY_VERSION_SUFFIX}".`,
  );
  return new ReplayFetcher(corpus);
}
