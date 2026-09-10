---
type: QA Checklist
title: QA — the runners-up a resolution rejected
description: One check per requirement in the resolution-alternatives capability, with what proves it.
resource: okf/capabilities/resolution-alternatives.md
tags: [competitor-resolution, review, ranking, qa]
timestamp: 2026-09-11
---

# QA — resolution alternatives

Covers [resolution-alternatives](/capabilities/resolution-alternatives.md).

**Two suites, and the split matters.** `alternativesFor` and
`reasonRankedLower` are pure, so most checks vary one input at a time. But
whether a **real** run has runners-up worth offering at all is a property of the
corpus, not of the function — a pipeline that reported one candidate per item
would satisfy every unit check and leave the swap control exactly as dead as it
was. So the replay asserts it against 534 committed real responses.

🔑 **Every check runs offline and costs nothing.** The corpus was committed for
this reason, so no check needs a person, a key or a card.

---

### Check: alternatives-reported-best-first

**Requirement:** A resolution that chose a candidate offers the runners-up
**Surface:** `alternativesFor`
**Automated:** test/alternatives.spec.ts

**Do**

Rank three qualifying candidates, report one, and read the alternatives.

**Expect**

The other two, in descending score order, the best first.

### Check: alternatives-exclude-the-chosen

**Requirement:** A resolution that chose a candidate offers the runners-up
**Surface:** `alternativesFor`
**Automated:** test/alternatives.spec.ts

**Do**

Read the alternatives of a resolution and look for the chosen listing's url.

**Expect**

Absent.

⚠️ An off-by-one in the filter puts the approved pairing in the list of things
to replace it with — which reads as a suggestion to swap a listing for itself.

### Check: alternatives-on-the-real-corpus

**Requirement:** A resolution that chose a candidate offers the runners-up
**Surface:** `resolveItem`, replayed
**Automated:** test/exit-criterion-53-rows.spec.ts

**Do**

Replay the 53 measured rows against the committed corpus and inspect every
reported resolution's alternatives.

**Expect**

At least one row offers alternatives; every one clears the evidence floor, is
not the chosen listing, carries a barcode state and a non-empty reason, and the
list is ordered best-first within the cap.

🔑 **The "at least one" assertion is the one that matters.** Without it this row
could ship having changed nothing observable, with every unit check green.

### Check: alternatives-refuse-below-the-floor

**Requirement:** A candidate that could not be reported cannot be offered
**Surface:** `MIN_EVIDENCE_TO_REPORT`
**Automated:** test/alternatives.spec.ts

**Do**

Rank a candidate one point below the floor and collect alternatives.

**Expect**

Not offered.

🔴 **The refusal the row turns on.** The floor exists because the handover once
reported a **$3,727 server** as the match for a **$13 accessory**, and every
alternative gets a swap button — so offering one below it hands a reviewer that
mistake with a control on it.

### Check: alternatives-refuse-without-part-number-evidence

**Requirement:** A candidate that could not be reported cannot be offered
**Surface:** `hasPartNumberEvidence`
**Automated:** test/alternatives.spec.ts

**Do**

Rank a same-brand, first-party, in-stock candidate whose model matches nothing,
at exactly the floor, and collect alternatives.

**Expect**

Not offered.

🔴 **The second gate, and the one the floor alone did not hold**: brand +
first-party + in-stock totals `6 + 3 + 1 = 10`, exactly
`MIN_EVIDENCE_TO_REPORT`. A numeric test alone admits a candidate with no
part-number evidence at all — which is the defect the flag was added for on the
chosen-candidate path, reappearing here.

### Check: alternatives-none-when-nothing-chosen

**Requirement:** A run that resolved nothing offers nothing
**Surface:** `alternativesFor`
**Automated:** test/alternatives.spec.ts

**Do**

Collect alternatives with a null chosen candidate.

**Expect**

Empty.

🔴 A `not-found` has no pairing to swap, so a list of things to swap it for
would be a screen inventing a decision.

### Check: alternatives-none-on-a-miss

**Requirement:** A run that resolved nothing offers nothing
**Surface:** `resolveItem`, replayed
**Automated:** test/exit-criterion-53-rows.spec.ts

**Do**

Replay the 53 rows and inspect every resolution with no match.

**Expect**

Empty alternatives on each; and there is at least one such row, so the check
has something to assert against.

### Check: alternatives-none-with-one-candidate

**Requirement:** A run that resolved nothing offers nothing
**Surface:** `alternativesFor`
**Automated:** test/alternatives.spec.ts

**Do**

Rank exactly one candidate and report it.

**Expect**

Empty — the only candidate is the chosen one.

### Check: alternatives-barcode-disagreed

**Requirement:** Each alternative says what is known about its barcode
**Surface:** `AlternativeBarcodeState`
**Automated:** test/alternatives.spec.ts

**Do**

Probe an alternative and record a barcode that does not match.

**Expect**

`barcodeState: "disagreed"`, the barcode carried verbatim, and the reason saying
it disagrees.

### Check: alternatives-barcode-absent

**Requirement:** Each alternative says what is known about its barcode
**Surface:** `AlternativeBarcodeState`
**Automated:** test/alternatives.spec.ts

**Do**

Probe an alternative that published no barcode.

**Expect**

`barcodeState: "absent"`, and the reason saying a swap cannot be verified
either.

🔴 **Not a mismatch.** 91 of 255 captured product pages publish an empty
barcode; collapsing this into "disagreed" would tell a reviewer a swap is
riskier than it is, and collapsing it into "unprobed" would claim nobody looked.

### Check: alternatives-barcode-unprobed

**Requirement:** Each alternative says what is known about its barcode
**Surface:** `AlternativeBarcodeState`
**Automated:** test/alternatives.spec.ts

