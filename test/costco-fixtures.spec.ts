import { gunzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import manifest from "./raw/manifest.json" with { type: "json" };

/**
 * The committed Costco pages carry no session value.
 *
 * 🔴 **A raw Costco product page carries the request it was served for**: the
 * sign-in link's `nonce=` and the app's `client_id`, the monitoring agent's
 * `dtTrId`, and a `clientId` uuid on every item. The committed pages are
 * distilled to the fields the adapter reads (`scripts/distil-costco.mjs`,
 * which also proved each one parses identically to its raw capture), and that
 * removes those by construction — this checks it, over every Costco file
 * committed, fixtures and replay corpus alike, so a page added later by hand
 * is held to the same rule.
 */

const dir = (rel: string): string =>
  fileURLToPath(new URL(rel, import.meta.url));

const isCostco = (name: string): boolean => name.startsWith("costco-");

/** Every committed Costco body, by name. */
function committedBodies(): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  for (const name of readdirSync(dir("./raw/"))) {
    if (!isCostco(name)) continue;
    out.push({
      name,
      body: gunzipSync(readFileSync(dir(`./raw/${name}`))).toString("utf8"),
    });
  }
  for (const name of readdirSync(dir("./corpus/"))) {
    if (!isCostco(name)) continue;
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
  /nonce=|client_id=|clientId/i,
  /dtTrId|dtSInfo|dtRpid/,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // a uuid
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/, // an IPv4 address
  /x-forwarded-for/i,
  /brd-customer|hl_[0-9a-f]{6,}|brightdata/i,
  // A header or a script reading one; Costco sells cookies, so not the word.
  /set-cookie|cookie:|document\.cookie/i,
];

const leaks = (body: string): string[] =>
  SESSION_MARKERS.filter((m) => m.test(body)).map(String);

const costcoFixtures = manifest.fixtures.filter((f) => isCostco(f.name));

describe("the committed Costco pages", () => {
  it("are listed in the manifest, each with its size", () => {
    const onDisk = readdirSync(dir("./raw/"))
      .filter(isCostco)
      .map((n) => n.replace(/\.(?:html|xml)\.gz$/, ""))
      .sort();
    expect(costcoFixtures.map((f) => f.name).sort()).toEqual(onDisk);
    // Not vacuous: the index, the sitemaps, the product pages and a shell.
    expect(onDisk.length).toBeGreaterThanOrEqual(9);
    for (const f of costcoFixtures) {
      const file = readdirSync(dir("./raw/")).find((n) =>
        n.startsWith(`${f.name}.`),
      );
      expect(file, f.name).toBeDefined();
      expect(statSync(dir(`./raw/${file ?? ""}`)).size).toBe(f.gzBytes);
    }
  });

  it("include pages taken raw from the investigation's cache", () => {
    // Not only the handover's own fixtures, whose nonce it had already
    // blanked: the distiller is proven on pages that still had theirs.
    const fromCache = costcoFixtures.filter((f) =>
      JSON.stringify(f.facts).includes("recon/captures/costco-upc/cache"),
    );
    expect(fromCache.map((f) => f.name).sort()).toEqual([
      "costco-pdp-airpods-4-anc",
      "costco-sitemap-index",
      "costco-sitemap-p-mod-full",
    ]);
  });

  it("🔴 carry no session value — no nonce, client id, trace id, address or vendor id", () => {
    const bodies = committedBodies();
    expect(bodies.length).toBeGreaterThan(costcoFixtures.length);
    for (const { name, body } of bodies) {
      expect(leaks(body), name).toEqual([]);
    }
  });

  it("CONTROL: the markers find real session values where they are", () => {
    // Without this, a marker list that matched nothing would pass above. Each
    // sample is copied from the raw AirPods page in the investigation's cache,
    // in the encoding the page carries it in.
    const leaked = [
      "nonce=03VbXvcelAZbmDGm\\u0026client_id=4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf",
      '"clientId":"4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf"',
      'dtTrId;desc="a8b107fb06830c963e9b2a0a4e8f06bd"',
    ];
    for (const sample of leaked) {
      expect(leaks(sample), sample).not.toEqual([]);
    }
  });

  it("CONTROL: a session value put back into a committed page is caught", () => {
    // The real file format: the AirPods page's flight data given back the
    // item clientId its raw capture carried.
    const body = gunzipSync(
      readFileSync(dir("./raw/costco-pdp-airpods-4-anc.html.gz")),
    ).toString("utf8");
    expect(leaks(body)).toEqual([]);
    const reinjected = body.replace(
      '\\"id\\":\\"1611943\\"',
      '\\"id\\":\\"1611943\\",\\"clientId\\":\\"4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf\\"',
    );
    expect(reinjected).not.toBe(body);
    expect(leaks(reinjected)).toEqual([
      String(SESSION_MARKERS[0]),
      String(SESSION_MARKERS[2]),
    ]);
  });

  it("are the pages the adapter reads, not hand-written ones", () => {
    for (const { name, body } of committedBodies()) {
      if (name.includes("sitemap")) {
        expect(body, name).toMatch(/<(?:urlset|sitemapindex) xmlns=/);
      } else {
        // Every distilled page keeps the asset path of the Costco app that
        // served it.
        expect(body, name).toMatch(/\/consumer-web\/(?:product|search)\//);
      }
    }
  });

  it("the full product sitemap is small enough to commit, and whole", () => {
    const full = costcoFixtures.find(
      (f) => f.name === "costco-sitemap-p-mod-full",
    );
    expect(full?.gzBytes).toBeLessThan(400_000);
    const body = gunzipSync(
      readFileSync(dir("./raw/costco-sitemap-p-mod-full.xml.gz")),
    ).toString("utf8");
    expect(body.match(/<url>/g)?.length).toBe(18_180);
  });
});
