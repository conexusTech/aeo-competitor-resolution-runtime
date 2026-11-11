import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 🔴 **A CONTROL proving a session-marker check can fail uses a synthetic
 * value, never one copied from a real page** (security finding 7).
 *
 * The fixture specs prove their leak checks can fire by feeding them samples
 * of a nonce, a trace id, a request id, a visitor token, an address. Those
 * samples used to be copied from the raw captures — real values from real
 * sessions, committed in a test file the distiller never sees. A synthetic
 * value of the same shape proves the same thing and leaks nothing.
 *
 * This reads the fixture specs' own source and requires every value of
 * a session shape in them to be synthetic:
 * - a uuid, or a run of 8+ hex digits with a letter in it, made of at most
 *   three distinct characters (`11111111-1111-4111-8111-111111111111`);
 * - an IPv4 address in a documentation range (RFC 5737);
 * - a named token (a nonce, a trace id, a challenge value) spelling SYNTHETIC.
 */

const SPECS = [
  "costco-fixtures.spec.ts",
  "bh-fixtures.spec.ts",
  "bestbuy-fixtures.spec.ts",
  "category-reads.spec.ts",
];

const source = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");

const fewChars = (value: string): boolean =>
  new Set(value.replace(/-/g, "")).size <= 3;

const DOCUMENTATION_NET = /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/;

/** Every value of a session shape in `text` that is not synthetic. */
function realLooking(text: string): string[] {
  const found: string[] = [];
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  for (const [value] of text.matchAll(uuid)) {
    if (!fewChars(value.toLowerCase())) found.push(value);
  }
  const withoutUuids = text.replace(uuid, "");
  for (const [value] of withoutUuids.matchAll(/\b[0-9a-f]{8,}\b/gi)) {
    if (/[a-f]/i.test(value) && !fewChars(value.toLowerCase()))
      found.push(value);
  }
  for (const [value] of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    if (!DOCUMENTATION_NET.test(value)) found.push(value);
  }
  const named = [
    /nonce=([A-Za-z0-9]{8,})/g,
    /bhTraceId&quot;:&quot;([^&]+)&quot;/g,
    /\bt:'([^']+)'/g,
    /\br:'([^']+)'/g,
  ];
  for (const pattern of named) {
    for (const m of text.matchAll(pattern)) {
      const value = m[1] ?? "";
      if (!value.includes("SYNTHETIC") && !fewChars(value)) found.push(value);
    }
  }
  return found;
}

describe("🔴 the fixture specs' CONTROL samples are synthetic", () => {
  for (const spec of SPECS) {
    it(`${spec} holds no value copied from a real session`, () => {
      expect(realLooking(source(spec))).toEqual([]);
    });
  }

  it("CONTROL: the rule finds a real-looking value where one is", () => {
    expect(
      realLooking(
        '"ssrReqId":"ea12cfe9-919a-45b7-9947-1d9bf2664ac2" nonce=Xy7Qp2Lm9Rt4 ' +
          "ray=9c41de07ab32ff10 10.20.30.40",
      ),
    ).toEqual([
      "ea12cfe9-919a-45b7-9947-1d9bf2664ac2",
      "9c41de07ab32ff10",
      "10.20.30.40",
      "Xy7Qp2Lm9Rt4",
    ]);
    expect(
      realLooking(
        '"id":"11111111-1111-4111-8111-111111111111" nonce=SYNTHETIC0 192.0.2.7',
      ),
    ).toEqual([]);
  });
});
