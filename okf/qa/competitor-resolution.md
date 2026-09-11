---
type: QA Checklist
title: Checks for resolving a client's item to a competitor's listing
description: One check per requirement in the competitor-resolution capability, with the command that runs it and the condition that makes it fail.
---

# Checks for resolving a client's item to a competitor's listing

Proves [competitor-resolution](/capabilities/competitor-resolution.md).

**Preconditions.** Node 22+, `npm ci`. **Nothing else.** No credentials, no
network, no database — everything above the fetcher is pure and the 53-row
replay reads a committed corpus. That is the point: a runtime that can only be
exercised against a live paid endpoint does not get exercised.

```bash
npm ci && npm run gate
```

**On the `Automated` split.** Every check below is automated. That is a property
of the design rather than of diligence: the corpus and the raw page fixtures were
committed precisely so that no check here needs a person, a key or a card.

⚠️ **One thing is deliberately NOT checked here.** Registering the image in the
production queue catalog is a write to a live system and belongs to a runbook,
not to a test suite.

---

### Check: resolution-replays-53-rows-offline

**Requirement:** The measured 53-row run is reproduced without spending anything
**Surface:** `resolveItem` over `ReplayFetcher`
**Automated:** `test/exit-criterion-53-rows.spec.ts` — "reproduces or beats the measured verified count on the rows it can replay", "agrees with the measured run row by row, not just in total"

**Do**

```bash
npx vitest run test/exit-criterion-53-rows.spec.ts --reporter=verbose
```

**Expect**

**40 of 53 rows replayed, verified 19 against the spike's 19**, and every
disagreement one of two *named* kinds — this pipeline being stricter, or one of
the spike's 5 network errors a cached response cannot reproduce. 🔴 **An
unexplained disagreement fails.** A total alone is satisfiable by getting
different rows right and wrong in equal measure, so agreement is asserted row by
row. The 13 unreplayed rows are corpus coverage: this pipeline plans different
queries, so the spike never fetched those pages.

---

### Check: resolution-loses-no-verification

**Requirement:** The measured 53-row run is reproduced without spending anything
**Surface:** the replay's `lostVerifications` assertion
**Automated:** `test/exit-criterion-53-rows.spec.ts` — "agrees with the measured run row by row, not just in total"

**Do**

```bash
npx vitest run test/exit-criterion-53-rows.spec.ts -t "row by row"
```

**Expect**

Zero. Every barcode the spike proved is proven here. This is the one assertion
held at exactly zero rather than reported, because a pairing the spike could
prove and this pipeline cannot is a regression however the totals look.

---

### Check: resolution-corpus-gap-is-not-a-miss

**Requirement:** The measured 53-row run is reproduced without spending anything
**Surface:** `NotInCorpus`
**Automated:** `test/replay-fetcher.spec.ts` — "rejects with NotInCorpus, not with a generic fetch failure"

**Do**

```bash
npx vitest run test/replay-fetcher.spec.ts
```

**Expect**

A distinct error type, not a `FetchFailed`. 🔴 During a replay a missing url
means the **corpus** is incomplete — a defect in the test data. Reported as a
network failure it would land on the spike's own 5 `error` rows and a wrong
answer would look like a faithful reproduction.

---

### Check: resolution-barcode-widths-agree

**Requirement:** A pairing is proven by barcode, whatever width the retailer publishes
**Surface:** `gtinMatches`
**Automated:** `test/gtin.spec.ts` — "gtinMatches — the retailer's own field, measured"

**Do**

```bash
npx vitest run test/gtin.spec.ts -t "the retailer's own field"
```

**Expect**

Four **measured** pairs agree — `097855114693` against `00097855114693`,
`619659075538` against `0619659075538`, and two more — plus the ordinary equal
case. 🔴 **A byte comparison is wrong for 4 of 22 proven pairings: 18%.** A false
mismatch is the worst output this product has, because it reads exactly like a
real one.

---

### Check: resolution-non-barcode-never-matches

**Requirement:** A pairing is proven by barcode, whatever width the retailer publishes
**Surface:** `gtinCore`'s width guard
**Automated:** `test/gtin.spec.ts` — "never matches when either side carries no digits"

**Do**

```bash
npx vitest run test/gtin.spec.ts -t "never matches when either side"
```

**Expect**

`SQR-WKIT-R2` and `1PZ1ML00050X` do not match each other. 🔴 **Found by this
check against my own first implementation**, which stripped non-digits
unconditionally and mined `2` out of a real part number from a real client's
barcode column — so two unrelated part numbers compared **equal**. Removing the
width guard reds 2 of 21 checks in that file.

---

