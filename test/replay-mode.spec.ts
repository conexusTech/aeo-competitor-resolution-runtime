import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUNDLED_CORPUS_PATH,
  buildVersion,
  fetcherFromEnv,
  isReplaying,
  loadCorpus,
  REPLAY_CORPUS_ENV,
  REPLAY_VERSION_SUFFIX,
} from "../src/fetcher/select.js";
import { ReplayFetcher } from "../src/fetcher/replay.js";

/**
 * Selecting the fetcher, and the stamp that makes a replayed run answerable
 * for later.
 *
 * 🔴 **The direction is the whole safety argument.** Live is what an absent
 * variable gets. A replay silently preferred in production would report
 * findings nobody paid for as though they were fresh, on the one screen a
 * customer is most likely to quote back — so "unset means live" is asserted
 * rather than assumed, and mutation-tested in both directions.
 */

const CORPUS = {
  entries: [{ url: "https://example.test/a", body: "<html/>" }],
};

function corpusFile(name: string, bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "replay-"));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

// ── Which fetcher ─────────────────────────────────────────────────────

describe("isReplaying", () => {
  it("is false when the variable is absent — the default that matters", () => {
    expect(isReplaying({})).toBe(false);
  });

  it("is false for an EMPTY variable, not true", () => {
    // ⚠️ A catalog entry that declares the key with no value, or a shell that
    // exports it empty, must not turn a paid run into a replay. Empty is the
    // shape an unset-but-declared variable actually takes.
    expect(isReplaying({ [REPLAY_CORPUS_ENV]: "" })).toBe(false);
  });

  it("is true when a path is named", () => {
    expect(isReplaying({ [REPLAY_CORPUS_ENV]: "/app/corpus/x.json.gz" })).toBe(
      true,
    );
  });
});

describe("fetcherFromEnv", () => {
  it("replays from a gzipped corpus", () => {
    const path = corpusFile(
      "c.json.gz",
      gzipSync(Buffer.from(JSON.stringify(CORPUS), "utf8")),
    );
    const fetcher = fetcherFromEnv({ [REPLAY_CORPUS_ENV]: path });
    expect(fetcher).toBeInstanceOf(ReplayFetcher);
    expect((fetcher as ReplayFetcher).entryCount).toBe(1);
  });

  it("reports zero live requests, so a replayed run prices at nothing", () => {
    // 🔑 The cost estimate reads `liveRequestCount`. A replay that reported
    // requests would put a dollar figure on pages nobody bought.
    const path = corpusFile(
      "c.json.gz",
      gzipSync(Buffer.from(JSON.stringify(CORPUS), "utf8")),
    );
    const fetcher = fetcherFromEnv({ [REPLAY_CORPUS_ENV]: path });
    expect(fetcher.liveRequestCount).toBe(0);
  });

  it("builds the LIVE fetcher when no corpus is named", () => {
    // 🔴 The control, and the one that matters most. With no Bright Data
    // credentials the live fetcher refuses BY NAME — which is exactly how we
    // know the live path was taken rather than a replay.
    expect(() => fetcherFromEnv({})).toThrow(/BRIGHTDATA_API_KEY/);
  });

  it("refuses a corpus path that does not exist, at START", () => {
    // The runtime's own convention: a run that cannot do its job says so
    // before spending, not after.
    expect(() =>
      fetcherFromEnv({ [REPLAY_CORPUS_ENV]: "/nope/missing.json.gz" }),
    ).toThrow();
  });
});

// ── Reading a corpus ──────────────────────────────────────────────────

describe("loadCorpus", () => {
  it("reads plain JSON as well as gzip, decided by the BYTES", () => {
    // 🔑 The gzip magic number rather than the file extension: a corpus copied
    // without its suffix is a mistake worth surviving.
    const plain = corpusFile("c.json", Buffer.from(JSON.stringify(CORPUS)));
    expect(loadCorpus(plain).entries).toHaveLength(1);

    const gz = corpusFile(
      "mislabelled.json",
      gzipSync(Buffer.from(JSON.stringify(CORPUS), "utf8")),
    );
    expect(loadCorpus(gz).entries).toHaveLength(1);
  });

  it("refuses a file that is not a corpus rather than replaying nothing", () => {
    // 🔴 An empty or wrong-shaped corpus would report every item as
    // NOT-FOUND — a plausible answer, and the wrong one. That is the failure
    // mode this repo has recorded twice: a confident result with no error.
    const wrong = corpusFile("x.json", Buffer.from(JSON.stringify({ a: 1 })));
    expect(() => loadCorpus(wrong)).toThrow(/not a corpus/);
  });
});