**Do**

Collect an alternative with no probe recorded for it.

**Expect**

`barcodeState: "unprobed"`, a null barcode, and the reason saying its page was
never opened.

🔑 **The state most alternatives are in**, because probes are the expensive part
and the measured count is 2.70 per row. Implying it was checked would be the
screen making a promise the run never made.

### Check: alternatives-reason-names-strongest-missing-signal

**Requirement:** The reason names a signal a reviewer can check
**Surface:** `reasonRankedLower`
**Automated:** test/alternatives.spec.ts

**Do**

Give the chosen candidate an exact part-number match plus brand and stock, and
the alternative only brand and stock.

**Expect**

The reason names the part-number difference, and **not** the weaker ones that
are also true.

⚠️ The strongest differing signal, not every difference: a reviewer needs the
reason that decided it, and nine clauses is a reason nobody reads.

### Check: alternatives-reason-prefers-the-stronger-signal

**Requirement:** The reason names a signal a reviewer can check
**Surface:** `reasonRankedLower`, `WEIGHTS`
**Automated:** test/alternatives.spec.ts

**Do**

Withhold both an exact part-number match (weight 20) and first-party (weight 3).

**Expect**

The part number, not the seller.

### Check: alternatives-reason-admits-a-tie

**Requirement:** The reason names a signal a reviewer can check
**Surface:** `reasonRankedLower`
**Automated:** test/alternatives.spec.ts

**Do**

Give the alternative exactly the chosen candidate's signals.

**Expect**

It says the ranking was a tie broken by discovery order.

🔴 **The weights are ordinal and unfitted**, so "it scored lower" is not true
when the signals are identical — only discovery order separated them, and
inventing a difference the scorer never made is worse than admitting there is
none.

### Check: alternatives-replay-split-unchanged

**Requirement:** Offering alternatives changes no ranking and spends nothing
**Surface:** `scoreBreakdown`, `scoreCandidate`
**Automated:** test/exit-criterion-53-rows.spec.ts

**Do**

Replay the 53 measured rows and compare the outcome split to the criterion.

**Expect**

Unchanged — verified count reproduced or beaten, row-by-row agreement intact.

🔴 **This check does NOT pin the score, and an earlier version of this
entry claimed it did.** A mutation adding `score += 1` to the `brandMatch`
credit left it **green**: the replay compares *outcomes*, and a uniform
nudge moves no candidate past another, so it changes which listing wins for
none of these rows.

So the arithmetic is pinned separately — see
`alternatives-score-pinned-to-its-signals` — and this check stands for what
it actually proves: the outcome split is unchanged.

⚠️ **The correction is the finding.** A checklist entry naming the wrong
check as a guard is worse than no entry, because the next reader stops
looking.

### Check: alternatives-score-pinned-to-its-signals

**Requirement:** Offering alternatives changes no ranking and spends nothing
**Surface:** `scoreBreakdown`, `scoreCandidate`, `WEIGHTS`
**Automated:** test/ranking-breakdown.spec.ts

**Do**

Score candidates matching an exact part number, a shared prefix, and
nothing at all, and compare each total to the sum of the named weights that
should have fired.

**Expect**

Exactly that sum, with the signal list naming each contributor once.

🔴 **This spec exists because a mutation proved the replay was not the pin
the checklist said it was.** Adding `score += 1` left the row-by-row replay
green; it turns these red immediately.

🔑 **Asserted against `WEIGHTS` by name, never against literals.** A
deliberate reweighting is a decision somebody makes and these stay correct
through it; an unnamed addition — the accident this is for — does not.

⚠️ Includes the pair that look contradictory until stated: `queryToken`
fires once per hit and the score counts every one, while the signal list
names it once.

### Check: alternatives-probe-outcomes-recorded

**Requirement:** Each alternative says what is known about its barcode
**Surface:** `resolveItem`'s probe loop, replayed
**Automated:** test/exit-criterion-53-rows.spec.ts

**Do**

Replay the 53 rows and tally the barcode state of every alternative.

**Expect**

At least one `disagreed`, at least one `absent`, and more `unprobed` than
the two combined — plus a barcode present on exactly the `disagreed` ones.

🔴 **This check exists because a mutation proved the corpus check did not
cover it.** Deleting the line that records what each probe published left
that check green, because it asserted only that `barcodeState` was one of
three values — and `unprobed` is one of three.

🔑 **Measured before being asserted**: 71 alternatives across 18 rows — **12
`disagreed`, 6 `absent`, 53 `unprobed`**. So all three states genuinely
occur here rather than being hoped for. ⚠️ Asserted as *at least one of
each* rather than the exact counts, because the counts are a property of
this corpus and would make a legitimate ranking change look like a
regression — while nought `disagreed` means the recording is gone.

### Check: alternatives-spend-nothing

**Requirement:** Offering alternatives changes no ranking and spends nothing
**Surface:** `ReplayFetcher.liveRequestCount`
**Automated:** test/exit-criterion-53-rows.spec.ts

**Do**

Read the live request count after the full replay.

**Expect**

Nought.

🔑 Alternatives come from the ranking a run already built, so there is nothing
extra to fetch — and this check is what would notice if somebody made one
re-probe the runners-up.

### Check: alternatives-honour-the-cap

**Requirement:** At most five are offered
**Surface:** `MAX_ALTERNATIVES`
**Automated:** test/alternatives.spec.ts

**Do**

Rank nine qualifying candidates and collect alternatives.

**Expect**

Five.

⚠️ The cap is a product judgement about a screen rather than a property of the
data, and the capability says so — beyond a handful the list is unprobed
candidates a reviewer cannot act on confidently.
