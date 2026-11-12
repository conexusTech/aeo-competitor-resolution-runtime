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
**Automated:** `test/resolve-outcomes.spec.ts` — "unconfirmed — a barcode published, and it disagrees"; `test/unread-best-candidate.spec.ts` — "an unconfirmed best carries the barcode its page published", "the primary value, where the page published several", "a lower listing proposed on the last attempt carries ITS barcode", "CONTROL: an unverifiable carries none, because its page published none"

**Do**

```bash
npx vitest run test/resolve-outcomes.spec.ts -t "unconfirmed"
npx vitest run test/unread-best-candidate.spec.ts -t "the evidence's retailer barcode"
```

**Expect**

Outcome `unconfirmed`, with evidence whose `retailerBarcode` is the barcode the
read page published — `099999999999`, the value that disagreed. The negative
half of the check above: without it, `unverifiable` could be returned for every
non-match and the distinction would be meaningless. The second command's four
pass: an unconfirmed best carries its page's value, the primary one where the
page published several; a lower listing proposed on the last attempt carries
its own page's value, not the unread best's; and the CONTROL, an
`unverifiable`, carries `null`. 🔴 **Until 2026-11-11 every `unconfirmed`
carried `null`**, which the gateway's review note reads as a page that could
not be read — so every real mismatch was described as an unread page, and the
portal's "theirs" column was blank. Seen on three Best Buy rows in a local run.

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

### Check: resolution-unfetched-searches-are-a-failure

**Requirement:** A search the retailer never answered is a failure, not a miss
**Surface:** `resolveItem`'s search loop
**Automated:** `test/resolve-outcomes.spec.ts` — "is a failure, not a miss, when no search could be fetched"

**Do**

```bash
npx vitest run test/resolve-outcomes.spec.ts -t "no search could be fetched"
```

Identity answers; every search url the plan asks for is a fetch failure.

**Expect**

`queriesTried` holds more than one search, the outcome is `not-found`, and
`failure` says all of them went unanswered, every one counted as could not be
fetched and none as a non-results page. `searchesUnfetched` equals the number
attempted. The gateway half — a resolution with a failure is recorded as
`error`, never `not_carried` — is [insights-run-failure-is-not-a-miss](aeo-backend:/qa/insights-run-orchestration.md) in `aeo-backend`.

🔴 **This is 2026-10-22's production defect.** An expired proxy credential made a
227-item run fetch nothing, and every item was filed `not_carried`. Two
mutations turn this red: returning `failure: null` from the empty pool (as
shipped) and the silent `continue` that counts nothing.

### Check: resolution-non-results-pages-are-a-failure

**Requirement:** A search the retailer never answered is a failure, not a miss
**Surface:** `resolveItem`'s search loop
**Automated:** `test/resolve-outcomes.spec.ts` — "is a failure when every search came back as something other than a results page", "counts both kinds when the two happen together"

**Do**

```bash
npx vitest run test/resolve-outcomes.spec.ts -t "a search the retailer never answered"
```

**Expect**

When the adapter answers `null` for every search body, `failure` counts every
search as not a results page. When the first is blocked and the rest fail to
fetch, both counts appear, in the failure and in `searchesUnfetched` /
`searchesNotResultsPage`. Not counting a non-results page turns both red. The
gateway half is [insights-run-failure-is-not-a-miss](aeo-backend:/qa/insights-run-orchestration.md).

### Check: resolution-throttled-specific-search-is-a-failure

**Requirement:** A search the retailer never answered is a failure, not a miss
**Surface:** `resolveItem`'s empty-pool and below-the-floor returns
**Automated:** `test/resolve-outcomes.spec.ts` — "is a failure when a throttled specific search sits beside a vaguer sibling that answered empty", "is a failure when the answered siblings held only candidates below the evidence floor"

**Do**

```bash
npx vitest run test/resolve-outcomes.spec.ts -t "throttled specific search|below the evidence floor"
```

The first, most specific search fails to fetch; every later one answers, first
with an empty results page and then with only a candidate below the evidence
floor.

**Expect**

Both are `not-found` with a failure saying one search went unanswered, never a
clean miss. 🔴 **This is the rule: every attempted search answered, not any.**
Restoring "one answered is enough" turns both red, and dropping the failure
from the below-the-floor return turns the second red. The gateway half is
[insights-run-failure-is-not-a-miss](aeo-backend:/qa/insights-run-orchestration.md).

### Check: resolution-adapters-refuse-a-non-results-page

**Requirement:** A search the retailer never answered is a failure, not a miss
**Surface:** each adapter's `parseSearchResults`
**Automated:** `test/adapter-amazon.spec.ts` — "returns null for a page that is not a results page", "returns null for a robot check, however Amazon-shaped it looks"; `test/adapter-newegg.spec.ts` — "returns null for markup carrying no state at all — not a results page"

**Do**

```bash
npx vitest run test/adapter-amazon.spec.ts test/adapter-newegg.spec.ts -t "null"
```

**Expect**

`null`, never `[]`, for a body that is not a results page: Amazon for anything
without its results container (including a robot check in full Amazon chrome),
Newegg for anything without its embedded state. ⚠️ The robot check is
hand-built: none has been captured, because the proxy unblocks before it
answers. Removing either adapter's recognition turns its checks red.

### Check: resolution-amazon-refuses-a-truncated-or-unreadable-page

**Requirement:** A search the retailer never answered is a failure, not a miss
**Surface:** the Amazon adapter's `parseSearchResults`
**Automated:** `test/adapter-amazon.spec.ts` — "returns null for the real results page cut short after its container", "returns null when there are result cells and none of them parses", "returns null for a lone valid result cell with no results container"

**Do**

```bash
npx vitest run test/adapter-amazon.spec.ts -t "cut short|none of them parses|lone valid result cell"
```

**Expect**

`null` for the real results page cut 2,000 bytes after its container, which
carries the container and neither a readable cell nor Amazon's no-results
message; `null` for a page of result cells none of which can be read; and
`null` for one valid cell with no container, while the same cell inside the
container is read. Each of three mutations turns exactly one red: not requiring
the no-results message, returning the empty list when no cell parsed, and
dropping the container marker's closing quote.

### Check: resolution-real-no-results-page-is-a-miss

**Requirement:** A search the retailer never answered is a failure, not a miss
**Surface:** each adapter's `parseSearchResults`
**Automated:** `test/adapter-amazon.spec.ts` — "returns [] for Amazon's real no-results page", "returns candidates for Amazon's real results page — the CONTROL"; `test/adapter-newegg.spec.ts` — "keeps [] and null apart on the same real page — the CONTROL"

**Do**

```bash
npx vitest run test/adapter-amazon.spec.ts -t "real no-results page"
npx vitest run test/adapter-newegg.spec.ts -t "keeps \[\] and null apart"
```

**Expect**

`[]` for Amazon's real no-results page — captured 2026-10-22 through the live
proxy, `test/raw/amazon-search-no-results.html.gz`, carrying the results
container and Amazon's no-results widget — and for Newegg's committed
no-results page; 16 and 44 candidates on the real results pages. 🔑 **This is
the calibration.** A recogniser keyed on anything the no-results page lacks
returns `null` here and turns every genuine miss into an error; changing
Amazon's marker to the result-cell attribute turns this check red.

### Check: resolution-every-search-answered-is-a-clean-miss

**Requirement:** A search the retailer never answered is a failure, not a miss
**Surface:** `resolveItem`
**Automated:** `test/resolve-outcomes.spec.ts` — "still reports a searched-and-found-nothing item as a clean miss", "is a clean miss below the floor when every search answered — the CONTROL"; `test/exit-criterion-53-rows.spec.ts`

**Do**

```bash
npx vitest run test/resolve-outcomes.spec.ts -t "searched-and-found-nothing|every search answered"
npx vitest run test/exit-criterion-53-rows.spec.ts
```

**Expect**

Every planned search answered with an empty results page gives `not-found`
with `failure` null and both counts 0; every search answered with only a
candidate below the floor gives the same. The 53-row replay keeps Newegg's
measured split row for row. ⚠️ **This is the control and stays green under
every mutation above.** `not_carried` is the signal the product sells, and a
fix that turned an answered miss into an error would destroy it.

### Check: resolution-unanswered-searches-are-counted

**Requirement:** A search the retailer never answered is a failure, not a miss
**Surface:** `Resolution`, `runList`'s journal, `tallySearches` and the run's summary line
**Automated:** `test/resolve-outcomes.spec.ts` — "carries the counts on a finding too, so a run can report them"; `test/run.spec.ts` — "retries after the run an item whose every search went unanswered", "totals the run's unanswered searches for its summary line"

**Do**

```bash
npx vitest run test/resolve-outcomes.spec.ts -t "carries the counts"
npx vitest run test/run.spec.ts -t "unanswered"
```

**Expect**

A finding whose first search was blocked carries `searchesNotResultsPage` 1.
A retried item keeps its first attempt's `searchesUnfetched`, and the journal
line carries both fields. The run's tally equals the searches the fetcher
refused, and the summary line reads `searches unanswered: N could not be
fetched, M came back as not a results page, across K item(s)`. 🔑 **M is the
figure the production verification reports**: searches answered by a page that
was not a results page. Not counting either kind turns these red.

### Check: resolution-unanswered-item-retried-after-the-run

**Requirement:** A search the retailer never answered is a failure, not a miss
**Surface:** `runList`
**Automated:** `test/run.spec.ts` — "retries after the run an item whose every search went unanswered"

**Do**

```bash
npx vitest run test/run.spec.ts -t "every search went unanswered"
```

