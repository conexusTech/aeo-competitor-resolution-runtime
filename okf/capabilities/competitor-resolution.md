---
type: Capability
title: A client's item is resolved to a competitor's listing, and the pairing is proven
description: What the runtime does with one item on a client's watchlist — how it decides what the item is, what it asks the retailer, what it will and will not call a match, and what it costs.
---

# A client's item is resolved to a competitor's listing, and the pairing is proven

Given a barcode and a client SKU, the runtime works out what the product is,
asks the retailer for it by name, and then **proves** the pairing by comparing
the retailer's own published barcode. An unproven candidate is reported as
unproven, and a listing the retailer publishes no barcode for is reported as a
third thing again — not as a probable match.

**Seeded 2026-09-10** by `competitor-resolution-runtime`. Every scenario below
was executed. The 53-row measured run is replayed **offline against a committed
corpus of 534 real responses**, so the outcome-split scenario costs nothing and
is deterministic.

⚠️ **Nothing here resolves a price over time.** A run produces the listing and
its price at that instant; two observations of the same item, and the question
of what changed between them, are `insights-price-observations`. Nothing here
writes to a database either — findings return through `aeo-backend`.

Module map and the traps: [service.md](/service.md).

## Scenarios

#### Scenario: The measured 53-row run is reproduced without spending anything

- GIVEN the 53 barcodes the handover spike measured, and its recorded outcome for each
- WHEN the pipeline resolves them against a committed corpus of real responses
- THEN no request is made and no money is spent
- AND every row the corpus can serve reaches the same outcome the spike recorded
- AND no barcode the spike proved is left unproven
- AND a row the corpus cannot serve is reported as un-replayable rather than counted as a miss

**Checked by:** resolution-replays-53-rows-offline, resolution-loses-no-verification, resolution-corpus-gap-is-not-a-miss

#### Scenario: A pairing is proven by barcode, whatever width the retailer publishes

- GIVEN a retailer that publishes the same barcode at 12, 13 or 14 digits
- WHEN a candidate's published barcode is compared with the client's
- THEN the two agree whenever they name the same product
- AND a value carrying no digits never compares equal to anything
- AND the retailer's value is stored exactly as published, never normalised

**Checked by:** resolution-barcode-widths-agree, resolution-non-barcode-never-matches, resolution-retailer-barcode-verbatim

#### Scenario: A listing the retailer publishes no barcode for is unverifiable, not probable

- GIVEN a candidate with part-number-level evidence whose page publishes no barcode
- WHEN the item is resolved
- THEN the outcome is `unverifiable` and the evidence carries no retailer barcode
- AND it is distinct from `unconfirmed`, which is a barcode that disagreed
- AND `unverifiable` is preferred when both are available among the probed candidates

**Checked by:** resolution-empty-barcode-is-unverifiable, resolution-disagreeing-barcode-is-unconfirmed, resolution-unverifiable-beats-unconfirmed

#### Scenario: A candidate with no part-number evidence is reported as nothing

- GIVEN the best candidate matches only on brand, stock and who sells it
- WHEN the item is resolved
- THEN the outcome is `not-found` and no listing is offered
- AND that holds even when the score alone reaches the reporting floor

**Checked by:** resolution-no-evidence-is-not-found, resolution-floor-alone-is-insufficient

#### Scenario: An item nobody searched for is not reported as assortment information

- GIVEN an item for which no searchable identity can be derived, at a retailer that does not accept a barcode search
- WHEN the item is resolved
- THEN the resolution carries a `failure` saying no search was attempted
- AND the gateway therefore records the item as `error` rather than `not_carried`

**Checked by:** resolution-never-searched-is-a-failure

#### Scenario: A source that could not be fetched is distinguished from an item with nothing to search for

- GIVEN identity cannot be established because the source could not be fetched at all
- WHEN the item is resolved
- THEN the `failure` says the source could not be fetched
- AND it does not read as an item whose list entry needs fixing

**Checked by:** resolution-unfetchable-identity-says-so

#### Scenario: An item that WAS searched and not found is still a clean miss

- GIVEN an item with a derivable identity, searched at the retailer, with nothing matching
- WHEN the item is resolved
- THEN the outcome is `not-found` with no `failure`
- AND the gateway records `not_carried`, which is real assortment information

**Checked by:** resolution-a-searched-miss-stays-a-miss

## An item nobody looked up is not a fact about the retailer

🔴 **This was wrong until 2026-09-11, and the repo already stated the rule it
broke.** When `establishIdentity` yields no brand, no part number and no phrase,
`planQueries` returns `[]` and the pipeline returned a clean `not-found` with
`failure: null`. The gateway maps that to item state `not_carried`, which its
own constants define as *"the competitor **genuinely** does not stock the item,
which is real assortment information"*.

A live queue run filed **3 of 10 items** that way, each noted *"0 candidate(s)
across 0 query attempt(s)"*. The run's own words admitted nobody looked while
the state it filed said the retailer does not carry the item.

🔑 **`runList` already refused exactly this on the throwing route**, with a
comment saying so in as many words: *"never as a clean miss, which would report
'this retailer does not carry it' for an item nobody managed to look up."* The
defect was that rule holding on one of two routes.

⚠️ **`tryFetch` swallowed `FetchFailed` into the same `null` as a page that
parsed to nothing**, so a proxy outage during identity was indistinguishable
from an item with nothing derivable — and reached the customer as assortment
information. It now reports which of the two nothings it got, because one is
ours to retry and one needs somebody to add a part number to the list.

