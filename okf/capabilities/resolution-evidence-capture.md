---
type: Capability
title: A run keeps the competitor page it decided on, within a budget, and says where it went
description: What a resolution run captures as evidence, why it is the page's bytes rather than a picture of it, how the budget is enforced before anything is spent, and what a capture failure does and does not cost.
---

# A run keeps the competitor page it decided on, within a budget, and says where it went

After a finding, the run offers the **one page the finding was decided on** to
the gateway, which stores it and answers with a key. The run keeps to a budget
it was handed with the job, records what happened to every offer, and never
lets a capture failure cost it a finding.

## 🔴 The artefact is a picture, and it was the page's bytes until 2026-09-13

This runtime still has **no browser**, and that is no longer the same as having
no screenshot. The reason it reaches retailers through a proxy is that a plain
request is refused — so a headless browser inside a Kubernetes Job would make
exactly the request the proxy exists to avoid. That argument is sound and it
was carried one step too far: **the proxy renders the page on its own side.**
`api.brightdata.com/request` takes `data_format: "screenshot"` on the same
endpoint, the same zone and the same credential this runtime already uses.

Measured against a real Amazon product page: HTTP 200, **2,994,302 bytes**,
magic `89 50 4E 47`, **1529 × 10,621** — the whole page, gallery, price and
reviews. Nobody had asked the vendor.

So the price of an image was half what this capability claimed:

| | the page's bytes | an image |
|---|---|---|
| proves what the parse read | **exactly, byte for byte** | approximately |
| settles "your matcher is wrong" | **yes** — it can be re-parsed | no |
| shows a person a price they recognise | no | **yes** |
| costs | nothing, already fetched | **one request, no new vendor** |

⚠️ **One artefact is kept per item, so choosing the picture gives up the
byte-for-byte record.** That is a real trade and it is stated rather than
discovered: a png cannot be re-parsed to settle a matcher dispute. Capturing
both is a different change with a different price — two requests and two quota
slots per item.

#### Scenario: A run asked for a picture gets one
- GIVEN a capture policy whose format is `png`
- WHEN the run captures a selected item's page
- THEN the artefact is a PNG the proxy rendered
- AND the markup is not also fetched, which would be a second paid request for
  bytes this path discards

**Checked by:** capture-takes-a-screenshot-when-the-policy-asks
**Checked by:** capture-stores-image-bytes-verbatim

#### Scenario: A body that is not an image is refused rather than stored
- GIVEN the vendor answers with a 200 carrying a short JSON error
- WHEN the run asks for a screenshot
- THEN the bytes are refused by their magic number, not by their length
- AND nothing is stored

**Checked by:** capture-refuses-a-200-that-is-not-a-png

## The bytes are free, and that decides the shape

The chosen page was fetched moments earlier, so the run asks its own fetcher for
it again and gets a **cache hit** — nothing paid, nothing re-requested. That is
why evidence is offered per **resolution** rather than per fetch: a run also
fetches search pages, catalogue pages and candidates it rejects, and capturing
every one of those would spend the whole budget on pages nobody opens.

## Two halves of "within a budget", in two places

🔑 The organization's quota, the retailer's registry capability and which items
qualify are **the gateway's** to know. The per-run ceiling is **this
container's** to keep. So the policy travels with the job, and a job that
carries none means captures are off.

## 🔴 A budget says how many; only the job's per-item flags say which

This was **missing when the row first closed, and the correction is recorded
rather than quietly folded in.** A run holding a budget of fifty and no
per-item answer captures the first fifty findings it happens to make — which is
exactly the *"whatever the run happened to do"* the gateway's selection rules
exist to replace. So each job item carries a `capture` flag, and an unmarked
one is **not selected**.

⚠️ **An unselected item is a different answer from an exhausted budget**, and it
does not consume one. Reporting it as a quota refusal would send an operator to
raise a budget that was never the reason.

## Requirements

#### Scenario: The page a finding was decided on is kept
- GIVEN a resolution that chose a competitor listing
- WHEN the run offers its evidence
- THEN the page the run actually read is posted, byte for byte
- AND a content hash over those bytes travels with it
- AND the key the gateway answers with is recorded

**Checked by:** capture-keeps-the-chosen-page
**Checked by:** capture-posts-the-bytes-the-run-read
**Checked by:** capture-hashes-the-bytes-not-the-encoding
**Checked by:** capture-records-where-the-gateway-put-it

#### Scenario: An outcome with no chosen page keeps nothing
- GIVEN a resolution that found no listing
- WHEN the run offers its evidence
- THEN nothing is read and nothing is posted
- AND the budget is untouched

**Checked by:** capture-skips-an-outcome-with-no-page