Every search url fails on its first fetch and answers on its second.

**Expect**

The item settles `verified` with no failure: it was held back as a failure and
asked again after the run. Returning `failure: null` from the empty pool turns
this red, because the item then settles `not-found` on the first pass and is
never retried.

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
**Automated:** `test/adapter-newegg.spec.ts` — "names the retailer as data, not as a type"; `test/pages-at-once.spec.ts` — "names no retailer outside its own adapter and the slug map"

**Do**

```bash
grep -rnE "[\"'\`](newegg|amazon|bestbuy|bh|costco)[\"'\`]" src --include="*.ts" | grep -v "^src/adapters/"
npx vitest run test/adapter-newegg.spec.ts test/pages-at-once.spec.ts -t "names the retailer as data|names no retailer outside its own adapter"
```

**Expect**

The grep prints nothing: none of the five slugs appears as a string anywhere
outside `src/adapters/`, where each adapter states its own, once, as its `slug`.
`src/main.ts` maps the slugs to adapters by each adapter's own `slug` field, so
it names none. The spec does the same over every source file outside
`src/adapters/`, and also refuses any comparison against a slug, either way
round. A line comparing `slug === "costco"` added to `src/resolve.ts` turns it red. ⚠️
**Still the weakest check here** — it proves no other file names a retailer,
not that no other file behaves differently per retailer. A prose mention in a
comment (Costco's page sizes beside the response ceiling, say) is not a string
literal and passes, which is intended. The handover's seam typed the retailer as
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

The with-part-number path prices at `100 × requestsPerItemWithPartNumber` and
the derived path at `100 × requestsPerItemDerivedIdentity`, with the second
dearer than the first. The real 8,926-row list prices **between $59 and $61**.

🔴 **This section carried the literals `200` and `470` and the range `$41–$43`
until 2026-09-12, and every one of them was stale.** The derived-identity
constant was corrected from 4.7 to 6.7 on 2026-09-11; `test/run.spec.ts` was
corrected in the same change and now multiplies the constant instead of
repeating it — this permanent document was not, so it contradicted both the
code and the very test it cites. Found by a review pass, not by a gate.

⚠️ **So the figures above are deliberately expressed as the arithmetic rather
than as numbers.** A literal here is a second copy of the constant, which is
the defect the constant exists to prevent. The dollar range stays a number
because it is the thing a rate change must surface — and it is the one figure
to update, in the same motion, if `usdPer1000Requests` is ever validated
against an invoice.

A single blended rate would report the same number for any mix of list, which
is precisely what an operator is asking about.

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

### Check: resolution-throttle-backs-off-longer

**Requirement:** An empty answer is waited out, not retried into
**Surface:** `LiveFetcher.fetch`
**Automated:** test/throttle-backoff.spec.ts

**Do**

Answer every attempt with a 200 and an empty body; record the durations the
fetcher sleeps for.

**Expect**

`[5000, 10000]` — fifteen seconds in total, which is what recovered the measured
case. The old schedule was `[1000, 2000]`.

⚠️ **The check measures the WAITS, not that a retry happened.** A check asserting
only "it retried" passes against the code that shipped.

### Check: resolution-ordinary-failure-keeps-short-backoff

**Requirement:** An ordinary failure keeps its short backoff
**Surface:** `LiveFetcher.fetch`
**Automated:** test/throttle-backoff.spec.ts

**Do**

Answer every attempt with a 5xx and record the sleeps.

**Expect**

`[1000, 2000]`, under five seconds in total.

🔑 **The control, and it is as load-bearing as the check above.** A fix that made
every retry slow would satisfy the throttle check and make every transient error
cost fifteen seconds.

### Check: resolution-recovered-throttle-counts-every-attempt

**Requirement:** A throttle that yields is counted as every attempt it took
**Surface:** `LiveFetcher.fetch`
**Automated:** `test/throttle-backoff.spec.ts` — "recovers when a later attempt answers, and is charged for both attempts"

**Do**

```bash
npx vitest run test/throttle-backoff.spec.ts -t "charged for both attempts"
```

**Expect**

The page is returned, `liveRequestCount` is 2, the result's `attempts` is 2,
`pagesDelivered` is 1, `throttleCount` is 0, and exactly one throttle backoff
was waited. ⚠️ This check was `resolution-recovered-throttle-costs-one-request`
and asserted a count of 1 until 2026-11-11, when every attempt sent began to
count (`resolution-counts-every-attempt`). The empty 200 was a request the
vendor was asked for.

### Check: resolution-throttles-counted-apart

**Requirement:** A run says how many of its failures were throttles
**Surface:** `LiveFetcher`
**Automated:** test/throttle-backoff.spec.ts

**Do**

Exhaust the attempts once against an empty 200 and once against a 503.

**Expect**

Both raise `FetchFailed` and both increment `failureCount`; only the empty one
increments `throttleCount`.

🔑 A run reporting `failures: 16` says something went wrong. One reporting
`16 throttled` says what to change.

### Check: resolution-failed-item-retried-after-the-run

**Requirement:** An item whose pipeline failed is tried once more
**Surface:** `runList`
**Automated:** test/request-attribution.spec.ts

**Do**

Resolve items against a fetcher that refuses each product probe its first
attempt and answers thereafter.

**Expect**

Every item settles with no failure, and each is reported exactly once.

### Check: resolution-retry-runs-one-at-a-time

**Requirement:** The retry does not recreate the throttle
**Surface:** `runList`
**Automated:** test/request-attribution.spec.ts

**Do**

Defer six items from a run at concurrency 3 and record the number of fetches in
flight whenever a search-engine url is fetched for the second time.

**Expect**

Never more than one.

🔴 **This check exists because a mutation reported GREEN, twice.** Running the
retry at full concurrency passed every other check. And the first version of this
one was itself vacuous: the fake failed the product probe **by url**, and every
item here derives the same identity and so shares one product url — so only the
first item failed, one item was deferred, and a serial retry was guaranteed
whatever the code did. It fails the product probe by count now, and asserts that
more than one item really was deferred.

### Check: resolution-retry-charges-both-attempts

**Requirement:** A retried item is charged for both attempts
**Surface:** `runList`
**Automated:** test/request-attribution.spec.ts

**Do**

Resolve one item that fails once and succeeds on the retry; compare its
`requests` against the fetcher's own count.

**Expect**

They agree. 🔴 A retry's meter starts at zero, so settling on it alone drops the
first attempt's spend — the vanishing-spend defect the per-item meter exists to
remove, reintroduced by the retry. An existing check caught exactly that.

### Check: resolution-retry-happens-once-only

**Requirement:** An item that fails twice is settled, not retried for ever
**Surface:** `runList`
**Automated:** test/request-attribution.spec.ts

**Do**

Resolve items against a fetcher that never answers the product probe.

**Expect**

Each settles with a failure, and the total charged equals what the fetcher sold.

## Amazon

Added 2026-10-22. Every check below runs against the committed Amazon pages in
`test/raw/` or a fake retailer, so none needs a key, a network or a card.

### Check: resolution-amazon-reads-the-gtin-label

**Requirement:** Amazon's barcode is read under whichever label it publishes it
**Surface:** the Amazon adapter's `parseProductPage`
**Automated:** `test/adapter-amazon.spec.ts` — "extracts the barcode published under a spelled-out GTIN label"

**Do**

```bash
npx vitest run test/adapter-amazon.spec.ts -t "spelled-out GTIN label"
```

**Expect**

`04713294232687`, read from the real product page's "Global Trade
Identification Number" row. Dropping that label from the accepted set turns it
red.

### Check: resolution-amazon-ignores-incidental-upc

**Requirement:** Amazon's barcode is read under whichever label it publishes it
**Surface:** the Amazon adapter's `parseProductPage`
**Automated:** `test/adapter-amazon.spec.ts` — "returns nothing from the sixteen incidental UPC strings on that page"

**Do**

```bash
npx vitest run test/adapter-amazon.spec.ts -t "incidental UPC"
```

**Expect**

The page carries at least sixteen `upc` strings, and the barcode read is not one
of them. A mutation taking the first `upc`-bearing string on the page turns it
red. ⚠️ It also turns red when the GTIN label is dropped, because it then reads
no barcode at all, so it is not isolated from the check above.

### Check: resolution-amazon-no-barcode-row-is-none

**Requirement:** Amazon's barcode is read under whichever label it publishes it
**Surface:** the Amazon adapter's `parseProductPage`
**Automated:** `test/adapter-amazon.spec.ts` — "reports no barcode for a details table that publishes none"

**Do**

```bash
npx vitest run test/adapter-amazon.spec.ts -t "publishes none"
```

**Expect**

`barcode` is `null` and `additionalBarcodes` is empty, which is what makes the
item `unverifiable` rather than mismatched (`resolution-empty-barcode-is-unverifiable`).
Reporting an empty string instead turns it red.

### Check: resolution-amazon-splits-a-two-barcode-field

**Requirement:** A field holding two barcodes verifies on either
**Surface:** the Amazon adapter's `parseProductPage`
**Automated:** `test/adapter-amazon.spec.ts` — "splits a field holding more than one barcode"

**Do**

```bash
npx vitest run test/adapter-amazon.spec.ts -t "more than one barcode"
```

**Expect**

`812348010548` as the barcode and `["191120055664"]` as the additional ones. Not
splitting on whitespace turns it red.

### Check: resolution-verifies-on-a-second-barcode

**Requirement:** A field holding two barcodes verifies on either
**Surface:** `resolveItem`'s probe loop
**Automated:** `test/resolve-outcomes.spec.ts` — "verified — the agreeing barcode is the SECOND value in the field"

**Do**

```bash
npx vitest run test/resolve-outcomes.spec.ts -t "SECOND value"
```

**Expect**

`verified`, with the evidence naming `812348010548`, the value that agreed, not
the field's first token. Two mutations turn it red: comparing only the primary
barcode, and naming the first token as the evidence.

### Check: resolution-amazon-offered-price-on-a-real-page

**Requirement:** The offered price is reported, never the struck-through list price
**Surface:** the Amazon adapter's `parseSearchResults`
**Automated:** `test/adapter-amazon.spec.ts` — "takes the offered price, not the struck-through list price", "prices every listing on this page — the CONTROL for the price checks"

**Do**

```bash
npx vitest run test/adapter-amazon.spec.ts -t "price"
```

**Expect**

`11999` for the discounted real listing, never `12999`, and every listing on the
page priced. Reading the struck-through span turns both red.

### Check: resolution-amazon-price-by-markup-not-order

**Requirement:** The offered price is reported, never the struck-through list price
**Surface:** the Amazon adapter's `parseSearchResults`
**Automated:** `test/adapter-amazon.spec.ts` — "chooses by markup, not by order — list price first still yields the offered one"

**Do**

```bash
npx vitest run test/adapter-amazon.spec.ts -t "by markup, not by order"
```

**Expect**

`11999` when the struck-through `$129.99` comes first in the cell. 🔑 **This is
the check that earns the tight pattern.** On the real page the offered price
happens to come first, so loosening the pattern to any `a-price` span leaves the
real-page check green and turns only this one red.

### Check: resolution-amazon-claims-no-model-or-seller

**Requirement:** What Amazon does not state is not invented
**Surface:** the Amazon adapter's `parseSearchResults`
**Automated:** `test/adapter-amazon.spec.ts` — "claims no model and no first-party status, because Amazon states neither"

**Do**

```bash
npx vitest run test/adapter-amazon.spec.ts -t "claims no model"
```

**Expect**

`model`, `isFirstParty` and `sellerName` are `null` for all 16 real results.
Assuming first-party turns it red. That a guessed brand never decides a pairing
is `resolution-floor-alone-is-insufficient`: brand, first-party and stock
together reach the reporting floor and are still refused without part-number
evidence.

## Best Buy, B&H and Costco

Added 2026-11-11. Every automated check below runs against the committed
Best Buy, B&H and Costco pages in `test/raw/` and the 20-row corpora in
`test/corpus/`, or a fake retailer, so none needs a key, a network or a card.
Pages marked SYNTHETIC in a test name are real pages with one value spliced in,
for a case no capture shows; the test says so.

🔑 **The three Manual checks are the live half of the investigation's
reproduction**: the same 20 rows through the real gateway, queue and runtime
container on the local stack, against Bright Data. They cost real requests, and
each run is capped. The offline checks prove the pipeline reproduces the
investigation on the pages it captured; only the live run proves the
competitor still answers the way those pages say.

---

### Check: resolution-bestbuy-reproduces-the-investigation

**Requirement:** The platform reproduces the investigation
**Surface:** `resolveItem` with the Best Buy adapter over `ReplayFetcher`
**Automated:** `test/exit-criterion-bestbuy-20-rows.spec.ts`

**Do**

```bash
npx vitest run test/exit-criterion-bestbuy-20-rows.spec.ts
```

**Expect**

25 tests pass, and the summary line reads `verified 11 vs the investigation's
11`. Each of the 11 rows the investigation verified is verified on the same
Best Buy SKU, row by row. Each of the other 9 is replayed as far as its barcode
search, which Best Buy answered with nothing, and must then ask for the
identity lookup and nothing else, for the named reason that no identity page
for those barcodes was captured. No row is verified without a barcode that
agrees, every page of the corpus is used, and nothing is spent. 🔴 Any other
disagreement fails the row's own test.

---

### Check: resolution-bh-reproduces-the-investigation

**Requirement:** The platform reproduces the investigation
**Surface:** `resolveItem` with the B&H adapter over `ReplayFetcher`
**Automated:** `test/exit-criterion-bh-20-rows.spec.ts`

**Do**

```bash
npx vitest run test/exit-criterion-bh-20-rows.spec.ts
```

**Expect**

28 tests pass, and the summary line reads `verified 8 vs the investigation's
8`. Each row reaches the outcome the investigation recorded: 8 verified by UPC,
3 discontinued listings to a person, 9 not found. 🔴 The CONTROL replays the
same rows with barcode search switched off and reproduces none of them, so the
pass is the barcode-first rule's, not the corpus's.

---

### Check: resolution-costco-reproduces-the-investigation

**Requirement:** The platform reproduces the investigation
**Surface:** `runList` and `resolveItem` with the Costco adapter over `ReplayFetcher`
**Automated:** `test/exit-criterion-costco-20-rows.spec.ts`

**Do**

```bash
npx vitest run test/exit-criterion-costco-20-rows.spec.ts
```

**Expect**

30 tests pass. Each of the 20 rows is not found, looked up in the product list
by its brand, with 0 failures, as the investigation found. The 21st row, the
AirPods, is verified on `195949689604` at `$99.97`, stock unknown, sold by
Costco. Costco's search is never asked. Run as one list at four pages at once,
the product index is read once and every row gets its outcome. 🔴 The CONTROL,
which takes candidates only from names that lead with the brand, never finds
the AirPods, so the product-line rule is what finds them.

---

### Check: resolution-bestbuy-reproduces-the-investigation-live

**Requirement:** The platform reproduces the investigation
**Surface:** the gateway, the local queue and the runtime container, against Best Buy through Bright Data
**Automated:** Manual

**Do**

Follow [the local end-to-end playbook](aeo-backend:/playbooks/competitor-insights-end-to-end-locally.md),
tier 4, on the `docker-desktop` context. Upload the 20 shared Micro Center rows
as a list against Best Buy, start a run, and delete its Job if it passes 200
requests. Then run a 1-row list holding Kensington `K72337US`
(`085896723370`), with its part number and brand.

**Expect**

On the 20-row list, 10 rows are verified, and every other row is in review,
not found, or failed with a reason. The investigation's 11th, Kensington
`K72337US`, is verified in the 1-row run once the client's part number reaches
the runtime. Without it the runtime derives `KMW72337` from elsewhere and does
not find the listing. That is the row
`resolution-client-part-number-asked-first` pins offline. Logs show at most 4
pages in flight.

---

### Check: resolution-bh-reproduces-the-investigation-live

**Requirement:** The platform reproduces the investigation
**Surface:** the gateway, the local queue and the runtime container, against B&H through Bright Data
**Automated:** Manual

**Do**

Follow [the local end-to-end playbook](aeo-backend:/playbooks/competitor-insights-end-to-end-locally.md),
tier 4, on the `docker-desktop` context. Upload the 20 shared Micro Center rows
as a list against B&H, start a run, and delete its Job if it passes 150
requests.

**Expect**

8 verified, 3 discontinued listings in review with the reason "discontinued at
B&H, no UPC published", 8 not carried, and 1 failure on a search B&H did not
answer. The failure is filed as an error, never as not carried. That matches
the investigation's 8 verified and 3 discontinued, and the one failure is a
search nobody answered, not a row the pipeline lost.

---

### Check: resolution-costco-reproduces-the-investigation-live

**Requirement:** The platform reproduces the investigation
**Surface:** the gateway, the local queue and the runtime container, against Costco through Bright Data
**Automated:** Manual

**Do**

Follow [the local end-to-end playbook](aeo-backend:/playbooks/competitor-insights-end-to-end-locally.md),
tier 4, on the `docker-desktop` context. Upload the 20 shared Micro Center rows
plus the AirPods row (UPC `195949689604`, Micro Center SKU `757427`) as a list
against Costco, start a run, and delete its Job if it passes 120 requests.

**Expect**

The 20 shared rows are not carried, with 0 failures, and the AirPods row is
verified on `195949689604` at `$99.97`, stock unknown. Costco's product list is
read once for the run: its sitemap index, then each product file it names, one
request each. No search page is requested. Logs show at most 4 pages in flight.

Measured 2026-11-11 on runtime `237f240` through the local portal: 21 items,
1 verified (AirPods, Costco item 4000308504, $99.97 against Micro Center's
$129.99, stock unknown, sold by Costco), 20 not carried, 0 failures, 6 requests
sent and 4 delivered, "pages at once: 4".

---

### Check: resolution-bestbuy-proves-by-published-barcode

**Requirement:** A pairing is proven by the competitor's own barcode
**Surface:** `resolveItem` with the Best Buy adapter
**Automated:** `test/adapter-bestbuy.spec.ts` — "verifies on the UPC the page publishes — M310, 097855066237 — in two requests"

**Do**

```bash
npx vitest run test/adapter-bestbuy.spec.ts -t "verifies on the UPC the page publishes"
```

**Expect**

`verified` on SKU `1297054`, with `retailerBarcode` `097855066237` as Best Buy
published it, first party, sold by Best Buy, at `1699` cents. Exactly two pages
are asked, the barcode search and the product page, and no identity is
established, because the barcode search found the listing.

---

### Check: resolution-bh-proves-by-published-barcode

**Requirement:** A pairing is proven by the competitor's own barcode
**Surface:** `resolveItem` with the B&H adapter
**Automated:** `test/adapter-bh.spec.ts` — "verifies the M310 on 097855066237: one search, one page, no identity bought"

**Do**

```bash
npx vitest run test/adapter-bh.spec.ts -t "verifies the M310 on 097855066237"
```

**Expect**

`verified`, with the barcode as B&H published it, after one search and one
product page, and no identity lookup bought.

---

### Check: resolution-costco-proves-by-published-barcode

**Requirement:** A pairing is proven by the competitor's own barcode
**Surface:** `resolveItem` with the Costco adapter over the AirPods row
**Automated:** `test/exit-criterion-costco-20-rows.spec.ts` — "verifies the AirPods at $99.97 by its UPC, stock unknown, sold by Costco"

**Do**

```bash
npx vitest run test/exit-criterion-costco-20-rows.spec.ts -t "verifies the AirPods at"
```

**Expect**

`verified`, with `retailerBarcode` `195949689604` as Costco's page states it,
price `9997`, `inStock` `null`, sold by Costco.

---

### Check: resolution-bestbuy-several-barcodes-verify

**Requirement:** A page publishing several barcodes still proves the pairing
**Surface:** the Best Buy adapter's `parseProductPage`, and `resolveItem`
**Automated:** `test/adapter-bestbuy.spec.ts` — "several barcodes: every value of a field, the first as barcode (spliced, not seen live)", "several barcodes verify on the value that agrees (spliced, not seen live)"

**Do**

```bash
npx vitest run test/adapter-bestbuy.spec.ts -t "several barcodes"
```

**Expect**

Both pass: the parse publishes every value of the field, the first as
`barcode` and the rest as `additionalBarcodes`, and the item verifies on the
value that agrees, not the first. ⚠️ **Best Buy has no multi-barcode page in
the captures**; the page is a real one with a second value spliced in, and the
test names say so.

---

### Check: resolution-bh-several-barcodes-verify

**Requirement:** A page publishing several barcodes still proves the pairing
**Surface:** the B&H adapter's `parseProductPage`, and `resolveItem`
**Automated:** `test/adapter-bh.spec.ts` — "publishes every UPC it states for its own item (SYNTHETIC: a second value)", "verifies on any of several UPCs the page states (SYNTHETIC: a second value)"

**Do**

```bash
npx vitest run test/adapter-bh.spec.ts -t "a second value"
```

**Expect**

Both pass: every UPC the page states for its own item is published, once each,
and the item verifies on whichever one agrees. A kit's component UPCs are not
among them (`resolution-bh-component-upc-never-matches`).

---

### Check: resolution-costco-several-barcodes-verify

**Requirement:** A page publishing several barcodes still proves the pairing
**Surface:** the Costco adapter's `parseProductPage`, and `resolveItem`'s probe loop
**Automated:** `test/adapter-costco.spec.ts` — "SYNTHETIC: every item's UPC, items first, the parent's last"; `test/resolve-outcomes.spec.ts` — "verified — the agreeing barcode is the SECOND value in the field"

**Do**

```bash
npx vitest run test/adapter-costco.spec.ts test/resolve-outcomes.spec.ts -t "every item's UPC, items first|SECOND value"
```

**Expect**

Both pass: a Costco page selling several items publishes every item's UPC,
the items' first and the parent's last, and the probe loop verifies on a value
that is not the first. 🔴 The parent's UPC is last because it can be one of
Costco's own numbers, which never verify (`resolution-costco-own-numbers-never-verify`).

---

### Check: resolution-bestbuy-refusal-is-a-failure

**Requirement:** A refused search is a failure, not a miss
**Surface:** the Best Buy adapter's `parseSearchResults`, and `resolveItem`
**Automated:** `test/adapter-bestbuy.spec.ts` — "a vendor refusal is a failure, not a miss", "an empty body is a failure, not a miss", "an empty body, a vendor refusal or a product page is not a results page"

**Do**

```bash
npx vitest run test/adapter-bestbuy.spec.ts -t "is a failure, not a miss|is not a results page"
```

**Expect**

Three pass. A vendor refusal, an empty body and a product page each parse to
`null`, never `[]`. Resolved, a refused or empty search leaves the item
`not-found` with a non-null `failure` and the unanswered search counted, which
the gateway records as an error, never as not carried.

---

### Check: resolution-bh-refusal-is-a-failure

**Requirement:** A refused search is a failure, not a miss
**Surface:** the B&H adapter's `parseSearchResults`, and `resolveItem`
**Automated:** `test/adapter-bh.spec.ts` — "a refused search is a failure, never a miss", "a body that is not a results page is null, never []", "a card whose fields moved is null, not an empty answer"

**Do**

```bash
npx vitest run test/adapter-bh.spec.ts -t "refused search is a failure|not a results page is null|fields moved is null"
```

**Expect**

Three pass. A body that is not a results page, and a results page whose cards
can no longer be read, both parse to `null`. Resolved, a refused search leaves
a non-null `failure`, never a clean miss.

---

### Check: resolution-costco-refusal-is-a-failure

**Requirement:** A refused search is a failure, not a miss
**Surface:** `IndexCache` and `resolveItem` with a product index; the Costco adapter's `parseSearchResults`
**Automated:** `test/product-index.spec.ts` — "a failed fetch of the list fails every item, with the reason", "a failed product file fails every item too"; `test/adapter-costco.spec.ts` — "a search page is a shell: nobody answered, never 'not carried'"

**Do**

```bash
npx vitest run test/product-index.spec.ts test/adapter-costco.spec.ts -t "fails every item|search page is a shell"
```

**Expect**

Three pass. A product list that could not be fetched, at the list or at any of
its product files, makes every item a failure with the reason, never a miss.
Costco's search page, an empty shell, parses to `null`, an answer nobody gave.

---

### Check: resolution-bestbuy-no-results-is-a-miss

**Requirement:** A search the competitor answers with nothing is a miss
**Surface:** the Best Buy adapter's `parseSearchResults`, and `resolveItem`
**Automated:** `test/adapter-bestbuy.spec.ts` — "search-empty-63005 is a miss: an answered page with nothing on it", "search-empty-63005 is a miss: every search answered with nothing"

**Do**

```bash
npx vitest run test/adapter-bestbuy.spec.ts -t "search-empty-63005"
```

**Expect**

Two pass. Best Buy's real no-results page parses to `[]`, and an item every
search of which was answered that way is `not-found` with no `failure`, its
searches listed.

---

### Check: resolution-bh-no-results-is-a-miss

**Requirement:** A search the competitor answers with nothing is a miss
**Surface:** the B&H adapter's `parseSearchResults`, and `resolveItem`
**Automated:** `test/adapter-bh.spec.ts` — "an explicit no-results page is [] — answered, with nothing on it", "search-no-results-cf-08lb is a miss: every search answered, nothing carried"

**Do**

```bash
npx vitest run test/adapter-bh.spec.ts -t "explicit no-results page|search-no-results-cf-08lb"
```

**Expect**

Two pass. B&H's real no-results page parses to `[]`, and an item whose every
search was answered that way is `not-found` with no `failure`.

---

### Check: resolution-costco-no-results-is-a-miss

**Requirement:** A search the competitor answers with nothing is a miss
**Surface:** `resolveItem` with a product index
**Automated:** `test/product-index.spec.ts` — "an item whose brand the index does not carry is a clean miss"; `test/exit-criterion-costco-20-rows.spec.ts` — "0 failures: every miss is a lookup the index answered"

**Do**

```bash
npx vitest run test/product-index.spec.ts test/exit-criterion-costco-20-rows.spec.ts -t "does not carry is a clean miss|every miss is a lookup the index answered"
```

**Expect**

Two pass. An item whose brand the product list does not carry is `not-found`
with no `failure`, its lookup recorded as `index:<brand>`; and on the 20 real
rows every miss is such a lookup, with 0 failures.

---

### Check: resolution-bestbuy-no-barcode-goes-to-a-person

**Requirement:** A candidate without a barcode match goes to a person
**Surface:** `resolveItem` with the Best Buy adapter
**Automated:** `test/adapter-bestbuy.spec.ts` — "removing the UPC makes it unverifiable, never verified or a mismatch"

**Do**

```bash
npx vitest run test/adapter-bestbuy.spec.ts -t "removing the UPC makes it unverifiable"
```

**Expect**

The M310's real page with its UPC removed from all three places makes the item
`unverifiable` on SKU `1297054`, with no retailer barcode: in review, never
verified and never a mismatch.

---

### Check: resolution-bh-no-barcode-goes-to-a-person

**Requirement:** A candidate without a barcode match goes to a person
**Surface:** `resolveItem` with the B&H adapter over the 20-row corpus
**Automated:** `test/exit-criterion-bh-20-rows.spec.ts` — "the 3 discontinued listings go to a person, with the reason"

**Do**

```bash
npx vitest run test/exit-criterion-bh-20-rows.spec.ts -t "3 discontinued listings go to a person"
```

**Expect**

The three real rows whose B&H listing has the right MFR # and brand and
publishes no UPC (Sabrent `CRW-UINB`, Kensington `K72337US`, Logitech
`980-000402`) are each `unverifiable` with the discontinued reason, and none is
verified or not found.

---

### Check: resolution-costco-no-barcode-goes-to-a-person

**Requirement:** A candidate without a barcode match goes to a person
**Surface:** `resolveItem` with a product index
**Automated:** `test/index-candidate-goes-to-a-person.spec.ts`

**Do**

```bash
npx vitest run test/index-candidate-goes-to-a-person.spec.ts
```

**Expect**

Four pass. A Costco candidate matched by its name whose page publishes no UPC
goes to a person as `unverifiable`, never `not-found`. 🔴 A candidate whose page
states a UPC that disagrees is never `unconfirmed`: an index match carries no
model, so a disagreeing barcode means another product, not a lead. The CONTROL
verifies the same candidate once its UPC is on the page.

---

### Check: resolution-barcode-searched-first-where-answered

**Requirement:** A competitor that answers a barcode search is asked the barcode first
**Surface:** `planQueries`, `barcodeQuery`, and each adapter's `querySupport`
**Automated:** `test/barcode-first.spec.ts` — "true puts the barcode first, then the plan it always had", "pads the core to 12 digits", "pads to 13 when the core is longer than 12"; `test/adapter-bestbuy.spec.ts`, `test/adapter-bh.spec.ts` — "asks the barcode first, and …"

**Do**

```bash
npx vitest run test/barcode-first.spec.ts test/adapter-bestbuy.spec.ts test/adapter-bh.spec.ts -t "puts the barcode first|asks the barcode first, and|pads"
```

**Expect**

Five pass. With `barcodeIsSearchable` true the plan's first query is the
barcode, its core zero-padded to 12 digits, or to 13 when the core is longer,
followed by the plan it always had. Best Buy and B&H both state true, and no
digit cap refuses the barcode at either.

---

### Check: resolution-barcode-hit-buys-no-identity

**Requirement:** A competitor that answers a barcode search is asked the barcode first
**Surface:** `resolveItem`'s barcode stage
**Automated:** `test/barcode-first.spec.ts` — "a hit fetches no identity page"; `test/barcode-stage-allowance.spec.ts` — "CONTROL: a barcode hit still verifies in the barcode stage, before identity"

**Do**

```bash
npx vitest run test/barcode-first.spec.ts test/barcode-stage-allowance.spec.ts -t "a hit fetches no identity page|barcode hit still verifies"
```

**Expect**

Two pass. A barcode search whose result verifies settles the item with no
client-catalogue page and no search-engine lookup asked, and `identity` is
`null`.

---

### Check: resolution-barcode-lookalike-is-never-opened

**Requirement:** A competitor that answers a barcode search is asked the barcode first
**Surface:** `resolveItem`'s barcode stage
**Automated:** `test/barcode-stage-allowance.spec.ts` — "never opens a result the retailer marked as a look-alike of the barcode", "opens at most two of the barcode's results, and leaves the item its whole budget", "is two probes"

**Do**

```bash
npx vitest run test/barcode-stage-allowance.spec.ts -t "look-alike of the barcode|opens at most two|is two probes"
```

**Expect**

Three pass. A barcode result the competitor marks as only partly matching is
never opened, and the barcode stage opens at most two results from its own
allowance, leaving the item every probe of its own. Measured at B&H: a barcode
it matches nothing of comes back as 28 screen kits marked partial.

---

### Check: resolution-barcode-miss-carries-on

**Requirement:** A competitor that answers a barcode search is asked the barcode first
**Surface:** `resolveItem`, `planQueries`
**Automated:** `test/barcode-first.spec.ts` — "a miss carries its pool and probes into the normal path, buying nothing twice", "the barcode takes none of the plan's six slots (review finding 11)", "the barcode stage spends its own two probes, never the item's"

**Do**

```bash
npx vitest run test/barcode-first.spec.ts -t "carries its pool and probes|takes none of the plan's six slots|spends its own two probes"
```

**Expect**

Three pass. After a barcode search that verifies nothing, its candidates and
its answered or unanswered tally carry into the part-number path, the barcode
is not asked again, no page it already read is bought twice, and the part-number
plan keeps all six of its queries.

---

### Check: resolution-barcode-not-searched-where-unanswered

**Requirement:** The retailer is never named above the adapter seam
**Surface:** `planQueries`, `barcodeQuery`, `resolveItem`
**Automated:** `test/barcode-first.spec.ts` — "false never asks the barcode", "is null where the retailer cannot search a barcode", "CONTROL: with the switch off, the barcode is never asked and identity is bought"

**Do**

```bash
npx vitest run test/barcode-first.spec.ts -t "false never asks the barcode|cannot search a barcode|with the switch off"
```

**Expect**

Three pass. Where `barcodeIsSearchable` is false, as at Newegg, Amazon and
Costco, no plan contains a barcode form and resolution buys an identity first,
exactly as before. The 53-row Newegg replay staying row-for-row identical is
the end-to-end form of this (`resolution-replays-53-rows-offline`).

---

### Check: resolution-pages-at-once-per-competitor

**Requirement:** A competitor is never read more pages at once than its own limit, and never more than 4
**Surface:** `runList`, `pagesAtOnce`
**Automated:** `test/pages-at-once.spec.ts` — "holds 3 pages in flight for an adapter whose limit is 3", "holds 4 …", "is 3 for Newegg and Amazon, as before the registry carried it"

**Do**

```bash
npx vitest run test/pages-at-once.spec.ts -t "pages in flight for an adapter|is 3 for Newegg and Amazon"
```

**Expect**

Three pass. A gated fetcher over 12 items records the most pages ever in
flight at once, and it equals the competitor's limit exactly, at 3 and at 4:
not less, which a run that worked one item at a time would show, and not more.
Newegg and Amazon state 3, as they ran before.

---

### Check: resolution-pages-at-once-job-wins

**Requirement:** A competitor is never read more pages at once than its own limit, and never more than 4
**Surface:** `runDispatchedJob`, `parseJob`
**Automated:** `test/pages-at-once.spec.ts` — "the job's figure wins over the adapter's", "CONTROL: with no figure from the job, the adapter's applies", "is null when an older gateway sends none", "refuses a figure that is two builds disagreeing"

**Do**

```bash
npx vitest run test/pages-at-once.spec.ts -t "figure wins over the adapter's|with no figure from the job|older gateway sends none|two builds disagreeing"
```

**Expect**

Four pass. A dispatched run
whose job says 4 for an adapter stating 3 holds 4 in flight, and one whose job
says 3 for an adapter stating 4 holds 3. A job with no figure holds the
adapter's. A job carrying a figure that is not a whole number of at least 1 is refused,
since it means the gateway and this build disagree.

---

### Check: resolution-pages-at-once-never-above-four

**Requirement:** A competitor is never read more pages at once than its own limit, and never more than 4
**Surface:** `pagesAtOnce`, `MAX_PAGES_AT_ONCE`
**Automated:** `test/pages-at-once.spec.ts` — "a job asking for 12 runs at 4", "never exceeds the ceiling, whoever asks", "never falls below one"

**Do**

```bash
npx vitest run test/pages-at-once.spec.ts -t "asking for 12 runs at 4|never exceeds the ceiling|never falls below one"
```

**Expect**

Three pass. A dispatched job asking for 12 holds 4 in flight, and no figure
from the job or the adapter yields more than 4 or fewer than 1. 🔴 The ceiling
is Jody's politeness rule, which the lead kept for slow competitors too: a
mistyped registry row cannot turn a run into a burst.

---

### Check: resolution-product-page-shell-is-not-no-barcode

**Requirement:** A product page that is not one is not a listing without a barcode
**Surface:** `resolveItem`'s probe loop, each adapter's `parseProductPage`
**Automated:** `test/product-page-not-a-product.spec.ts` — "is not a listing that publishes no barcode", "is recorded as nothing learned, never as an absent barcode", "teaches the run's memory nothing", "still spends the probe it cost"; `test/adapter-bh.spec.ts` — "a replacement page is a probe nobody answered, not a listing without a barcode"

**Do**

```bash
npx vitest run test/product-page-not-a-product.spec.ts test/adapter-bh.spec.ts -t "is not a listing that publishes no barcode|nothing learned|teaches the run's memory nothing|still spends the probe|replacement page is a probe nobody answered"
```

**Expect**

Five pass. A probed page that parses to `null` never makes the item
`unverifiable`, is recorded as nothing learned, leaves the run's memory of
listings untouched, and still counts as the probe it cost. B&H's real
replacement page is such a page.

---

### Check: resolution-real-page-without-barcode-is-unverifiable

**Requirement:** A product page that is not one is not a listing without a barcode
**Surface:** `resolveItem`'s probe loop
**Automated:** `test/product-page-not-a-product.spec.ts` — "CONTROL: a real page publishing no barcode IS unverifiable"

**Do**

```bash
npx vitest run test/product-page-not-a-product.spec.ts -t "a real page publishing no barcode IS unverifiable"
```

**Expect**

`unverifiable`. 🔑 The control that keeps the rule above from swallowing a real
answer: treating every page without a barcode as unanswered would pass the
check above and lose every genuine `unverifiable`.

---

### Check: resolution-price-from-probed-page

**Requirement:** The price comes from the page that proved the pairing when the card shows none
**Surface:** `resolveItem`'s evidence
**Automated:** `test/evidence-from-the-page.spec.ts` — "takes the page's price and stock over the search result's", "an unverifiable listing's price comes from its page too"

**Do**

```bash
npx vitest run test/evidence-from-the-page.spec.ts -t "takes the page's price and stock|unverifiable listing's price comes from its page"
```

**Expect**

Two pass. The pairing's price and stock are the page's, where the search
result shows another price or none, and that holds for an `unverifiable`
pairing too.

---

### Check: resolution-price-falls-back-to-the-card

**Requirement:** The price comes from the page that proved the pairing when the card shows none
**Surface:** `resolveItem`'s evidence
**Automated:** `test/evidence-from-the-page.spec.ts` — "falls back to the search result where the page states neither", "CONTROL: a pairing proven from the run's memory, with no page read, keeps the search result's", "Newegg's page parse states no price and no stock on any committed product page", "Amazon's page parse states no price and no stock on its committed product page"

**Do**

```bash
npx vitest run test/evidence-from-the-page.spec.ts -t "falls back to the search result|run's memory, with no page read|page parse states no price and no stock"
```

**Expect**

Four pass. Where the page states no price or stock, the search result's are
kept. Newegg's and Amazon's page parses state neither on any committed product
page, so their pairings keep the search result's price exactly as before.

---

### Check: resolution-unknown-stock-is-unknown

**Requirement:** The price comes from the page that proved the pairing when the card shows none
**Surface:** `resolveItem`'s evidence, `GatewayClient.reportResolutions`
**Automated:** `test/evidence-from-the-page.spec.ts` — "is unknown, not guessed, where neither states the stock", "is sent as null, not dropped and not false"

**Do**

```bash
npx vitest run test/evidence-from-the-page.spec.ts -t "is unknown, not guessed|is sent as null"
```

**Expect**

Two pass. Where neither the page nor the card states the stock, `inStock` is
`null`, and the posted body carries `"inStock":null`, never `false` and never
omitted. The gateway stores it as `unknown`; that half is
`insights-observation-stock-unknown` in `aeo-backend`.

---

### Check: resolution-price-source-says-the-page

**Requirement:** Every price a finding reports says which page it came from
**Surface:** `resolveItem`'s evidence
**Automated:** `test/evidence-from-the-page.spec.ts` — "the product page, where the page that proved the pairing states the price", "the search results page, where only the card that found it does", "none, where there is no price to say it of", "the search results page for a pairing proven from the run's memory, whose page was not read"; `test/replays-unchanged.spec.ts`

**Do**

```bash
npx vitest run test/evidence-from-the-page.spec.ts -t "says which page it came from"
npx vitest run test/replays-unchanged.spec.ts
```

**Expect**

Four pass. `match.priceSource` is `product_page` where the page stated the
price, `search_results_page` where only the card did (and where the pairing was
proven from memory, with no page read), and `null` exactly where `priceCents`
is `null`. The four committed replays still reproduce every row: their records
differ from before only by this one field — 24 Newegg prices from the search
card, 11 Best Buy, 8 B&H and 1 Costco from the product page, 3 B&H matches with
none. Mutating either label turns a check red.

---

### Check: resolution-price-source-on-the-wire

**Requirement:** Every price a finding reports says which page it came from
**Surface:** `GatewayClient.reportResolutions`
**Automated:** `test/evidence-from-the-page.spec.ts` — "is sent inside the match, beside the price it describes"

**Do**

```bash
npx vitest run test/evidence-from-the-page.spec.ts -t "is sent inside the match"
```

**Expect**

One pass. The posted body carries `"priceCents":1299,"priceSource":"product_page"`
inside the finding's `match` (contract point 9: in the match evidence, none on
alternatives, none without a match).