// ── The stamp ─────────────────────────────────────────────────────────

describe("buildVersion", () => {
  it("is the build alone on a live run", () => {
    expect(buildVersion({ RESOLUTION_BUILD_VERSION: "abc123@deadbeef" })).toBe(
      "abc123@deadbeef",
    );
  });

  it("appends the replay marker on a replayed run", () => {
    // 🔴 The gateway PERSISTS this on `insights_runs.runtime_version`, so a
    // replayed run stays identifiable after the fact. A log line would be gone
    // by the time anybody asks "was that measured today?".
    expect(
      buildVersion({
        RESOLUTION_BUILD_VERSION: "abc123@deadbeef",
        [REPLAY_CORPUS_ENV]: "/app/corpus/x.json.gz",
      }),
    ).toBe(`abc123@deadbeef${REPLAY_VERSION_SUFFIX}`);
  });

  it("still names the build it replayed on, rather than replacing it", () => {
    // ⚠️ A suffix, not a substitution: "which image was this" and "was it paid
    // for" are different questions and both get an answer.
    const stamped = buildVersion({
      RESOLUTION_BUILD_VERSION: "abc123@deadbeef",
      [REPLAY_CORPUS_ENV]: "/x",
    });
    expect(stamped).toContain("abc123@deadbeef");
  });

  it("says unknown rather than throwing when the build was not stamped", () => {
    expect(buildVersion({})).toBe("unknown");
    expect(buildVersion({ [REPLAY_CORPUS_ENV]: "/x" })).toBe(
      `unknown${REPLAY_VERSION_SUFFIX}`,
    );
  });

  it("fits the column the gateway stores it in", () => {
    // `insights_runs.runtime_version` is varchar(120). A stamp that overflowed
    // it would be rejected at the callback, losing the finding rather than the
    // marker.
    const longest = buildVersion({
      RESOLUTION_BUILD_VERSION: "a".repeat(100),
      [REPLAY_CORPUS_ENV]: "/x",
    });
    expect(longest.length).toBeLessThanOrEqual(120);
  });
});

// ── Every reporting path carries it ───────────────────────────────────

describe("the stamp reaches every report, not one of them", () => {
  /**
   * 🔴 **`RESOLUTION_BUILD_VERSION` was read in THREE independent places** —
   * `main.ts` and two separate request bodies in `gateway/client.ts`. Stamping
   * one would leave a replayed capture upload, or a replayed terminal event,
   * reporting a clean version — and those are the two records an auditor would
   * reach for.
   *
   * ⚠️ This is a **source** check, which this repo normally avoids. It is here
   * because the property is "no other copy exists", and an absence has no
   * natural failure mode: exercising the three call sites proves they agree
   * today and nothing about a fourth being added tomorrow.
   */
  it("leaves no direct read of the build version outside the accessor", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const files = ["../src/main.ts", "../src/gateway/client.ts"];
    for (const rel of files) {
      const path = fileURLToPath(new URL(rel, import.meta.url));
      const source = readFileSync(path, "utf8");
      expect(source).not.toContain('process.env["RESOLUTION_BUILD_VERSION"]');
    }
  });

  it("names the bundled corpus path the image actually carries", async () => {
    // ⚠️ The Dockerfile copies `test/corpus` to `/app/corpus`. If either side
    // moved, a catalog entry pointing at the constant would refuse at start —
    // loudly, but only when somebody tried to use it.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const dockerfile = readFileSync(
      fileURLToPath(new URL("../Dockerfile", import.meta.url)),
      "utf8",
    );
    expect(dockerfile).toContain("COPY test/corpus ./corpus");

    // 🔴 **Both halves, because the COPY is dead without the second.**
    // `.dockerignore` excludes `test` wholesale, so the first build attempt
    // failed with "/test/corpus: not found" — loudly, which is how it was
    // found. But a later reader tidying that exception away would break replay
    // mode with a build error rather than a silent one, and the pair is what
    // makes the feature reachable at all.
    const dockerignore = readFileSync(
      fileURLToPath(new URL("../.dockerignore", import.meta.url)),
      "utf8",
    );
    expect(dockerignore).toContain("!test/corpus");
    expect(BUNDLED_CORPUS_PATH.startsWith("/app/corpus/")).toBe(true);
    // The file the constant names is the one committed here.
    expect(BUNDLED_CORPUS_PATH).toContain("launch-retailer-53.json.gz");
  });
});
