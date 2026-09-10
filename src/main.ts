/**
 * The container entry point.
 *
 * Reads the job's envelope from the environment, resolves the list, journals as
 * it goes, and reports what it spent. Deliberately thin: everything it calls is
 * covered offline, so this file holds no logic worth testing through a container.
 */

import { readFile } from "node:fs/promises";

import { neweggAdapter } from "./adapters/newegg.js";
import type { RetailerAdapter } from "./adapters/types.js";
import { liveFetcherFromEnv } from "./fetcher/live.js";
import { estimateRun, runList, RUN_DEFAULTS } from "./run.js";
import type { ResolveRequest } from "./resolve.js";

/**
 * Retailer capability is a registry row in the gateway, not a constant here.
 * This map is the last place a retailer is named at all, and it maps a slug the
 * job supplies to the adapter that implements it — so adding a retailer is a
 * new adapter file and one entry, never a change to the engine.
 */
const ADAPTERS: Record<string, RetailerAdapter> = {
  [neweggAdapter.slug]: neweggAdapter,
};

interface JobEnvelope {
  readonly retailerSlug: string;
  readonly items: readonly ResolveRequest[];
  readonly clientCatalogueUrlTemplate?: string | null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value == null || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function readEnvelope(): Promise<JobEnvelope> {
  // A path, not an inline blob: a client list is thousands of rows and an
  // environment variable is not the place for it.
  const path = requireEnv("RESOLUTION_JOB_FILE");
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${path} does not hold a job envelope`);
  }
  const envelope = parsed as Partial<JobEnvelope>;
  if (
    typeof envelope.retailerSlug !== "string" ||
    !Array.isArray(envelope.items)
  ) {
    throw new Error(
      `${path} must carry a retailerSlug and an items array; got ` +
        `${Object.keys(envelope).join(", ") || "nothing"}`,
    );
  }
  return {
    retailerSlug: envelope.retailerSlug,
    items: envelope.items,
    clientCatalogueUrlTemplate: envelope.clientCatalogueUrlTemplate ?? null,
  };
}

async function main(): Promise<void> {
  const version = process.env["RESOLUTION_BUILD_VERSION"] ?? "unknown";
  const envelope = await readEnvelope();

  const adapter = ADAPTERS[envelope.retailerSlug];
  if (adapter === undefined) {
    // Refused up front, by name. Discovering it mid-run would waste whatever
    // had already been paid for.
    throw new Error(
      `no adapter for retailer "${envelope.retailerSlug}"; this image carries: ` +
        `${Object.keys(ADAPTERS).join(", ")}`,
    );
  }

  const { requests, usd } = estimateRun(envelope.items.length, 0);
  console.log(
    `resolution-runtime ${version}: ${envelope.items.length} items against ` +
      `${adapter.slug}; worst-case ${requests.toFixed(0)} requests, ` +
      `~$${usd.toFixed(2)} ESTIMATED (the rate is not invoice-validated)`,
  );

  const fetcher = liveFetcherFromEnv();
  const results = await runList(envelope.items, adapter, fetcher, {
    ...RUN_DEFAULTS,
    runDir: process.env["RESOLUTION_RUN_DIR"] ?? RUN_DEFAULTS.runDir,
    clientCatalogueUrlTemplate: envelope.clientCatalogueUrlTemplate ?? null,
    onProgress: (progress) => {
      if (progress.completed % 25 !== 0) return;
      console.log(
        `[${progress.completed}/${progress.total}] ` +
          `verified=${progress.outcomes.verified} ` +
          `unverifiable=${progress.outcomes.unverifiable} ` +
          `unconfirmed=${progress.outcomes.unconfirmed} ` +
          `not-found=${progress.outcomes["not-found"]} | ` +
          `${progress.liveRequests} requests, ~$${progress.estimatedUsd.toFixed(2)}`,
      );
    },
  });

  const tally = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  const failures = results.filter((r) => r.failure !== null).length;

  console.log(`\n--- done ---`);
  console.log(`items:     ${results.length}`);
  for (const [outcome, count] of Object.entries(tally)) {
    console.log(`  ${outcome.padEnd(14)} ${count}`);
  }
  console.log(`failures:  ${failures}`);
  console.log(`requests:  ${fetcher.liveRequestCount}`);
}

await main();
