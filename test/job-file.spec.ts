import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { neweggAdapter } from "../src/adapters/newegg.js";
import type { RetailerAdapter } from "../src/adapters/types.js";
import type { Fetcher } from "../src/fetcher/types.js";
import {
  JOB_FILE_ENV,
  jobFileFromEnv,
  readJobEnvelope,
} from "../src/job-file.js";
import { inQueueMode } from "../src/queue/task-record.js";
import { RUN_DEFAULTS, runList } from "../src/run.js";

/**
 * File mode: a run driven with **no queue and no gateway**.
 *
 * ⚠️ **Kept deliberately, not left behind.** The previous change's exit
 * criterion is met by replaying a committed corpus offline, so removing the way
 * to drive the pipeline without services would trade a free deterministic check
 * for a paid manual one — and it is also how a run is re-driven by hand after
 * an incident.
 */
describe("file mode", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "resolution-jobfile-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (body: unknown): Promise<string> => {
    const file = path.join(dir, "job.json");
    await writeFile(file, JSON.stringify(body), "utf8");
    return file;
  };

  it("reads a job from a file", async () => {
    const file = await write({
      retailerSlug: "newegg",
      items: [{ barcode: "649532609635", clientSku: "SKU-001" }],
    });
    const envelope = await readJobEnvelope(file);
    expect(envelope.retailerSlug).toBe("newegg");
    expect(envelope.items).toHaveLength(1);
    // Absent means null, never undefined — one shape for "not supplied".
    expect(envelope.clientCatalogueUrlTemplate).toBeNull();
  });

  it("refuses an envelope with no retailer or no items, naming what it got", async () => {
    await expect(readJobEnvelope(await write({ items: [] }))).rejects.toThrow(
      /must carry a retailerSlug and an items array; got items/,
    );
    await expect(
      readJobEnvelope(await write({ retailerSlug: "newegg" })),
    ).rejects.toThrow(/retailerSlug/);
  });

  it("refuses a file that is not JSON, or not an object", async () => {
    const file = path.join(dir, "bad.json");
    await writeFile(file, "not json at all", "utf8");
    await expect(readJobEnvelope(file)).rejects.toThrow(
      /could not be read as JSON/,
    );
    await expect(readJobEnvelope(await write([1, 2, 3]))).rejects.toThrow(
      /must carry a retailerSlug/,
    );
  });

  it("explains a missing job file, and points at the queue path instead", () => {
    expect(() => jobFileFromEnv({})).toThrow(new RegExp(JOB_FILE_ENV));
    expect(() => jobFileFromEnv({})).toThrow(/by reference instead/);
  });

  it("needs neither the queue nor the gateway to run a list", async () => {
    // 🔑 The whole point of this mode. Nothing here touches `QUEUE_API_URL`,
    // `RESOLUTION_GATEWAY_URL` or a credential — and the environment says so.
    expect(inQueueMode({})).toBe(false);

    const file = await write({
      retailerSlug: "newegg",
      items: [
        { barcode: "649532609635", clientSku: "SKU-001" },
        { barcode: "884102021862", clientSku: "SKU-011" },
      ],
    });
    const envelope = await readJobEnvelope(file);

    const adapter = {
      ...neweggAdapter,
      searchUrl: () => "https://example.test/search",
      parseSearchResults: () => [],
    } as unknown as RetailerAdapter;
    const fetcher = {
      fetch: (url: string) =>
        Promise.resolve({ url, body: "<html></html>", cached: true }),
      liveRequestCount: 0,
    } as unknown as Fetcher;

    const results = await runList(envelope.items, adapter, fetcher, {
      ...RUN_DEFAULTS,
      runDir: dir,
    });

    expect(results).toHaveLength(2);
    // And nothing was bought: every page came from the double.
    expect(fetcher.liveRequestCount).toBe(0);
  });
});
