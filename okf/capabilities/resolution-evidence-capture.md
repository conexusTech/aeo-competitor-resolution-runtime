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

## 🔴 The artefact is the page's bytes, not a picture of it

This runtime has **no browser and cannot usefully have one**. The reason it
reaches retailers through a proxy is that a plain request is refused — so a
headless browser inside a Kubernetes Job would make exactly the request the
proxy exists to avoid, and fail on precisely the sites this runtime is for.
Routing a browser through a proxy is a different vendor product, with its own
credential and its own price.

So the two artefacts are different things rather than better and worse:

| | the page's bytes | an image |
|---|---|---|
| proves what the parse read | **exactly, byte for byte** | approximately |
| settles "your matcher is wrong" | **yes** — it can be re-parsed | no |
| shows a person a price they recognise | no | **yes** |
| costs | **nothing, already fetched** | a second request and a new vendor |

⚠️ **`png` is in the format vocabulary and no code path produces one.** A job
asking for it is **refused loudly** rather than served HTML labelled as an
image, because a reviewer screen showing a broken picture with no explanation is
worse than a screen saying captures are unavailable. Delivering a real image is
a spend decision, priced as its own change.

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

🔴 **It produces no image, so nothing here serves a thumbnail.** The gallery
field for one exists in the portal's contract and will be empty for every
capture this runtime makes. Named here so a reader of the reviewer screen knows
why, rather than filing it as a bug.

⚠️ **The retailer registry's `screenshots` capability is `true` for the launch
retailer and describes an intention nobody has delivered.** It is the gateway's
gate on whether to ask for captures at all; it does not mean an image is
available.

## Related

- [How one item becomes a pairing](/capabilities/competitor-resolution.md)
- [How a run is dispatched and reports](/capabilities/resolution-run-dispatch.md)
