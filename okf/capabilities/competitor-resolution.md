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

#### Scenario: A search the retailer never answered is a failure, not a miss

- GIVEN an item with an identity, whose searches turn up nothing that can be reported
- WHEN any search it attempted could not be fetched or came back as something other than a results page
- THEN the outcome carries a failure counting the searches of each kind
- AND the gateway records `error`, never `not_carried`
- AND an item is a clean miss only when every search it attempted was answered by a real results page
- AND a page cut short, or one whose result cells cannot be read, is not a results page
- AND every resolution carries both counts, and the run totals them in its summary

**Checked by:** resolution-unfetched-searches-are-a-failure, resolution-non-results-pages-are-a-failure, resolution-throttled-specific-search-is-a-failure, resolution-adapters-refuse-a-non-results-page, resolution-amazon-refuses-a-truncated-or-unreadable-page, resolution-real-no-results-page-is-a-miss, resolution-every-search-answered-is-a-clean-miss, resolution-unanswered-searches-are-counted, resolution-unanswered-item-retried-after-the-run

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

🔴 **The same rule was broken one step later, and production showed it on
2026-10-22.** An expired proxy credential made a run over a 227-item list fetch
nothing. Identity was settled, the search plan was non-empty, and every search
fetch failed — but the search step dropped each failure without a trace, the
empty pool returned a clean `not-found`, and the gateway filed every item
`not_carried`. The run reported success. The rule above held for identity and
not for search.

🔑 **A page that is not a results page is no more an answer than a failed
fetch.** Each adapter now says which of two empty answers it got: a results
page with nothing on it, or a body that is not a results page at all — a robot
check, an error page, a truncated body. It recognises its own results page by
structure the retailer always emits for one, calibrated on a real no-results
page, never by the absence of results. For Amazon that is the results
container, and then either a readable result cell or Amazon's own no-results
message; a page with neither, or with cells none of which can be read, is not
an answer.

🔴 **A miss needs every attempted search answered.** The plan asks its most
specific query first — the exact part number — and its vaguest last. If the
specific search is throttled and a vague one comes back empty, nobody asked the
retailer the question that would have found the item, so the item is a failure,
not a miss. That holds whether the answered searches came back empty or held
only candidates too weak to report. The failure counts the searches that could
not be fetched and the ones that came back as something else, so a run's record
says whether to fix a credential or wait out a block. Every resolution carries
both counts, a retried item keeps both attempts', and the run prints their
totals beside its outcome split.

🔑 **The gateway half is the gateway's check.** That a resolution carrying a
failure is recorded as `error` and never `not_carried` is
[insights-run-failure-is-not-a-miss](aeo-backend:/qa/insights-run-orchestration.md),
in `aeo-backend`.

⚠️ **Newegg's measured split did not move.** Every one of the 211 search pages
in the committed 53-row corpus carries the retailer's embedded state, so none of
them changes answer; the replay reproduces every row exactly.

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
- AND where the retailer refuses barcode searches, no barcode form is ever asked for

**Checked by:** resolution-query-limits-are-configuration, resolution-short-numeric-still-asked, resolution-retailer-is-data-not-a-type, resolution-barcode-not-searched-where-unanswered

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

#### Scenario: A throttle that yields is counted as every attempt it took
- GIVEN a fetch throttled once and answered on the next attempt
- WHEN it succeeds
- THEN both attempts are counted as requests sent, one page is counted as delivered, and no throttle is recorded

**Checked by:** resolution-recovered-throttle-counts-every-attempt

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

## An item the run could not complete gets one more go, after the pressure stops

🔴 **Measured: the throttle is ours.** After the backoff landed, a live 73-row run
still left 6 items whose identity lookup the vendor answered with an empty body
even after 15 seconds of waiting — and **every one of those six returned
250–390 KB on the first attempt, with no wait at all, once the run was over**.
The vendor is not blocking those urls. It is rate-limiting us while three workers
press it.

