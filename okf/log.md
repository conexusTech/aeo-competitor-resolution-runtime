# OKF Log

## 2026-09-10

- **Update** — The adapter seam and the identity layer. `src/adapters/types.ts` is the seam every retailer-varying behaviour sits behind, plus `canQuery`; `src/identity/` holds the provenanced identity model, a barcode derivation and a `schema.org/Product` reader. Gate green: 6 suites, 79 tests.

- **Learning** — 🔑 **The client's own catalogue publishes the part number the pipeline was inferring from a search engine, and it publishes it as a STANDARD.** Measured on the 7 client pages the handover spike captured: **7 of 7** carry a `schema.org/Product` JSON-LD node with `sku`, `mpn` and `brand`. So the primary identity source is a **standards reader**, not a scraper for one client — a client publishing structured data needs no code here at all, only a URL template in configuration. That is what makes it satisfy "no customer named in a code path" rather than merely avoid the phrase. Verified by running the committed reader against the untouched captures: **7 of 7 correct**.

- **Learning** — 🔴 **The free barcode derivation is right 3 times out of 4 on numeric part numbers and wrong in a way nothing about the answer reveals.** A UPC-A's manufacturer item reference reproduces the published part number exactly for `30184`, `10174` and `29648` — and yields `01043` where the real one is `63005`. Both are 5-digit numerics. **So "it is free, try it first and stop" is the wrong design**: it would take a wrong identity while an authoritative one was one request away. It is a **corroborator** — sources are tried in order of *authority, not cost*, and agreement between two independent derivations is recorded as evidence rather than discarded. The handover had no notion of provenance at all, so nothing downstream could tell an inferred pairing from a stated one.

- **Learning** — ⚠️ **A blacklist redaction leaked the customer's domain 7 times and its name 9 times, and reading it did not reveal that.** Building the committed fixture from real client pages, the first pass redacted `@id`, `url` and `image` — and missed `offers["@id"]` and the `review` nodes. The fix is not a longer blacklist: it is **sanitise every string recursively, then assert nothing survived and refuse to write the file if anything did**. The committed spec re-asserts it, so a hand-edit cannot quietly reintroduce it. **A redaction you can only verify by reading is not a redaction.**

- **Learning** — **My own first `gtinCore` mined a digit out of a part number, and its own control test caught it.** `SQR-WKIT-R2` is a real value from a real client's barcode column; stripping non-digits yields `2`, so two unrelated part numbers would have compared **equal**. That is the mine-digits-from-a-non-barcode failure `aeo-backend`'s upload explicitly refuses, arriving through the back door of a comparison helper. Fixed with a GTIN-width guard and proven load-bearing by removing it. 🔑 **The lesson is where the test came from**: the assertion that caught it exists only because the control was written before the implementation was trusted.

- **Learning** — ⚠️ **The 7 "second retailer" captures are the CLIENT's own catalogue, and I said otherwise first.** They sit under a `mc` prefix beside the competitor's captures and I read them as a second retailer's — evidence, I said, that the adapter seam was not imaginary. Checking rather than asserting: **7 of 7 match a client row on both SKU and barcode.** They are the client's own pages. The correction is what produced the identity finding above, so the cost of being wrong out loud was zero and the cost of not checking would have been a fabricated claim about the seam.

- **Update** — Repo created and scaffolded for `competitor-resolution-runtime` (Phase CI-1, row 3). TypeScript + npm, one `gate` entry point running lint · typecheck · build · test · `okf:check`, CI running that same entry point, and an OKF bundle with `index.md` and `service.md`. Deliberately **TypeScript rather than Python**, unlike the two AgentCore runtimes: the handover spike that measured this whole strategy is 615 lines of TypeScript with its reasoning written down, so this row is a port behind an adapter seam rather than a rewrite.

- **Learning** — 🔑 **611 cached HTTP responses from the handover's 53-row run survive on disk, which turns this row's exit criterion from a paid manual run into a free deterministic test.** 71 search-engine pages, 271 retailer searches, 255 product pages, 160.6 MB. Everything above the fetcher is pure, so the whole pipeline can be replayed offline — the same property `aeo-howto-generation-runtime` has, and the reason it has 127 tests. ⚠️ **160 MB cannot be committed, and the cache is in one Downloads folder on one machine** — which is precisely the shape of the `commit-eap-parity-fixtures` finding: a fixture that lives on one machine makes a test that only runs there. The corpus has to be distilled to something committable, with the distillation script committed beside it.

- **Learning** — 🔴 **The retailer's barcode field is not fixed-width; it zero-pads, and a byte comparison would report 18% of proven pairings as mismatches.** Measured on the 22 verified rows: 18 twelve-digit, 2 thirteen, 2 fourteen, and only **18 of 22 byte-equal** to the client's value. All four differences are zero-padded forms of the same UPC-A. **A false mismatch is the worst output this product has, because it reads exactly like a real one.** The handover already gets this right and the way it does is the design decision worth keeping: the comparison key is **derived at compare time and never stored** — strip leading zeros from both sides. That is also why `aeo-backend` storing an EAN-13 at 13 digits was right; storage is the record, the comparison key is a function of it.

- **Learning** — ⚠️ **The EAN-13 question that gates this row's outcome states is still open, and the 53-row sample cannot close it.** Exactly one row carries a 13-digit client value and it came back `not-found` — no product page, so no barcode to compare. **A 0-for-1 record is not evidence either way.** It matters because 1,081 of the client's 8,926 items are genuine EAN-13s: if the retailer's field never carries EAN-13 for an import, those are **unverifiable rather than mismatched**. So `unverifiable` is a first-class outcome from the first commit, and the question gets answered by a deliberate probe that costs real requests — not by inference from this sample.

