import { describe, expect, it } from "vitest";

import type { ListingReader } from "../src/adapters/types.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchResult,
} from "../src/fetcher/types.js";
import type { ReadJob, ReportOutcome } from "../src/gateway/client.js";
import {
  runReadJob,
  type ListingReading,
  type ReadRunPort,
  type ReadRunResult,
} from "../src/read-run.js";
import { SHUTDOWN, StopSwitch } from "../src/stop-signal.js";
import { FakeClock, settle } from "./fake-clock.js";

/**
 * A listing read told to stop by the cluster files the readings it made and
 * ends its batch, inside the grace period.
 *
 * 🔑 **`error`, never `completed`, when listings were left unread** — the
 * terminal the gateway already gets from the queue for a killed batch, sooner
 * and with the buffered readings filed rather than lost. A read has no
 * `yielded`: its listings are read again at the next slot, and the gateway
 * files the unread ones as missing either way.
 */

const READER: ListingReader = {
  slug: "fake",
  hosts: ["r.test"],
  pacing: { pagesAtOnce: 1 },
  fetchProfile: { country: null, timeoutMs: null },
  readListingPage: (html) => ({
    kind: "page",
    page: {
      pageItemId: html,
      barcode: "812348010548",
      additionalBarcodes: [],
      priceCents: 999,
      inStock: true,
    },
  }),
};

const job = (n: number): ReadJob => ({
  readRunId: "55555555-5555-4555-8555-555555555555",
  retailerSlug: "fake",
  listings: Array.from({ length: n }, (_, i) => ({
    itemId: `L${i}`,
    url: `https://r.test/p/L${i}`,
  })),
  pagesAtOnce: 1,
});

type Hold = number | "forever" | "throttled";

/** Answers each page with its own id; a check can hold or throttle one. */
class HeldFetcher implements Fetcher {
  liveRequestCount = 0;
  fetches = 0;
  get pagesDelivered(): number {
    return this.liveRequestCount;
  }
  constructor(
    private readonly clock: FakeClock,
    private readonly onFetch: (n: number) => Hold,
  ) {}
  fetch(url: string): Promise<FetchResult> {
    const n = ++this.fetches;
    const hold = this.onFetch(n);
    const id = url.slice(url.lastIndexOf("/") + 1);
    if (hold === "throttled") {
      this.liveRequestCount++;
      return Promise.reject(new FetchFailed(url, null, 200, 1));
    }
    const answer = (): FetchResult => {
      this.liveRequestCount++;
      return { url, body: id, cached: false, attempts: 1 };
    };
    if (hold === 0) return Promise.resolve(answer());
    return new Promise<FetchResult>((resolve) => {
      if (hold === "forever") return;
      this.clock.after(hold, () => resolve(answer()));
    });
  }
}

/** The gateway's read callback, recording what it was sent. */
function port(
  listings: number,
  holdReadings = false,
): {
  port: ReadRunPort;
  events: { type: string; ids: string[]; message?: string }[];
} {
  const events: { type: string; ids: string[]; message?: string }[] = [];
  const applied = (): Promise<ReportOutcome> =>
    Promise.resolve({ kind: "applied" });
  return {
    events,
    port: {
      fetchJob: () => Promise.resolve(job(listings)),
      reportReadings: (readings: readonly ListingReading[]) => {
        events.push({ type: "readings", ids: readings.map((r) => r.itemId) });
        return holdReadings
          ? new Promise<ReportOutcome>(() => undefined)
          : applied();
      },
      reportCompleted: () => {
        events.push({ type: "completed", ids: [] });
        return applied();
      },
      reportError: (message: string) => {
        events.push({ type: "error", ids: [], message });
        return applied();
      },
    },
  };
}

function start(
  listings: number,
  script: (n: number, stop: StopSwitch) => Hold,
  holdReadings = false,
  flushAt?: number,
) {
  const clock = new FakeClock();
  const stop = new StopSwitch(clock);
  const fetcher = new HeldFetcher(clock, (n) => script(n, stop));
  const gateway = port(listings, holdReadings);
  let result: ReadRunResult | null = null;
  const done = runReadJob({
    client: gateway.port,
    readerFor: () => READER,
    fetcher,
    now: () => new Date(clock.now()),
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        clock.after(ms, resolve);
      }),
    clock,
    stop,
    log: () => undefined,
    ...(flushAt === undefined ? {} : { flushAt }),
  }).then((r) => {
    result = r;
    return r;
  });
  return {
    done,
    clock,
    stop,
    fetcher,
    events: gateway.events,
    isDone: () => result !== null,
    stopped: async () => {
      await stop.asked;
      await settle();
    },
  };
}

