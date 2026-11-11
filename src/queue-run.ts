/**
 * A run dispatched by the queue, reporting to the gateway as it goes.
 *
 * ⚠️ **This lives outside `main.ts` so it can be tested without a container.**
 * `main.ts` is deliberately thin — it reads the environment and picks a mode —
 * but the sequence below is not thin: the order of the job fetch, the
 * acknowledgement load, the terminal report and the final flush each encode a
 * decision, and the failure they guard against only appears when a run dies
 * part-way. Left inside `main.ts` those would be provable only by running a
 * container against a live gateway, which is exactly the kind of check nobody
 * runs.
 *
 * Every dependency is injected for the same reason.
 */

import { Capturer, tallyCaptures } from "./capture/capturer.js";
import { SYSTEM_CLOCK, type Clock } from "./clock.js";
import type { CaptureRecord } from "./capture/types.js";
import {
  MAX_PAGES_AT_ONCE,
  pagesAtOnce,
  type RetailerAdapter,
} from "./adapters/types.js";
import type { Fetcher } from "./fetcher/types.js";
import type { GatewayClient, ResolutionJob } from "./gateway/client.js";
import type { DispatchPayload } from "./queue/task-record.js";
import type { GatewayReporter } from "./reporting/reporter.js";
import type { Resolution, ResolveRequest } from "./resolve.js";
import type { RunOptions, RunProgress } from "./run.js";
import {
  NEVER_STOPPED,
  SHUTDOWN,
  boundAfterStop,
  type StopRequest,
} from "./stop-signal.js";

/** Progress ticks and log lines are emitted on this boundary. */
export const PROGRESS_EVERY = 25;

export interface QueueRunDeps {
  readonly dispatch: DispatchPayload;
  readonly client: GatewayClient;
  readonly reporter: GatewayReporter;
  /** Resolved from the job's retailer slug — never from the dispatch. */
  readonly adapterFor: (retailerSlug: string) => RetailerAdapter;
  readonly fetcher: Fetcher;
  /**
   * ⚠️ **Typed as `ResolveRequest` rather than an inline pair.** It was
   * `{ barcode, clientSku }`, and that is how the client's product name got
   * silently dropped here: the mapping below satisfied a narrower structural
   * type, so adding a field to the wire shape and to the plan changed nothing
   * and no check could see it. The request type is the one thing both ends
   * already agree on.
   */
  readonly runList: (
    items: readonly ResolveRequest[],
    adapter: RetailerAdapter,
    fetcher: Fetcher,
    options: RunOptions,
  ) => Promise<Resolution[]>;
  readonly baseOptions: RunOptions;
  readonly log?: (message: string) => void;
  /**
   * What the job's time budget and the shutdown's waits are measured on. The
   * system clock unless a check moves one by hand.
   */
  readonly clock?: Clock;
  /**
   * The cluster telling this container to stop (SIGTERM). Never, unless the
   * caller wires one — see `watchForTermination`.
   */
  readonly stop?: StopRequest;
}

export interface QueueRunResult {
  readonly resolutions: readonly Resolution[];
  readonly liveRequests: number;
  /** True when the gateway said the run no longer exists and we stopped. */
  readonly stoppedEarly: boolean;
  /**
   * True when this container handed the run back unfinished — its time
   * budget was spent, or it was told to stop, with items not yet finished —
   * and so answered `yielded` rather than `completed`. ⚠️ The decision, not
   * proof of delivery: after a stop, a gateway that did not answer in time
   * never received it.
   */
  readonly yielded: boolean;
  /** One per resolution offered, whatever happened to it. */
  readonly captures: readonly CaptureRecord[];
}

