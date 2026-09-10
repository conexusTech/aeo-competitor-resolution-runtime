/**
 * The gateway seam: where this container gets its job and sends its findings.
 *
 * One place knows that the envelope is snake_case, that Basic auth is the
 * credential, and what each status code means for retrying — because those are
 * the three things a second implementation would get subtly wrong.
 *
 * ── Two casings in one body, and neither is normalised ─────────────────
 * 🔑 The **envelope** is snake_case (`type`, `tenant_id`, `organization_id`) to
 * match the gateway's house runtime-callback contract. The **resolutions** it
 * carries are this runtime's own `Resolution` objects, camelCase, journalled to
 * disk and posted **byte for byte**. Renaming them at the boundary would put a
 * translation layer on the one payload whose whole value is that it is what the
 * pipeline actually produced, and every rename is a place to get a field wrong
 * silently.
 *
 * ── The status contract IS the retry policy ────────────────────────────
 * 🔴 Getting this backwards is silent in testing and expensive in production. A
 * container that retries a 400 retries forever; one that gives up on a 5xx
 * throws away findings it had already paid for.
 *
 * | status | meaning | what this does |
 * |---|---|---|
 * | 2xx | applied, including an idempotent replay | record the acknowledgement |
 * | 400 | malformed — this build and that build disagree | stop reporting, keep running |
 * | 401/403 | the credential is wrong | stop reporting, keep running |
 * | 404 | the run is not visible, or has ended | **stop the run** |
 * | 5xx / network | transient | retry with backoff |
 */

import type { Resolution } from "../resolve.js";

export const GATEWAY_URL_ENV = "RESOLUTION_GATEWAY_URL";
export const GATEWAY_USER_ENV = "RESOLUTION_GATEWAY_USER";
export const GATEWAY_PASSWORD_ENV = "RESOLUTION_GATEWAY_PASSWORD";

/**
 * Resolutions per `resolutions` event.
 *
 * 🔑 **A cross-repo contract, and it matches the gateway's cap exactly.** The
 * receiving DTO declares `@ArrayMaxSize(250)`, so a larger batch is a 400 —
 * non-retryable, and therefore a batch of findings lost to a number. Matching
 * rather than guessing lower follows the precedent
 * `configurable-prospect-scanner` set for the scan-event cap, which cites the
 * gateway's own constant in a comment for exactly this reason.
 */
export const MAX_RESOLUTIONS_PER_EVENT = 250;

/** Attempts per request, including the first. */
const ATTEMPTS = 4;
const BACKOFF_BASE_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;

/** One item of the client's list, as the gateway serves it. */
export interface JobItem {
  readonly barcode: string;
  readonly clientSku: string;
}

/** The job for a live run. */
export interface ResolutionJob {
  readonly runId: string;
  readonly retailerSlug: string;
  readonly itemsTotal: number;
  readonly items: readonly JobItem[];
}

/**
 * How a report ended.
 *
 * `retryable` never appears — by the time this returns, retries are spent. The
 * three outcomes are the three things a caller must do differently.
 */
export type ReportOutcome =
  /** Applied. Safe to record as acknowledged. */
  | { readonly kind: "applied" }
  /**
   * Refused in a way no retry fixes. The run continues and keeps journalling;
   * the findings are on disk and a later resume re-sends them.
   */
  | {
      readonly kind: "refused";
      readonly status: number;
      readonly detail: string;
    }
  /**
   * The run is gone — cancelled, or never visible under this tenant. Continuing
   * to spend on it is waste, so the caller stops.
   */
  | { readonly kind: "run-gone"; readonly detail: string }
  /** Still failing after every attempt. Not acknowledged; a resume re-sends. */
  | { readonly kind: "unreachable"; readonly detail: string };

/** The run is not there to report to. */
export class RunGone extends Error {
  constructor(readonly detail: string) {
    super(`the resolution run is no longer live: ${detail}`);
    this.name = "RunGone";
  }
}