---

### Check: resolution-client-part-number-asked-first

**Requirement:** The client's own part number and brand are searched before anything derived
**Surface:** `planQueries`, `establishIdentity`
**Automated:** `test/client-part-number-and-brand.spec.ts` — "Kensington K72337US: the client's part number is asked first"

**Do**

```bash
npx vitest run test/client-part-number-and-brand.spec.ts -t "Kensington K72337US"
```

**Expect**

Four pass. `K72337US` is queried right after the barcode, before any derived
form, with provenance `client`, outranking the barcode's derived `72337`. The
derived forms are still asked after it. 🔴 The CONTROL, without the client's
part number, guesses `KMW72337` exactly as the live run did.

---

### Check: resolution-client-brand-wins

**Requirement:** The client's own part number and brand are searched before anything derived
**Surface:** `establishIdentity`, `planQueries`
**Automated:** `test/client-part-number-and-brand.spec.ts` — "772269: the client's brand overrides a derived 'WIRELESS'", "B&H: the client's brand is the brand a part number needs"

**Do**

```bash
npx vitest run test/client-part-number-and-brand.spec.ts -t "WIRELESS|brand is the brand a part number needs"
```

**Expect**

Five pass. With the client's brand, the item's brand is the client's and no
query is scoped to `WIRELESS`, and a catalogue brand that disagrees does not
replace it. At B&H the client's brand finds the wrist rest and no cable is
probed. The CONTROLs, without the client's brand, derive `WIRELESS` and probe
cables.

