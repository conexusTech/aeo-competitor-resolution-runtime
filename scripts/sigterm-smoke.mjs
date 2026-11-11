#!/usr/bin/env node
/**
 * SIGTERM against the real process — the one part of the hand-back the unit
 * checks cannot reach: `main.ts` listening with `process.on` and leaving with
 * `process.exit`.
 *
 *   npm run build && node scripts/sigterm-smoke.mjs yield   # ~1 s
 *   node scripts/sigterm-smoke.mjs twice                    # ~1 s
 *   node scripts/sigterm-smoke.mjs hang                     # ~29 s
 *
 * A local fake queue and gateway on 127.0.0.1, the built entry point in queue
 * mode against the committed replay corpus, so nothing is bought and nothing
 * leaves the machine. The job fetch is held until SIGTERM has been sent, so
 * the signal always lands mid-run.
 *
 * - `yield`: one SIGTERM. Expect exit code 0 and a `yielded` event.
 * - `twice`: two SIGTERMs 200 ms apart. Expect the same, and the second logged
 *   as ignored.
 * - `hang`: the gateway never answers the job fetch, a wait nothing but the
 *   backstop bounds. Expect exit code 1 from the backstop, before the 30 s
 *   grace period. (A hand-back the gateway does not answer is abandoned at
 *   27 s and exits 0 instead — that is checked in test/sigterm-yield.spec.ts.)
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scenario = process.argv[2] ?? "yield";
if (!["yield", "twice", "hang"].includes(scenario)) {
  console.error(`unknown scenario "${scenario}": yield, twice or hang`);
  process.exit(2);
}

const events = [];
let jobAsked = () => undefined;
const jobRequested = new Promise((resolve) => {
  jobAsked = resolve;
});
let releaseJob = () => undefined;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/api/tasks/")) {
    res.end(
      JSON.stringify({
        payload: {
          resolution_run_id: "11111111-1111-4111-8111-111111111111",
          tenant_id: "22222222-2222-4222-8222-222222222222",
          organization_id: "33333333-3333-4333-8333-333333333333",
          watchlist_id: "44444444-4444-4444-8444-444444444444",
          retailer_slug: "newegg",
          items_total: 1,
        },
      }),
    );
    return;
  }
  if (req.method === "GET") {
    jobAsked();
    releaseJob = () =>
      res.end(
        JSON.stringify({
          retailerSlug: "newegg",
          items: [{ barcode: "649532609635", clientSku: "SKU-1" }],
        }),
      );
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    events.push(JSON.parse(body).type);
    res.end(JSON.stringify({ applied: 1 }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const child = spawn(process.execPath, [path.join(repo, "dist/main.js")], {
  cwd: repo,
  env: {
    PATH: process.env.PATH,
    TASK_RECORD_ID: "smoke",
    QUEUE_API_URL: base,
    RESOLUTION_GATEWAY_URL: base,
    RESOLUTION_GATEWAY_USER: "smoke",
    RESOLUTION_GATEWAY_PASSWORD: "smoke",
    RESOLUTION_REPLAY_CORPUS: path.join(
      repo,
      "test/corpus/launch-retailer-53.json.gz",
    ),
    RESOLUTION_RUN_DIR: mkdtempSync(path.join(os.tmpdir(), "sigterm-smoke-")),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));
const started = Date.now();
const exited = new Promise((resolve) =>
  child.on("exit", (code, signal) => resolve({ code, signal })),
);

await jobRequested;
child.kill("SIGTERM");
if (scenario === "twice") {
  await new Promise((resolve) => setTimeout(resolve, 200));
  child.kill("SIGTERM");
}
await new Promise((resolve) => setTimeout(resolve, 300));
if (scenario !== "hang") releaseJob();

const { code, signal } = await exited;
server.close();
const seconds = (Date.now() - started) / 1000;
console.log(
  output
    .split("\n")
    .filter((line) => /SIGTERM|yield|shutdown/i.test(line))
    .join("\n"),
);
console.log(JSON.stringify({ scenario, code, signal, seconds, events }));

const expected =
  scenario === "hang"
    ? code === 1 && seconds < 30 && events.length === 0
    : code === 0 && events.join(",") === "yielded";
console.log(expected ? "PASS" : "FAIL");
process.exit(expected ? 0 : 1);