🔑 **So the retry waits for the pressure to stop rather than for a timer.** A
second pass at the end, **one item at a time**, costs only the rows that failed —
8% of that run — and asks at the moment the evidence says the answer is
available.

#### Scenario: An item whose pipeline failed is tried once more
- GIVEN an item whose fetch failed during the run
- WHEN the list finishes
- THEN it is attempted again, and a success settles it as a finding

**Checked by:** resolution-failed-item-retried-after-the-run

#### Scenario: The retry does not recreate the throttle
- GIVEN several items deferred from one run
- WHEN they are retried
- THEN no more than one fetch is in flight at a time

**Checked by:** resolution-retry-runs-one-at-a-time

#### Scenario: A retried item is charged for both attempts
- GIVEN an item that failed once and succeeded on the retry
- WHEN the run reports what it spent
- THEN the item carries the requests from both attempts

**Checked by:** resolution-retry-charges-both-attempts

#### Scenario: An item that fails twice is settled, not retried for ever
- GIVEN an item whose every attempt fails
- WHEN the retry pass ends
- THEN it is recorded as a failure and the queue does not grow

**Checked by:** resolution-retry-happens-once-only

⚠️ **Deferred BEFORE being reported, never retried after.** The reporter skips a
client SKU the gateway has already acknowledged, so a sweep that ran after
reporting would be silently dropped — and would appear to work on a short, fast
list, because nothing is flushed until a hundred findings have piled up or the
oldest has waited a minute.

## The second retailer: Amazon

**Added 2026-10-22**, recording what `insights-amazon-retailer` built on
2026-09-13 and never wrote down. The adapter sits behind the same seam as the
launch retailer and nothing above it names either. Amazon states less than
Newegg does at the search stage — no model, no seller — so what it does not
state stays unknown, and the barcode is the only thing that decides a pairing.

#### Scenario: Amazon's barcode is read under whichever label it publishes it

- GIVEN a real Amazon product page with a valid EAN-13 under "Global Trade Identification Number"
- WHEN it is parsed
- THEN that barcode is read
- AND the incidental "UPC" strings elsewhere on the page yield nothing
- AND a details table with no barcode row yields none, so the item is `unverifiable`, not mismatched

**Checked by:** resolution-amazon-reads-the-gtin-label, resolution-amazon-ignores-incidental-upc, resolution-amazon-no-barcode-row-is-none, resolution-empty-barcode-is-unverifiable

#### Scenario: A field holding two barcodes verifies on either

- GIVEN one field publishing two barcodes, one equal to the client's
- WHEN compared
- THEN the pairing is verified
- AND the evidence names the barcode that agreed

**Checked by:** resolution-amazon-splits-a-two-barcode-field, resolution-verifies-on-a-second-barcode

#### Scenario: The offered price is reported, never the struck-through list price

- GIVEN an Amazon result carrying both an offered price and a struck-through list price
- WHEN it is parsed
- THEN the offered price is reported
- AND that holds whichever order Amazon emits the two in

**Checked by:** resolution-amazon-offered-price-on-a-real-page, resolution-amazon-price-by-markup-not-order

#### Scenario: What Amazon does not state is not invented

- GIVEN Amazon search results, which state no model and no seller
- WHEN they are parsed and ranked
- THEN model and first-party stay unknown
- AND a brand guessed from the title never decides a pairing

**Checked by:** resolution-amazon-claims-no-model-or-seller, resolution-floor-alone-is-insufficient

## Best Buy, B&H and Costco: what each build meets

**Added 2026-11-11** by `insights-bestbuy-competitor`, `insights-bh-competitor`
and `insights-costco-competitor`, which were planned and built together. Each
competitor was worked out first in the Meriwether data scraper, and its
investigation's code was the specification, not code copied in. Each adapter
sits behind the same seam as Newegg's and Amazon's.