---

### Check: resolution-costco-looked-up-by-client-brand

**Requirement:** The client's own part number and brand are searched before anything derived
**Surface:** `resolveItem` with a product index
**Automated:** `test/client-part-number-and-brand.spec.ts` — "Costco: the product index is looked up by the client's brand"

**Do**

```bash
npx vitest run test/client-part-number-and-brand.spec.ts -t "product index is looked up by the client's brand"
```

**Expect**

Two pass. With the client's brand and part number the product list is asked by
them and the AirPods verify. Without them the identity cannot be fetched and
no brand reaches the list.

---

### Check: resolution-client-fields-absent-run-as-before

**Requirement:** The client's own part number and brand are searched before anything derived
**Surface:** `parseJob`
**Automated:** `test/client-part-number-and-brand.spec.ts` — "reads them ABSENT or null as not supplied, so an older gateway still runs", "reads both from the gateway's job, trimmed of nothing and typed", "hands both to the run: the queue's mapping is where productName was once lost"

**Do**

```bash
npx vitest run test/client-part-number-and-brand.spec.ts -t "ABSENT or null as not supplied|reads both from the gateway's job|hands both to the run"
```

**Expect**

Three pass. A job item with neither field, or with either `null`, reads as not
supplied and runs as before. A job carrying both hands both to the run, which
is where `productName` was once lost.

