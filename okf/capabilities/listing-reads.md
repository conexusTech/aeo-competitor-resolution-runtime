---
type: Capability
title: The runtime reads listings the platform already knows, once each
description: Read mode — a read job names a retailer and its listings; each page is fetched once, fresh, read by the adapter, and reported with which listing the page says it is, when it was read and what the container bought. A page nobody could read is a failed reading, never a finding.
---

# The runtime reads listings, once each

Part of `shared-competitor-targets` (MC-1 C6), the runtime's half. A monitoring
tick no longer has to re-search an item whose pairing is settled: the gateway
already knows the listing, so it dispatches a **listing read run** — one
retailer, the listings to read on it — and files each reading into every list
that watches the listing. The filing, the slot times and the switch are the
gateway's, recorded in `aeo-backend`'s `insights-shared-listing-readings`
capability.

**Same image, same catalog entry.** The dispatch payload picks the mode.

## The contract

**In.** The queue payload carries `listing_read_run_id` and nothing that names an
organization. The container then reads its job from
`GET /runtime/insights/reads/:readRunId`:

```json
{ "retailerSlug": "newegg", "listings": [{ "itemId": "N82E16826197074", "url": "https://www.newegg.com/p/N82E16826197074" }] }
```

Each `url` must parse, be `https`, carry no credentials and no explicit port, and
be on one of the reader's own hosts — `newegg.com` / `www.newegg.com`,
`amazon.com` / `www.amazon.com`. One listing failing that refuses the whole job
before anything is bought.

**Out.** `POST /runtime/insights/reads/:readRunId/events`, Basic auth, the same
status contract as a resolution run's callback. Three event types, each carrying
`runtime_version` and `requests_spent` (what this container has bought so far,
for the gateway to take as a `GREATEST`), and none carrying a tenant, an
organization or a list:

| `type` | Also carries |
|---|---|
| `readings` | `readings`: up to 250 |
| `completed` | nothing more |
| `error` | `message` |

**A reading** is one of three shapes, and `pageFound` tells them apart:

| Field | A page was read | The vendor said gone | The page could not be read |
|---|---|---|---|
| `itemId` | the listing's id, as asked | as asked | as asked |
| `pageItemId` | the listing the page says it is, or `null` | `null` | `null` |
| `readAt` | ISO 8601, when the page arrived | when the attempt ended | when the attempt ended |
| `pageFound` | `true` | `false` | `null` |
| `barcode` | trimmed: `""` if published empty, `null` if no field | `null` | `null` |
| `additionalBarcodes` | further barcodes in the same field | `[]` | `[]` |
| `priceCents` | the offer's price, or `null` if none is offered; never 0 | `null` | `null` |
| `inStock` | `true` / `false`, or `null` if no availability is stated | `null` | `null` |
| `failure` | `null` | `not-found: …` | `fetch-failed: …`, `not-a-product-page: …` or `unreadable-offer: …` |

- `not-found` — the vendor relayed a **404 or 410** for the page.
- `fetch-failed` — any other status, or no response at all.
- `not-a-product-page` — a body arrived and is not a product page: a robot check, an error page, a search page, a body cut short.
- `unreadable-offer` — a product page whose offer cannot be read: in stock with no readable price, or neither a price nor an availability with nothing saying there is no offer.

🔴 **Whether the proxy relays a retailer's own 404 as its 404 is unproven.** The
runtime maps a relayed 404 or 410 to `not-found`, and that mapping is tested. What
the vendor actually answers for a delisted page has not been measured, so until
it is, a delisted listing may still arrive as `fetch-failed` or
`not-a-product-page`.

## What the gateway must do with this

These are requirements on `shared-competitor-targets` T-7 (dispatch and ingest)
and T-9 (filing). The runtime is built against them.

- **T-9: refuse a reading whose `pageItemId` is not the listing's `itemId`**,
  `null` included. A product url can come to serve another product; filing that
  page's price against this listing is the error the field exists to stop.
- **T-7: `GET /reads/:id` serves only the listings that have no reading yet.** A
  container that dies and is restarted then re-buys at most the readings it had
  not sent, never the whole job. The runtime keeps no journal of its own.
