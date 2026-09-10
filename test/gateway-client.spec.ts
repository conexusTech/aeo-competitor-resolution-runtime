import { describe, expect, it } from "vitest";

import {
  GATEWAY_PASSWORD_ENV,
  GATEWAY_URL_ENV,
  GATEWAY_USER_ENV,
  GatewayClient,
  MAX_RESOLUTIONS_PER_EVENT,
  RunGone,
  gatewayFromEnv,
  parseJob,
} from "../src/gateway/client.js";
import type { Resolution } from "../src/resolve.js";

/**
 * The gateway seam.
 *
 * 🔴 **The status contract IS the retry policy, and getting it backwards is
 * silent in testing and expensive in production.** A container that retries a
 * 400 retries forever; one that gives up on a 5xx throws away findings it had
 * already paid for. Every case below is one of those two mistakes, refused.
 */

const IDENTITY = {
  runId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  organizationId: "33333333-3333-4333-8333-333333333333",
};

const CREDS = {
  baseUrl: "http://gateway.local",
  user: "ci",
  password: "secret",
};

const JOB = {
  runId: IDENTITY.runId,
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
    queriesTried: ["CyberPower CP1350PFCLCD"],
    candidatesSeen: 1,
    probes: 1,
    requests: 0,
    match: null,
    failure: null,
  }) as unknown as Resolution;

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/**
 * The JSON body of a recorded call.
 *
 * ⚠️ Narrowed rather than `String()`-ed: `init.body` is a `BodyInit`, and
 * stringifying a `ReadableStream` gives "[object Object]" — an assertion
 * against which would pass while checking nothing.
 */
function bodyOf(call: Call | undefined): Record<string, unknown> {
  const body = call?.init?.body;
  if (typeof body !== "string") {
    throw new Error(`the recorded call carries no string body`);
  }
  return JSON.parse(body) as Record<string, unknown>;
}