The brief gives the three builds one set of scenarios: "each build meets every
scenario below for its own competitor". So each scenario appears here once, in
the brief's words, and is checked once per competitor. Their competitor-specific
rules follow in the sections below.

🔑 **Two of the brief's build scenarios are the gateway's, not this runtime's.**
*The estimate uses the competitor's measured cost* is the retailer registry's,
in [insights-retailer-registry](aeo-backend:/capabilities/insights-retailer-registry.md).
*The competitor's monitoring follows its measured numbers* is the shared listing
reads', in
[insights-shared-listing-readings](aeo-backend:/capabilities/insights-shared-listing-readings.md).
*A member-only price is not a missing price (Costco)* is a property of reading a
listing, so it is in [listing-reads](/capabilities/listing-reads.md).

#### Scenario: The platform reproduces the investigation
- GIVEN the investigation's 20-row result
- WHEN the same 20 rows run in Meriwether against the competitor
- THEN at least as many rows are verified, or the difference is explained row by row

**Checked by:** resolution-bestbuy-reproduces-the-investigation, resolution-bh-reproduces-the-investigation, resolution-costco-reproduces-the-investigation, resolution-bestbuy-reproduces-the-investigation-live, resolution-bh-reproduces-the-investigation-live, resolution-costco-reproduces-the-investigation-live

#### Scenario: A pairing is proven by the competitor's own barcode
- GIVEN a client product whose barcode the competitor publishes
- WHEN a run resolves it
- THEN the item is verified, and the evidence shows the barcode as the competitor published it

**Checked by:** resolution-bestbuy-proves-by-published-barcode, resolution-bh-proves-by-published-barcode, resolution-costco-proves-by-published-barcode

#### Scenario: A page publishing several barcodes still proves the pairing
- GIVEN a product page that lists two barcodes in one place, one of them the client's
- WHEN a run resolves the item
- THEN the item is verified, not reported as a barcode that disagrees

**Checked by:** resolution-bestbuy-several-barcodes-verify, resolution-bh-several-barcodes-verify, resolution-costco-several-barcodes-verify

#### Scenario: A refused search is a failure, not a miss
- GIVEN the competitor answers a search with a robot check, an error or an empty response
- WHEN a run resolves the item
- THEN the item is reported as a failed lookup with its reason
- AND it is never reported as not carried

**Checked by:** resolution-bestbuy-refusal-is-a-failure, resolution-bh-refusal-is-a-failure, resolution-costco-refusal-is-a-failure

#### Scenario: A search the competitor answers with nothing is a miss
- GIVEN the competitor answers a part-number search with its normal no-results answer
- WHEN a run resolves the item
- THEN the item is reported as not found, with the searches that were tried

**Checked by:** resolution-bestbuy-no-results-is-a-miss, resolution-bh-no-results-is-a-miss, resolution-costco-no-results-is-a-miss

#### Scenario: A candidate without a barcode match goes to a person
- GIVEN a listing whose part number and brand agree with the client's but which publishes no barcode
- WHEN a run resolves the item
- THEN the item goes to review, and is never shown as a match

**Checked by:** resolution-bestbuy-no-barcode-goes-to-a-person, resolution-bh-no-barcode-goes-to-a-person, resolution-costco-no-barcode-goes-to-a-person

⚠️ **Costco has no search, so its two search scenarios are met by its product
list.** Costco's search and category pages arrive empty through our Bright Data
setup, so an item is looked up in Costco's published product list instead. A
list that could not be read is Costco's refused search, and a brand the list
does not carry is its no-results answer. Costco's search page is still
recognised as an answer nobody gave, should anything ever ask it.

⚠️ **Costco reproduces a 20-row result of nothing.** The investigation found
none of the 20 shared Micro Center rows at Costco, and none of 78 in a random
sample of Micro Center's list; Costco was built anyway, so it is ready when a
customer's list overlaps it (the lead). Its proof of a pairing is a 21st row,
the AirPods the investigation verified by barcode.

