---
type: QA Checklist
title: QA — a run keeps the competitor page it decided on, within a budget
description: One check per requirement in the resolution-evidence-capture capability, with what to do and what to expect.
---

# QA — a run keeps the competitor page it decided on, within a budget

Checks for
[resolution-evidence-capture](/capabilities/resolution-evidence-capture.md).
Written at plan time, before the code existed.

🔑 **Every check is automated**, which is a property of the change rather than
of diligence: the gateway and the retailer are both reached through seams with
doubles behind them, and the artefact is bytes the run already holds — so
nothing here needs a person, a credential or a card.

```bash
npm test
```

🔑 **Thirteen mutations were each shown to turn exactly the right check red**,
then reverted, with all five source files confirmed byte-identical afterwards.

🔴 **Three of those mutations reported green on the first attempt and none was a
weak check.** Two were aimed at a branch the named check never reaches — one
mutated `parseJob` for a check whose client double bypasses it, one mutated the
journal's *read* filter when the reachable branch is the *write*. The third did
not **compile**, so the suite reported "no tests", which scores identically to
"the check cannot fail" and is a different thing entirely. The break-proof
harness now reports those three verdicts separately.

⚠️ **The harness's own verdict line was broken twice by shell escaping** — once
into `/d+ (failed|passed)/`, a double-escaped `\d` matching nothing, and once
into a literal **backspace byte** where `\b` was meant. Both failed loudly
rather than passing silently, which is the only reason they were cheap to find.
**Never type an escape through a shell; build it.**

⚠️ **Nothing here is a deployed check.** Storing the bytes and enforcing the
organization's quota belong to `insights-screenshot-library`, and the end-to-end
journey belongs to the phase's exit check.

## Checks

### Check: capture-keeps-the-chosen-page

**Requirement:** The page a finding was decided on is kept
**Surface:** `Capturer.offer`
**Automated:** `test/capture.spec.ts`

**Do**

Offer a resolution whose match names a product page.

**Expect**

One capture, its `sourceUrl` that page, `state: captured`, and the storage key
the gateway answered with. The fetcher was asked for exactly that one url.

### Check: capture-posts-the-bytes-the-run-read

**Requirement:** The page a finding was decided on is kept
**Surface:** `artifactFrom`
**Automated:** `test/capture.spec.ts`

**Do**

Offer a resolution and decode what was posted.

**Expect**

The page's bytes, byte for byte, with `format: page_html` and the item's SKU
alongside. ⚠️ Base64 because a transport must not mangle the bytes, not because
the bytes are opaque.

### Check: capture-hashes-the-bytes-not-the-encoding

**Requirement:** The page a finding was decided on is kept
**Surface:** `artifactFrom`
**Automated:** `test/capture.spec.ts`

**Do**

Compare the artefact's hash against a hash of the raw bytes; change one byte and
compare again; hash a page of multi-byte characters.

**Expect**

Equal to the hash over the **bytes**, different when a byte changes, and a
`byteSize` counting bytes rather than characters. 🔑 A hash over the base64
could not prove the stored artefact is the page the run read. **Mutation-tested**
by hashing the encoding instead.

### Check: capture-records-where-the-gateway-put-it

**Requirement:** The page a finding was decided on is kept
**Surface:** `captures.jsonl`
**Automated:** `test/capture.spec.ts`

**Do**

Offer a page, then read the run's capture journal.

**Expect**

One line, `state: captured`, carrying the storage key, the source url and the
hash.

### Check: capture-skips-an-outcome-with-no-page

**Requirement:** An outcome with no chosen page keeps nothing
**Surface:** `Capturer.offer`
**Automated:** `test/capture.spec.ts`

**Do**

Offer a `not-found` resolution whose match is absent.

**Expect**

Nothing read, nothing posted, budget untouched. 🔑 Recorded as skipped rather
than failed: there was no competitor page to be evidence of, and nothing went
wrong.

### Check: capture-refuses-over-budget-before-spending

**Requirement:** The budget is spent before anything else is
**Surface:** `CaptureBudget.request`
**Automated:** `test/capture.spec.ts`

**Do**

With a budget of one, offer two **different** pages.

**Expect**

The first kept, the second `skipped_quota` — and exactly one fetch and one post
in total, so the refusal spent nothing.

🔑 **The budget is taken before the page is read and before anything is
posted.** Asked afterwards it would be a report rather than a budget: the page
would already be fetched, posted and stored. **Mutation-tested** by granting
every request.