const read = (events: { type: string; ids: string[] }[]): string[] =>
  events.filter((e) => e.type === "readings").flatMap((e) => e.ids);

describe("a listing read told to stop", () => {
  it("takes no new listing, files its readings, and ends the batch naming how far it got", async () => {
    // The stop comes as the third page is asked for; that page is finished.
    const { done, events, fetcher } = start(5, (n, stop) => {
      if (n === 3) stop.request();
      return 0;
    });
    const result = await done;
    expect(fetcher.fetches).toBe(3);
    expect(read(events)).toEqual(["L0", "L1", "L2"]);
    expect(events.map((e) => e.type)).toEqual(["readings", "error"]);
    expect(events[1]?.message).toMatch(/told to stop.*3 of 5/);
    expect(result.stopped).toBe(true);
  });

  it("abandons a page still in flight after the wait, and still files the rest", async () => {
    const { done, events, clock, isDone, stopped } = start(5, (n, stop) => {
      if (n !== 3) return 0;
      stop.request();
      return "forever";
    });
    await stopped();
    await clock.advance(SHUTDOWN.inFlightMs - 1);
    expect(isDone()).toBe(false);
    await clock.advance(1);
    await done;
    expect(read(events)).toEqual(["L0", "L1"]);
    expect(events.map((e) => e.type)).toEqual(["readings", "error"]);
  });

  it("files nothing after ending the batch, even when the abandoned page arrives late", async () => {
    // The wait gives up at 20 s and the batch ends; the abandoned page arrives
    // at 22 s. With batches of one, recording it would send it at once —
    // after the error that ended the batch.
    const { done, events, clock, stopped } = start(
      5,
      (n, stop) => {
        if (n !== 3) return 0;
        stop.request();
        return 22_000;
      },
      false,
      1,
    );
    await stopped();
    await clock.advance(SHUTDOWN.inFlightMs);
    await done;
    await clock.advance(2_000);
    await settle();
    expect(events.map((e) => e.type)).toEqual([
      "readings",
      "readings",
      "error",
    ]);
    expect(read(events)).toEqual(["L0", "L1"]);
  });

  it("stops waiting out a throttled page's re-read at once rather than at the end of its delay", async () => {
    // The first page is throttled and set aside for 20 s; the worker is
    // waiting on it when the stop comes. It must not wait the delay out.
    const { done, events, isDone, stop } = start(1, (n) =>
      n === 1 ? "throttled" : 0,
    );
    await settle();
    expect(isDone()).toBe(false);
    stop.request();
    await settle();
    await done;
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect(events[0]?.message).toMatch(/0 of 1/);
  });

  it("is not held past the grace period by a readings batch the gateway never answers", async () => {
    const { done, clock, isDone, stopped } = start(
      5,
      (n, stop) => {
        if (n === 3) stop.request();
        return 0;
      },
      true,
    );
    await stopped();
    await clock.advance(SHUTDOWN.finishByMs - 1);
    expect(isDone()).toBe(false);
    await clock.advance(1);
    await done;
    expect(clock.now()).toBeLessThan(SHUTDOWN.graceMs);
  });

  it("completes as usual when told to stop after its last listing was read", async () => {
    const { done, events } = start(3, (n, stop) => {
      if (n === 3) stop.request();
      return 0;
    });
    const result = await done;
    expect(read(events)).toEqual(["L0", "L1", "L2"]);
    expect(events.map((e) => e.type)).toEqual(["readings", "completed"]);
    expect(result.stopped).toBe(false);
  });

  it("CONTROL: never told to stop, it reads every listing and completes", async () => {
    const { done, events } = start(4, () => 0);
    const result = await done;
    expect(read(events)).toEqual(["L0", "L1", "L2", "L3"]);
    expect(events.map((e) => e.type)).toEqual(["readings", "completed"]);
    expect(result.stopped).toBe(false);
  });
});