## Rules every competitor follows

**Approved by the lead on 2026-11-10, from Jody Holmes's rules** in the brief.
Each holds for every competitor through the seam: a competitor states its
answer as data, and nothing above the seam names it.

#### Scenario: A competitor that answers a barcode search is asked the barcode first
- GIVEN a competitor whose search answers a barcode
- WHEN an item is resolved
- THEN the barcode is the first search asked, before anything is bought to identify the item
- AND a listing that search finds and proves costs no identification lookup at all
- AND a result the competitor marks as only partly matching the barcode is never opened
- AND a barcode search that finds nothing is carried into the part-number search, and the barcode is not asked twice

**Checked by:** resolution-barcode-searched-first-where-answered, resolution-barcode-hit-buys-no-identity, resolution-barcode-lookalike-is-never-opened, resolution-barcode-miss-carries-on

#### Scenario: A competitor is never read more pages at once than its own limit, and never more than 4
- GIVEN a competitor whose limit comes with the job, or is the competitor's own where the job states none
- WHEN a resolution run works its list
- THEN no more pages are in flight at once than that limit
- AND the job's figure wins over the competitor's own
- AND a job asking for more than 4 is read 4 at a time

**Checked by:** resolution-pages-at-once-per-competitor, resolution-pages-at-once-job-wins, resolution-pages-at-once-never-above-four

#### Scenario: A product page that is not one is not a listing without a barcode
- GIVEN a probed page that is not a product page: an empty product shell, a replacement page, a page with no product data
- WHEN the item is resolved
- THEN the probe counts as one nobody answered
- AND the item is never unverifiable on the strength of it
- AND a real product page that publishes no barcode still makes the item unverifiable

**Checked by:** resolution-product-page-shell-is-not-no-barcode, resolution-real-page-without-barcode-is-unverifiable

#### Scenario: The price comes from the page that proved the pairing when the card shows none
- GIVEN a pairing proven on a product page that states a price and stock, found from a search result that shows neither
- WHEN the finding is reported
- THEN its price and stock are the page's
- AND where both state a price, the page's is reported
- AND where the page states neither, the search result's are kept
- AND a stock neither states is reported as unknown, never as in or out of stock

**Checked by:** resolution-price-from-probed-page, resolution-price-falls-back-to-the-card, resolution-unknown-stock-is-unknown

#### Scenario: Every price a finding reports says which page it came from
- GIVEN a pairing whose price was read from its product page, or only from the search result that found it
- WHEN the finding is reported
- THEN its price is labelled as the product page's or as the search results page's, beside the price itself
- AND a pairing with no price carries no source
- AND a pairing proven from the run's memory, whose page was not read, is labelled the search results page's

**Checked by:** resolution-price-source-says-the-page, resolution-price-source-on-the-wire

#### Scenario: The client's own part number and brand are searched before anything derived
- GIVEN a row of the client's list that states the product's part number and brand
- WHEN the item is resolved
- THEN the client's part number is searched right after the barcode, ahead of any part number derived from elsewhere
- AND the client's brand is the item's brand, even where a derived one disagrees
- AND at Costco the product list is looked up by the client's brand
- AND a row stating neither resolves exactly as it did before
- AND a part number or brand that is not text, or is longer than the gateway accepts, refuses the job

**Checked by:** resolution-client-part-number-asked-first, resolution-client-brand-wins, resolution-costco-looked-up-by-client-brand, resolution-client-fields-absent-run-as-before, resolution-client-fields-refused-when-malformed

#### Scenario: A product page that could not be read is a failure, never "not carried", and the best candidate is never proposed unread
- GIVEN an item whose candidate product pages could not all be read, because a fetch failed or the page was not a product page
- WHEN no page that was read settles the item
- THEN the item is a failure with its reason, which the gateway records as an error, never as not carried
- AND the best candidate is never proposed as a match while its page is unread
- AND on the run's first pass an unread best is a failure even when a lower listing was read and qualifies, so the retry after the run reads it again
- AND only on that retry is a lower listing, read and naming the part number, proposed in its place

