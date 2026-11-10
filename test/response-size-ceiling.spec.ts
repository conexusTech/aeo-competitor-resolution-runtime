import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIVE_DEFAULTS,
  LiveFetcher,
  MAX_RESPONSE_BYTES,
} from "../src/fetcher/live.js";
import { FetchFailed } from "../src/fetcher/types.js";

/**
 * 🔴 **A body past the response ceiling is a failed attempt, never a cut
 * page** (security finding 4).
 *
 * The live fetcher read every vendor response whole into memory, whatever its
 * size, so one runaway body could exhaust the container. Now it reads the
 * response as a stream and stops at `MAX_RESPONSE_BYTES`: the attempt fails
 * and is retried and counted like any other, and nothing past the ceiling is
 * ever parsed — a cut page would read as a page that lacks whatever was cut.
 */

let cacheDir: string;
const fetcher = () =>
  new LiveFetcher({
    ...LIVE_DEFAULTS,
    apiKey: "k",
    zone: "z",
    cacheDir,
    delayMinMs: 0,
    delayMaxMs: 0,
    throttleDelayMs: 0,
  });

/** A streamed body of `size` bytes, recording how much of it was pulled. */
function streamed(size: number): { response: Response; pulled: () => number } {
  const chunk = new Uint8Array(64 * 1024).fill(0x61);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const n = Math.min(chunk.length, size - sent);
      controller.enqueue(chunk.subarray(0, n));
      sent += n;
    },
  });
  return {
    response: new Response(stream, { status: 200 }),
    pulled: () => sent,
  };
}

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(os.tmpdir(), "ceiling-spec-"));
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: () => void) => {
    fn();
    return 0 as never;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("the response ceiling", () => {
  it("is 12 MB: three times Costco's largest measured page", () => {
    expect(MAX_RESPONSE_BYTES).toBe(12 * 1024 * 1024);
  });

  it("🔴 a body past it fails every attempt, and is not read past the ceiling", async () => {
    const pulls: (() => number)[] = [];
    vi.stubGlobal("fetch", () => {
      const s = streamed(MAX_RESPONSE_BYTES * 4);
      pulls.push(s.pulled);
      return Promise.resolve(s.response);
    });
    const f = fetcher();
    const error: unknown = await f
      .fetch("https://www.costco.com/p/-/x/1")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchFailed);
    expect((error as FetchFailed).attempts).toBe(LIVE_DEFAULTS.attempts);
    // Every attempt was paid for, and none read more than a chunk past it.
    expect(f.liveRequestCount).toBe(LIVE_DEFAULTS.attempts);
    expect(f.pagesDelivered).toBe(0);
    for (const pulled of pulls) {
      expect(pulled()).toBeLessThan(MAX_RESPONSE_BYTES + 256 * 1024);
    }
  });

  it("🔴 a body that says up front it is past the ceiling is refused unread", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response("x".repeat(3_000), {
          status: 200,
          headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
        }),
      ),
    );
    await expect(
      fetcher().fetch("https://www.costco.com/p/-/x/1"),
    ).rejects.toBeInstanceOf(FetchFailed);
  });

  it("CONTROL: a body just under it is a page, read whole", async () => {
    const size = MAX_RESPONSE_BYTES - 1;
    vi.stubGlobal("fetch", () => Promise.resolve(streamed(size).response));
    const result = await fetcher().fetch("https://www.costco.com/p/-/x/1");
    expect(result.body.length).toBe(size);
  });

  it("CONTROL: multi-byte text is decoded across chunks", async () => {
    const text = `${"é".repeat(5_000)}✓`;
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(text, { status: 200 })),
    );
    const result = await fetcher().fetch("https://www.costco.com/p/-/x/1");
    expect(result.body).toBe(text);
  });
});
