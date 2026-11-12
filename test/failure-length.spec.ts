import { describe, expect, it } from "vitest";

import type {
  ParsedCandidate,
  RetailerAdapter,
} from "../src/adapters/types.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchResult,
} from "../src/fetcher/types.js";
import { GatewayClient } from "../src/gateway/client.js";
import {
  DEFAULT_OPTIONS,
  resolveItem,
  type Resolution,
} from "../src/resolve.js";
import { MAX_FAILURE_LENGTH } from "../src/wire-limits.js";

/**
 * 🔴 **A failure is bounded, because the gateway refuses a long one with a
 * batch-wide 400.** `ResolutionDto.failure` is `@MaxLength(512)` in
 * `aeo-backend`, and the 400 is never retried — every finding in the batch is
 * lost to one item's sentence. The resolver used to quote every query it
 * tried, so a client's 400-character product name alone took the failure
 * past it.
 */

const LONG_NAME = `Acme ${"Ultra ".repeat(80)}Widget`.slice(0, 400);

/** A searched retailer whose searches all answer with no results. */
const adapter: RetailerAdapter = {
  slug: "fake",
  querySupport: {
    maxNumericQueryDigits: null,
    barcodeIsSearchable: false,
    partNumberNeedsBrand: false,
  },
  pacing: { pagesAtOnce: 3 },
  fetchProfile: { country: null, timeoutMs: null },
  maxProbes: null,
  productIndex: null,
  hosts: ["retailer.test"],
  buildSearchUrl: (q) => `https://retailer.test/s?q=${encodeURIComponent(q)}`,
  parseSearchResults: (): ParsedCandidate[] => [],
  parseProductPage: () => null,
};

/** Every search answered; every identity source fails to fetch. */
const fetcher: Fetcher = {
  liveRequestCount: 0,
  pagesDelivered: 0,
  fetch(url: string): Promise<FetchResult> {
    if (url.startsWith("https://retailer.test/s?")) {
      return Promise.resolve({
        url,
        body: "SEARCH",
        cached: true,
        attempts: 0,
      });
    }
    return Promise.reject(new FetchFailed(url, undefined, 502, 3));
  },
};

describe("🔴 a resolution's failure", () => {
  it("is the gateway's 512 characters, in one place", () => {
    expect(MAX_FAILURE_LENGTH).toBe(512);
  });

  it("names the kinds of search it tried, never their text — a 400-character name included", async () => {
    expect(LONG_NAME).toHaveLength(400);
    const r = await resolveItem(
      { barcode: "812348010548", clientSku: "SKU-1", productName: LONG_NAME },
      adapter,
      fetcher,
      {
        ...DEFAULT_OPTIONS,
        clientCatalogueUrlTemplate: "https://catalogue.test/{sku}",
      },
    );
    expect(r.outcome).toBe("not-found");
    expect(r.queriesTried).toEqual([LONG_NAME]);
    expect(r.failure).not.toBeNull();
    expect(r.failure).not.toContain("Ultra");
    expect(r.failure).toContain("the client's product name");
    expect(r.failure).toContain("never by part number");
    expect(r.failure?.length ?? 0).toBeLessThanOrEqual(MAX_FAILURE_LENGTH);
  });

  it("calls the client's name spelled out the client's product name, never a derivation", async () => {
    // An EAN-13 that fits no UPC-A derives no item reference, so every query
    // asked is the client's name, in one form or the other.
    const r = await resolveItem(
      {
        barcode: "4006381333931",
        clientSku: "SKU-1",
        brand: "MSI",
        productName: "MAG X870E TOMAHAWK MAX WF",
      },
      adapter,
      fetcher,
      {
        ...DEFAULT_OPTIONS,
        clientCatalogueUrlTemplate: "https://catalogue.test/{sku}",
      },
    );
    // Every search answers an empty page, so the fallback is asked too.
    expect(r.queriesTried).toEqual([
      "MAG X870E TOMAHAWK MAX WF",
      "MSI MAG X870E TOMAHAWK MAX WIFI",
    ]);
    expect(r.failure).toContain("the client's product name");
    expect(r.failure).not.toContain("derived from its barcode");
  });
});

describe("🔴 the gateway client never posts a failure past the limit", () => {
  const resolution = (failure: string | null): Resolution => ({
    barcode: "812348010548",
    clientSku: "SKU-1",
    outcome: "not-found",
    identity: null,
    queriesTried: [],
    candidatesSeen: 0,
    probes: 0,
    requests: 0,
    match: null,
    alternatives: [],
    failure,
    searchesUnfetched: 0,
    searchesNotResultsPage: 0,
    probesUnanswered: 0,
  });

  const post = async (failures: (string | null)[]): Promise<unknown[]> => {
    const bodies: unknown[] = [];
    const client = new GatewayClient(
      { baseUrl: "https://gateway.test", user: "u", password: "p" },
      { tenantId: "t", organizationId: "o", runId: "r" },
      {
        fetch: (_url, init) => {
          const sent = init?.body;
          if (typeof sent !== "string") throw new Error("no JSON body");
          bodies.push(JSON.parse(sent));
          return Promise.resolve(new Response("{}", { status: 200 }));
        },
        log: () => {},
        sleep: async () => {},
      },
    );
    await client.reportResolutions(failures.map(resolution));
    return bodies;
  };
  const failuresIn = (body: unknown): (string | null)[] =>
    (body as { resolutions: { failure: string | null }[] }).resolutions.map(
      (r) => r.failure,
    );

  it("cuts one longer than 512 to 512, keeping how it starts", async () => {
    // A failure built from an exception message, which can carry a url.
    const long = `could not fetch https://x.test/${"a".repeat(2_000)}`;
    const [body] = await post([long, "short", null]);
    const [cut, short, none] = failuresIn(body);
    expect(cut?.length).toBe(MAX_FAILURE_LENGTH);
    expect(cut?.startsWith("could not fetch https://x.test/aaa")).toBe(true);
    expect(cut?.endsWith("…")).toBe(true);
    expect(short).toBe("short");
    expect(none).toBeNull();
  });

  it("sends one exactly at the limit as it is", async () => {
    const at = "x".repeat(MAX_FAILURE_LENGTH);
    const [body] = await post([at]);
    expect(failuresIn(body)).toEqual([at]);
  });
});