**Checked by:** resolution-unread-product-page-is-a-failure, resolution-costco-unread-pages-are-a-failure, resolution-unread-best-never-proposed, resolution-unread-best-retried-first, resolution-unread-best-sibling-on-retry

#### Scenario: Every request the vendor was asked for is counted
- GIVEN a run whose fetches are sometimes retried, sometimes answered with a body too short to be a page, and sometimes refused on every attempt
- WHEN the run reports what it spent
- THEN every attempt sent to the vendor is counted, retries and failures included
- AND a page served from the run's own disk cache counts nothing

**Checked by:** resolution-counts-every-attempt, resolution-disk-cache-counts-nothing

🔴 **Until 2026-11-11 a run counted delivered pages only**, so Best Buy's 166
requests sent for 110 pages delivered read as 110, and a page that failed three
times counted nothing. Retries, short bodies and timeouts are all requests the
vendor was asked for. Which of them Bright Data bills is unconfirmed until an
invoice, and counting every attempt is the figure that is safe either way. How
each attempt is charged to its item, and the pages delivered reported beside
the spend, are in
[resolution-request-attribution](/capabilities/resolution-request-attribution.md).

⚠️ **Pages at once is the registry's, and the rest of how a competitor is
fetched is the adapter's.** Best Buy's page time measured 20 s one day and one
to three minutes the day before, so how many pages are read at once must change
without a rebuild: it arrives with the job, from the gateway's retailer
registry. The country a page is fetched from, how long one attempt may take and
how many product pages one item may open are facts about the competitor's
website, so they stay with the adapter. Newegg and Amazon read 3 pages at once,
fetched exactly as before.

## Best Buy

Best Buy answers a barcode search, so it is asked the barcode first: the
investigation proved 11 of its 20 rows that way, and its part-number searches
proved none of the other 9. Its
product page states every barcode it publishes, the price, the stock and who
sells the offer. It is read through its website, never its developer API, whose
terms forbid this use.

#### Scenario: A Best Buy marketplace listing is recorded as one, with its seller
- GIVEN a Best Buy listing whose page says it is sold by a marketplace seller
- WHEN a run pairs it
- THEN the pairing is recorded as a marketplace listing with the seller's name, and its price and stock from the page
- AND a listing Best Buy sells itself is recorded as first party, sold by Best Buy, even where its search card did not say
- AND at equal evidence Best Buy's own listing is opened first

**Checked by:** resolution-bestbuy-seller-class-recorded, resolution-bestbuy-page-decides-the-seller-class, resolution-bestbuy-first-party-probed-first

#### Scenario: A Best Buy page of look-alikes is not a match
- GIVEN a Best Buy search that answers a part number only with products that resemble it
- WHEN a run resolves the item
- THEN the item is not found, and never unconfirmed on a look-alike

**Checked by:** resolution-bestbuy-lookalike-page-is-not-a-match

## B&H

B&H answers a barcode search and states every barcode on its product page. Its
catalogue spans photo, video, audio and computing, so a bare part number often
belongs to another brand's product there.

#### Scenario: A discontinued B&H listing goes to a person, with its reason
- GIVEN a B&H listing with the item's part number and brand, which B&H says is discontinued, with no barcode and no price
- WHEN a run resolves the item
- THEN the item goes to review as unverifiable, with the reason that it is discontinued at B&H and publishes no barcode
- AND it is never verified and never filed as not carried

**Checked by:** resolution-bh-discontinued-goes-to-review, resolution-bh-discontinued-after-a-lookalike-barcode-answer

#### Scenario: A B&H kit's component barcodes are never the kit's
- GIVEN a B&H kit whose page lists the barcodes of the products it contains
- WHEN a run resolves an item whose barcode is one of those components'
- THEN the kit is never verified as the item