### Check: resolution-retailer-barcode-verbatim

**Requirement:** A pairing is proven by barcode, whatever width the retailer publishes
**Surface:** `parseProductPage`
**Automated:** `test/adapter-newegg.spec.ts` — "reads a zero-padded 14-digit barcode verbatim, without normalising it"

**Do**

```bash
npx vitest run test/adapter-newegg.spec.ts -t "verbatim"
```

**Expect**

`00097855114693`, not `097855114693`. Normalising at the parser would discard
the evidence of what the retailer actually published; comparison is a separate
job done at compare time.

---

### Check: resolution-empty-barcode-is-unverifiable

**Requirement:** A listing the retailer publishes no barcode for is unverifiable, not probable
**Surface:** `resolveItem` → `unverifiable`
**Automated:** `test/resolve-outcomes.spec.ts` — "unverifiable — a listing found, no barcode published"; `test/adapter-newegg.spec.ts` — "reports an EMPTY barcode as null, not as an empty string"

**Do**

```bash
npx vitest run test/resolve-outcomes.spec.ts -t "unverifiable"
```

**Expect**

Outcome `unverifiable`, with evidence whose `retailerBarcode` is `null`. 🔴
**Measured: 91 of 255 captured product pages publish the barcode key EMPTY —
35.7% of everything the spike probed.** The spike compared the empty string,
got "no match", and reported those as `probable` — claiming "we think this is
it" for a third of everything probed when the truthful answer is "this cannot be
proven either way here".

---

### Check: resolution-disagreeing-barcode-is-unconfirmed

**Requirement:** A listing the retailer publishes no barcode for is unverifiable, not probable
**Surface:** `resolveItem` → `unconfirmed`
**Automated:** `test/resolve-outcomes.spec.ts` — "unconfirmed — a barcode published, and it disagrees"

**Do**

```bash
npx vitest run test/resolve-outcomes.spec.ts -t "unconfirmed"
```

**Expect**

Outcome `unconfirmed`. The negative half of the check above: without it,
`unverifiable` could be returned for every non-match and the distinction would
be meaningless.

---

### Check: resolution-unverifiable-beats-unconfirmed

**Requirement:** A listing the retailer publishes no barcode for is unverifiable, not probable
**Surface:** the probe loop's `noBarcodeFound` memory
**Automated:** `test/resolve-outcomes.spec.ts` — "unverifiable beats unconfirmed when both are available"

**Do**

```bash
npx vitest run test/resolve-outcomes.spec.ts -t "unverifiable beats"
```

**Expect**

`unverifiable`. An item the retailer cannot prove either way must not be
downgraded to "probably this" because some later candidate disagreed.

---

### Check: resolution-never-searched-is-a-failure

**Requirement:** An item nobody searched for is not reported as assortment information
**Surface:** `resolveItem`
**Automated:** test/resolve-outcomes.spec.ts

**Do**

Resolve an item at a retailer that does not accept a barcode search, where the
search-engine lookup answers with a page yielding no part number, brand or
phrase.

**Expect**

`queriesTried` is empty and `failure` is set, naming that no search was
attempted and that no searchable identity could be derived.

🔑 **`failure` is the whole difference** between the gateway writing `error`
and writing `not_carried`. The mutation that restores `failure: null` — exactly
what shipped — turns this red.

### Check: resolution-unfetchable-identity-says-so

**Requirement:** A source that could not be fetched is distinguished from an item with nothing to search for
**Surface:** `tryFetch`, `establishIdentity`
**Automated:** test/resolve-outcomes.spec.ts

**Do**

Resolve the same item against a fetcher that fails every url.

**Expect**

`failure` names that a source could not be fetched, and does **not** say no
searchable identity could be derived.

⚠️ **A retryable outage must not read as a list the customer has to go and
fix.** Two mutations turn this red: collapsing both cases into one reason, and
`tryFetch` no longer reporting that it failed.

### Check: resolution-a-searched-miss-stays-a-miss

**Requirement:** An item that WAS searched and not found is still a clean miss
**Surface:** `resolveItem`
**Automated:** test/resolve-outcomes.spec.ts

**Do**

Resolve an item whose identity yields a part number, against a retailer whose
searches all come back empty.

**Expect**

The outcome is `not-found`, `queriesTried` is non-empty, and `failure` is
`null`.

⚠️ **This is the control, and it is the point.** `not_carried` is real
assortment information and the product sells it. A fix that turned every miss
into an error would destroy that signal; the mutation widening the guard to
every item turns six checks red.

### Check: resolution-no-evidence-is-not-found

