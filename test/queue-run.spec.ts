import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { neweggAdapter } from "../src/adapters/newegg.js";
import type { RetailerAdapter } from "../src/adapters/types.js";
import type { Fetcher } from "../src/fetcher/types.js";
import { PROGRESS_EVERY, runDispatchedJob } from "../src/queue-run.js";
import type { DispatchPayload } from "../src/queue/task-record.js";
import type { Resolution } from "../src/resolve.js";
import { RUN_DEFAULTS, runList } from "../src/run.js";

/**
 * The sequence a queue-dispatched run follows.
 *
 * ⚠️ **This is why the orchestration lives outside `main.ts`.** Each ordering
 * below encodes a decision whose failure only appears when a run dies part-way,
 * and inside an entry point they would be provable only by running a container
 * against a live gateway — the kind of check nobody runs.
 */

const DISPATCH: DispatchPayload = {
  resolutionRunId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  organizationId: "33333333-3333-4333-8333-333333333333",
  watchlistId: "44444444-4444-4444-8444-444444444444",
  retailerSlug: "newegg",
  itemsTotal: 2,
};

const JOB = {
  runId: DISPATCH.resolutionRunId,
  retailerSlug: "newegg",
  itemsTotal: 2,
  items: [
    { barcode: "649532609635", clientSku: "SKU-001" },
    { barcode: "884102021862", clientSku: "SKU-011" },
  ],
};

const resolution = (clientSku: string): Resolution =>
  ({
    barcode: "649532609635",
    clientSku,
    outcome: "verified",
    identity: null,
    queriesTried: [],
    candidatesSeen: 1,
    probes: 1,
    requests: 2,
    match: null,
    failure: null,
  }) as unknown as Resolution;

const fetcher = (liveRequestCount = 41): Fetcher => ({
  fetch: () => Promise.reject(new Error("the pipeline is not exercised here")),
  liveRequestCount,
});

/** A reporter double recording the order it was called in. */
function fakeReporter(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const offered: string[] = [];
  return {
    calls,
    offered,
    reporter: {
      load: () => Promise.resolve(void calls.push("load")),
      offer: (r: Resolution) => {
        calls.push(`offer:${r.clientSku}`);
        offered.push(r.clientSku);
        return Promise.resolve();
      },
      flush: () => Promise.resolve(void calls.push("flush")),
      reportProgress: () => Promise.resolve(void calls.push("progress")),
      reportCompleted: () => Promise.resolve(void calls.push("completed")),
      reportError: () => Promise.resolve(void calls.push("error")),
      acknowledgedCount: 0,
      isRunGone: false,
      isReporting: true,
      wasReported: () => false,
      ...over,
    },
  };
}

function fakeClient(job: unknown = JOB) {
  return {
    fetchJob: () => Promise.resolve(job),
    reportProgress: () => Promise.resolve({ kind: "applied" } as const),
    reportResolutions: () => Promise.resolve({ kind: "applied" } as const),
    reportCompleted: () => Promise.resolve({ kind: "applied" } as const),
    reportError: () => Promise.resolve({ kind: "applied" } as const),
  };
}

const adapterFor = (slug: string): RetailerAdapter => {
  if (slug !== "newegg") throw new Error(`no adapter for retailer "${slug}"`);
  return neweggAdapter;
};

