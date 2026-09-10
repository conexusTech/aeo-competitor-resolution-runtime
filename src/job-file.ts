/**
 * A job described in a file, for a local or manual run.
 *
 * ⚠️ **This path is kept deliberately, not left behind.** The previous change's
 * exit criterion is met by replaying a committed corpus with no network, no
 * queue and no gateway — so removing the way to drive the pipeline without
 * services would trade a free deterministic check for a paid manual one. It is
 * also how a run is re-driven by hand after an incident.
 *
 * Extracted from `main.ts` so it can be tested: the entry point holds no logic
 * worth testing through a container, and a reader that refuses a bad shape is
 * logic.
 */

import { readFile } from "node:fs/promises";

import type { ResolveRequest } from "./resolve.js";

export const JOB_FILE_ENV = "RESOLUTION_JOB_FILE";

export interface JobEnvelope {
  readonly retailerSlug: string;
  readonly items: readonly ResolveRequest[];
  readonly clientCatalogueUrlTemplate: string | null;
}

/**
 * Read the envelope, refusing a shape the run cannot work.
 *
 * A path rather than an inline blob: a client list is thousands of rows, and an
 * environment variable is not the place for one.
 */
export async function readJobEnvelope(
  path: string,
  read: (p: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<JobEnvelope> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await read(path));
  } catch (error) {
    throw new Error(
      `${path} could not be read as JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${path} does not hold a job envelope`);
  }
  const envelope = parsed as Partial<JobEnvelope>;
  if (
    typeof envelope.retailerSlug !== "string" ||
    envelope.retailerSlug === "" ||
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

/** The configured job file, or an explanation of what is missing. */
export function jobFileFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const path = env[JOB_FILE_ENV];
  if (path == null || path === "") {
    throw new Error(
      `${JOB_FILE_ENV} is required for a run outside the queue. Under the ` +
        `queue the job arrives by reference instead — see src/queue/task-record.ts.`,
    );
  }
  return path;
}
