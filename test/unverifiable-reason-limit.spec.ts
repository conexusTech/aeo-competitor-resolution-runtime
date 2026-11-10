import { gunzipSync } from "node:zlib";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { amazonAdapter } from "../src/adapters/amazon.js";
import { bestbuyAdapter } from "../src/adapters/bestbuy.js";
import { bhAdapter, DISCONTINUED_NO_UPC } from "../src/adapters/bh.js";
import { costcoAdapter } from "../src/adapters/costco.js";
import { neweggAdapter } from "../src/adapters/newegg.js";
import {
  MAX_UNVERIFIABLE_REASON_LENGTH,
  type RetailerAdapter,
} from "../src/adapters/types.js";

/**
 * No adapter states an unverifiable reason the gateway would refuse.
 *
 * 🔴 **A reason past `MAX_UNVERIFIABLE_REASON_LENGTH` costs a whole batch**:
 * the gateway answers it with a 400 that is never retried. The client refuses
 * to send one (see `gateway-client.spec.ts`), which keeps the batch from being
 * lost but still fails the run — so every reason an adapter can state is held
 * to the limit here, on every real page committed to this repo.
 */

const ADAPTERS: readonly RetailerAdapter[] = [
  neweggAdapter,
  amazonAdapter,
  bestbuyAdapter,
  bhAdapter,
  costcoAdapter,
];

const dir = (rel: string): string =>
  fileURLToPath(new URL(rel, import.meta.url));

/** Every committed page body: the raw fixtures and every replay corpus. */
function committedBodies(): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir("./raw/"))) {
    if (!name.endsWith(".gz")) continue;
    out.push(gunzipSync(readFileSync(dir(`./raw/${name}`))).toString("utf8"));
  }
  for (const name of readdirSync(dir("./corpus/"))) {
    const corpus: unknown = JSON.parse(
      gunzipSync(readFileSync(dir(`./corpus/${name}`))).toString("utf8"),
    );
    const entries: unknown =
      corpus !== null && typeof corpus === "object"
        ? Reflect.get(corpus, "entries")
        : null;
    if (!Array.isArray(entries)) throw new Error(`${name} has no entries`);
    const list: readonly unknown[] = entries;
    for (const entry of list) {
      const body: unknown =
        entry !== null && typeof entry === "object"
          ? Reflect.get(entry, "body")
          : null;
      if (typeof body === "string") out.push(body);
    }
  }
  return out;
}

describe("every unverifiable reason fits the gateway's limit", () => {
  const bodies = committedBodies();
  const reasons = new Map<string, Set<string>>();
  for (const adapter of ADAPTERS) {
    const seen = new Set<string>();
    for (const body of bodies) {
      const reason = adapter.parseProductPage(body)?.unverifiableReason;
      if (typeof reason === "string") seen.add(reason);
    }
    reasons.set(adapter.slug, seen);
  }

  it("is the gateway's 200 characters", () => {
    expect(MAX_UNVERIFIABLE_REASON_LENGTH).toBe(200);
  });

  for (const adapter of ADAPTERS) {
    it(`🔴 ${adapter.slug}: no reason on any committed page exceeds it`, () => {
      for (const reason of reasons.get(adapter.slug) ?? []) {
        expect(reason.length).toBeGreaterThan(0);
        expect(reason.length).toBeLessThanOrEqual(
          MAX_UNVERIFIABLE_REASON_LENGTH,
        );
      }
    });
  }

  it("B&H's discontinued reason is among them, so the check reads something", () => {
    // CONTROL: were no page to yield a reason, every check above would pass
    // over an empty set.
    expect([...(reasons.get("bh") ?? [])]).toEqual([DISCONTINUED_NO_UPC]);
    expect(DISCONTINUED_NO_UPC.length).toBeLessThanOrEqual(
      MAX_UNVERIFIABLE_REASON_LENGTH,
    );
  });

  it("the adapters that state no reason state none", () => {
    for (const slug of ["newegg", "amazon", "bestbuy", "costco"]) {
      expect([...(reasons.get(slug) ?? [])]).toEqual([]);
    }
  });
});