⚠️ **This changes what the customer is TOLD, not what gets bought.** The gateway
re-attempts an item on `state <> 'approved'`, so `error` and `not_carried` are
retried identically.

#### Scenario: What the item is comes from the most authoritative source available

- GIVEN a client whose own catalogue publishes a part number, and a barcode it can also be derived from
- WHEN identity is established
- THEN the client's published part number wins over the derived one
- AND the derived one is recorded as corroboration when the two agree
- AND every identity says which source produced it
- AND a catalogue page for a different product is refused rather than read

**Checked by:** resolution-authority-beats-free, resolution-agreement-is-corroboration, resolution-identity-carries-provenance, resolution-wrong-product-page-refused

#### Scenario: The retailer is never named above the adapter seam

- GIVEN a retailer whose search refuses queries of ten or more digits
- WHEN queries are planned
- THEN the refusal is read from configuration, not from a branch on the retailer's name
- AND a short numeric part number is still asked for
- AND no barcode form is ever asked for

**Checked by:** resolution-query-limits-are-configuration, resolution-short-numeric-still-asked, resolution-retailer-is-data-not-a-type

#### Scenario: A first-party listing is probed before a marketplace one

- GIVEN two candidates with equal evidence, one sold by the retailer and one by a third party
- WHEN probe order is decided
- THEN the retailer's own listing is probed first
- AND a listing with a named third-party seller is never treated as first-party, whatever its item id looks like

**Checked by:** resolution-first-party-probed-first, resolution-seller-decides-first-party

#### Scenario: A run survives being killed and re-buys nothing

- GIVEN a run interrupted part-way, with a journal on disk
- WHEN it is started again over the same list
- THEN the completed items are not fetched again and nothing is spent on them
- AND a journal whose last line was truncated mid-write is still usable
- AND an item the pipeline could not complete is recorded as a failure, never as a clean miss

**Checked by:** resolution-run-resumes-without-spending, resolution-truncated-journal-survives, resolution-failure-is-not-a-miss

#### Scenario: What a run will cost is stated before it starts, and never as a price

- GIVEN a list where some items have a part number and some do not
- WHEN the run is estimated
- THEN the two paths are priced at their separately measured request rates
- AND an empty list estimates zero rather than dividing by zero
- AND the money figure is labelled an estimate wherever it is reported

**Checked by:** resolution-estimate-branches-per-item, resolution-estimate-zero-for-empty, resolution-money-rate-is-unvalidated

#### Scenario: The parsers work against the retailer's real markup

- GIVEN pages captured from the live retailer
- WHEN they are parsed
- THEN candidates, prices, sellers and barcodes are read from real markup rather than from a hand-written fixture
- AND a results page carrying no results returns nothing rather than failing
- AND a genuine EAN-13 published by the retailer is read as such

**Checked by:** resolution-parses-real-pages, resolution-empty-results-page-is-not-an-error, resolution-reads-genuine-ean13

## A silent throttle is waited out rather than given up on

🔴 **21% of a live 73-row run failed to establish an identity, so those rows were
never searched at all.** Reproduced on the host under the run's own shape, three
at a time: **33%, 6 of 18.**

🔑 **The signature is an HTTP 200 with a ZERO-BYTE body.** Not a 4xx, not a
timeout, not a block page — nothing at all. The 2,000-byte floor correctly
refuses it, and the old schedule then retried at 1 s and 2 s and gave up at 3.

🔑 **It is a throttle, not a dead url**, and that was measured: a barcode whose
lookup returned 0 bytes twice in a row returned **338,079 bytes after a
15-second wait**, and a second recovered on an immediate retry.

⚠️ **This was the largest single cause of a quality gap.** That run reached 28
verified against the handover spike's 35 on identical rows, and 15 of the 33
disagreements were items nobody looked up.

#### Scenario: An empty answer is waited out, not retried into
- GIVEN the vendor answers a fetch with a body too short to be a page
- WHEN the fetcher retries
- THEN it waits 5 seconds, then 10 — fifteen in total, which is what recovered the measured case

**Checked by:** resolution-throttle-backs-off-longer

#### Scenario: An ordinary failure keeps its short backoff
- GIVEN the vendor answers with a 5xx
- WHEN the fetcher retries
- THEN it waits one second, then two, as before

**Checked by:** resolution-ordinary-failure-keeps-short-backoff

#### Scenario: A throttle that yields is charged once
- GIVEN a fetch throttled once and answered on the next attempt
- WHEN it succeeds
- THEN one request is counted and no throttle is recorded

**Checked by:** resolution-recovered-throttle-costs-one-request

#### Scenario: A run says how many of its failures were throttles
- GIVEN a run whose failures were the vendor answering with nothing
- WHEN it reports
- THEN throttles are counted apart from other failures

**Checked by:** resolution-throttles-counted-apart

⚠️ **The trade is run time, and it is real.** A row throttled on every attempt now
costs 15 seconds of waiting instead of 3. On a list where a fifth of lookups are
throttled that is minutes, which is why the delay is a named constant rather
than a number in a loop.

⚠️ **Distinguishing the two failures is the load-bearing part**, not the bigger
number. A fix that simply made every retry slow would pass the first check and
make every transient error cost fifteen seconds — which the second check refuses.