describe("a queue-dispatched run", () => {
  it("fetches the job BEFORE loading acknowledgements or spending anything", async () => {
    // The job fetch is the 404 that stops an ended run, so nothing may precede
    // it — least of all a fetch that costs money.
    const order: string[] = [];
    const { reporter } = fakeReporter({
      load: () => Promise.resolve(void order.push("load")),
    });
    await runDispatchedJob({
      dispatch: DISPATCH,
      client: {
        ...fakeClient(),
        fetchJob: () => {
          order.push("fetchJob");
          return Promise.resolve(JOB);
        },
      } as never,
      reporter: reporter as never,
      adapterFor,
      fetcher: fetcher(),
      runList: () => {
        order.push("runList");
        return Promise.resolve([]);
      },
      baseOptions: RUN_DEFAULTS,
      log: () => {},
    });
    expect(order).toEqual(["fetchJob", "load", "runList"]);
  });

  it("drives the run from the gateway's items, not the dispatch's count", async () => {
    let seen: readonly { clientSku: string }[] = [];
    const { reporter } = fakeReporter();
    await runDispatchedJob({
      dispatch: { ...DISPATCH, itemsTotal: 9999 },
      client: fakeClient() as never,
      reporter: reporter as never,
      adapterFor,
      fetcher: fetcher(),
      runList: (items) => {
        seen = items;
        return Promise.resolve([]);
      },
      baseOptions: RUN_DEFAULTS,
      log: () => {},
    });
    expect(seen.map((i) => i.clientSku)).toEqual(["SKU-001", "SKU-011"]);
  });

  it("notes a dispatch/job count mismatch without failing on it", async () => {
    // ⚠️ Not an error: a list can change between dispatch and fetch, and an
    // item withdrawn mid-dispatch is ordinary. Worth a line because a large gap
    // deserves attention.
    const lines: string[] = [];
    const { reporter } = fakeReporter();
    await runDispatchedJob({
      dispatch: { ...DISPATCH, itemsTotal: 8926 },
      client: fakeClient() as never,
      reporter: reporter as never,
      adapterFor,
      fetcher: fetcher(),
      runList: () => Promise.resolve([]),
      baseOptions: RUN_DEFAULTS,
      log: (m) => lines.push(m),
    });
    expect(lines.join(" ")).toMatch(/dispatch said 8926 items.*served 2/);
  });

  it("resolves the adapter from the JOB's retailer, refusing by name", async () => {
    const { reporter } = fakeReporter();
    await expect(
      runDispatchedJob({
        dispatch: DISPATCH,
        client: fakeClient({ ...JOB, retailerSlug: "acme" }) as never,
        reporter: reporter as never,
        adapterFor,
        fetcher: fetcher(),
        runList: () => Promise.resolve([]),
        baseOptions: RUN_DEFAULTS,
        log: () => {},
      }),
    ).rejects.toThrow(/no adapter for retailer "acme"/);
  });

  // ── Terminal paths ──────────────────────────────────────────────────

  it("reports completion on a clean finish", async () => {
    const { calls, reporter } = fakeReporter();
    await runDispatchedJob({
      dispatch: DISPATCH,
      client: fakeClient() as never,
      reporter: reporter as never,
      adapterFor,
      fetcher: fetcher(),
      runList: () => Promise.resolve([resolution("SKU-001")]),
      baseOptions: RUN_DEFAULTS,
      log: () => {},
    });
    expect(calls).toContain("completed");
    expect(calls).not.toContain("error");
  });

  it("reports an error on a crash, and re-throws", async () => {
    // 🔴 A crash that reported nothing would leave the run live until the
    // gateway's five-minute poller reconciled it — and a resolution run holds
    // its whole watchlist in `resolving` until it ends, so a silent death locks
    // the list rather than merely misreporting one row.
    const { calls, reporter } = fakeReporter();
    await expect(
      runDispatchedJob({
        dispatch: DISPATCH,
        client: fakeClient() as never,
        reporter: reporter as never,
        adapterFor,
        fetcher: fetcher(),
        runList: () => Promise.reject(new Error("the proxy died")),
        baseOptions: RUN_DEFAULTS,
        log: () => {},
      }),
    ).rejects.toThrow("the proxy died");
    expect(calls).toContain("error");
    expect(calls).not.toContain("completed");
  });

  it("flushes last, whatever happened", async () => {
    // The case where neither terminal report ran.
    const { calls, reporter } = fakeReporter();
    await expect(
      runDispatchedJob({
        dispatch: DISPATCH,
        client: fakeClient() as never,
        reporter: reporter as never,
        adapterFor,
        fetcher: fetcher(),
        runList: () => Promise.reject(new Error("boom")),
        baseOptions: RUN_DEFAULTS,
        log: () => {},
      }),
    ).rejects.toThrow();
    expect(calls[calls.length - 1]).toBe("flush");
  });

  it("does NOT claim completion for a run the gateway said was gone", async () => {
    // Calling it finished would claim work that was cut short.
    const { calls, reporter } = fakeReporter({ isRunGone: true });
    const result = await runDispatchedJob({
      dispatch: DISPATCH,
      client: fakeClient() as never,
      reporter: reporter as never,
      adapterFor,
      fetcher: fetcher(),
      runList: () => Promise.resolve([]),
      baseOptions: RUN_DEFAULTS,
      log: () => {},
    });
    expect(result.stoppedEarly).toBe(true);
    expect(calls).not.toContain("completed");
  });

  it("does not wait on a progress report, so a slow gateway cannot stall the run", async () => {
    // ⚠️ A progress tick is a convenience. Awaiting it would put the gateway's
    // latency inside the fetch loop of a run that already takes hours, and
    // losing one costs nothing but a stale number on a screen.
    let progressSettled = false;
    const { reporter } = fakeReporter({
      reportProgress: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            progressSettled = true;
            resolve();
          }, 60_000),
        ),
    });

    const result = await runDispatchedJob({
      dispatch: DISPATCH,
      client: fakeClient() as never,
      reporter: reporter as never,
      adapterFor,
      fetcher: fetcher(),
      runList: (_items, _adapter, _f, options) => {
        // Drive one progress tick on the reporting boundary.
        options.onProgress?.({
          completed: PROGRESS_EVERY,
          total: PROGRESS_EVERY,
          outcomes: {
            verified: 1,
            unverifiable: 0,
            unconfirmed: 0,
            "not-found": 0,
          },
          liveRequests: 3,
          estimatedUsd: 0.003,
        });
        return Promise.resolve([]);
      },
      baseOptions: RUN_DEFAULTS,
      log: () => {},
    });

    // The run finished while that report is still outstanding.
    expect(result.stoppedEarly).toBe(false);
    expect(progressSettled).toBe(false);
  });

  it("reports the requests actually spent, from the fetcher's own meter", async () => {
    let reported = -1;
    const { reporter } = fakeReporter({
      reportCompleted: (n: number) => Promise.resolve(void (reported = n)),
    });
    await runDispatchedJob({
      dispatch: DISPATCH,
      client: fakeClient() as never,
      reporter: reporter as never,
      adapterFor,
      // ⚠️ `liveRequestCount` excludes cache hits by contract, which is exactly
      // right: a cache hit cost nothing, so charging for it would overstate.
      fetcher: fetcher(4211),
      runList: () => Promise.resolve([]),
      baseOptions: RUN_DEFAULTS,
      log: () => {},
    });
    expect(reported).toBe(4211);
  });
});