---

### Check: resolution-client-fields-refused-when-malformed

**Requirement:** The client's own part number and brand are searched before anything derived
**Surface:** `parseJob`, `readJobEnvelope`
**Automated:** `test/client-part-number-and-brand.spec.ts` — "refuses one that is not a string: two builds disagreeing", "refuses one past the gateway's own limit: 128 for a part number, 160 for a brand", "reads both from a job file, and refuses a wrong type there too"

**Do**

```bash
npx vitest run test/client-part-number-and-brand.spec.ts -t "not a string|past the gateway's own limit|wrong type there too"
```

**Expect**

Three pass. A part number or brand that is not a string, or longer than the
gateway's own limits of 128 and 160 characters, refuses the job before anything
is bought, from the gateway and from a job file alike.

---

### Check: resolution-unread-product-page-is-a-failure

**Requirement:** A product page that could not be read is a failure, never "not carried", and the best candidate is never proposed unread
**Surface:** `resolveItem`
**Automated:** `test/unanswered-probes.spec.ts` — "a searched retailer: a miss with an unread product page is a failure", "Newegg's real adapter, every product page failing", "the 53-row Newegg replay"

**Do**

```bash
npx vitest run test/unanswered-probes.spec.ts -t "a searched retailer|Newegg's real adapter|53-row Newegg replay"
```

