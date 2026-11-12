import { describe, expect, it } from "vitest";

import { GatewayClient, parseJob } from "../src/gateway/client.js";
import type { Resolution } from "../src/resolve.js";
import { record } from "./gateway-double.js";

/**
 * The leg id: which container of a run sent a callback.
 *
 * 🔑 **A run can now span several containers**, one after another, and a late
 * callback from an earlier one must not be read as the current one's. So when
 * the gateway names the container's leg in the job, every run event carries it
 * back as `leg_id`. With none named, every body is exactly what it was.
 */

const LEG = "9f1c2b3a-4d5e-4f60-8a7b-0c1d2e3f4a5b";

const job = (extra: Record<string, unknown>): Record<string, unknown> => ({
  retailerSlug: "newegg",
  items: [{ barcode: "812348010548", clientSku: "S" }],
  ...extra,
});

const resolution: Resolution = {
  barcode: "812348010548",
  clientSku: "S",
  outcome: "not-found",
  identity: null,
  alternatives: [],
  queriesTried: [],
  queryTrail: [],
  candidatesSeen: 0,
  probes: 0,
  requests: 1,
  match: null,
  failure: null,
  searchesUnfetched: 0,
  searchesNotResultsPage: 0,
  probesUnanswered: 0,
};

/** A client whose job is `served`, recording the body of every event. */
function clientServing(served: Record<string, unknown>) {
  const bodies: string[] = [];
  const fetch: typeof globalThis.fetch = (_input, init) => {
    if (init?.method === "POST") {
      const body = init.body;
      if (typeof body !== "string") throw new Error("no string body");
      bodies.push(body);
      return Promise.resolve(
        new Response(JSON.stringify({ applied: 1 }), { status: 200 }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(served), { status: 200 }),
    );
  };
  const client = new GatewayClient(
    { baseUrl: "http://gateway.test", user: "u", password: "p" },
    {
      runId: "11111111-1111-4111-8111-111111111111",
      tenantId: "22222222-2222-4222-8222-222222222222",
      organizationId: "33333333-3333-4333-8333-333333333333",
    },
    { fetch, sleep: () => Promise.resolve(), log: () => undefined },
  );
  return { client, bodies };
}

/** One of each run event, in a fixed order. */
async function sendEveryEvent(client: GatewayClient): Promise<void> {
  await client.reportProgress({ itemsReported: 1, requestsSpent: 2 });
  await client.reportResolutions([resolution], 2, 2);
  await client.reportYielded(2, 2);
  await client.reportCompleted(2, 2);
  await client.reportError("boom", { at: "x" }, 2, 2);
}

const EVERY_TYPE = ["progress", "resolutions", "yielded", "completed", "error"];

describe("the job's legId on the wire", () => {
  it("is no leg id when an older gateway sends none, or null", () => {
    expect(parseJob(job({}), "r").legId).toBeNull();
    expect(parseJob(job({ legId: null }), "r").legId).toBeNull();
  });

  it("carries a uuid as it was sent", () => {
    expect(parseJob(job({ legId: LEG }), "r").legId).toBe(LEG);
    const upper = LEG.toUpperCase();
    expect(parseJob(job({ legId: upper }), "r").legId).toBe(upper);
  });

  it("refuses a leg id that is not a uuid string, naming the field", () => {
    for (const bad of [
      123,
      true,
      {},
      "",
      "not-a-uuid",
      `${LEG}x`,
      ` ${LEG}`,
      LEG.replace(/-/g, ""),
    ]) {
      expect(() => parseJob(job({ legId: bad }), "r")).toThrow(/'legId'/);
    }
  });
});

describe("every run event names the leg that sent it", () => {
  it("carries `leg_id` on every event type when the job named a leg", async () => {
    const { client, bodies } = clientServing(job({ legId: LEG }));
    await client.fetchJob();
    await sendEveryEvent(client);
    const events = bodies.map((b) => record(JSON.parse(b)));
    expect(events.map((e) => e["type"])).toEqual(EVERY_TYPE);
    for (const event of events) expect(event["leg_id"]).toBe(LEG);
  });

  it("CONTROL: with no leg named, every body is byte for byte what it was", async () => {
    // Against a client that never read a job — today's bodies.
    const without = clientServing(job({}));
    await without.client.fetchJob();
    await sendEveryEvent(without.client);
    const before = clientServing(job({}));
    await sendEveryEvent(before.client);
    expect(without.bodies).toHaveLength(EVERY_TYPE.length);
    expect(without.bodies).toEqual(before.bodies);
    for (const body of without.bodies) expect(body).not.toContain("leg_id");
  });
});