/**
 * The `onResolved` seam, against the real `runList`.
 *
 * 🔑 The ordering is the point: a report must never describe a finding the
 * journal does not hold. A container dying in that window would leave the
 * finding filed remotely and absent locally, so a resume would neither
 * re-resolve it nor re-send it, and nothing anywhere would say what became of
 * that item.
 */
describe("the onResolved seam", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "resolution-run-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** An adapter and fetcher that make `resolveItem` return a clean miss fast. */
  const emptyPipeline = () => ({
    adapter: {
      ...neweggAdapter,
      searchUrl: () => "https://example.test/search",
      parseSearchResults: () => [],
    } as unknown as RetailerAdapter,
    fetcher: {
      fetch: (url: string) =>
        Promise.resolve({ url, body: "<html></html>", cached: true }),
      liveRequestCount: 0,
    } as unknown as Fetcher,
  });

  it("fires once per item, and the finding is ALREADY on disk when it does", async () => {
    const { adapter, fetcher: f } = emptyPipeline();
    const journalPath = path.join(dir, RUN_DEFAULTS.journalName);
    const wasOnDisk: { sku: string; found: boolean }[] = [];

    await runList(
      [
        { barcode: "649532609635", clientSku: "SKU-001" },
        { barcode: "884102021862", clientSku: "SKU-011" },
      ],
      adapter,
      f,
      {
        ...RUN_DEFAULTS,
        runDir: dir,
        onResolved: async (resolution) => {
          // Read the journal from inside the hook: THIS finding must already be
          // a line in it. ⚠️ Asserting a line COUNT here would be asserting the
          // concurrency (3 by default), not the ordering — two items can both
          // journal before either hook runs, which says nothing about whether
          // the ordering is right.
          const text = await readFile(journalPath, "utf8").catch(() => "");
          wasOnDisk.push({
            sku: resolution.clientSku,
            found: text.includes(`"clientSku":"${resolution.clientSku}"`),
          });
        },
      },
    );

    expect(wasOnDisk).toHaveLength(2);
    expect(wasOnDisk.every((r) => r.found)).toBe(true);
    expect(wasOnDisk.map((r) => r.sku).sort()).toEqual(["SKU-001", "SKU-011"]);
  });

  it("stops taking items once shouldContinue says no", async () => {
    const { adapter, fetcher: f } = emptyPipeline();
    let resolved = 0;
    const results = await runList(
      Array.from({ length: 5 }, (_, i) => ({
        barcode: `64953260963${i}`,
        clientSku: `SKU-${i}`,
      })),
      adapter,
      f,
      {
        ...RUN_DEFAULTS,
        runDir: dir,
        concurrency: 1,
        onResolved: () => void resolved++,
        // The one thing that stops a run early: the gateway saying the run is
        // gone. Buying pages for findings nobody will accept is pure waste.
        shouldContinue: () => resolved < 2,
      },
    );
    expect(resolved).toBe(2);
    expect(results.length).toBeLessThan(5);
  });

  it("CONTROL: without shouldContinue, every item is worked", async () => {
    // A stop that fired unconditionally would pass the check above while
    // truncating every run.
    const { adapter, fetcher: f } = emptyPipeline();
    let resolved = 0;
    await runList(
      Array.from({ length: 5 }, (_, i) => ({
        barcode: `64953260963${i}`,
        clientSku: `SKU-${i}`,
      })),
      adapter,
      f,
      {
        ...RUN_DEFAULTS,
        runDir: dir,
        concurrency: 1,
        onResolved: () => void resolved++,
      },
    );
    expect(resolved).toBe(5);
  });

  it("re-buys nothing on a resume, which the journal already guaranteed", async () => {
    const { adapter, fetcher: f } = emptyPipeline();
    const items = [
      { barcode: "649532609635", clientSku: "SKU-001" },
      { barcode: "884102021862", clientSku: "SKU-011" },
    ];
    await runList(items, adapter, f, { ...RUN_DEFAULTS, runDir: dir });

    let resolvedAgain = 0;
    const second = await runList(items, adapter, f, {
      ...RUN_DEFAULTS,
      runDir: dir,
      onResolved: () => void resolvedAgain++,
    });
    // Nothing re-resolved, and the results still come back complete from the
    // journal — so a resumed run reports the same set without re-fetching.
    expect(resolvedAgain).toBe(0);
    expect(second).toHaveLength(2);
  });
});