⚠️ **Two different pages, deliberately.** Offering the same url twice is served
from the already-accepted set and never reaches the budget at all — which is
correct behaviour, and made this check pass on a `captured` record the first
time it was written.

### Check: capture-keeps-a-zero-budget

**Requirement:** The budget is spent before anything else is
**Surface:** `CaptureBudget`
**Automated:** `test/capture.spec.ts`

**Do**

Offer a page with the budget set to zero and captures enabled.

**Expect**

`skipped_quota`, nothing posted. 🔑 Zero-with-enabled is a real state — the
organization's quota is spent — and it is distinguishable from captures being
switched off.

### Check: capture-keeps-the-jobs-budget-across-pages

**Requirement:** The budget is spent before anything else is
**Surface:** `runDispatchedJob`
**Automated:** `test/queue-run.spec.ts`

**Do**

Dispatch a run whose job carries a budget of one, and resolve two different
pages.

**Expect**

One post; the two records read `captured` then `skipped_quota`.

### Check: capture-disabled-when-the-job-is-silent

**Requirement:** Captures are off unless the job asks for them
**Surface:** `parseCapturePolicy`, `runDispatchedJob`
**Automated:** `test/capture.spec.ts`, `test/queue-run.spec.ts`, `test/gateway-client.spec.ts`

**Do**

Parse a job with no `capture` block, and dispatch a run with one.

**Expect**

Disabled, nothing read, nothing posted. 🔴 **Absent means disabled, never
enabled** — a gateway that predates capture support carries no block, and
defaulting to on would spend a budget nobody set against a quota nobody is
tracking. **Mutation-tested** by reading an absent policy as enabled.

### Check: capture-names-the-page-it-would-have-kept

**Requirement:** Captures are off unless the job asks for them
**Surface:** `CaptureRecord.sourceUrl`
**Automated:** `test/capture.spec.ts`

**Do**

Offer a page with captures disabled and read the record.

**Expect**

The url is still recorded. 🔑 That is what makes "turn captures on" an
actionable answer rather than a blank row.

### Check: capture-refuses-a-malformed-policy

**Requirement:** Captures are off unless the job asks for them
**Surface:** `parseCapturePolicy`
**Automated:** `test/capture.spec.ts`, `test/gateway-client.spec.ts`

**Do**

Parse policies with no `enabled`, a negative budget, a fractional budget, a
non-object, and a budget that is a string.

**Expect**

Each refused by name. ⚠️ Tolerant of absence and strict about presence: a
malformed block is two builds disagreeing about a budget, and reading it as "no
captures" would hide a real mismatch behind a plausible default.

### Check: capture-refuses-an-image-request

**Requirement:** Captures are off unless the job asks for them
**Surface:** `parseCapturePolicy`
**Automated:** `test/capture.spec.ts`

**Do**

Ask for `format: png`, and separately for an unknown format.

**Expect**

Both refused, the first naming the reason no image is produced.

🔴 **Refused loudly rather than silently downgraded to HTML.** A gateway asking
for an image would otherwise receive bytes labelled as one, and the reviewer
screen would show a broken picture with no explanation. **Mutation-tested** by
letting the request through.

### Check: capture-keeps-only-selected-items

**Requirement:** Only the items a rule chose are kept
**Surface:** `CapturerDeps.isSelected`, `runDispatchedJob`
**Automated:** `test/capture.spec.ts`, `test/queue-run.spec.ts`

**Do**

Dispatch a run whose job marks one of two items, and resolve both.

**Expect**

Only the marked item posted; the other recorded `skipped_unselected`, nothing
read for it.

🔴 **A budget says HOW MANY; only these flags say WHICH.** A run with a budget
and no per-item answer captures the first budget-many findings it happens to
make — exactly what the selection rules exist to replace. **This was missing
when the row first closed**, and `isSelected` is required with no default so
the fail-open direction cannot hide in a constructor.

### Check: capture-does-not-charge-for-an-unselected-item

**Requirement:** Only the items a rule chose are kept
**Surface:** the order of the selection check and the budget
**Automated:** `test/capture.spec.ts`

**Do**

With a budget of one, offer an unselected item and then a selected one.

**Expect**

The first `skipped_unselected`, the second `captured`, one capture spent.

🔴 An unselected item is a **different answer** from an exhausted budget and
must not consume one — reporting it as a quota refusal would send an operator to
raise a budget that was never the reason.

### Check: capture-unmarked-is-not-selected

