# OKF Log

## 2026-09-11

- **Update** — `resolution-evidence-capture` corrected the same day: each job item now carries a `capture` flag, and an unmarked one is **not selected**. New `skipped_unselected` state, `CapturerDeps.isSelected` required with **no default**, and four checks. 307 tests, up from 300.

- **Learning** — 🔴 **A budget says HOW MANY; only a per-item answer says WHICH — and the row closed without one.** The criterion asks that *"which items get captured is a stated rule rather than whatever the run happened to do"*, and a run holding a budget of fifty with no per-item flag captures the first fifty findings it happens to make. That **is** whatever the run happened to do. 🔑 **The seam was in the wrong place**: the split said the runtime owns the mechanism and the gateway owns selection, but selection has to *reach* the mechanism, so the runtime owed a flag it was never given. Recorded as a correction rather than folded in quietly.

- **Learning** — 🔑 **`isSelected` is required with no default, and the type checker then named all five call sites.** A default would have been a fail-open direction hidden in a constructor; making it required turned the contract change into five compile errors, each at a place that had to say what it meant. ⚠️ **The same forcing function found a fixture that was silently wrong**: the budget check's second SKU was not in the job at all, so it tripped the new selection branch instead of the budget — a check that had been exercising the right thing for the wrong reason.

- **Learning** — 🔴 **An unselected item is a different answer from an exhausted budget, and must not consume one.** Reporting it as `skipped_quota` would send an operator to raise a budget that was never the reason. So the selection check sits **before** the budget is touched: a rule is not a quota.

- **Learning** — ⚠️ **A lint rule caught a type assertion that was weakening nothing — yet.** `as unknown as Resolution` on a literal that already satisfies `Resolution` hides no mismatch today and would hide the next one. Removed rather than suppressed, which is the same call as the `no-base-to-string` finding earlier in this row.


- **Update** — `resolution-evidence-capture` landed: a run keeps the competitor page each finding was decided on, within a budget handed over with the job, and records where the gateway put it. New `src/capture/` (`types`, a pure `budget` ledger, and `Capturer` with its own `captures.jsonl` journal), `GatewayClient.postCapture`, a `capture` block on the job, and the wiring in `queue-run`. New concepts: `capabilities/resolution-evidence-capture` (9 scenarios), `qa/resolution-evidence-capture` (30 checks). **300 tests, up from 250**, and **13 mutations each shown to turn exactly the right check red**.

- **Learning** — 🔴 **This runtime cannot take a screenshot, and the reason is structural rather than a missing dependency.** The row is named for one; what is deliverable is the page's **bytes**. The proxy exists because the retailer refuses a plain request, so a headless browser inside a Kubernetes Job would make exactly the request the proxy avoids and fail on precisely the sites this runtime is for. Routing a browser through a proxy is a different vendor product with its own credential — and `BRIGHTDATA_API_KEY`, the credential this runtime's own fetch path needs, **is not set anywhere on this machine**, so the alternative could not even be probed. 🔑 **The bytes are the better artefact for one job and useless for the other**: they prove byte-for-byte what the parse read and can be re-parsed to settle a matcher dispute, and they show a person nothing. So `png` is in the vocabulary, no code path emits it, a job asking for it is **refused by name**, and the portal's `thumbnailUrl` will be null for every capture — priced as its own row rather than hidden.

- **Learning** — 🔴 **Three of thirteen mutations reported GREEN on the first attempt and not one was a weak check.** Two were aimed at a branch the named check never reaches: one mutated `parseJob` for a check whose client double bypasses it entirely, and one mutated the capture journal's **read** filter when a failed capture is never **written**, so there was no row for a looser filter to match. The third **did not compile** — it left a variable possibly unassigned, so the suite reported "no tests", which scores identically to "the check cannot fail". 🔑 **The harness now reports three verdicts rather than two**, because a broken mutation recorded as a weak check is a finding about the wrong thing.

- **Learning** — ⚠️ **The break-proof harness's own verdict line was broken twice by shell escaping, in two different ways.** Once it came out as `/d+ (failed|passed)/` — a double-escaped `\d` that matches nothing — and once as a **literal backspace byte** where `\b` was meant, invisible in the source. Every mutation was then reported as broken. 🔑 **Both failed loudly rather than passing silently, which is the only reason they were cheap to find** — the same property that makes a deferred check recoverable and a defeated one not. The rule that survives: **never type an escape through a shell; build it, and prove no control byte survives with a control that fires.**

- **Learning** — 🔴 **A test double typed as `unknown` turned a contract change into a runtime failure nine tests deep.** Adding a required field to `ResolutionJob` should have been one compile error naming the fixture; instead `const JOB = {…}` plus `fakeClient(job: unknown)` plus `as never` at every call site produced `Cannot read properties of undefined` pointing at the **new code** rather than at the stale fake. Now typed as the thing it fakes. ⚠️ **The `as never` at the call sites is still there and still hides the rest** — a double is only as honest as its narrowest type.

- **Learning** — 🔑 **A budget asked after the spend is a report, not a budget** — and the same distinction decides the refund. The ledger is taken **before** the page is read and before anything is posted; and when the upload fails it is **handed back**, because nothing was stored so nothing should be charged. Without the refund a bad half-hour of gateway errors would silently eat a whole organization's quota and skip evidence for every item after it. ⚠️ A refund is not amnesia: the attempt is still recorded as `failed`.

- **Learning** — ⚠️ **A check about a budget needs two DIFFERENT pages, and the first version of it did not have them.** Offering the same url twice is served from the already-accepted set and never reaches the budget at all — correct behaviour, and it made the over-budget check pass on a `captured` record. Same family as the four absence-checks that could not fail on `insights-derived-reads`: **the positive case has to be constructed deliberately.**

- **Learning** — 🔑 **A 409 from the capture endpoint means "already stored", not a failure.** The gateway keys an artefact on its content hash, so a page two items resolved to — or one a resumed run re-posts — is already there; reading that as an error would make a correct idempotent retry look like a fault. ⚠️ **And a 429 is refused rather than retried**: a full quota does not improve by asking again, and a retry loop against one would spend the run's wall clock on evidence it cannot store. 🔴 **A 2xx carrying no storage key is refused rather than invented** — a fabricated key would put an unopenable link on a reviewer's screen.


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
