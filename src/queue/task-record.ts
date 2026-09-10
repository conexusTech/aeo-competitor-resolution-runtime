/**
 * Self-bootstrap when launched as a `conqrse-queue` task.
 *
 * 🔑 **The queue does not pass the job.** It injects exactly one environment
 * variable — `TASK_RECORD_ID` — and the business payload stays in the portal's
 * own database. So a container expecting its work in the environment, or in a
 * file on disk, gets nothing at all under the queue.
 *
 * That is not inferred. `configurable-prospect-scanner/aeo/bootstrap.py` is the
 * same fetch on the same contract, and says so from the container's side:
 *
 * > *"The queue does not pass the job. It injects exactly one environment
 * > variable — `TASK_RECORD_ID` — and the payload stays in the portal's own
 * > database: 'Only the reference is injected'."*
 *
 * Everything else the catalog entry declares — the proxy credentials, the
 * gateway URL and its Basic auth — arrives through `envFrom`, which the
 * executor wires normally. Only the *business* payload is by reference.
 *
 * ⚠️ **Field names come from the gateway's enqueue site, not from memory.** It
 * is `organization_id`, not `org_id` — the sort of detail that costs a run, and
 * the sort a plausible guess gets wrong silently.
 */

/** Injected by the k8s executor. Its presence IS "we are running under the queue". */
export const TASK_RECORD_ID_ENV = "TASK_RECORD_ID";

/**
 * Where to read the payload back from. In-cluster this is the portal's
 * ClusterIP service; against a portal on a laptop it is the host address.
 */
export const QUEUE_API_URL_ENV = "QUEUE_API_URL";

/** How long to wait for the task record. One read, at start, before any work. */
const FETCH_TIMEOUT_MS = 30_000;

/** The task reference could not be resolved into a runnable job. */
export class BootstrapError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BootstrapError";
  }
}

/**
 * The dispatch payload, as `InsightsRunsService.start()` writes it.
 *
 * ⚠️ **There is no `items` field, deliberately.** The real client export is
 * 8,926 rows, and the queue persists this payload in its own database — so the
 * list is fetched from the gateway instead. See `src/gateway/client.ts`.
 */
export interface DispatchPayload {
  readonly resolutionRunId: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly watchlistId: string;
  readonly retailerSlug: string;
  /** What the gateway believed the list held at dispatch. Advisory. */
  readonly itemsTotal: number | null;
}

/** True when this process was started by the queue. */
export function inQueueMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[TASK_RECORD_ID_ENV];
  return value != null && value !== "";
}

/**
 * Read the task record and return its payload.
 *
 * The queue's intake is documented as internal with no application auth — a
 * network boundary rather than a credential one — so this sends none.
 */
export async function fetchTaskPayload(
  queueUrl: string,
  taskRecordId: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<unknown> {
  const url = `${queueUrl.replace(/\/+$/, "")}/api/tasks/${encodeURIComponent(taskRecordId)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new BootstrapError(
      `could not read task ${taskRecordId} from ${url}`,
      error,
    );
  }
  if (!response.ok) {
    throw new BootstrapError(
      `could not read task ${taskRecordId} from ${url}: status ${response.status}`,
    );
  }

  let record: unknown;
  try {
    record = await response.json();
  } catch (error) {
    throw new BootstrapError(
      `task ${taskRecordId} did not answer with JSON`,
      error,
    );
  }
  if (record === null || typeof record !== "object") {
    throw new BootstrapError(`task ${taskRecordId} is not an object`);
  }
  return (record as { payload?: unknown }).payload;
}

/**
 * Map the payload onto what a run needs, refusing rather than guessing.
 *
 * ⚠️ **Every required field is named in the failure.** A missing one means this
 * build and the gateway disagree about the envelope, and a container that
 * proceeded on partial input would spend money producing findings it could not
 * file — the worst available outcome, because the money is gone either way.
 */
export function dispatchFromPayload(payload: unknown): DispatchPayload {
  if (payload === null || typeof payload !== "object") {
    throw new BootstrapError(
      `the task record carries no object payload — got ${
        payload === null ? "null" : typeof payload
      }`,
    );
  }
  const raw = payload as Record<string, unknown>;

  const text = (key: string): string | null => {
    const value = raw[key];
    return typeof value === "string" && value !== "" ? value : null;
  };

  const resolutionRunId = text("resolution_run_id");
  const tenantId = text("tenant_id");
  const organizationId = text("organization_id");
  const watchlistId = text("watchlist_id");
  const retailerSlug = text("retailer_slug");

  const missing = Object.entries({
    resolution_run_id: resolutionRunId,
    tenant_id: tenantId,
    organization_id: organizationId,
    watchlist_id: watchlistId,
    retailer_slug: retailerSlug,
  })
    .filter(([, value]) => value === null)
    .map(([key]) => key);

  if (
    missing.length > 0 ||
    resolutionRunId === null ||
    tenantId === null ||
    organizationId === null ||
    watchlistId === null ||
    retailerSlug === null
  ) {
    throw new BootstrapError(
      `the dispatch payload is missing ${missing.join(", ")} — cannot run. ` +
        `Keys present: ${Object.keys(raw).sort().join(", ") || "(none)"}`,
    );
  }

  // Advisory only: the gateway's count at dispatch. The list fetched from the
  // gateway is what the run actually works, because the list can change between
  // the two — an item withdrawn mid-dispatch is ordinary.
  const total = raw["items_total"];
  const itemsTotal =
    typeof total === "number" && Number.isFinite(total) && total >= 0
      ? total
      : null;

  return {
    resolutionRunId,
    tenantId,
    organizationId,
    watchlistId,
    retailerSlug,
    itemsTotal,
  };
}

/**
 * Resolve the dispatch from the queue. Returns `null` when not in queue mode.
 *
 * ⚠️ Reads the environment **at call time**, never at module load. A sibling
 * runtime shipped a bug where a top-level `const x = process.env.X` captured
 * `undefined` before anything had loaded the environment, then served its
 * default forever — a correctly-set variable that did nothing.
 */
export async function bootstrapFromQueue(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<DispatchPayload | null> {
  const taskRecordId = env[TASK_RECORD_ID_ENV];
  if (taskRecordId == null || taskRecordId === "") return null;

  const queueUrl = env[QUEUE_API_URL_ENV];
  if (queueUrl == null || queueUrl === "") {
    throw new BootstrapError(
      `${TASK_RECORD_ID_ENV} is set (queue mode) but ${QUEUE_API_URL_ENV} is ` +
        `not — the payload is delivered by reference and cannot be fetched ` +
        `without it. Declare it on the catalog entry's envFrom/ConfigMap.`,
    );
  }

  const payload = await fetchTaskPayload(queueUrl, taskRecordId, fetchImpl);
  return dispatchFromPayload(payload);
}