**Requirement:** Only the items a rule chose are kept
**Surface:** `parseJob`
**Automated:** `test/gateway-client.spec.ts`, `test/queue-run.spec.ts`

**Do**

Parse a job item with no `capture` field, and dispatch a run whose job marks
nothing.

**Expect**

`false`, and nothing captured. ⚠️ The same direction as the policy itself: a
gateway that predates selection marks nothing, and capturing anyway would spend
a budget against items no rule chose.

### Check: capture-refuses-a-malformed-selection-flag

**Requirement:** Only the items a rule chose are kept
**Surface:** `parseJob`
**Automated:** `test/gateway-client.spec.ts`

**Do**

Parse an item whose `capture` is the string `"yes"`.

**Expect**

Refused by name. Strict about presence, tolerant of absence.

### Check: capture-keeps-a-shared-page-once

**Requirement:** One page two items share is kept once
**Surface:** the accepted set, keyed on url
**Automated:** `test/capture.spec.ts`

**Do**

Offer two items whose matches are the same listing.

**Expect**

One post, both records `captured` with the same key, and one capture spent.
⚠️ Keyed on the **url** rather than the item, because charging a quota twice for
one artefact is the failure this avoids.

### Check: capture-records-a-refusal-with-its-reason

**Requirement:** A capture failure costs the evidence, never the finding
**Surface:** `Capturer.offer`
**Automated:** `test/capture.spec.ts`

**Do**

Make the gateway refuse the capture.

**Expect**

`state: failed` carrying the gateway's own detail, and **nothing journalled**.

⚠️ Journalled only after the gateway's answer. Written before it, a container
dying in the window would mark a page stored that never was, and a resume would
skip evidence nobody holds. **Mutation-tested** by journalling the failure too.

### Check: capture-refunds-an-unstored-page

**Requirement:** A capture failure costs the evidence, never the finding
**Surface:** `CaptureBudget.refund`
**Automated:** `test/capture.spec.ts`

**Do**

With a budget of one, make the gateway unreachable and offer two pages. Also
refund an unspent budget twice.

**Expect**

Both recorded `failed`, nothing spent, and the ledger never negative.

🔑 Nothing was stored, so nothing should be charged — without the refund a bad
half-hour of gateway errors would silently eat a whole organization's quota and
skip evidence for everything after it. **Both mutation-tested.**

### Check: capture-survives-a-transport-that-throws

**Requirement:** A capture failure costs the evidence, never the finding
**Surface:** `Capturer.offer`
**Automated:** `test/capture.spec.ts`

**Do**

Make the upload seam reject rather than answer.

**Expect**

`state: failed` naming the thrown error. **Mutation-tested** by removing the
catch.

### Check: capture-survives-a-page-that-cannot-be-reread

**Requirement:** A capture failure costs the evidence, never the finding
**Surface:** `Capturer.offer`
**Automated:** `test/capture.spec.ts`

**Do**

Make the fetcher reject for the chosen url.

**Expect**

`state: failed` saying the page could not be re-read, nothing posted, budget
handed back.

### Check: capture-never-throws

**Requirement:** A capture failure costs the evidence, never the finding
**Surface:** `Capturer.offer`
**Automated:** `test/capture.spec.ts`

**Do**

Exercise every failure shape — a throwing upload, a rejecting fetcher, a refusal
— and assert the call resolves each time.

**Expect**

A record every time and never a rejection. 🔴 Asserted as one property because a
single path that threw would abandon a paid finding.

### Check: capture-reports-the-finding-when-every-capture-fails

**Requirement:** A capture failure costs the evidence, never the finding
**Surface:** `runDispatchedJob`
**Automated:** `test/queue-run.spec.ts`

**Do**

Dispatch a run whose capture endpoint always throws.

**Expect**

The finding still offered to the reporter, and the capture recorded as failed
with its reason.

### Check: capture-reports-the-finding-first

**Requirement:** A capture failure costs the evidence, never the finding
**Surface:** `runDispatchedJob`
**Automated:** `test/queue-run.spec.ts`

**Do**

Record the order the reporter and the capture endpoint are called in.

**Expect**

The finding, then the capture. The finding is the product and the evidence is a
convenience — a priority, stated as an order. **Mutation-tested** by swapping
them.

### Check: capture-does-not-repost-an-accepted-page

**Requirement:** A resumed run neither re-posts nor forgets
**Surface:** `readCaptureJournal`
**Automated:** `test/capture.spec.ts`

**Do**

Capture a page, then build a second capturer over the same run directory and
offer the same page.

