import { describe, expect, it } from "vitest";

import {
  BootstrapError,
  QUEUE_API_URL_ENV,
  TASK_RECORD_ID_ENV,
  bootstrapFromQueue,
  dispatchFromPayload,
  fetchTaskPayload,
  inQueueMode,
} from "../src/queue/task-record.js";

/**
 * The by-reference handover from `conqrse-queue`.
 *
 * The queue injects exactly one variable and keeps the payload in the portal's
 * own database, so everything here is about not guessing: not guessing that the
 * job is in the environment, not guessing the field names, and not proceeding
 * on a payload that is missing one.
 *
 * 🔴 **A container that ran on partial input would spend money producing
 * findings it could not file** — the worst available outcome, because the money
 * is gone either way.
 */

const PAYLOAD = {
  resolution_run_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  organization_id: "33333333-3333-4333-8333-333333333333",
  watchlist_id: "44444444-4444-4444-8444-444444444444",
  retailer_slug: "newegg",
  items_total: 8926,
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("queue mode is selected by TASK_RECORD_ID and by nothing else", () => {
  it("is on when the variable carries a value", () => {
    expect(inQueueMode({ [TASK_RECORD_ID_ENV]: "task-1" })).toBe(true);
  });

  it("is off when it is absent or empty", () => {
    expect(inQueueMode({})).toBe(false);
    expect(inQueueMode({ [TASK_RECORD_ID_ENV]: "" })).toBe(false);
  });

  it("is off for an environment that merely looks like a queue run", () => {
    // The presence of a gateway or a job file says nothing about who started
    // this process. Only the queue sets the task reference.
    expect(
      inQueueMode({
        [QUEUE_API_URL_ENV]: "http://queue",
        RESOLUTION_GATEWAY_URL: "http://gateway",
        RESOLUTION_JOB_FILE: "./job.json",
      }),
    ).toBe(false);
  });
});

describe("the dispatch payload", () => {
  it("maps to the run, tenant and organization by the gateway's own field names", () => {
    const dispatch = dispatchFromPayload(PAYLOAD);
    expect(dispatch).toEqual({
      resolutionRunId: PAYLOAD.resolution_run_id,
      tenantId: PAYLOAD.tenant_id,
      organizationId: PAYLOAD.organization_id,
      watchlistId: PAYLOAD.watchlist_id,
      retailerSlug: "newegg",
      itemsTotal: 8926,
    });
  });

  it("CONTROL: refuses `org_id`, the plausible name the gateway does not use", () => {
    // 🔑 The scanner's bootstrap records this exact trap: "it is
    // `organization_id`, not `org_id`, which is the sort of detail that costs a
    // run". A reader that accepted either would hide the disagreement.
    const wrong = {
      ...PAYLOAD,
      organization_id: undefined,
      org_id: PAYLOAD.organization_id,
    };
    expect(() => dispatchFromPayload(wrong)).toThrow(/organization_id/);
  });

  it.each([
    "resolution_run_id",
    "tenant_id",
    "organization_id",
    "watchlist_id",
    "retailer_slug",
  ])("refuses a payload with no %s, naming it", (field) => {
    const partial: Record<string, unknown> = { ...PAYLOAD };
    delete partial[field];
    expect(() => dispatchFromPayload(partial)).toThrow(BootstrapError);
    expect(() => dispatchFromPayload(partial)).toThrow(
      new RegExp(`missing[^—]*${field}`),
    );
  });

  it("names every missing field at once rather than the first", () => {
    // Discovering them one container start at a time is how a config error
    // takes five deploys.
    const bare = { retailer_slug: "newegg" };
    expect(() => dispatchFromPayload(bare)).toThrow(
      /resolution_run_id, tenant_id, organization_id, watchlist_id/,
    );
  });

  it("lists the keys it did receive, so a mismatch is diagnosable", () => {
    expect(() => dispatchFromPayload({ scan_run_id: "x" })).toThrow(
      /Keys present: scan_run_id/,
    );
  });

  it("refuses an empty string as a value", () => {
    // A present-but-empty field is a configuration error dressed as data.
    expect(() => dispatchFromPayload({ ...PAYLOAD, tenant_id: "" })).toThrow(
      /tenant_id/,
    );
  });

  it("treats an absent or nonsense items_total as unknown rather than zero", () => {
    // ⚠️ Advisory only, and 0 would be a claim. The gateway refuses to dispatch
    // an empty list, so a 0 here means the two disagree — and the fetched list
    // is what the run actually works either way.
    expect(
      dispatchFromPayload({ ...PAYLOAD, items_total: undefined }).itemsTotal,
    ).toBeNull();
    expect(
      dispatchFromPayload({ ...PAYLOAD, items_total: "8926" }).itemsTotal,
    ).toBeNull();
    expect(
      dispatchFromPayload({ ...PAYLOAD, items_total: -1 }).itemsTotal,
    ).toBeNull();
  });

  it("refuses a payload that is not an object at all", () => {
    expect(() => dispatchFromPayload(null)).toThrow(/no object payload/);
    expect(() => dispatchFromPayload("a string")).toThrow(/no object payload/);
  });
});

describe("reading the task record", () => {
  it("asks the queue for the task by id, under /api/tasks", () => {
    let asked = "";
    const fetchImpl = ((url: string | URL) => {
      asked = String(url);
      return Promise.resolve(jsonResponse({ payload: PAYLOAD }));
    }) as unknown as typeof globalThis.fetch;

    return fetchTaskPayload("http://queue.local/", "task-7", fetchImpl).then(
      (payload) => {
        // The trailing slash on the base must not double up.
        expect(asked).toBe("http://queue.local/api/tasks/task-7");
        expect(payload).toEqual(PAYLOAD);
      },
    );
  });

  it("sends no credential, because the queue's intake is network-gated", async () => {
    // Documented on both sides as a network boundary rather than a credential
    // one. Sending one would be inventing a contract.
    let sawInit: RequestInit | undefined;
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      sawInit = init;
      return Promise.resolve(jsonResponse({ payload: PAYLOAD }));
    }) as unknown as typeof globalThis.fetch;

    await fetchTaskPayload("http://queue", "task-1", fetchImpl);
    expect(sawInit?.headers).toBeUndefined();
  });

  it("explains a non-2xx rather than parsing it", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response("nope", { status: 500 }),
      )) as unknown as typeof globalThis.fetch;
    await expect(
      fetchTaskPayload("http://queue", "task-1", fetchImpl),
    ).rejects.toThrow(/status 500/);
  });

  it("explains a transport failure, naming the url it tried", async () => {
    const fetchImpl = (() =>
      Promise.reject(
        new Error("ECONNREFUSED"),
      )) as unknown as typeof globalThis.fetch;
    await expect(
      fetchTaskPayload("http://queue", "task-1", fetchImpl),
    ).rejects.toThrow(/could not read task task-1 from http:\/\/queue/);
  });
});

