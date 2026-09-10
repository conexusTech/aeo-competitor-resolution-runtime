import { describe, expect, it } from "vitest";

import { corpusKey, ReplayFetcher } from "../src/fetcher/replay.js";
import { NotInCorpus } from "../src/fetcher/types.js";

const corpus = {
  entries: [
    { url: "https://example.test/a", body: "<html>a</html>" },
    { url: "https://example.test/b", body: "<html>b</html>" },
  ],
};

describe("ReplayFetcher", () => {
  it("serves a body for a url the corpus holds", async () => {
    const f = new ReplayFetcher(corpus);
    await expect(f.fetch("https://example.test/a")).resolves.toEqual({
      url: "https://example.test/a",
      body: "<html>a</html>",
      cached: true,
    });
  });

  it("spends nothing, ever", async () => {
    const f = new ReplayFetcher(corpus);
    await f.fetch("https://example.test/a");
    await f.fetch("https://example.test/b");
    expect(f.liveRequestCount).toBe(0);
  });

  it("🔴 rejects with NotInCorpus, not with a generic fetch failure", async () => {
    // The distinction is the point. During a replay, a missing url means the
    // CORPUS is incomplete — a defect in the test data. Reported as a network
    // failure it would land on the spike's 5 `error` rows and a wrong answer
    // would look like a faithful reproduction.
    const f = new ReplayFetcher(corpus);
    await expect(
      f.fetch("https://example.test/missing"),
    ).rejects.toBeInstanceOf(NotInCorpus);
  });

  it("reports how much of the corpus a run never touched", async () => {
    // An unused entry means the pipeline asked for something different from
    // what the measured run asked for — worth knowing when a reproduction
    // gets the right totals by a different route.
    const f = new ReplayFetcher(corpus);
    expect(f.entryCount).toBe(2);
    expect(f.unusedEntryCount).toBe(2);
    await f.fetch("https://example.test/a");
    expect(f.unusedEntryCount).toBe(1);
  });

  it("keys on the exact url, so a changed query is a different request", () => {
    expect(corpusKey("https://x.test/?d=a")).not.toBe(
      corpusKey("https://x.test/?d=b"),
    );
    expect(corpusKey("https://x.test/?d=a")).toBe(
      corpusKey("https://x.test/?d=a"),
    );
  });
});