**Requirement:** A candidate with no part-number evidence is reported as nothing
**Surface:** `MIN_EVIDENCE_TO_REPORT` and `hasPartNumberEvidence`
**Automated:** `test/resolve-outcomes.spec.ts` — "not-found — a candidate with no part-number evidence is reported as nothing"

**Do**

```bash
npx vitest run test/resolve-outcomes.spec.ts -t "no part-number evidence"
```

**Expect**

`not-found`, with no listing offered. 🔴 This is the guard that stopped the
handover reporting a **$3,727 server** as the match for a **$13 accessory** from
a junk inferred identity. Reporting nothing beats reporting something wrong,
because a wrong pairing is indistinguishable from a real one downstream.

---

### Check: resolution-floor-alone-is-insufficient

**Requirement:** A candidate with no part-number evidence is reported as nothing
**Surface:** `hasPartNumberEvidence` as a second condition
**Automated:** `test/resolve-outcomes.spec.ts` — "keeps the reporting floor above what a brand match alone can earn"

**Do**

```bash
npx vitest run test/resolve-outcomes.spec.ts -t "reporting floor"
```

**Expect**

The arithmetic asserted: `brandMatch 6 + firstParty 3 + inStock 1` equals
`MIN_EVIDENCE_TO_REPORT` **exactly**. 🔴 **So the numeric floor was reachable
with no part-number evidence at all**, and the guard whose stated purpose is
"no model-level evidence, report nothing" reported same-brand in-stock listings.
Inherited from the handover, found by a check written about the *invariant*
rather than the behaviour. Raising the floor to 11 would fix this instance and
let the next weight change break it silently; requiring the evidence explicitly
cannot drift. Closing it moved 4 rows of the 53 from `probable` to `not-found`.

---

### Check: resolution-authority-beats-free

**Requirement:** What the item is comes from the most authoritative source available
**Surface:** `mergeIdentities`
**Automated:** `test/identity-merge.spec.ts` — "prefers the authoritative source over the free one"

**Do**

```bash
npx vitest run test/identity-merge.spec.ts
```

**Expect**

`63005` wins over `01043`. 🔴 **Both are 5-digit numerics, so nothing about the
answer's shape reveals which is right** — only its provenance does. The free
barcode derivation reproduces the client's published part number for 3 of the 4
numeric ones and gets the fourth wrong, so "it is free, try it first and stop"
would take a wrong identity while an authoritative one was one request away.

---

### Check: resolution-agreement-is-corroboration

**Requirement:** What the item is comes from the most authoritative source available
**Surface:** `ProductIdentity.corroboratedBy`
**Automated:** `test/identity-merge.spec.ts` — "records agreement between independent sources as corroboration"; `test/identity-real-pages.spec.ts` — "the free derivation agrees with only 3 of the 7"

**Do**

```bash
npx vitest run test/identity-real-pages.spec.ts
```

**Expect**

Agreement recorded, and the **3 of 7** count asserted against real published
part numbers. The count is asserted so that a change improving the derivation
forces the authority ordering to be reconsidered rather than drifting.

---

### Check: resolution-identity-carries-provenance

**Requirement:** What the item is comes from the most authoritative source available
**Surface:** `IdentityProvenance`
**Automated:** `test/exit-criterion-53-rows.spec.ts` — "records identity provenance on every resolution that has an identity"

**Do**

```bash
npx vitest run test/exit-criterion-53-rows.spec.ts -t "provenance"
```

**Expect**

Every identity names its source. 🔑 Not bookkeeping: an item paired through a
search-engine inference deserves different handling from one paired through the
client's own published part number, and the handover had no notion of provenance
at all, so nothing downstream could tell them apart.

---

### Check: resolution-wrong-product-page-refused

**Requirement:** What the item is comes from the most authoritative source available
**Surface:** the SKU check in `identityFromStructuredData`
**Automated:** `test/identity-from-structured-data.spec.ts` — "refuses a page whose Product is a DIFFERENT product"

**Do**

```bash
npx vitest run test/identity-from-structured-data.spec.ts -t "DIFFERENT product"
```

**Expect**

`null`. 🔴 A templated catalogue URL can land on a search page, a "similar
items" block, a redirect to a replacement, or a soft 404 returning 200 with some
other product's structured data. Reading that page's part number attaches a
confidently wrong identity, which becomes a wrong **match** — indistinguishable
from a real one. Returning `null` costs a fallback; guessing costs a false
pairing.

---

### Check: resolution-query-limits-are-configuration

**Requirement:** The retailer is never named above the adapter seam
**Surface:** `canQuery`, `QuerySupport`
**Automated:** `test/adapters-can-query.spec.ts`; `test/query-plan.spec.ts` — "never plans a query the retailer is known to refuse"