describe("bootstrapping", () => {
  const fetchOk = (() =>
    Promise.resolve(
      jsonResponse({ payload: PAYLOAD }),
    )) as unknown as typeof globalThis.fetch;

  it("returns nothing at all when not in queue mode", async () => {
    // File mode must not be perturbed by this path existing.
    expect(await bootstrapFromQueue({}, fetchOk)).toBeNull();
  });

  it("refuses at start when the queue url is missing, naming the variable", async () => {
    // 🔑 The failure has to be legible: the payload is by reference, so without
    // this variable there is no way to reach it — and the fix is a ConfigMap
    // entry on the catalog entry, which the message says.
    await expect(
      bootstrapFromQueue({ [TASK_RECORD_ID_ENV]: "task-1" }, fetchOk),
    ).rejects.toThrow(
      new RegExp(`${TASK_RECORD_ID_ENV} is set[\\s\\S]*${QUEUE_API_URL_ENV}`),
    );
    await expect(
      bootstrapFromQueue({ [TASK_RECORD_ID_ENV]: "task-1" }, fetchOk),
    ).rejects.toThrow(/envFrom\/ConfigMap/);
  });

  it("resolves the dispatch end to end", async () => {
    const dispatch = await bootstrapFromQueue(
      { [TASK_RECORD_ID_ENV]: "task-1", [QUEUE_API_URL_ENV]: "http://queue" },
      fetchOk,
    );
    expect(dispatch?.resolutionRunId).toBe(PAYLOAD.resolution_run_id);
    expect(dispatch?.retailerSlug).toBe("newegg");
  });

  it("reads the environment at call time, not at import time", async () => {
    // ⚠️ A sibling runtime shipped a bug where a top-level
    // `const x = process.env.X` captured `undefined` before anything had loaded
    // the environment, then served its default forever. Two calls with
    // different environments must give different answers.
    expect(await bootstrapFromQueue({}, fetchOk)).toBeNull();
    const second = await bootstrapFromQueue(
      { [TASK_RECORD_ID_ENV]: "task-1", [QUEUE_API_URL_ENV]: "http://queue" },
      fetchOk,
    );
    expect(second).not.toBeNull();
  });

  it("refuses a task record carrying no payload", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse({ id: "task-1", status: "running" }),
      )) as unknown as typeof globalThis.fetch;
    await expect(
      bootstrapFromQueue(
        { [TASK_RECORD_ID_ENV]: "task-1", [QUEUE_API_URL_ENV]: "http://queue" },
        fetchImpl,
      ),
    ).rejects.toThrow(/no object payload/);
  });
});
