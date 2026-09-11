/**
 * The container entry point.
 *
 * Two ways in, one pipeline:
 *
 * - **Queue mode**, selected by `TASK_RECORD_ID` being present. The job is read
 *   from the queue **by reference** and the findings stream back to the gateway
 *   as they are made. This is how production runs.
 * - **File mode**, `RESOLUTION_JOB_FILE`. No queue, no gateway, output to
 *   standard output. This is how a local run, a manual re-run and every offline
 *   proof are driven, and it is why the whole suite needs neither service.
 *
 * ⚠️ **File mode is kept deliberately, not left behind.** The previous change's
 * exit criterion is met by replaying a committed corpus with no network;
 * removing the path that makes that possible would trade a free deterministic
 * check for a paid manual one.
 *
 * Deliberately thin: it reads the environment and picks a mode. The sequence a
 * queue run follows lives in `queue-run.ts`, where it can be tested without a
 * container — see that file's docblock for why that split exists.
 */

import { neweggAdapter } from "./adapters/newegg.js";
import type { RetailerAdapter } from "./adapters/types.js";
import { buildVersion, fetcherFromEnv } from "./fetcher/select.js";
import { jobFileFromEnv, readJobEnvelope } from "./job-file.js";
import { GatewayClient, RunGone, gatewayFromEnv } from "./gateway/client.js";
import { bootstrapFromQueue, inQueueMode } from "./queue/task-record.js";
import { runDispatchedJob } from "./queue-run.js";
import { GatewayReporter } from "./reporting/reporter.js";
import { estimateRun, runList, RUN_DEFAULTS } from "./run.js";
import type { Resolution } from "./resolve.js";

/**
 * Retailer capability is a registry row in the gateway, not a constant here.
 * This map is the last place a retailer is named at all, and it maps a slug the
 * job supplies to the adapter that implements it — so adding a retailer is a
 * new adapter file and one entry, never a change to the engine.
 */
const ADAPTERS: Record<string, RetailerAdapter> = {
  [neweggAdapter.slug]: neweggAdapter,
};

/**
 * Pick the adapter, refusing up front by name. Discovering this mid-run would
 * waste whatever had already been paid for.
 */
function requireAdapter(retailerSlug: string): RetailerAdapter {
  const adapter = ADAPTERS[retailerSlug];
  if (adapter === undefined) {
    throw new Error(
      `no adapter for retailer "${retailerSlug}"; this image carries: ` +
        `${Object.keys(ADAPTERS).join(", ")}`,
    );
  }
  return adapter;
}

/**
 * ⚠️ **Delegated rather than read here.** The same value is reported by the
 * gateway client from two other places, and a replayed run has to carry its
 * stamp on all three — see `fetcher/select.ts`.
 */
const version = (): string => buildVersion();

const runDir = (): string =>
  process.env["RESOLUTION_RUN_DIR"] ?? RUN_DEFAULTS.runDir;

function announce(itemCount: number, adapter: RetailerAdapter): void {
  const { requests, usd } = estimateRun(itemCount, 0);
  console.log(
    `resolution-runtime ${version()}: ${itemCount} items against ` +
      `${adapter.slug}; worst-case ${requests.toFixed(0)} requests, ` +
      `~$${usd.toFixed(2)} ESTIMATED (the rate is not invoice-validated)`,
  );
}

function tally(results: readonly Resolution[], liveRequests: number): void {
  const byOutcome = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  const failures = results.filter((r) => r.failure !== null).length;

  console.log(`\n--- done ---`);
  console.log(`items:     ${results.length}`);
  for (const [outcome, count] of Object.entries(byOutcome)) {
    console.log(`  ${outcome.padEnd(14)} ${count}`);
  }
  console.log(`failures:  ${failures}`);
  console.log(`requests:  ${liveRequests}`);
}

async function runFromQueue(): Promise<void> {
  const dispatch = await bootstrapFromQueue();
  if (dispatch === null) {
    // Unreachable: the caller checked. An assertion rather than a non-null
    // cast, so the two checks cannot drift apart silently.
    throw new Error("queue mode was selected but no dispatch was resolved");
  }

  const client = new GatewayClient(gatewayFromEnv(), {
    runId: dispatch.resolutionRunId,
    tenantId: dispatch.tenantId,
    organizationId: dispatch.organizationId,
  });
  const reporter = new GatewayReporter(client, { runDir: runDir() });
  // 🔴 **Live unless the environment names a corpus.** Until this row, both
  // paths built the live fetcher unconditionally, so the committed corpus was
  // unreachable from the container and a dispatched run could not happen
  // without a paid credential.
  const fetcher = fetcherFromEnv();

  const result = await runDispatchedJob({
    dispatch,
    client,
    reporter,
    adapterFor: requireAdapter,
    fetcher,
    runList,
    baseOptions: {
      ...RUN_DEFAULTS,
      runDir: runDir(),
      clientCatalogueUrlTemplate:
        process.env["RESOLUTION_CLIENT_CATALOGUE_URL_TEMPLATE"] ?? null,
    },
  });

  tally(result.resolutions, result.liveRequests);
}

/** A local or manual run: no queue, no gateway, output to the console. */
async function runFromFile(): Promise<void> {
  const envelope = await readJobEnvelope(jobFileFromEnv());
  const adapter = requireAdapter(envelope.retailerSlug);
  announce(envelope.items.length, adapter);

  const fetcher = fetcherFromEnv();
  const results = await runList(envelope.items, adapter, fetcher, {
    ...RUN_DEFAULTS,
    runDir: runDir(),
    clientCatalogueUrlTemplate: envelope.clientCatalogueUrlTemplate ?? null,
    onProgress: (progress) => {
      if (progress.completed % 25 !== 0) return;
      console.log(
        `[${progress.completed}/${progress.total}] ` +
          `verified=${progress.outcomes.verified} ` +
          `unverifiable=${progress.outcomes.unverifiable} ` +
          `unconfirmed=${progress.outcomes.unconfirmed} ` +
          `not-found=${progress.outcomes["not-found"]} | ` +
          `${progress.liveRequests} requests, ` +
          `~$${progress.estimatedUsd.toFixed(2)}`,
      );
    },
  });

  tally(results, fetcher.liveRequestCount);
}

async function main(): Promise<void> {
  if (!inQueueMode()) {
    await runFromFile();
    return;
  }
  try {
    await runFromQueue();
  } catch (error) {
    if (error instanceof RunGone) {
      // Not a failure of this container. The run ended before it started, so
      // there is nothing to report and nothing to retry.
      console.log(error.message);
      return;
    }
    throw error;
  }
}

await main();
