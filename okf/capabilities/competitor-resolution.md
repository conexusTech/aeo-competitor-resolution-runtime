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