**Expect**

Seven pass. An item whose answered searches leave a candidate page unread,
because it failed to fetch or was not a product page, is `not-found` with a
`failure` counting the unread pages, never a clean miss; every product page
read, a weak miss stays clean. On Newegg's real adapter no row that probed
anything ends a clean miss when every page fails. 🔴 Replayed, every one of the
53 rows whose probes all answered has exactly the outcome, failure and listing
it had before the rule.

---

### Check: resolution-costco-unread-pages-are-a-failure

**Requirement:** A product page that could not be read is a failure, never "not carried", and the best candidate is never proposed unread
**Surface:** `resolveItem` with the Costco adapter
**Automated:** `test/unanswered-probes.spec.ts` — "Costco: the AirPods row with no product page read"

**Do**

```bash
npx vitest run test/unanswered-probes.spec.ts -t "Costco: the AirPods row"
```

**Expect**

Three pass. The AirPods row with every product page failing to fetch, or every
one coming back as Costco's empty product shell, is a failure, never a clean
miss. The CONTROL, with its pages read, verifies with no failure.

---

### Check: resolution-unread-best-never-proposed

**Requirement:** A product page that could not be read is a failure, never "not carried", and the best candidate is never proposed unread
**Surface:** `resolveItem`'s choice of finding
**Automated:** `test/unread-best-candidate.spec.ts` — "is a failure — never proposed — when no read listing clears the floor", "is a failure for a page that parsed to nothing, as for one that failed", "CONTROL: on the last attempt the same sibling, UNREAD, is not proposed", "CONTROL: its barcode disagrees → unconfirmed on it, as before"

**Do**

```bash
npx vitest run test/unread-best-candidate.spec.ts -t "never proposed|parsed to nothing|UNREAD, is not proposed|its barcode disagrees"
```

**Expect**

Four pass. A best candidate whose page was never read is never the proposed
match: the item is a failure, whether the page failed or parsed to nothing, and
an unread sibling is not proposed either. The CONTROL, with the best's page
read and its barcode disagreeing, is `unconfirmed` on it as before.

---

### Check: resolution-unread-best-retried-first

**Requirement:** A product page that could not be read is a failure, never "not carried", and the best candidate is never proposed unread
**Surface:** `resolveItem`, `runList`'s retry after the run
**Automated:** `test/unread-best-candidate.spec.ts` — "on a first attempt is a failure, even with a read lower listing that qualifies", "the unread best goes to the after-run retry, and the retry can verify it", "the live Kensington shape: unread at the barcode stage, read on the second try"

**Do**

```bash
npx vitest run test/unread-best-candidate.spec.ts -t "on a first attempt is a failure|goes to the after-run retry|live Kensington shape"
```

**Expect**

Three pass. On the first pass an unread best is a failure even when a lower
listing was read and qualifies, so the item goes to the retry after the run,
where the best can be read and verify. That is the live Kensington row's shape.

---

### Check: resolution-unread-best-sibling-on-retry