export async function runDispatchedJob(
  deps: QueueRunDeps,
): Promise<QueueRunResult> {
  const log = deps.log ?? console.log;
  const clock = deps.clock ?? SYSTEM_CLOCK;
  const stop = deps.stop ?? NEVER_STOPPED;
  const stopAsked = (): boolean => stop.askedAt !== null;
  /**
   * A closing report: waited for in full, unless the container has been told
   * to stop — then only until `SHUTDOWN.finishByMs` after the signal, so a
   * gateway that never answers cannot keep it alive until SIGKILL.
   */
  const closing = async (work: Promise<void>, what: string): Promise<void> => {
    const outcome = await boundAfterStop(
      work,
      stop,
      clock,
      SHUTDOWN.finishByMs,
    );
    if (outcome.kind === "timed-out") {
      log(
        `gave up waiting to ${what}: the cluster's grace period is nearly ` +
          `over, and the gateway learns how this container ended from the queue`,
      );
    }
  };
  // 🔑 The budget counts from here, before the job is even fetched: it exists
  // to finish this container well inside the queue's deadline, and that
  // deadline started earlier still.
  const startedAt = clock.now();

  // Before anything is spent: the job, and the adapter that can do it. A
  // terminal run answers 404 here — the guard that stops a container restarted
  // long after its run was cancelled from buying pages again.
  const job: ResolutionJob = await deps.client.fetchJob();
  const adapter = deps.adapterFor(job.retailerSlug);

  if (
    deps.dispatch.itemsTotal !== null &&
    deps.dispatch.itemsTotal !== job.itemsTotal
  ) {
    // Not an error. A list can change between dispatch and fetch — an item
    // withdrawn mid-dispatch is ordinary — and the fetched list is the one the
    // run works. Logged because a large gap deserves someone's attention.
    log(
      `note: the dispatch said ${deps.dispatch.itemsTotal} items and the ` +
        `gateway served ${job.itemsTotal}; working the served list`,
    );
  }

  await deps.reporter.load();
  if (deps.reporter.acknowledgedCount > 0) {
    log(
      `resuming: ${deps.reporter.acknowledgedCount} finding(s) were already ` +
        `accepted by the gateway and will not be re-sent`,
    );
  }

  // The evidence keeper. Built from the JOB's policy, never from the dispatch:
  // the organization's quota can be spent between dispatch and fetch, and the
  // fetched job is the one the run works.
  // 🔴 Built from the job's own per-item flags. A budget says HOW MANY; only
  // these say WHICH — and a run that captured the first budget-many findings
  // would be doing exactly what the selection rules exist to replace.
  const selected = new Set(
    job.items.filter((item) => item.capture).map((item) => item.clientSku),
  );
  const capturer = new Capturer({
    policy: job.capture,
    isSelected: (clientSku) => selected.has(clientSku),
    fetcher: deps.fetcher,
    fetchProfile: adapter.fetchProfile,
    hosts: adapter.hosts,
    runDir: deps.baseOptions.runDir,
    upload: (args) => deps.client.postCapture(args),
    log,
  });
  await capturer.load();
  if (capturer.acceptedCount > 0) {
    log(
      `resuming: ${capturer.acceptedCount} page(s) were already stored and ` +
        `will not be re-posted`,
    );
  }
  if (job.capture.enabled) {
    log(
      `capturing evidence: up to ${job.capture.budget} page(s) this run of ` +
        `${selected.size} selected item(s), format ${job.capture.format}`,
    );
  }

  // 🔑 The registry's figure, from the job, wins over everything; only a
  // gateway that predates it leaves the caller's setting (normally `null`, the
  // adapter's own) in force. `runList` clamps either to `MAX_PAGES_AT_ONCE`.
  const concurrency = job.pagesAtOnce ?? deps.baseOptions.concurrency;
  const source =
    job.pagesAtOnce === null
      ? "the job names none"
      : `the job asked for ${job.pagesAtOnce}`;
  log(
    `pages at once: ${pagesAtOnce(concurrency, adapter.pacing)} ` +
      `(${source}; at most ${MAX_PAGES_AT_ONCE})`,
  );

  // 🔑 **The time budget.** Past it, no new item is taken: an item already
  // taken is finished, the end-of-run retry pass is skipped (both are
  // `runList` honouring `shouldContinue`), and whatever was not reached is
  // handed back with `yielded` for the gateway to give a fresh container.
  const budgetMs =
    job.stopTakingItemsAfterSec === null
      ? null
      : job.stopTakingItemsAfterSec * 1000;
  const budgetSpent = (): boolean =>
    budgetMs !== null && clock.now() - startedAt >= budgetMs;
  if (job.stopTakingItemsAfterSec !== null) {
    log(
      `time budget: no new item after ${job.stopTakingItemsAfterSec}s; ` +
        `whatever is left then is handed back as yielded`,
    );
  }

  let lastTick = 0;
  /**
   * The findings this container made, in the order they were made — what it
   * can say it finished when it stops waiting on an item still in flight.
   */
  const finishedHere: Resolution[] = [];

  try {
    const work = deps.runList(
      job.items.map((item) => ({
        barcode: item.barcode,
        clientSku: item.clientSku,
        productName: item.productName,
        partNumber: item.partNumber,
        brand: item.brand,
      })),
      adapter,
      deps.fetcher,
      {
        ...deps.baseOptions,
        concurrency,
        onResolved: async (resolution) => {
          // 🔴 The finding first, the evidence second, and the order is a
          // priority rather than a correctness argument: the finding is the
          // product and the capture is a convenience. `offer` here is also
          // what enforces journal-before-report, which `runList` guarantees by
          // calling this only after the resolution is on disk.
          await deps.reporter.offer(resolution);
          // Never throws — see `Capturer`. A run must not lose a paid finding
          // because a page could not be stored.
          await capturer.offer(resolution);
          finishedHere.push(resolution);
        },
        // Three things stop a run early. The gateway saying the run is gone:
        // buying pages for findings nobody will accept is pure waste. The time
        // budget, and the cluster's SIGTERM: past either, the rest belongs to
        // the next container.
        shouldContinue: () =>
          !deps.reporter.isRunGone && !budgetSpent() && !stopAsked(),
        onProgress: (progress: RunProgress) => {
          if (progress.completed % PROGRESS_EVERY !== 0) return;
          log(
            `[${progress.completed}/${progress.total}] ` +
              `verified=${progress.outcomes.verified} ` +
              `unverifiable=${progress.outcomes.unverifiable} ` +
              `unconfirmed=${progress.outcomes.unconfirmed} ` +
              `not-found=${progress.outcomes["not-found"]} | ` +
              `${progress.liveRequests} requests, ` +
              `~$${progress.estimatedUsd.toFixed(2)}`,
          );
          if (progress.completed <= lastTick) return;
          lastTick = progress.completed;
          // Deliberately NOT awaited. A progress tick is a convenience, and
          // awaiting it would put the gateway's latency inside the fetch loop;
          // losing one costs a stale number on a screen.
          void deps.reporter.reportProgress({
            itemsReported: progress.completed,
            requestsSpent: progress.liveRequests,
            pagesDelivered: progress.pagesDelivered,
          });
        },
      },
    );

    // 🔑 **The items run to the end — unless the container is told to stop.**
    // Then no new item is taken, and the ones in flight get
    // `SHUTDOWN.inFlightMs` from the signal to finish; one still going after
    // that is abandoned to the next container, so the last findings and
    // `yielded` still go out before SIGKILL.
    const ran = await boundAfterStop(work, stop, clock, SHUTDOWN.inFlightMs);
    const resolutions = ran.kind === "done" ? ran.value : [...finishedHere];

    if (deps.reporter.isRunGone) {
      // Not a completion. The gateway already knows this run ended, and calling
      // it finished would claim work that was cut short.
      log("stopped early: the gateway reported this run as gone");
      return {
        resolutions,
        liveRequests: deps.fetcher.liveRequestCount,
        stoppedEarly: true,
        yielded: false,
        captures: capturer.records,
      };
    }

    // 🔑 **`yielded` only when something is left.** A budget that ran out, or
    // a stop that came, during the last item leaves nothing to hand back, and
    // a `yielded` then would start a container with no work — so it is
    // `completed`, as it would have been without either.
    const unfinished = job.items.length - resolutions.length;
    const yielding =
      (budgetSpent() || stopAsked()) &&
      (ran.kind === "timed-out" || unfinished > 0);

    if (job.capture.enabled) {
      const tally = tallyCaptures(capturer.records);
      log(
        `captures: ${tally.captured} stored, ${tally.failed} failed, ` +
          `${tally.skipped_quota} over budget, ` +
          `${tally.skipped_unselected} not selected, ` +
          `${capturer.remaining} left`,
      );
    }

    if (yielding) {
      const why = stopAsked()
        ? "the container was told to stop"
        : "the time budget ran out";
      const abandoned =
        ran.kind === "timed-out"
          ? `; an item still in flight after ` +
            `${SHUTDOWN.inFlightMs / 1000}s was abandoned`
          : "";
      log(
        `yielding: ${resolutions.length} of ${job.items.length} item(s) ` +
          `finished when ${why}${abandoned}; the rest go to the next container`,
      );
      await closing(
        deps.reporter.reportYielded(
          deps.fetcher.liveRequestCount,
          deps.fetcher.pagesDelivered,
        ),
        "hand the run back",
      );
    } else {
      await closing(
        deps.reporter.reportCompleted(
          deps.fetcher.liveRequestCount,
          deps.fetcher.pagesDelivered,
        ),
        "report completion",
      );
    }
    return {
      resolutions,
      liveRequests: deps.fetcher.liveRequestCount,
      stoppedEarly: false,
      yielded: yielding,
      captures: capturer.records,
    };
  } catch (error) {
    // 🔴 A crash that reported nothing would leave the run live until the
    // gateway's five-minute poller reconciled it from the queue — and a
    // resolution run holds its whole watchlist in `resolving` until it ends, so
    // a silent death locks the list rather than merely misreporting one row.
    const message = error instanceof Error ? error.message : String(error);
    await closing(
      deps.reporter.reportError(message, {
        requests_spent: deps.fetcher.liveRequestCount,
      }),
      "report the error",
    );
    throw error;
  } finally {
    // Whatever happened, findings that were paid for get one last chance to be
    // filed. Both terminal reports flush first, so this covers the case where
    // neither ran — and `flush` is total, so it cannot mask the original error.
    await closing(deps.reporter.flush(), "file the last findings");
  }
}
