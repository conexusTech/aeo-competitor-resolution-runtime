import { gunzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import manifest from "./raw/manifest.json" with { type: "json" };

/**
 * The committed B&H pages carry no session value.
 *
 * 🔴 **A raw B&H page carries the request it was served for**: `bhTraceId`,
 * `ssrReqId` and `qasAuthToken` inside its preloaded state, Cloudflare's
 * per-request `__CF$cv$params` and challenge `ray=`, and the watchdog
 * beacon's `reqId=`. The committed pages are distilled to the fields the
 * adapter reads (`scripts/distil-bh.mjs`, which also proved each one parses
 * identically to its raw capture), and that removes those by construction —
 * this checks it, over every B&H file committed, fixtures and replay corpus
 * alike, so a page added later by hand is held to the same rule.
 */

const dir = (rel: string): string =>
  fileURLToPath(new URL(rel, import.meta.url));

/** Every committed B&H body, by name. */
function committedBodies(): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  for (const name of readdirSync(dir("./raw/"))) {
    if (!name.startsWith("bh-")) continue;
    out.push({
      name,
      body: gunzipSync(readFileSync(dir(`./raw/${name}`))).toString("utf8"),
    });
  }
  for (const name of readdirSync(dir("./corpus/"))) {
    if (!name.startsWith("bh-")) continue;
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
  /bhTraceId|ssrReqId|qasAuthToken/i,
  /__CF\$cv\$params|challenge-platform/,
  /[?&](?:reqId|ray)=/,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // a uuid
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/, // an IPv4 address
  /x-forwarded-for/i,
  /brd-customer|hl_[0-9a-f]{6,}|brightdata/i,
  /cookie/i,
];

const leaks = (body: string): string[] =>
  SESSION_MARKERS.filter((m) => m.test(body)).map(String);

const bhFixtures = manifest.fixtures.filter((f) => f.name.startsWith("bh-"));

describe("the committed B&H pages", () => {
  it("are listed in the manifest, each with its size", () => {
    const onDisk = readdirSync(dir("./raw/"))
      .filter((n) => n.startsWith("bh-"))
      .map((n) => n.replace(/\.html\.gz$/, ""))
      .sort();
    expect(bhFixtures.map((f) => f.name).sort()).toEqual(onDisk);
    // Not vacuous: the searches, the product pages, the kit and the shells.
    expect(onDisk.length).toBeGreaterThanOrEqual(10);
    for (const f of bhFixtures) {
      expect(statSync(dir(`./raw/${f.name}.html.gz`)).size).toBe(f.gzBytes);
    }
  });

  it("include pages taken raw from the investigation's cache", () => {
    // Not only the handover's own fixtures, whose session values it had
    // already blanked: the distiller is proven on a page that still had them.
    const fromCache = bhFixtures.filter((f) =>
      JSON.stringify(f.facts).includes("recon/captures/bh-upc/cache"),
    );
    expect(fromCache.length).toBeGreaterThan(0);
  });

  it("🔴 carry no session value — no trace id, token, address or vendor id", () => {
    const bodies = committedBodies();
    expect(bodies.length).toBeGreaterThanOrEqual(bhFixtures.length);
    for (const { name, body } of bodies) {
      expect(leaks(body), name).toEqual([]);
    }
  });

  it("CONTROL: the markers find real session values where they are", () => {
    // Without this, a marker list that matched nothing would pass above.
    // Each sample is copied from the raw M310 page in the investigation's
    // cache, in the encoding the page carries it in.
    const leaked = [
      "&quot;bhTraceId&quot;:&quot;RZQQBOLWCWEI5W4PFCFJ&quot;",
      "&quot;ssrReqId&quot;:&quot;ea62cfe1-919a-45b7-9947-1d9bf2664ac2&quot;",
      "__CF$cv$params={r:'a583bbe40cefef9f',t:'MTc5NDI5OTgzMg=='}",
      "/cdn-cgi/challenge-platform/scripts/precursor/main.js?ray=a583bbe40cefef9f",
      "/aperture/client/watchdog?reqId=ea62cfe1-919a-45b7-9947-1d9bf2664ac2",
    ];
    for (const sample of leaked) {
      expect(leaks(sample), sample).not.toEqual([]);
    }
  });

  it("CONTROL: a session value put back into a committed page is caught", () => {
    // The real file format, not a sample string: the M310 page's preloaded
    // state given back the trace id and request id its raw capture carried.
    const body = gunzipSync(
      readFileSync(dir("./raw/bh-pdp-m310.html.gz")),
    ).toString("utf8");
    expect(leaks(body)).toEqual([]);
    const reinjected = body.replace(
      'data-data="{',
      'data-data="{&quot;ConfigStore&quot;:{&quot;bhTraceId&quot;:' +
        "&quot;RZQQBOLWCWEI5W4PFCFJ&quot;,&quot;ssrReqId&quot;:" +
        "&quot;ea62cfe1-919a-45b7-9947-1d9bf2664ac2&quot;},",
    );
    expect(reinjected).not.toBe(body);
    expect(leaks(reinjected)).toEqual([
      String(SESSION_MARKERS[0]),
      String(SESSION_MARKERS[3]),
    ]);
  });

  it("are the pages the adapter reads, not hand-written ones", () => {
    // Every distilled page keeps B&H's own preloaded-state attribute.
    for (const { name, body } of committedBodies()) {
      expect(body, name).toContain(
        '<div class="bh-preloaded-data" data-data="',
      );
    }
  });
});