**Requirement:** A product page that could not be read is a failure, never "not carried", and the best candidate is never proposed unread
**Surface:** `resolveItem` on its last attempt
**Automated:** `test/unread-best-candidate.spec.ts` — "on the last attempt, a lower listing read and naming the part number is proposed", "the best never answering: the retry proposes the read sibling", "the best answering in the retry: the retry settles on it"

**Do**

```bash
npx vitest run test/unread-best-candidate.spec.ts -t "lower listing read and naming the part number|proposes the read sibling|best answering in the retry"
```

**Expect**

Three pass. Only on the last attempt is a lower listing that was read and names
the part number proposed in the unread best's place; where the best answers
in the retry, the retry settles on it instead.

---

### Check: resolution-counts-every-attempt

**Requirement:** Every request the vendor was asked for is counted
**Surface:** `LiveFetcher`
**Automated:** `test/counts-every-request.spec.ts` — "a fetch that fails 3 times counts 3", "a short 200 counts 1", "a dropped connection counts, because the request was sent", "a page that arrives on its second attempt is 2 sent and 1 delivered", "a screenshot counts every attempt too"

**Do**

```bash
npx vitest run test/counts-every-request.spec.ts -t "fails 3 times counts 3|a short 200 counts 1|dropped connection counts|2 sent and 1 delivered|screenshot counts every attempt"
```

**Expect**

Five pass. `liveRequestCount` is 3 for a fetch that fails three times, 1 for a
200 too short to be a page, and counts a dropped connection. A page arriving on
its second attempt is 2 sent and 1 delivered, and a screenshot counts each of
its attempts the same way.

---

### Check: resolution-disk-cache-counts-nothing

**Requirement:** Every request the vendor was asked for is counted
**Surface:** `LiveFetcher`
**Automated:** `test/counts-every-request.spec.ts` — "CONTROL: a page served from the disk cache counts nothing"

**Do**

```bash
npx vitest run test/counts-every-request.spec.ts -t "served from the disk cache counts nothing"
```

**Expect**

`liveRequestCount` and `pagesDelivered` are both 0 for a page served from the
disk cache. 🔑 The control: counting every call instead of every attempt sent
would pass the check above and charge a resumed run for pages it never bought.

---

### Check: resolution-bestbuy-seller-class-recorded

**Requirement:** A Best Buy marketplace listing is recorded as one, with its seller
**Surface:** the Best Buy adapter's `parseSearchResults` and `parseProductPage`, and `resolveItem`
**Automated:** `test/adapter-bestbuy.spec.ts` — "3P is a marketplace match with the seller's name, its price and its stock from the page", "1P is first party, sold by Best Buy", "3P is a marketplace listing, and the card does not name its seller", "names a marketplace listing's seller from the page"

**Do**

```bash
npx vitest run test/adapter-bestbuy.spec.ts -t "3P is a marketplace|1P is first party|names a marketplace listing's seller"
```

**Expect**

Four pass. A `3P` listing is verified as a marketplace match, `isFirstParty`
`false`, seller `IPC-STORE`, at `12310` cents and out of stock, all from its
page, because the card names no marketplace seller. A `1P` card is first party,
sold by Best Buy.

---

### Check: resolution-bestbuy-page-decides-the-seller-class

**Requirement:** A Best Buy marketplace listing is recorded as one, with its seller
**Surface:** `resolveItem`'s evidence
**Automated:** `test/first-party-from-the-page.spec.ts` — "an unhydrated card whose page says 1P is first party, sold by Best Buy", "an unhydrated card whose page says 3P is a marketplace listing, with its seller", "Best Buy reads its page's seller classification"

**Do**

```bash
npx vitest run test/first-party-from-the-page.spec.ts -t "unhydrated card|Best Buy reads its page's seller classification"
```

**Expect**

Three pass. Best Buy hydrates only its first few search cards, so a card with
a SKU and no seller is unknown; its page's classification decides, `1P` first
party sold by Best Buy and `3P` a marketplace listing with the seller's name.
🔴 Kept unknown, the gateway would store a first-party listing as a marketplace
one and weaken a barcode agreement that is in fact authoritative.

---

### Check: resolution-bestbuy-first-party-probed-first

**Requirement:** A Best Buy marketplace listing is recorded as one, with its seller
**Surface:** `probeOrder` with Best Buy candidates
**Automated:** `test/adapter-bestbuy.spec.ts` — "at equal score the 1P listing is probed first"

**Do**

```bash
npx vitest run test/adapter-bestbuy.spec.ts -t "1P listing is probed first"
```

**Expect**

The probe order is `1297054` (first party) before `11521676` (marketplace).

---

### Check: resolution-bestbuy-lookalike-page-is-not-a-match

**Requirement:** A Best Buy page of look-alikes is not a match
**Surface:** the Best Buy adapter's `parseSearchResults`, and `resolveItem`
**Automated:** `test/adapter-bestbuy.spec.ts` — "the 18 air-filter look-alike page is not a match: dvsOnly answers []", "CONTROL: the same look-alike page read as a hybrid page would offer the filters", "the air-filter look-alike page is not-found, never unconfirmed", "drops what Best Buy marks isTermMatch false, keeps the exact part number first"

**Do**

```bash
npx vitest run test/adapter-bestbuy.spec.ts -t "air-filter look-alike|same look-alike page|isTermMatch false"
```

**Expect**

Four pass. Best Buy's real page answering a part number with 18 air filters it
marks as look-alikes parses to `[]`, and the item is `not-found` with no match
and no failure, never `unconfirmed`. The CONTROL reads the same page as a
hybrid page would and offers the filters, so the pass is the look-alike rule's.

---

### Check: resolution-bh-discontinued-goes-to-review

**Requirement:** A discontinued B&H listing goes to a person, with its reason
**Surface:** the B&H adapter's `parseProductPage`, and `resolveItem`
**Automated:** `test/adapter-bh.spec.ts` — "the discontinued Z623 is unverifiable, for a person, with its reason", "says why a discontinued listing publishes no barcode", "a discontinued item has no current price and, here, no UPC"

**Do**

```bash
npx vitest run test/adapter-bh.spec.ts -t "discontinued Z623|says why a discontinued listing|discontinued item has no current price"
```

**Expect**

Three pass. The real discontinued Z623 page parses with no barcode, no price,
and the reason "discontinued at B&H, no UPC published". Resolved, the item is
`unverifiable` on `736288` with model `980-000402` and brand Logitech, with no
`failure`, so it is never filed as not carried. One probe is spent: the Z313,
Z625 and Z533 share Logitech's `980-00` prefix and are not opened.

---

### Check: resolution-bh-discontinued-after-a-lookalike-barcode-answer

**Requirement:** A discontinued B&H listing goes to a person, with its reason
**Surface:** `resolveItem`'s barcode stage and part-number path
**Automated:** `test/barcode-stage-allowance.spec.ts` — "B&H: a barcode answered with look-alikes, then the MFR # finding a discontinued item"

**Do**

```bash
npx vitest run test/barcode-stage-allowance.spec.ts -t "barcode answered with look-alikes"
```

**Expect**

Two pass. A barcode B&H answers only with look-alikes, followed by an MFR #
search that finds the discontinued item, still ends `unverifiable` with the
discontinued reason; the look-alikes never take its place.

---

### Check: resolution-bh-component-upc-never-matches

**Requirement:** A B&H kit's component barcodes are never the kit's
**Surface:** the B&H adapter's `parseProductPage`, and `resolveItem`
**Automated:** `test/adapter-bh.spec.ts` — "a kit's components' UPCs are never the kit's", "a UPC equal only to a kit component's is never verified (SYNTHETIC search)"

**Do**

```bash
npx vitest run test/adapter-bh.spec.ts -t "components' UPCs are never the kit's|equal only to a kit component's"
```

**Expect**

Two pass. A real kit page's component UPCs are never among its published
barcodes, and an item whose barcode equals only a component's is never
verified on the kit.

---

### Check: resolution-bh-another-brands-part-number-is-not-a-candidate

**Requirement:** At B&H a part number names a product only with its brand
**Surface:** `resolveItem` with `partNumberNeedsBrand`
**Automated:** `test/adapter-bh.spec.ts` — "another brand's item under the same bare part number is not a candidate"; `test/part-number-needs-brand.spec.ts` — "never probes or proposes another brand's item with the same part number", "CONTROL: with the switch off, the same cable is probed and proposed", "still finds the item's own listing among other brands'"

**Do**

```bash
npx vitest run test/adapter-bh.spec.ts test/part-number-needs-brand.spec.ts -t "under the same bare part number|another brand's item with the same part number|the same cable is probed|own listing among other brands'"
```

**Expect**

Four pass. Where the item's brand is known, a listing with the item's part
number under another brand is never probed or proposed, and the item's own
listing among them is still found. The CONTROL, with the rule switched off,
probes and proposes the same cable. Measured at B&H: four of the
investigation's not-carried rows had their MFR # on another brand's item there.

---

### Check: resolution-bh-unknown-brand-goes-to-a-person

**Requirement:** At B&H a part number names a product only with its brand
**Surface:** `resolveItem` with `partNumberNeedsBrand`
**Automated:** `test/part-number-needs-brand.spec.ts` — "another brand's listing under the same part number goes to a person — never verified"

**Do**

```bash
npx vitest run test/part-number-needs-brand.spec.ts -t "goes to a person"
```

**Expect**

Where the item's brand is unknown, another brand's listing under the same part
number is not refused, since nothing refutes it, but it goes to a person and is
never verified.

---

### Check: resolution-costco-index-read-once-per-run