/** A fetch double that answers from a queue of responses and records calls. */
function stubFetch(answers: (() => Response)[]) {
  const calls: Call[] = [];
  let i = 0;
  const impl = ((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const answer = answers[Math.min(i, answers.length - 1)];
    i++;
    if (answer === undefined) throw new Error("no answer configured");
    return Promise.resolve(answer());
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

const ok =
  (body: unknown = { applied: 1 }) =>
  () =>
    new Response(JSON.stringify(body), { status: 200 });
const status =
  (code: number, body = "") =>
  () =>
    new Response(body, { status: code });
const boom = () => () => {
  throw new Error("ECONNRESET");
};

const client = (
  answers: (() => Response)[],
  log: (m: string) => void = () => {},
) => {
  const { impl, calls } = stubFetch(answers);
  return {
    // No real waiting: the backoff is seven seconds across four attempts,
    // and a suite that pays that per retry case is a suite nobody runs.
    client: new GatewayClient(CREDS, IDENTITY, {
      fetch: impl,
      log,
      sleep: async () => {},
    }),
    calls,
  };
};

describe("credentials", () => {
  it("reads all three at call time and refuses with the names of what is missing", () => {
    expect(() => gatewayFromEnv({})).toThrow(
      new RegExp(
        `${GATEWAY_URL_ENV}, ${GATEWAY_USER_ENV}, ${GATEWAY_PASSWORD_ENV}`,
      ),
    );
    expect(() =>
      gatewayFromEnv({
        [GATEWAY_URL_ENV]: "http://g",
        [GATEWAY_USER_ENV]: "ci",
      }),
    ).toThrow(new RegExp(GATEWAY_PASSWORD_ENV));
  });

  it("says why it refuses at start rather than after spending", () => {
    // 🔑 A run that cannot report is a run whose findings never reach the
    // client, and the money is spent either way — so the refusal belongs before
    // the first fetch, not after the last.
    expect(() => gatewayFromEnv({})).toThrow(/refuses at start rather/);
  });

  it("trims a trailing slash so a url never doubles up", () => {
    expect(
      gatewayFromEnv({
        [GATEWAY_URL_ENV]: "http://g/",
        [GATEWAY_USER_ENV]: "ci",
        [GATEWAY_PASSWORD_ENV]: "s",
      }).baseUrl,
    ).toBe("http://g");
  });
});

describe("fetching the job", () => {
  it("asks the run's own route with Basic auth", async () => {
    const { client: c, calls } = client([ok(JOB)]);
    const job = await c.fetchJob();
    expect(calls[0]?.url).toBe(
      `http://gateway.local/runtime/insights/runs/${IDENTITY.runId}`,
    );
    const auth = (calls[0]?.init?.headers as Record<string, string>)[
      "Authorization"
    ];
    expect(auth).toBe(`Basic ${Buffer.from("ci:secret").toString("base64")}`);
    expect(job.items).toHaveLength(2);
    expect(job.retailerSlug).toBe("newegg");
  });

  it("stops the container when the run has ended", async () => {
    // 🔑 This is the guard that stops a container restarted long after its run
    // was cancelled from buying pages again — the queue deleting a Job is not
    // instantaneous and its retry policy is not ours.
    const { client: c } = client([status(404)]);
    await expect(c.fetchJob()).rejects.toThrow(RunGone);
    await expect(c.fetchJob()).rejects.toThrow(/nothing to resolve/);
  });

  it("does not retry a 404 — an ended run does not un-end", async () => {
    const { client: c, calls } = client([status(404)]);
    await expect(c.fetchJob()).rejects.toThrow(RunGone);
    expect(calls).toHaveLength(1);
  });

  it("retries a 5xx and succeeds on a later attempt", async () => {
    const { client: c, calls } = client([status(503), status(503), ok(JOB)]);
    const job = await c.fetchJob();
    expect(job.itemsTotal).toBe(2);
    expect(calls).toHaveLength(3);
  });

  it("gives up after its attempts, saying what it was doing", async () => {
    const { client: c } = client([boom()]);
    await expect(c.fetchJob()).rejects.toThrow(/could not fetch the job/);
  });
});

describe("the job's shape is checked, not assumed", () => {
  it("refuses a job with no retailer", () => {
    expect(() => parseJob({ items: JOB.items }, "run-1")).toThrow(
      /names no retailer/,
    );
  });

  it("refuses an item missing either identifier", () => {
    expect(() =>
      parseJob({ retailerSlug: "newegg", items: [{ barcode: "1" }] }, "run-1"),
    ).toThrow(/missing barcode or clientSku/);
  });

  it("refuses an empty list, because the gateway will not dispatch one", () => {
    // 🔑 An empty list here means this build and that one disagree — and a run
    // that resolves nothing is reported by the gateway as DEGRADED, which is a
    // confusing answer to a problem that is really this.
    expect(() =>
      parseJob({ retailerSlug: "newegg", items: [] }, "run-1"),
    ).toThrow(/refuses to dispatch an empty list/);
  });
});

describe("posting an event", () => {
  it("puts the identity on the envelope in snake_case", async () => {
    const { client: c, calls } = client([ok()]);
    await c.reportProgress({ itemsReported: 25, requestsSpent: 61 });
    const body = bodyOf(calls[0]);
    expect(body["tenant_id"]).toBe(IDENTITY.tenantId);
    expect(body["organization_id"]).toBe(IDENTITY.organizationId);
    expect(body["type"]).toBe("progress");
    expect(body["items_reported"]).toBe(25);
    expect(body["requests_spent"]).toBe(61);
    // No camelCase leaks into the envelope.
    expect(Object.keys(body).filter((k) => /[A-Z]/.test(k))).toEqual([]);
  });

  it("keeps the resolutions camelCase, byte for byte", async () => {
    // 🔑 Two contracts in one body, deliberately. A resolution is the object
    // journalled to disk, reposted verbatim — renaming its fields would put a
    // translation layer on the one payload whose value is that it is what the
    // pipeline actually produced.
    const { client: c, calls } = client([ok()]);
    const one = resolution("SKU-001");
    await c.reportResolutions([one]);
    const body = bodyOf(calls[0]) as { resolutions: unknown[] };
    expect(body.resolutions[0]).toEqual(JSON.parse(JSON.stringify(one)));
    expect(Object.keys(body.resolutions[0] as object)).toContain("clientSku");
  });

  it("posts to the events route", async () => {
    const { client: c, calls } = client([ok()]);
    await c.reportCompleted(4211);
    expect(calls[0]?.url).toBe(
      `http://gateway.local/runtime/insights/runs/${IDENTITY.runId}/events`,
    );
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("stamps the build version so a finding traces to an image", async () => {
    const { client: c, calls } = client([ok()]);
    await c.reportCompleted(1);
    const body = bodyOf(calls[0]);
    expect(body["runtime_version"]).toBeTypeOf("string");
  });

  it("truncates an error message rather than letting a stack through", async () => {
    const { client: c, calls } = client([ok()]);
    await c.reportError("x".repeat(5000));
    const body = bodyOf(calls[0]) as { message: string };
    expect(body.message).toHaveLength(2000);
  });
});

describe("the retry policy", () => {
  it("retries a 5xx", async () => {
    const { client: c, calls } = client([status(502), status(502), ok()]);
    expect((await c.reportCompleted(1)).kind).toBe("applied");
    expect(calls).toHaveLength(3);
  });

  it("retries a transport failure", async () => {
    const { client: c, calls } = client([boom(), ok()]);
    expect((await c.reportCompleted(1)).kind).toBe("applied");
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry a 400 — a retry loop against a shape mismatch is forever", async () => {
    const { client: c, calls } = client([status(400, "malformed")]);
    const outcome = await c.reportCompleted(1);
    expect(outcome).toMatchObject({ kind: "refused", status: 400 });
    expect(calls).toHaveLength(1);
  });

  it("does NOT retry a 401 or a 403 — a wrong credential does not improve", async () => {
    for (const code of [401, 403]) {
      const { client: c, calls } = client([status(code)]);
      expect(await c.reportCompleted(1)).toMatchObject({
        kind: "refused",
        status: code,
      });
      expect(calls).toHaveLength(1);
    }
  });

  it("reports a 404 as the run being gone, not as a refusal", async () => {
    // The two need different handling: a refusal means keep running and keep
    // journalling; a gone run means stop spending.
    const { client: c } = client([status(404)]);
    expect(await c.reportCompleted(1)).toMatchObject({ kind: "run-gone" });
  });

  it("gives up as unreachable after every attempt, and says so once", async () => {
    const lines: string[] = [];
    const { client: c, calls } = client([status(500)], (m) => lines.push(m));
    const outcome = await c.reportCompleted(1);
    expect(outcome.kind).toBe("unreachable");
    expect(calls).toHaveLength(4);
    // ⚠️ Not acknowledged, and the message says what happens next — the
    // findings stay journalled and a resumed run re-sends them.
    expect(lines.join(" ")).toMatch(/stay journalled/);
  });

  it("carries the gateway's own detail on a refusal, for diagnosis", async () => {
    const { client: c } = client([
      status(400, "resolutions.0.outcome invalid"),
    ]);
    const outcome = await c.reportCompleted(1);
    expect(outcome).toMatchObject({
      kind: "refused",
      detail: expect.stringContaining("resolutions.0.outcome") as unknown,
    });
  });
});

describe("the batch cap is a cross-repo contract", () => {
  it("matches the gateway's declared maximum", () => {
    // 🔑 The receiving DTO declares `@ArrayMaxSize(250)`, so a larger batch is a
    // 400 — non-retryable, and therefore a batch of paid findings lost to a
    // number. Matching rather than guessing lower follows the precedent the
    // prospect scanner set for the scan-event cap.
    expect(MAX_RESOLUTIONS_PER_EVENT).toBe(250);
  });

  it("refuses an over-cap batch here rather than sending it to be 400'd", async () => {
    const { client: c, calls } = client([ok()]);
    const many = Array.from({ length: MAX_RESOLUTIONS_PER_EVENT + 1 }, (_, i) =>
      resolution(`SKU-${i}`),
    );
    await expect(c.reportResolutions(many)).rejects.toThrow(
      /at most 250 findings and this one carries 251/,
    );
    expect(calls).toHaveLength(0);
  });

  it("sends a batch exactly at the cap", async () => {
    const { client: c, calls } = client([ok()]);
    const exact = Array.from({ length: MAX_RESOLUTIONS_PER_EVENT }, (_, i) =>
      resolution(`SKU-${i}`),
    );
    expect((await c.reportResolutions(exact)).kind).toBe("applied");
    expect(calls).toHaveLength(1);
  });

  it("sends nothing for an empty batch", async () => {
    const { client: c, calls } = client([ok()]);
    expect((await c.reportResolutions([])).kind).toBe("applied");
    expect(calls).toHaveLength(0);
  });
});