- **Learning** — **This repo pins `eol=lf` in `.gitattributes` from its first commit, and that is not housekeeping.** Two repos in this workspace carry a red lint baseline made *entirely* of `Delete ␍` — 9,216 in `aeo-howto-web`, most of `aeo-backend`'s 33,818 — because `core.autocrlf` is true globally and neither repo pinned line endings. Both cost real time to diagnose, and neither is fixable now without rewriting every file in the repo. It also lints the whole tree at `--max-warnings 0` rather than only changed files, which `aeo-backend` cannot do: a new repo has no debt to scope around.

## 2026-09-10

### Update — `resolution-runtime-gateway-dispatch`

**Concepts added:** `capabilities/resolution-run-dispatch`,
`qa/resolution-run-dispatch`. **Concepts updated:** `service.md`.

The container now takes its job from `conqrse-queue` **by reference**, fetches
the client's list from the gateway, and streams findings back as it makes them.
New modules: `src/queue/task-record.ts`, `src/gateway/client.ts`,
`src/reporting/reporter.ts`, `src/queue-run.ts`, `src/job-file.ts`.
**250 tests, up from 160.**

### Learning — `service.md` had been describing an intention as behaviour

It said findings *"go back through that repo's runtime-callback controller"*.
They did not: `main.ts` read its job from `RESOLUTION_JOB_FILE` — a path on
disk — reported by `console.log`, and the repo contained **no HTTP call at all**
outside the proxy fetcher. The sentence was true of the design and false of the
code, which is the failure mode a bundle exists to prevent. Corrected, and the
correction is marked as one rather than quietly rewritten.

### Learning — the acknowledgement journal's write order is the whole argument

Two journals, because they answer different questions and fail at different
moments. `resolutions.jsonl` is what the run **found** and stops a resume
re-buying; `reported.jsonl` is what the gateway **accepted** and stops a resume
re-sending.

🔴 The acknowledgement is written **after** the 200, never before:

- **Before**, and a container dying in that window loses the finding
  permanently — journalled so never re-resolved, marked reported so never
  re-sent, and the client's item stays unresolved with nothing anywhere
  explaining why.
- **After**, and a death in that window re-sends on resume, which the gateway's
  `(run_id, watchlist_item_id)` unique index turns into a no-op.

**At-least-once delivery to an idempotent receiver is the only pair that cannot
lose data**, and the gateway was built to be that receiver. Reversing the order
in source turns four checks red, including the one that asserts an unreachable
gateway records nothing.

### Learning — dropping the already-accepted is what the criterion asked for

Relying on the receiver's idempotency is *safe* — the gateway answers
`applied: 0` — but it still re-sends. A resumed run over 8,926 items would
re-post every finding it had already filed. So the reporter drops them locally
**and** the gateway dedupes; the two are belt and braces rather than one
mechanism written twice.

⚠️ The opposite check is what makes that safe: a finding journalled but **never
accepted** must be re-sent. Dropping those too would mean a gateway outage
silently lost every finding made during it.

### Learning — a real backoff makes the retry policy the untested part

Four attempts at 500ms doubling is **seven seconds** of genuine waiting per
retry case. The first version of the client had no sleep seam, and two tests
timed out at five seconds — the honest reading of which is not "raise the
timeout" but "a suite that pays that is a suite nobody runs, so the retry policy
would end up the one untested part of the file". Injected, and the spec now runs
in 207ms instead of 17s.

### Learning — a line count asserted the concurrency, not the ordering

The `onResolved` check first asserted the journal held **1 then 2** lines when
the hook fired. It read `[2, 2]`, because the default concurrency is 3 and both
items journalled before either hook ran — which says nothing about whether the
ordering is right. Rewritten to assert that **this** finding is already in the
journal, which is the invariant and is concurrency-independent.

### Learning — the orchestration moved out of `main.ts` to be testable

`main.ts` claims to hold "no logic worth testing through a container", and that
was becoming false: the order of the job fetch, the acknowledgement load, the
terminal report and the final flush each encode a decision whose failure appears
only when a run dies part-way. Inside an entry point with a top-level `await`,
those are provable only by running a container against a live gateway — the kind
of check nobody runs. Now `queue-run.ts`, with every dependency injected.

### Learning — the job fetch is a spend guard, so nothing may precede it

A terminal run answers **404** at `GET /runtime/insights/runs/:runId`, and that
is what stops a container restarted long after its run was cancelled from buying
pages again — the queue deleting a Job is not instantaneous and its retry policy
is not ours. So the fetch happens before the acknowledgement load and before the
first request, and a check asserts that order rather than trusting it.

### Learning — the batch cap is a cross-repo contract, matched not guessed

The gateway's DTO declares `@ArrayMaxSize(250)`, and a larger batch is answered
with a non-retryable **400** — a batch of paid findings lost to a number. The
runtime matches 250 exactly and cites the gateway's constant, following the
precedent `configurable-prospect-scanner` set for the scan-event cap. An
over-cap batch is refused locally rather than sent to be refused remotely.

### Learning — thirteen invariants, each shown to fail

The acknowledge-before-accept inversion, re-sending the accepted, dropping the
unaccepted, reporting before journalling, ignoring the early stop, both
terminal-before-flush orderings, the missing crash report, retrying a 4xx, not
retrying a 5xx, an over-cap batch, accepting `org_id`, and starting on an empty
job. Each turned exactly the check that names it red; all five source files were
then confirmed **byte-identical** to their pre-break state.

⚠️ A **control** sits beside the early-stop check: without `shouldContinue`,
every item must still be worked. A stop that fired unconditionally would pass
the positive check while truncating every run.