**Requirement:** Costco's product list is read once per run, not once per item
**Surface:** `IndexCache`, `runList`
**Automated:** `test/product-index.spec.ts` — "20 items at 4 workers make exactly 1 fetch of each of its files", "reads the list first, with its own minimum size, and the competitor's profile"; `test/exit-criterion-costco-20-rows.spec.ts` — "reads the product index once, and gives every row its outcome"

**Do**

```bash
npx vitest run test/product-index.spec.ts test/exit-criterion-costco-20-rows.spec.ts -t "exactly 1 fetch of each of its files|reads the list first|reads the product index once"
```

**Expect**

Three pass. 20 items at 4 workers fetch the list and each of its two product
files exactly once, and every item verifies. The list is fetched first, with
its own minimum body size and the competitor's fetch profile. Over the real
Costco corpus, one run of 21 rows reads the index once.

---

### Check: resolution-costco-index-charged-once

**Requirement:** Costco's product list is read once per run, not once per item
**Surface:** `IndexCache`, `RequestMeter`
**Automated:** `test/product-index.spec.ts` — "charges the read to one item only, so the run's spend is counted once"

**Do**

```bash
npx vitest run test/product-index.spec.ts -t "charges the read to one item only"
```

**Expect**

The index's requests are charged to one item, and the per-item figures sum to
the fetcher's total, so a run's spend counts the list once.

---

### Check: resolution-costco-index-reread-on-retry

**Requirement:** Costco's product list is read once per run, not once per item
**Surface:** `IndexCache`, `runList`'s retry after the run
**Automated:** `test/product-index.spec.ts` — "a failure is dropped before the second pass, which refetches once and resolves", "a cache keeps a failure until told to forget it", "a failed index read buys nothing else: no identity page, on either pass"

**Do**

```bash
npx vitest run test/product-index.spec.ts -t "dropped before the second pass|keeps a failure until told|buys nothing else"
```

**Expect**

Three pass. A list read that failed is dropped before the retry after the run,
which fetches it once more and resolves; within one pass the failure is kept,
so it is not fetched again per item. A failed index read buys nothing else for
the item on either pass.

---

### Check: resolution-costco-never-searched

**Requirement:** A Costco product is found in its product list, never by search
**Surface:** the Costco adapter's configuration, `resolveItem` with a product index
**Automated:** `test/adapter-costco.spec.ts` — "never searches: a product index, and neither barcode nor part number searchable", "never reaches Costco's internal catalogue API, only its website"; `test/exit-criterion-costco-20-rows.spec.ts` — "never searches Costco"; `test/product-index.spec.ts` — "records the lookup as `index:<brand>` and never searches"

**Do**

```bash
npx vitest run test/adapter-costco.spec.ts test/exit-criterion-costco-20-rows.spec.ts test/product-index.spec.ts -t "never searches|catalogue API|records the lookup as"
```

**Expect**

Four pass. Costco states a product index and neither barcode nor part number searchable;
over the real corpus no search url is ever asked; each lookup is recorded as
`index:<brand>`; and the adapter never names Costco's internal catalogue
service, only its website.

---

### Check: resolution-costco-finds-by-product-line

**Requirement:** A Costco product is found in its product list, never by search
**Surface:** the Costco adapter's `productIndex.candidates`
**Automated:** `test/adapter-costco.spec.ts` — "finds AirPods, whose name has no 'apple', first — and sets no brand on it", "leads with the brand, and shares a word of what the product is", "puts a name that spells the part number first"; `test/exit-criterion-costco-20-rows.spec.ts` — "the AirPods row is never found, so the product-line rule is what finds it"

**Do**

```bash
npx vitest run test/adapter-costco.spec.ts test/exit-criterion-costco-20-rows.spec.ts -t "finds AirPods|leads with the brand, and shares|spells the part number first|product-line rule is what finds it"
```

**Expect**

Four pass. The AirPods, whose name in the list has no "apple", are found first
by the product-line word of the client's name, with no brand invented for them.
A name leading with the brand and sharing a word of what the product is, and a
name spelling the part number, are candidates, the latter first. The CONTROL
shows the AirPods are never found by brand alone.

---

### Check: resolution-costco-finds-popular-product-lines

**Requirement:** A product Costco names by its line, not its brand, is found
**Surface:** the Costco adapter's `productIndex.candidates`
**Automated:** `test/adapter-costco.spec.ts` — "demo row $sku: its proven page is within the first three candidates", "every proven row ranks FIRST: the size the client states puts the exact product ahead", "lists each url once", "'true' is not a product line", "'memory' is not a product line"

**Do**

```bash
npx vitest run test/adapter-costco.spec.ts -t "a product Costco names by its line"
```

**Expect**

All pass, on the 18,180-entry sitemap fixture. Each of the ten Micro Center rows
the investigation proved at Costco, and that the fixture holds, has its proven
page first among its candidates: the six iPads, two MacBook Airs, AirPods Max 2
and Galaxy Buds4 Pro. Before the change, eight of the ten were not candidates
at all. Each url is listed once. Neither "true" nor "memory" admits names that
merely lead with it.

---

### Check: resolution-costco-prices-the-matched-item

**Requirement:** A Costco pairing carries the price of the item that matched
**Surface:** the Costco adapter's `parseProductPage` (`barcodePrices`), `resolve`'s evidence
**Automated:** `test/costco-prices-the-matched-item.spec.ts` — "the client's Space Gray iPad agrees with the item the page prices: verified at $649.99, from the product page", "matches the per-barcode price whatever encoding the client wrote"; `test/adapter-costco.spec.ts` — "the iPad Air page: four colours, priceInfo pricing item 2042802 at $649.99", "prices the barcode of the item priceInfo prices, and no sibling's"

**Do**

```bash
npx vitest run test/costco-prices-the-matched-item.spec.ts test/adapter-costco.spec.ts -t "Space Gray iPad|whatever encoding|four colours|no sibling's"
```

**Expect**

Four pass, on a real Costco iPad Air page that lists four colours and prices
only Space Gray (item 2042802, $649.99). A client row whose barcode is Space
Gray's, in any encoding, is verified at 64999 with the price read from the
product page.

---

### Check: resolution-costco-never-a-siblings-price

**Requirement:** A Costco pairing carries the price of the item that matched
**Surface:** the Costco adapter's `parseProductPage` (`barcodePrices`), `resolve`'s evidence
**Automated:** `test/costco-prices-the-matched-item.spec.ts` — "the client's Starlight iPad agrees with a sibling the page does not price: verified, with no price", "the MacBook Neo: the matched item is unpriced, and its priced sibling's $689.99 is never used", "where a page prices per barcode, an unpriced barcode never takes the page's one price"; `test/adapter-costco.spec.ts` — "a barcode two items carry is unpriced unless both show one price", "a JSON-LD price is never credited to priceInfo's item when the JSON-LD names another sku", "member-only or in-cart-only, no barcode is priced"

**Do**

```bash
npx vitest run test/costco-prices-the-matched-item.spec.ts test/adapter-costco.spec.ts -t "Starlight|MacBook Neo|never takes the page's one price|two items carry|never credited|member-only or in-cart-only"
```

**Expect**

All pass. A row matching an unpriced colour (Starlight), and the MacBook Neo
whose page prices only a sibling ($689.99), are verified with no price. A
barcode two items carry, a JSON-LD price naming another item, and member-only
or in-cart-only pages price nothing.

---

### Check: resolution-costco-other-products-are-not-candidates

**Requirement:** A Costco product is found in its product list, never by search
**Surface:** the Costco adapter's `productIndex.candidates`
**Automated:** `test/adapter-costco.spec.ts` — "a brand's product of another kind is not a candidate", "another brand's product sharing words is not a candidate", "with neither a brand nor a name, finds nothing"

**Do**

```bash
npx vitest run test/adapter-costco.spec.ts -t "of another kind is not a candidate|another brand's product sharing words|finds nothing"
```

**Expect**

Three pass. The brand's product of another kind, and another brand's product
sharing words with the item, are not candidates, and an item with neither a
brand nor a name finds nothing.

---

### Check: resolution-costco-own-numbers-never-verify

**Requirement:** Costco's own item numbers never prove a pairing
**Surface:** the Costco adapter's `parseProductPage`
**Automated:** `test/adapter-costco.spec.ts` — "a Costco-internal parent UPC is never published as a barcode", "are `4` and one of the page's item numbers, or a 49999… value", "on a page stating no item numbers, a 4000001… or 4000002… value is Costco's own (review finding 13)", "a parent-only page's 4000001… UPC is never published as its barcode"

**Do**

```bash
npx vitest run test/adapter-costco.spec.ts -t "Costco-internal parent UPC|one of the page's item numbers|is Costco's own|parent-only page"
```

**Expect**

Four pass. Costco's internal values, `4` followed by one of the page's item
numbers, or a `49999…` value, or a `4000001…` / `4000002…` value on a page
stating no item numbers, are never published as a barcode, so they can never
verify anything.

---

### Check: resolution-costco-real-barcode-still-read

**Requirement:** Costco's own item numbers never prove a pairing
**Surface:** the Costco adapter's `parseProductPage`
**Automated:** `test/adapter-costco.spec.ts` — "never swallow a real barcode", "CONTROL: a real 400… EAN-13 is still a barcode, item numbers or none"

**Do**

```bash
npx vitest run test/adapter-costco.spec.ts -t "never swallow a real barcode|EAN-13 is still a barcode"
```

**Expect**

Two pass. A genuine EAN-13 beginning `400`, and every real barcode on the
committed pages, is still published. 🔑 The control: refusing every value
beginning `4` would pass the check above and lose real European barcodes.
