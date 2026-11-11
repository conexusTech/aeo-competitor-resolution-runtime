import { GatewayClient } from "../src/gateway/client.js";

/**
 * The gateway, as far as a run can see it: the real `GatewayClient` over a
 * `fetch` that serves the job and records every event body the run posts.
 *
 * 🔑 **The real client, so the checks read the wire bodies the gateway will
 * read** — `type`, `requests_spent`, `pages_delivered` — rather than which
 * method a double was called with. Typed as the thing it fakes, with no cast.
 */

export const RUN_IDENTITY = {
  runId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  organizationId: "33333333-3333-4333-8333-333333333333",
} as const;

/** An object out of a parsed body, without a cast. */
export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("the event body is not an object");
  }
  return Object.fromEntries(Object.entries(value));
}

/**
 * How the double answers one event: applied, held open, refused with a 400
 * (a shape no retry fixes), or answered 404 (the run is gone).
 */
export type Answer = "apply" | "hold" | "refuse" | "gone";

export interface GatewayDouble {
  readonly client: GatewayClient;
  /** Every event posted, in the order the requests were made. */
  readonly events: Record<string, unknown>[];
  /** Events whose 200 has been sent, in the order they were answered. */
  readonly answered: Record<string, unknown>[];
  /** Answer every held event now. */
  release(): void;
}

/**
 * @param job The body served for the run's job.
 * @param answer How to answer each event. `hold` keeps the request open until
 * `release()` — or for ever, which is a gateway that never answers.
 */
export function gatewayDouble(
  job: Record<string, unknown>,
  answer: (event: Record<string, unknown>) => Answer = () => "apply",
): GatewayDouble {
  const events: Record<string, unknown>[] = [];
  const answered: Record<string, unknown>[] = [];
  const held: (() => void)[] = [];
  const applied = (event: Record<string, unknown>): Response => {
    answered.push(event);
    return new Response(JSON.stringify({ applied: 1 }), { status: 200 });
  };
  const fetch: typeof globalThis.fetch = (_input, init) => {
    if (init?.method !== "POST") {
      return Promise.resolve(
        new Response(JSON.stringify(job), { status: 200 }),
      );
    }
    const body = init.body;
    if (typeof body !== "string") throw new Error("no string body");
    const event = record(JSON.parse(body));
    events.push(event);
    switch (answer(event)) {
      case "apply":
        return Promise.resolve(applied(event));
      case "refuse":
        return Promise.resolve(new Response("bad shape", { status: 400 }));
      case "gone":
        return Promise.resolve(new Response("no such run", { status: 404 }));
      case "hold":
        return new Promise<Response>((resolve) => {
          held.push(() => resolve(applied(event)));
        });
    }
  };
  const client = new GatewayClient(
    { baseUrl: "http://gateway.test", user: "u", password: "p" },
    RUN_IDENTITY,
    { fetch, sleep: () => Promise.resolve(), log: () => undefined },
  );
  return {
    client,
    events,
    answered,
    release: () => {
      for (const go of held.splice(0, held.length)) go();
    },
  };
}

/** The client SKUs a run's `resolutions` events carried, in order. */
export function filed(events: readonly Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    if (event["type"] !== "resolutions") continue;
    const list = event["resolutions"];
    if (!Array.isArray(list)) continue;
    for (const entry of list) out.push(String(record(entry)["clientSku"]));
  }
  return out;
}

/** The event types, progress ticks left out. */
export const typesOf = (
  events: readonly Record<string, unknown>[],
): unknown[] => events.map((e) => e["type"]).filter((t) => t !== "progress");
