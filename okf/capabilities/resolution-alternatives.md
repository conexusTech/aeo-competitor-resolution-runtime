---
type: Capability
title: The runners-up a resolution rejected, and why each ranked lower
description: Which candidates a run offers as alternatives to the pairing it chose, why anything below the evidence floor is refused, and what each one says about whether its barcode was ever read.
resource: src/alternatives.ts
tags: [competitor-resolution, review, ranking, evidence]
timestamp: 2026-09-11
---

# The runners-up a resolution rejected

A resolution reported one candidate and let the rest of its ranking go out of
scope, which left the reviewed *use this listing instead* control with nothing
to offer. Nothing here fetches anything: this is about not discarding what a run
already computed.

## 🔴 An alternative must clear the same floor the chosen candidate did

"Report the runners-up" reads as *all of them*, and that would be wrong.
`MIN_EVIDENCE_TO_REPORT` exists because the handover once reported a **$3,727
server** as the match for a **$13 accessory** — a candidate below it is *the top
hit for a vague phrase*.

Every alternative gets a **swap button**. So offering one below the floor puts
that exact mistake in a list with a control on it, and a wrong pairing is
indistinguishable from a real one downstream.

Both gates apply, the same two the chosen candidate had to pass: the numeric
floor **and** `hasPartNumberEvidence` — because brand + first-party + in-stock
totals exactly the floor on its own, which is the reason the flag exists at all.

## 🔴 Every alternative says whether anybody looked

Probes are the expensive part — measured at 2.70 per row against a ceiling of
eight — so most ranked candidates are scored from search-result text and never
opened.

| `barcodeState` | means |
|---|---|
| `disagreed` | probed; it published a barcode and it did not match |
| `absent` | probed; it published no barcode to compare |
| `unprobed` | never opened — nothing about its barcode is known |

🔑 **Three states rather than a nullable string**, because `null` would collapse
the two that matter. "Its barcode disagrees" and "nobody has checked this one"
are different risks, and a reviewer swapping is choosing which to take on. The
same distinction [the outcomes](/capabilities/competitor-resolution.md) already
draw between `unconfirmed` and `unverifiable`, where **91 of 255 captured pages
publish no barcode at all**.

## The reason is derived, never composed

⚠️ The ranking weights are ordinal and unfitted — `ranking.ts` says so itself —
so "scored eight lower" is noise dressed as information. `reasonRankedLower`
names the **strongest signal the chosen candidate had that this one lacks**,
from the same breakdown the scorer produced, and every one of those is something
a reviewer can check against the page in front of them.

🔑 **A tie says it was a tie.** When no signal differs, the ranking was decided
by discovery order, and saying "it scored lower" would invent a distinction the
scorer never made.

⚠️ **One implementation, not two.** `scoreCandidate` delegates to
`scoreBreakdown` rather than the breakdown re-deriving what the scorer did — two
copies of that arithmetic is how a signal list comes to disagree with the number
it explains, and the number is load-bearing: the 53-row replay's outcome split
is the only property of this module anybody has measured.

## What is deliberately absent

⚠️ **Storing them is not this repo's job.** The gateway's `insights_matches`
holds them and the portal reads them — a row that needs two repos is a modelling
error, so this capability ends at the reported `Resolution`.

⚠️ **The cap of five is a product judgement about a screen**, not a property of
the data, and is recorded as one.

## Scenarios

#### Scenario: A resolution that chose a candidate offers the runners-up

- GIVEN a run that ranked several candidates and reported one
- WHEN the resolution is read
- THEN the others that cleared the evidence floor are offered, best first
- AND the chosen candidate is not among them

**Checked by:** alternatives-reported-best-first
**Checked by:** alternatives-exclude-the-chosen
**Checked by:** alternatives-on-the-real-corpus

#### Scenario: A candidate that could not be reported cannot be offered

- GIVEN a candidate below the evidence floor
- OR one with no part-number evidence at a passing score
- WHEN alternatives are collected
- THEN neither is offered

**Checked by:** alternatives-refuse-below-the-floor
**Checked by:** alternatives-refuse-without-part-number-evidence

#### Scenario: A run that resolved nothing offers nothing

- GIVEN a resolution with no match
- WHEN it is read
- THEN it offers no alternatives at all

**Checked by:** alternatives-none-when-nothing-chosen
**Checked by:** alternatives-none-on-a-miss
**Checked by:** alternatives-none-with-one-candidate

#### Scenario: Each alternative says what is known about its barcode

- GIVEN alternatives that were probed and disagreed, probed with no barcode, and never probed
- WHEN each is read
- THEN each says which, and its reason says so too

**Checked by:** alternatives-barcode-disagreed
**Checked by:** alternatives-barcode-absent
**Checked by:** alternatives-barcode-unprobed

#### Scenario: The reason names a signal a reviewer can check

- GIVEN an alternative lacking a signal the chosen candidate had
- WHEN its reason is read
- THEN it names the strongest such signal, not the score
- AND a tie is described as a tie rather than as a difference

**Checked by:** alternatives-reason-names-strongest-missing-signal
**Checked by:** alternatives-reason-prefers-the-stronger-signal
**Checked by:** alternatives-reason-admits-a-tie

#### Scenario: Offering alternatives changes no ranking and spends nothing

- GIVEN the 53 measured rows replayed against the committed corpus
- WHEN the run completes
- THEN the outcome split is unchanged
- AND no live request was made

**Checked by:** alternatives-replay-split-unchanged
**Checked by:** alternatives-spend-nothing

#### Scenario: At most five are offered

- GIVEN more qualifying candidates than the cap
- WHEN alternatives are collected
- THEN the cap is honoured

**Checked by:** alternatives-honour-the-cap

## Related

- [The outcomes they sit beside](/capabilities/competitor-resolution.md)
- [How a run reports](/capabilities/resolution-run-dispatch.md)
- [The gateway that stores them](aeo-backend:/capabilities/insights-review-decisions.md)