- **T-7: a queue task that succeeds without a `completed` event is not a
  completed read run.** It is a run whose container ended without saying so.
- **T-7: the job is distinct on `url` and on `itemId`.** The runtime refuses a job
  that names either twice, rather than buy the same page twice.
- **T-7: accept at least 250 readings in one event**, the same cap as the
  resolutions callback.
- **T-7: a resolution payload omits `listing_read_run_id` rather than sending it
  as `null`.** The runtime picks the mode by which key is present, so a `null`
  key makes a resolution payload carry both and it is refused.
- **T-9: `inStock: null` is stored as `stock_status 'unknown'`**, and a reading
  carries no promo.
- **T-9: `pageFound: false` is the only shape that says the listing is gone.**
  `null` is a failure to read, and files as a missing observation.

## Scenarios

#### Scenario: A read job fetches each listing's page once
- GIVEN a read job naming several listings
- WHEN the container reads it, with any number of workers
- THEN each listing's page is requested exactly once
- AND nothing else is requested: no search, no probe, no capture, no retry of a failed page
- AND a job naming one listing, or one page, twice is refused before anything is bought

**Checked by:** listing-read-fetches-each-once
**Checked by:** listing-read-more-workers-than-listings
**Checked by:** listing-read-refuses-a-listing-named-twice
**Checked by:** listing-read-replays-the-committed-pages

#### Scenario: A read fetches only the retailer's own pages
- GIVEN a read job whose listings name urls
- WHEN any url does not parse, is not https, carries credentials or a port, or is on a host that is not the retailer's
- THEN the whole job is refused before any page is bought
- AND a listing on the retailer's bare host is read like any other

**Checked by:** listing-read-refuses-a-malformed-url
**Checked by:** listing-read-refuses-another-host
**Checked by:** listing-read-accepts-the-bare-host

#### Scenario: A read is always a fresh page
- GIVEN a page already bought into the disk cache by an earlier run
- WHEN a read run reads that listing
- THEN the page is fetched again and billed, never served from the cache
- AND resolution still serves its cache

**Checked by:** listing-read-never-serves-the-cache
**Checked by:** listing-read-resolution-keeps-its-cache
**Checked by:** listing-read-run-builds-its-fetcher-cacheless

#### Scenario: A page that was read is reported with what it says
- GIVEN a listing's real product page, on either retailer
- WHEN it is read
- THEN the reading carries the barcode as published, the offered price and whether it is in stock
- AND a barcode the page publishes empty stays the empty string
- AND a zero price is no price
- AND an out-of-stock page offering no price is still a page, with no price
- AND the resolution path's own parse of the same page is unchanged

**Checked by:** listing-read-newegg-pages
**Checked by:** listing-read-empty-barcode-stays-empty
**Checked by:** listing-read-amazon-featured-offer
**Checked by:** listing-read-zero-price-is-no-price
**Checked by:** listing-read-out-of-stock-is-a-page
**Checked by:** listing-read-resolution-parse-unchanged

#### Scenario: A reading says which listing the page is
- GIVEN a product page read for a listing
- WHEN the reading is reported
- THEN it carries the listing the page itself names, in the form a search names it
- AND never the id the job asked for, so a page now showing a different product is visible

**Checked by:** listing-read-page-names-itself
**Checked by:** listing-read-reports-the-page-identity

#### Scenario: Amazon's offer is read from one buying option
- GIVEN an Amazon page offering more than one buying option
- WHEN it is read
- THEN price and availability both come from the buy box's first option
- AND a gap in that option is never filled from another
- AND "In stock soon" or "In Stock on" a date is not in stock

**Checked by:** listing-read-amazon-one-buying-option
**Checked by:** listing-read-amazon-back-order-is-not-stock
**Checked by:** listing-read-amazon-out-of-stock-page

