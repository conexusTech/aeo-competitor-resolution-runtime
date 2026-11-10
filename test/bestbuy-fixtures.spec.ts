import { gunzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import manifest from "./raw/manifest.json" with { type: "json" };

/**
 * The committed Best Buy pages carry no session value.
 *
 * 🔴 **A raw Best Buy page carries the request it was served for**: the
 * vendor's egress addresses in `x-forwarded-for`, the visitor token in several
 * encodings, cookies (`SID`, `CTT`, `__gpi`, `s_ecid`) and analytics ids. The
 * committed pages are distilled to the fields the adapter reads, which removes
 * those by construction — and this checks it, over every Best Buy file
 * committed, fixtures and replay corpus alike, so a page added later by hand
 * is held to the same rule.
 */

const dir = (rel: string): string =>
  fileURLToPath(new URL(rel, import.meta.url));

/** Every committed Best Buy body, by name. */
function committedBodies(): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  for (const name of readdirSync(dir("./raw/"))) {
    if (!name.startsWith("bestbuy-")) continue;
    out.push({
      name,
      body: gunzipSync(readFileSync(dir(`./raw/${name}`))).toString("utf8"),
    });
  }
  for (const name of readdirSync(dir("./corpus/"))) {
    if (!name.startsWith("bestbuy-")) continue;
    const corpus: unknown = JSON.parse(
      gunzipSync(readFileSync(dir(`./corpus/${name}`))).toString("utf8"),
    );
    const entries: unknown =
      corpus !== null && typeof corpus === "object"
        ? Reflect.get(corpus, "entries")
        : null;
    if (!Array.isArray(entries)) throw new Error(`${name} has no entries`);
    const list: readonly unknown[] = entries;
    list.forEach((entry, i) => {
      const body: unknown =
        entry !== null && typeof entry === "object"
          ? Reflect.get(entry, "body")
          : null;
      if (typeof body !== "string") throw new Error(`${name}[${i}] no body`);
      out.push({ name: `${name}[${i}]`, body });
    });
  }
  return out;
}

/** The same list the distiller refuses to emit past. */
const SESSION_MARKERS: readonly RegExp[] = [
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/, // an IPv4 address
  /x-forwarded-for/i,
  /visitor(?:Token|Id)/i,
  /"(?:SID|CTT|UT|VT|AT|__gpi|s_ecid|rxVisitor)"/,
  /UID=|MCMID/,
  /brd-customer|hl_[0-9a-f]{6,}|brightdata/i,
  /cookie/i,
];

const bestbuyFixtures = manifest.fixtures.filter((f) =>
  f.name.startsWith("bestbuy-"),
);

describe("the committed Best Buy pages", () => {
  it("are listed in the manifest, each with its size", () => {
    const onDisk = readdirSync(dir("./raw/"))
      .filter((n) => n.startsWith("bestbuy-"))
      .map((n) => n.replace(/\.html\.gz$/, ""))
      .sort();
    expect(bestbuyFixtures.map((f) => f.name).sort()).toEqual(onDisk);
    // Not vacuous: the searches, the product pages and the listing page.
    expect(onDisk.length).toBeGreaterThanOrEqual(8);
    for (const f of bestbuyFixtures) {
      expect(statSync(dir(`./raw/${f.name}.html.gz`)).size).toBe(f.gzBytes);
    }
  });

  it("include a barcode search taken from the investigation's cache", () => {
    const fromCache = bestbuyFixtures.filter(
      (f) =>
        f.name.startsWith("bestbuy-search-upc-") &&
        JSON.stringify(f.facts).includes("recon/captures/bestbuy-upc/cache"),
    );
    expect(fromCache.length).toBeGreaterThan(0);
  });

  it("🔴 carry no session value — no address, token, cookie or vendor id", () => {
    const bodies = committedBodies();
    expect(bodies.length).toBeGreaterThanOrEqual(bestbuyFixtures.length);
    for (const { name, body } of bodies) {
      for (const marker of SESSION_MARKERS) {
        expect(marker.test(body), `${name} matches ${String(marker)}`).toBe(
          false,
        );
      }
    }
  });

  it("CONTROL: the markers find a session value where one is", () => {
    // Without this, a marker list that matched nothing would pass above.
    const leaked = [
      '{"x-forwarded-for":"r1fc0, 23.195.36.147"}',
      '"visitorToken":"01a1c0a2-c8f3-71ae-8713-7842e6ce05ca"',
      '"SID":"a95d4f61"',
      "UID=0000168e468cbbdc:T=1794233265",
    ];
    for (const sample of leaked) {
      expect(SESSION_MARKERS.some((m) => m.test(sample))).toBe(true);
    }
  });

  it("are the pages the adapter reads, not hand-written ones", () => {
    // Every distilled page keeps Best Buy's own GraphQL transport push.
    for (const { name, body } of committedBodies()) {
      expect(body, name).toContain(
        '(window[Symbol.for("ApolloSSRDataTransport")] ??= []).push(',
      );
    }
  });
});