**Expect**

Nothing posted, the record still `captured` with the original key, and the
resumed run charged nothing.

🔑 The same at-least-once-to-an-idempotent-receiver shape the findings use.
**Mutation-tested** by forgetting the journal.

### Check: capture-retries-a-failed-page

**Requirement:** A resumed run neither re-posts nor forgets
**Surface:** `readCaptureJournal`
**Automated:** `test/capture.spec.ts`

**Do**

Fail a capture, then resume with a working gateway.

**Expect**

It is attempted again and stored. ⚠️ Only an **accepted** capture suppresses a
retry — otherwise a gateway outage would permanently lose the evidence for every
item resolved during it.

⚠️ **Mutation-tested by journalling the failure as stored**, which is the
reachable branch. Loosening the journal's *read* filter proves nothing here,
because a failed capture is never written in the first place — there is no row
for a looser filter to match.

### Check: capture-journals-only-what-was-accepted

**Requirement:** A resumed run neither re-posts nor forgets
**Surface:** `captures.jsonl`
**Automated:** `test/capture.spec.ts`

**Do**

Refuse a capture and read the journal.

**Expect**

Empty.

### Check: capture-refuses-to-offer-before-reading-its-journal

**Requirement:** A resumed run neither re-posts nor forgets
**Surface:** `Capturer.journal`
**Automated:** `test/capture.spec.ts`

**Do**

Offer a page without calling `load()` first.

**Expect**

Refused by name. A journal appended to before it was read would leave the
suppression set wrong in exactly the direction that re-posts pages.

### Check: capture-conflict-means-stored

**Requirement:** The gateway's answers are read the way it means them
**Surface:** `GatewayClient.postCapture`
**Automated:** `test/gateway-client.spec.ts`

**Do**

Answer the post with a 409 carrying a storage key.

**Expect**

`stored`, on one attempt.

🔑 The gateway keys an artefact on its content hash, so a page two items
resolved to — or one a resumed run re-posts — is already there. Reading that as
an error would make a correct idempotent retry look like a fault.
**Mutation-tested.**

### Check: capture-does-not-retry-a-full-quota

**Requirement:** The gateway's answers are read the way it means them
**Surface:** `GatewayClient.postCapture`
**Automated:** `test/gateway-client.spec.ts`

**Do**

Answer with a 429.

**Expect**

`refused`, one attempt. A full quota does not improve by asking again, and a
retry loop against one would spend the run's wall clock on evidence it cannot
store. **Mutation-tested** by retrying it.

### Check: capture-does-not-retry-a-refusal

**Requirement:** The gateway's answers are read the way it means them
**Surface:** `GatewayClient.postCapture`
**Automated:** `test/gateway-client.spec.ts`

**Do**

Answer with a 400 naming a hash mismatch.

**Expect**

`refused` carrying that detail, one attempt.

### Check: capture-retries-a-server-error

**Requirement:** The gateway's answers are read the way it means them
**Surface:** `GatewayClient.postCapture`
**Automated:** `test/gateway-client.spec.ts`

**Do**

Answer 503, 503, then success.

**Expect**

`stored` after three attempts.

### Check: capture-gives-up-as-unreachable

**Requirement:** The gateway's answers are read the way it means them
**Surface:** `GatewayClient.postCapture`
**Automated:** `test/gateway-client.spec.ts`

**Do**

Make every attempt throw at the transport.

**Expect**

`unreachable` after four attempts. ⚠️ The sleep is injected, because four
attempts of real backoff is seven seconds and a suite that pays that per case is
a suite nobody runs.

### Check: capture-refuses-an-answer-with-no-key

**Requirement:** The gateway's answers are read the way it means them
**Surface:** `storageKeyOf`
**Automated:** `test/gateway-client.spec.ts`

**Do**

Answer 200 with a body carrying no `storage_key`, and separately with a body
that is not JSON.

**Expect**

`refused` both times, the first saying no key was returned.

🔴 A 2xx with no key is the gateway and this build disagreeing about the
response shape. Refused rather than invented — a fabricated key would put an
unopenable link on a reviewer's screen.

### Check: capture-tallies-by-state

**Requirement:** An operator can read what the run kept
**Surface:** `tallyCaptures`
**Automated:** `test/capture.spec.ts`

**Do**

Offer a page, an outcome with no page, and a second item resolving to the first
page. Tally.

**Expect**

Two kept, one off, none over budget — and one capture spent, because the shared
page cost nothing the second time.