**Do**

```bash
npx vitest run test/adapters-can-query.spec.ts test/query-plan.spec.ts
```

**Expect**

Every barcode form refused locally, at 11, 12, 13 and 14 digits, without
spending a request to rediscover a known refusal. ⚠️ **A `null` limit means
unmeasured, never unlimited-and-verified** — a retailer nobody has probed must
not have a cap invented for it, because that would silently refuse queries it
can answer.

---

### Check: resolution-short-numeric-still-asked

**Requirement:** The retailer is never named above the adapter seam
**Surface:** `canQuery`
**Automated:** `test/adapters-can-query.spec.ts` — "allows a numeric part number at the measured boundary"

**Do**

```bash
npx vitest run test/adapters-can-query.spec.ts -t "measured boundary"
```

**Expect**

`2960703` is asked for. 🔑 The half of the rule easiest to lose: the naive
reading is "refuse numeric queries", which would refuse a real 7-digit model
number that **resolved one of the 22 verified rows**. The measured constraint is
a digit count — ten or more — not "numeric".

---

### Check: resolution-retailer-is-data-not-a-type

**Requirement:** The retailer is never named above the adapter seam
**Surface:** `RetailerAdapter.slug`
**Automated:** `test/adapter-newegg.spec.ts` — "names the retailer as data, not as a type"

**Do**

```bash
grep -rn "newegg" src --include="*.ts" | grep -v "src/adapters/newegg.ts"
```

**Expect**

Only `src/main.ts`'s slug-to-adapter map. ⚠️ **A grep, and it is the weakest
check here** — it proves no other file mentions the name, not that no other file
behaves differently per retailer. The handover's seam typed the retailer as
`"autozone" | "newegg"`; a union is a code path per retailer, and the compiler
pointing at every `switch` that narrows on it feels like safety while being the
coupling the seam exists to remove.

---

### Check: resolution-first-party-probed-first

**Requirement:** A first-party listing is probed before a marketplace one
**Surface:** `probeOrder`
**Automated:** `test/resolve-outcomes.spec.ts` — "ranks a first-party listing above a marketplace one at equal evidence"

**Do**

```bash
npx vitest run test/resolve-outcomes.spec.ts -t "first-party listing above"
```

**Expect**

The retailer's own listing first. A marketplace listing publishes the
**seller's** barcode — observed on a network-switch offer reporting an unrelated
one — so a first-party match is strong evidence and a marketplace mismatch is
weak.

---

### Check: resolution-seller-decides-first-party

**Requirement:** A first-party listing is probed before a marketplace one
**Surface:** `parseSearchResults` → `isFirstParty`
**Automated:** `test/adapter-newegg.spec.ts` — "calls a warehouse-shaped id with a named seller NOT first-party", "finds both kinds on one real page"

**Do**

```bash
npx vitest run test/adapter-newegg.spec.ts -t "named seller"
```

**Expect**

`isFirstParty: false` for a warehouse-shaped id carrying a named seller. 🔴
**Measured across 1,992 listings the two signals disagree on 358 (18%):** 288
warehouse-id-and-no-seller, **260 warehouse-id-with-a-seller**, 1,346
other-id-with-a-seller, 98 other-id-and-no-seller. The spike ranked on the id
shape alone and so labelled those 260 first-party. Whose barcode the page
carries follows the **seller**, not where the stock sits. A companion check
requires both kinds to appear on one real page, so a hardcoded value could not
pass.

---

### Check: resolution-run-resumes-without-spending

**Requirement:** A run survives being killed and re-buys nothing
**Surface:** `readJournal`, `runList`
**Automated:** `test/run.spec.ts` — "resumes from the journal and re-buys nothing"

**Do**

```bash
npx vitest run test/run.spec.ts -t "re-buys nothing"
```

**Expect**

The fetcher is asked for **nothing at all** — asserted as an empty request list,
not as a low count. A run killed at hour three must not restart at hour zero on
a list that costs money by the request.

---

### Check: resolution-truncated-journal-survives

**Requirement:** A run survives being killed and re-buys nothing
**Surface:** `readJournal`
**Automated:** `test/run.spec.ts` — "survives a truncated final journal line"

**Do**

```bash
npx vitest run test/run.spec.ts -t "truncated"
```

**Expect**

The complete lines are read and the partial one skipped. 🔴 A half-written final
line is **exactly** what a killed process leaves behind. Refusing to start costs
the whole run; skipping the line costs one re-resolution.

---

### Check: resolution-failure-is-not-a-miss