#### Scenario: A page nobody could read is a failed reading, never a finding
- GIVEN a listing whose page could not be fetched, came back as something other than a product page, or shows an offer that cannot be read
- WHEN it is read
- THEN the reading is a failure with its reason and the vendor's own detail
- AND it is never reported as out of stock or no price
- AND only a relayed 404 or 410 is reported as page not found
- AND the other listings in the job are read and the job completes

**Checked by:** listing-read-failed-fetch-is-a-failure
**Checked by:** listing-read-relayed-gone-is-not-found
**Checked by:** listing-read-other-statuses-stay-failures
**Checked by:** listing-read-not-found-against-the-live-vendor
**Checked by:** listing-read-not-a-product-page-is-a-failure
**Checked by:** listing-read-search-page-is-not-a-product-page
**Checked by:** listing-read-block-or-truncated-page-is-not-a-product-page
**Checked by:** listing-read-unreadable-offer-is-a-failure
**Checked by:** listing-read-both-missing-is-a-failure
**Checked by:** listing-read-failure-does-not-stop-the-job

#### Scenario: Every reading carries when its page was read
- GIVEN a read job
- WHEN each page arrives
- THEN its reading's time is the moment that page arrived from the vendor
- AND not the moment it was cached, the job started or the reading was reported

**Checked by:** listing-read-time-is-when-the-page-arrived
**Checked by:** listing-read-fetcher-stamps-arrival
**Checked by:** listing-read-carries-every-field

#### Scenario: Every event carries what the container bought
- GIVEN a read job in which some pages are bought and some fail
- WHEN the container reports
- THEN every batch, the completion and any error carry the requests bought so far
- AND a failed fetch is not counted as bought
- AND a run whose readings the gateway did not accept ends in error, naming how many

**Checked by:** listing-read-cost-on-every-event
**Checked by:** listing-read-undelivered-ends-in-error
**Checked by:** listing-read-crash-reports-what-was-spent

#### Scenario: A read run carries no organization
- GIVEN a read run
- WHEN it is dispatched and when it reports
- THEN a payload naming a tenant, an organization or a list is refused at start
- AND no event it sends carries a tenant, an organization, a list or a resolution run

**Checked by:** listing-read-payload-refuses-an-organization
**Checked by:** listing-read-events-carry-no-organization

#### Scenario: The payload picks the mode, and an ambiguous payload is refused
- GIVEN the one image and catalog entry
- WHEN a payload carries a listing read run id, it runs read mode
- AND when it carries a resolution run id, it runs resolution mode exactly as before
- AND a payload carrying both, or neither, is refused at start

**Checked by:** listing-read-mode-selects-read
**Checked by:** listing-read-mode-keeps-resolution
**Checked by:** listing-read-mode-refuses-both-or-neither

#### Scenario: A read stops when the gateway says the read run has ended
- GIVEN a read run the gateway has ended
- WHEN the container asks for its job, or reports a batch
- THEN it stops buying pages and sends no completion

**Checked by:** listing-read-job-404-is-gone
**Checked by:** listing-read-stops-when-gone
**Checked by:** listing-read-status-contract
**Checked by:** listing-read-batch-cap

#### Scenario: Reading changes nothing about resolution
- GIVEN the 53-row replay of the launch retailer
- WHEN it runs on a build that can read
- THEN every resolution is identical to the build before

**Checked by:** listing-read-53-row-replay-unchanged

## What this does not cover yet

- **The vendor's answer for a delisted page.** See the 🔴 note above; the live
  half of `listing-read-not-found-against-the-live-vendor` is a paid probe the
  lead decides.
- **Amazon's offer is calibrated on one product page.** On it the buy box's first
  option is the open one, $472.00, beside a second at $479.99. A buy box laid out
  differently reads as an unreadable offer rather than a listing with no price.
  "No featured offers available" as visible text is Amazon's wording, not a
  capture: no page showing it is committed.
- **Newegg's identity is calibrated on four product pages**, two showing a
  marketplace offer of a warehouse product. The page names the listing as a
  search does: `ParentItem` when there is one, else `Item`.
- **A read run keeps no journal.** A restarted container's counter starts again
  from zero, so `requests_spent` under-reports that case; T-7 serving only the
  unread listings bounds what it re-buys.