**Checked by:** resolution-bh-component-upc-never-matches

#### Scenario: At B&H a part number names a product only with its brand
- GIVEN a B&H listing whose part number equals the item's but whose brand is another's
- WHEN a run resolves the item
- THEN that listing is never opened and never proposed
- AND where the item's brand is unknown, such a listing goes to a person and is never verified

**Checked by:** resolution-bh-another-brands-part-number-is-not-a-candidate, resolution-bh-unknown-brand-goes-to-a-person

## Costco

Costco is found through its published product list, about 18,000 products in
its sitemap, then proven by the barcode on its product page. Its product pages
are the slowest any competitor serves, about one to one and a half minutes, and
the largest, about 3 MB.

#### Scenario: Costco's product list is read once per run, not once per item
- GIVEN a run over many items at Costco, several worked at once
- WHEN each item is looked up in Costco's product list
- THEN each file of the list is fetched once for the whole run, and charged once
- AND the list's own index is read first, so a product file Costco adds is not missed
- AND the retry after the run reads a list that failed once more

**Checked by:** resolution-costco-index-read-once-per-run, resolution-costco-index-charged-once, resolution-costco-index-reread-on-retry

#### Scenario: A Costco product is found in its product list, never by search
- GIVEN an item at Costco
- WHEN a run resolves it
- THEN Costco's search is never asked
- AND its candidates are the products whose names lead with the item's brand, or with a product-line word of the client's name for it
- AND another brand's product sharing words, or the brand's product of another kind, is not a candidate

**Checked by:** resolution-costco-never-searched, resolution-costco-finds-by-product-line, resolution-costco-other-products-are-not-candidates

#### Scenario: A product Costco names by its line, not its brand, is found
- GIVEN a client row for an iPad or MacBook that Costco sells under a name leading with "ipad" or "macbook", a word hundreds of Costco's names share
- WHEN its candidates are taken from Costco's product list
- THEN the product's own page is among the three Costco reads, the size the client states putting it first
- AND a word that merely leads some names, such as "memory", does not make every such name a candidate

**Checked by:** resolution-costco-finds-popular-product-lines

#### Scenario: A Costco pairing carries the price of the item that matched
- GIVEN a Costco page listing several items, priced only for the one it shows first
- WHEN a client row's barcode agrees with that item
- THEN the pairing carries that item's price, read from the product page
- AND a row whose barcode agrees with an item the page does not price carries no price

**Checked by:** resolution-costco-prices-the-matched-item, resolution-costco-never-a-siblings-price

#### Scenario: A client naming only its storage still reaches the Costco product that states its memory
- GIVEN a client row naming a laptop's storage but not its memory, and Costco's name for the product stating both
- WHEN its candidates are ranked
- THEN the memory Costco states is no conflict, and the product's page is among the three Costco reads
- AND a client that names its memory, or a size the entry lacks, is ranked exactly as before

**Checked by:** resolution-costco-memory-is-no-conflict-for-a-storage-only-name

#### Scenario: A listing whose page states the client's model number goes to a person, not "not carried"
- GIVEN an Amazon listing whose search result names no part number, and whose own page states the client's model number but publishes no barcode
- WHEN the item is resolved
- THEN the listing is proposed for a person to confirm, and the item is not filed as not carried
- AND a page whose barcode disagrees, whose model is another product's, lists several models, or whose listing is renewed or refurbished is never proposed

**Checked by:** resolution-amazon-page-model-goes-to-a-person

#### Scenario: Costco's own item numbers never prove a pairing
- GIVEN a Costco page that states Costco's internal numbers beside the barcodes of the items it sells
- WHEN it is read for a pairing
- THEN only the items' barcodes are compared, and Costco's own numbers never verify anything
- AND a genuine barcode that happens to begin like one of Costco's numbers is still a barcode

**Checked by:** resolution-costco-own-numbers-never-verify, resolution-costco-real-barcode-still-read