**Requirement:** A run survives being killed and re-buys nothing
**Surface:** `runList`'s catch, `Resolution.failure`
**Automated:** `test/run.spec.ts` — "records a pipeline failure as a failure, never as a clean miss"

**Do**

```bash
npx vitest run test/run.spec.ts -t "never as a clean miss"
```

**Expect**

A recorded failure with its reason. 🔴 Reporting "this retailer does not carry
it" for an item nobody managed to look up is the difference between a coverage
figure and a lie — and coverage is the number this whole product reports.

---

### Check: resolution-estimate-branches-per-item

**Requirement:** What a run will cost is stated before it starts, and never as a price
**Surface:** `estimateRun`
**Automated:** `test/run.spec.ts` — "prices the two paths differently", "prices the measured 8,926-row list at the figure on record"

**Do**

```bash
npx vitest run test/run.spec.ts -t "prices"
```

**Expect**

200 requests for 100 items with a part number, 470 without, and the real
8,926-row list between $41 and $43 — which is where the roadmap's ~$42 comes
from, so a rate change surfaces here. A single blended rate reports the same
number for any mix of list, which is precisely what an operator is asking about.

---

### Check: resolution-estimate-zero-for-empty

**Requirement:** What a run will cost is stated before it starts, and never as a price
**Surface:** `estimateRun`
**Automated:** `test/run.spec.ts` — "estimates zero for an empty list rather than dividing by zero"

**Do**

```bash
npx vitest run test/run.spec.ts -t "empty list"
```

**Expect**

`{ requests: 0, usd: 0 }`. A `NaN` reaching a response renders as an empty cost
rather than as an error.

---

### Check: resolution-money-rate-is-unvalidated

**Requirement:** What a run will cost is stated before it starts, and never as a price
**Surface:** `COST.usdPer1000Requests`
**Automated:** `test/run.spec.ts` — "the money rate is unvalidated, and the constant says so"

**Do**

```bash
npx vitest run test/run.spec.ts -t "unvalidated"
```

**Expect**

The rate is still 1. ⚠️ **Not a behaviour check — a tripwire.** The request
*counts* are measured; the money is not. If somebody calibrates the rate against
a real invoice this fails, and the docblock claiming it is unvalidated has to be
revisited in the same change. The runtime's own startup log labels the figure
`ESTIMATED` for the same reason.

---

### Check: resolution-parses-real-pages

**Requirement:** The parsers work against the retailer's real markup
**Surface:** `parseSearchResults`, `parseProductPage`
**Automated:** `test/adapter-newegg.spec.ts` — the whole file, over 7 committed gzipped captures

**Do**

```bash
npx vitest run test/adapter-newegg.spec.ts
```

**Expect**

44 candidates off the most populated captured page, every one with an id, a
fetchable url and a title, and no duplicate ids. 🔑 **Real markup is the one
thing a hand-written fixture cannot honestly stand in for**, and 2.1 MB of it
compresses to 369 KB — small enough that there is no excuse for not committing
it. The raw 160 MB cache is not in git, and briefly disappearing from the machine
it lived on is exactly why these seven are.

---

### Check: resolution-empty-results-page-is-not-an-error

**Requirement:** The parsers work against the retailer's real markup
**Surface:** `parseSearchResults`
**Automated:** `test/adapter-newegg.spec.ts` — "returns [] for a page with state and no results, rather than throwing"

**Do**

```bash
npx vitest run test/adapter-newegg.spec.ts -t "no results"
```

**Expect**

`[]`, from a real captured page that carries the embedded state and no products.
🔴 **That is the majority case — 156 of 271 captured search pages.** Treating it
as a parse failure would turn the retailer's ordinary "nothing matched" into an
error on 58% of searches, and an error is a different outcome from a miss.

---

### Check: resolution-reads-genuine-ean13

**Requirement:** The parsers work against the retailer's real markup
**Surface:** `parseProductPage`
**Automated:** `test/adapter-newegg.spec.ts` — "reads a GENUINE EAN-13 — the retailer does publish them"

**Do**

```bash
npx vitest run test/adapter-newegg.spec.ts -t "GENUINE EAN-13"
```

**Expect**

`5028551561707` — 13 digits, no leading zero, so not a padded UPC-A. 🔑 **This
closed Phase CI-1's one open cross-row dependency.** The board recorded that
nobody had checked whether the retailer's barcode field carries EAN-13 for an
import product, and that if it did not, **1,081 of the client's 8,926 items
(12%) would be unverifiable by construction**. Measured across all 255 captured
product pages: **6 distinct genuine EAN-13s**, GS1 prefixes 502, 471, 426, 509
and 695 — all non-US, which is exactly the import case in question.