#### Scenario: The budget is spent before anything else is
- GIVEN a run whose budget is already used up
- WHEN a further page is offered
- THEN it is refused before the page is read and before anything is posted
- AND the refusal is recorded as being over budget rather than as a failure

**Checked by:** capture-refuses-over-budget-before-spending
**Checked by:** capture-keeps-a-zero-budget
**Checked by:** capture-keeps-the-jobs-budget-across-pages

#### Scenario: Captures are off unless the job asks for them
- GIVEN a job carrying no capture policy
- WHEN a page is offered
- THEN nothing is read and nothing is posted
- AND the page that would have been kept is still named
- AND a malformed policy is refused rather than read as "no captures"

**Checked by:** capture-disabled-when-the-job-is-silent
**Checked by:** capture-names-the-page-it-would-have-kept
**Checked by:** capture-refuses-a-malformed-policy
**Checked by:** capture-refuses-an-image-request

#### Scenario: Only the items a rule chose are kept
- GIVEN a job marking some items for capture and not others
- WHEN findings are made for both
- THEN only the marked ones are read and posted
- AND an unmarked one is recorded as unselected rather than failed or over budget
- AND it consumes no budget
- AND a job marking nothing captures nothing
- AND a malformed flag is refused rather than read as unmarked

**Checked by:** capture-keeps-only-selected-items
**Checked by:** capture-does-not-charge-for-an-unselected-item
**Checked by:** capture-unmarked-is-not-selected
**Checked by:** capture-refuses-a-malformed-selection-flag

#### Scenario: One page two items share is kept once
- GIVEN two items that resolve to the same competitor listing
- WHEN both are offered
- THEN the page is posted once
- AND the second item is charged nothing

**Checked by:** capture-keeps-a-shared-page-once

#### Scenario: A capture failure costs the evidence, never the finding
- GIVEN a gateway that refuses, cannot be reached, or throws
- WHEN a page is offered
- THEN the failure is recorded with its reason
- AND the budget is handed back, because nothing was stored
- AND the finding is reported regardless
- AND the run continues

**Checked by:** capture-records-a-refusal-with-its-reason
**Checked by:** capture-refunds-an-unstored-page
**Checked by:** capture-survives-a-transport-that-throws
**Checked by:** capture-survives-a-page-that-cannot-be-reread
**Checked by:** capture-never-throws
**Checked by:** capture-reports-the-finding-when-every-capture-fails
**Checked by:** capture-reports-the-finding-first

#### Scenario: A resumed run neither re-posts nor forgets
- GIVEN a run that already had pages accepted
- WHEN it starts again
- THEN it does not re-post those pages, and is charged nothing for them
- AND a capture that FAILED is attempted again
- AND nothing is recorded as accepted that the gateway did not accept

**Checked by:** capture-does-not-repost-an-accepted-page
**Checked by:** capture-retries-a-failed-page
**Checked by:** capture-journals-only-what-was-accepted
**Checked by:** capture-refuses-to-offer-before-reading-its-journal

#### Scenario: The gateway's answers are read the way it means them
- GIVEN a capture posted to the gateway
- WHEN it answers
- THEN a conflict means the page is already stored, not that anything failed
- AND a full quota is not retried
- AND a malformed request is not retried
- AND a server error is retried, and a transport failure gives up as unreachable
- AND an acceptance carrying no key is refused rather than invented

**Checked by:** capture-conflict-means-stored
**Checked by:** capture-does-not-retry-a-full-quota
**Checked by:** capture-does-not-retry-a-refusal
**Checked by:** capture-retries-a-server-error
**Checked by:** capture-gives-up-as-unreachable
**Checked by:** capture-refuses-an-answer-with-no-key

#### Scenario: An operator can read what the run kept
- GIVEN a finished run
- WHEN its captures are tallied
- THEN each offer is counted under one of kept, failed, over budget or off

**Checked by:** capture-tallies-by-state

## What this capability does NOT claim

🔑 **It produces an image, and the sentence here said the opposite until
2026-09-13.** This block read "It produces no image, so nothing here serves a
thumbnail", and the portal's gallery field was empty for every capture as a
result. The reasoning behind it — no browser — was true and the conclusion was
not, because the proxy renders.

⚠️ **It still produces no image under REPLAY.** A replayed run serves committed
bytes and has no proxy to ask, so a `png` policy has nothing to take a picture
with. The fetcher advertises the capability only when it has one, and the
capturer refuses by name rather than storing markup labelled as an image.

⚠️ **The retailer registry's `screenshots` capability is `true` for the launch
retailer and describes an intention nobody has delivered.** It is the gateway's
gate on whether to ask for captures at all; it does not mean an image is
available.

## Related

- [How one item becomes a pairing](/capabilities/competitor-resolution.md)
- [How a run is dispatched and reports](/capabilities/resolution-run-dispatch.md)