export interface GatewayCredentials {
  readonly baseUrl: string;
  readonly user: string;
  readonly password: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read the gateway credentials, or explain what is missing.
 *
 * ⚠️ **At call time, never at module load** — the same rule `liveFetcherFromEnv`
 * follows, and for the same measured reason.
 */
export function gatewayFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GatewayCredentials {
  const baseUrl = env[GATEWAY_URL_ENV];
  const user = env[GATEWAY_USER_ENV];
  const password = env[GATEWAY_PASSWORD_ENV];
  const missing = [
    baseUrl == null || baseUrl === "" ? GATEWAY_URL_ENV : null,
    user == null || user === "" ? GATEWAY_USER_ENV : null,
    password == null || password === "" ? GATEWAY_PASSWORD_ENV : null,
  ].filter((name): name is string => name !== null);

  if (
    missing.length > 0 ||
    baseUrl == null ||
    user == null ||
    password == null
  ) {
    throw new Error(
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required ` +
        `to report to the gateway. A run that cannot report is a run whose ` +
        `findings never reach the client, so this refuses at start rather ` +
        `than after spending.`,
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), user, password };
}

/** The identity the gateway stamps every written row from. */
export interface RunIdentity {
  readonly runId: string;
  readonly tenantId: string;
  readonly organizationId: string;
}

/**
 * Seams a test needs, and one of them is not optional in practice.
 *
 * ⚠️ **`sleep` is injectable because the backoff is real.** Four attempts at
 * 500ms doubling is seven seconds of genuine waiting, and a suite that pays
 * that per retry case is a suite nobody runs — so the retry policy would end up
 * untested, which is the one part of this file that must not be.
 */
export interface GatewayClientSeams {
  readonly fetch?: typeof globalThis.fetch;
  readonly log?: (message: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class GatewayClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly log: (message: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly credentials: GatewayCredentials,
    private readonly identity: RunIdentity,
    seams: GatewayClientSeams = {},
  ) {
    this.fetchImpl = seams.fetch ?? globalThis.fetch;
    this.log = seams.log ?? console.warn;
    this.sleep = seams.sleep ?? sleep;
  }

  private get authHeader(): string {
    const { user, password } = this.credentials;
    return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
  }

  private get runUrl(): string {
    return `${this.credentials.baseUrl}/runtime/insights/runs/${encodeURIComponent(this.identity.runId)}`;
  }

  /**
   * The job: which adapter, and which items.
   *
   * ⚠️ **A 404 here means the run has ended**, and it is the guard that stops a
   * container restarted long after its run was cancelled from spending again —
   * the queue deleting a Job is not instantaneous and its retry policy is not
   * ours. Thrown rather than returned, because there is no useful work left.
   */
  async fetchJob(): Promise<ResolutionJob> {
    const response = await this.attempt(
      () =>
        this.fetchImpl(this.runUrl, {
          headers: { Authorization: this.authHeader },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
      "fetch the job",
    );

    if (response.status === 404) {
      throw new RunGone(
        `the gateway serves no job for run ${this.identity.runId} — it has ` +
          `ended, so there is nothing to resolve`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `could not fetch the job for run ${this.identity.runId}: status ` +
          `${response.status}`,
      );
    }

    const body: unknown = await response.json();
    return parseJob(body, this.identity.runId);
  }

  async reportProgress(args: {
    readonly itemsReported: number;
    readonly requestsSpent: number;
    readonly phase?: string;
  }): Promise<ReportOutcome> {
    return this.postEvent({
      type: "progress",
      items_reported: args.itemsReported,
      requests_spent: args.requestsSpent,
      ...(args.phase === undefined ? {} : { phase: args.phase }),
    });
  }

  /**
   * One batch of findings.
   *
   * The resolutions go in **as they are** — the same objects written to the
   * journal, with no field renamed. See the module docblock.
   */
  async reportResolutions(
    resolutions: readonly Resolution[],
  ): Promise<ReportOutcome> {
    if (resolutions.length === 0) return { kind: "applied" };
    if (resolutions.length > MAX_RESOLUTIONS_PER_EVENT) {
      // Refused here rather than sent and 400'd: the gateway's answer would be
      // non-retryable, so a caller that ignored the cap would lose the batch.
      throw new Error(
        `a resolutions event carries at most ${MAX_RESOLUTIONS_PER_EVENT} ` +
          `findings and this one carries ${resolutions.length} — the gateway ` +
          `answers a larger batch with a non-retryable 400`,
      );
    }
    return this.postEvent({ type: "resolutions", resolutions });
  }

  async reportCompleted(requestsSpent: number): Promise<ReportOutcome> {
    return this.postEvent({ type: "completed", requests_spent: requestsSpent });
  }

  async reportError(
    message: string,
    context?: Record<string, unknown>,
  ): Promise<ReportOutcome> {
    return this.postEvent({
      type: "error",
      // The gateway stores 2,000 characters; a stack is longer and the tail is
      // the useless half.
      message: message.slice(0, 2000),
      ...(context === undefined ? {} : { context }),
    });
  }

  /**
   * Post one event, retrying only what retrying can fix.
   *
   * The envelope's identity fields are added here, from the dispatch — the
   * gateway ignores per-row identity and stamps everything from the run it
   * verified, so these exist to address the run rather than to describe it.
   */
  private async postEvent(
    event: Record<string, unknown>,
  ): Promise<ReportOutcome> {
    const body = JSON.stringify({
      tenant_id: this.identity.tenantId,
      organization_id: this.identity.organizationId,
      runtime_version: process.env["RESOLUTION_BUILD_VERSION"] ?? "unknown",
      ...event,
    });

    let lastDetail = "no attempt was made";
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt > 0) await this.sleep(BACKOFF_BASE_MS * 2 ** attempt);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.runUrl}/events`, {
          method: "POST",
          headers: {
            Authorization: this.authHeader,
            "Content-Type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        // A transport failure is the case retrying exists for.
        lastDetail = error instanceof Error ? error.message : String(error);
        continue;
      }

      if (response.ok) return { kind: "applied" };

      if (response.status === 404) {
        return {
          kind: "run-gone",
          detail:
            `the gateway does not recognise run ${this.identity.runId} ` +
            `under this tenant, or it has ended`,
        };
      }

      if (response.status < 500) {
        // 🔴 Non-retryable by contract. A 400 means the shapes disagree and a
        // 401/403 means the credential is wrong; neither improves by asking
        // again, and a retry loop against either is the failure mode the
        // gateway's own docblock warns about.
        const detail = await safeText(response);
        return { kind: "refused", status: response.status, detail };
      }

      lastDetail = `status ${response.status}: ${await safeText(response)}`;
    }

    this.log(
      `gateway unreachable after ${ATTEMPTS} attempts (${lastDetail}) — the ` +
        `findings stay journalled and a resumed run will re-send them`,
    );
    return { kind: "unreachable", detail: lastDetail };
  }

  /** Retry a GET the same way, since the job fetch has the same failure modes. */
  private async attempt(
    send: () => Promise<Response>,
    what: string,
  ): Promise<Response> {
    let lastError: unknown = null;
    for (let i = 0; i < ATTEMPTS; i++) {
      if (i > 0) await this.sleep(BACKOFF_BASE_MS * 2 ** i);
      try {
        const response = await send();
        // A 5xx is worth another try; anything else is the answer.
        if (response.status < 500) return response;
        lastError = new Error(`status ${response.status}`);
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `could not ${what} after ${ATTEMPTS} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "(no body)";
  }
}

/**
 * Read the job, refusing a shape the run cannot work.
 *
 * An empty item list is refused rather than run: the gateway will not dispatch
 * one, so an empty list here means the two disagree, and a run that resolves
 * nothing is reported by the gateway as degraded — a confusing answer to a
 * problem that is really this.
 */
export function parseJob(body: unknown, runId: string): ResolutionJob {
  if (body === null || typeof body !== "object") {
    throw new Error(`the gateway's job for run ${runId} is not an object`);
  }
  const raw = body as Record<string, unknown>;
  const retailerSlug = raw["retailerSlug"];
  const items = raw["items"];

  if (typeof retailerSlug !== "string" || retailerSlug === "") {
    throw new Error(`the job for run ${runId} names no retailer`);
  }
  if (!Array.isArray(items)) {
    throw new Error(`the job for run ${runId} carries no items array`);
  }

  const parsed: JobItem[] = [];
  for (const [index, entry] of items.entries()) {
    if (entry === null || typeof entry !== "object") {
      throw new Error(`item ${index} of run ${runId} is not an object`);
    }
    const item = entry as Record<string, unknown>;
    const barcode = item["barcode"];
    const clientSku = item["clientSku"];
    if (typeof barcode !== "string" || typeof clientSku !== "string") {
      throw new Error(
        `item ${index} of run ${runId} is missing barcode or clientSku`,
      );
    }
    parsed.push({ barcode, clientSku });
  }

  if (parsed.length === 0) {
    throw new Error(
      `the job for run ${runId} carries no items — the gateway refuses to ` +
        `dispatch an empty list, so this build and that one disagree`,
    );
  }

  return {
    runId,
    retailerSlug,
    itemsTotal: parsed.length,
    items: parsed,
  };
}
