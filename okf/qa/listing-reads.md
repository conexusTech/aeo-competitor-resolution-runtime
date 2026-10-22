---
type: QA Checklist
title: QA — the runtime reads listings, once each
description: One check per requirement in the listing-reads capability, with what to do and what to expect.
---

# QA — listing reads

Checks for [listing-reads](/capabilities/listing-reads.md). Written with the
tests, before the read mode existed, and extended test-first after review.

🔑 **Every check but one is automated and offline**: real captured product
pages from `test/raw`, hand-built variants of them where a case has no capture,
and a stubbed vendor for the live fetcher. No credential, no network, no queue.

```bash
npx vitest run test/read-run.spec.ts test/queue-task-record.spec.ts test/exit-criterion-53-rows.spec.ts
```

⚠️ **The one Manual check is the live half of "page not found"**: whether the
proxy relays a retailer's 404 at all. It costs real requests, and the lead
decides whether to run it.

🔴 **Forty-eight mutations across two rounds, each shown red, then reverted byte
for byte**, with a syntax-error control scoring "no tests" rather than red. The
checks below name the mutations that turned them red.

---

### Check: listing-read-fetches-each-once

**Requirement:** A read job fetches each listing's page once
**Surface:** `runReadJob`
**Automated:** test/read-run.spec.ts

**Do**

Run a four-listing Newegg job with three workers, one listing's page failing, through a fetcher that records every url it is asked for.

**Expect**

The recorded urls are exactly the four listing urls, once each, and each listing is reported once. 🔴 Mutations: a second fetch per listing, and a cursor read before it is advanced (a race between workers), each turn this red.

### Check: listing-read-more-workers-than-listings

**Requirement:** A read job fetches each listing's page once
**Surface:** `runReadJob`
**Automated:** test/read-run.spec.ts

**Do**

Run a two-listing job with eight workers.

**Expect**

Two fetches, two distinct urls. The control for idle workers taking an index that does not exist.

### Check: listing-read-refuses-a-listing-named-twice

**Requirement:** A read job fetches each listing's page once
**Surface:** `parseReadJob`
**Automated:** test/read-run.spec.ts

**Do**

Parse a job naming one listing twice, and one naming two ids on the same url.

**Expect**

Both refused, naming the repeat, before any page is bought. 🔴 Mutation: dropping the duplicate check turns this red.

### Check: listing-read-replays-the-committed-pages

**Requirement:** A read job fetches each listing's page once
**Surface:** `runReadJob` over `ReplayFetcher`
**Automated:** test/read-run.spec.ts

**Do**

Build a replay corpus from the four committed Newegg product pages and run the job through it.

**Expect**

Every corpus entry is served, the four barcodes come back in order (the empty one as `""`), and the run completes with `requests_spent` 0.

### Check: listing-read-refuses-a-malformed-url

**Requirement:** A read fetches only the retailer's own pages
**Surface:** `parseReadJob`
**Automated:** test/read-run.spec.ts

**Do**

Parse jobs whose one listing has no id, no url, a `javascript:` url, an `http` url, a url with `user:pw@`, one with port 8443, and `https://` alone.

**Expect**

Each refused, naming the listing. 🔴 Mutations: accepting a non-https url, and accepting credentials in a url, each turn this red.

### Check: listing-read-refuses-another-host

**Requirement:** A read fetches only the retailer's own pages
**Surface:** `runReadJob`
**Automated:** test/read-run.spec.ts

**Do**

Run a Newegg job with one extra listing on `evil.example`, on `www.newegg.com.evil.example`, and on `www.amazon.com`.

**Expect**

Each rejected with a message naming the host; **zero** fetches; exactly one event, `error`. 🔴 Mutations: removing the host check, and letting any host containing the retailer's name through, each turn this red.

### Check: listing-read-accepts-the-bare-host

**Requirement:** A read fetches only the retailer's own pages
**Surface:** `runReadJob`
**Automated:** test/read-run.spec.ts

**Do**

Run a one-listing job on `https://newegg.com/…`.

**Expect**

It is fetched. The control for a host check that only accepts `www.`.

### Check: listing-read-never-serves-the-cache

**Requirement:** A read is always a fresh page
**Surface:** `LiveFetcher` with `serveFromCache: false`
**Automated:** test/read-run.spec.ts

**Do**

With the vendor stubbed, fetch a url once with the default fetcher (it caches), then again with a read's fetcher.

**Expect**

The second fetch reaches the vendor, is `cached: false` and is billed. 🔴 Mutation: ignoring the option turns this red.

### Check: listing-read-resolution-keeps-its-cache

**Requirement:** A read is always a fresh page
**Surface:** `LiveFetcher` default
**Automated:** test/read-run.spec.ts

**Do**

Fetch the same url with two default fetchers over one cache directory.

**Expect**

The second is a cache hit and the vendor is called once. The control: resolution's resume depends on it.

### Check: listing-read-run-builds-its-fetcher-cacheless

**Requirement:** A read is always a fresh page
**Surface:** `readFetcherFromEnv`
**Automated:** test/read-run.spec.ts

**Do**

Build a read run's fetcher with proxy credentials set and no corpus; then with a corpus named.

**Expect**

A `LiveFetcher` whose `servesFromCache` is `false`; with a corpus, a `ReplayFetcher`. 🔴 Mutation: building the default live fetcher turns this red.

### Check: listing-read-newegg-pages

**Requirement:** A page that was read is reported with what it says
**Surface:** `readListingPage` (Newegg)
**Automated:** test/read-run.spec.ts

**Do**

Read `pdp-barcode-12`, `-13` and `-14`.

**Expect**

Pages with barcodes `065030870382`, `5028551561707`, `00097855114693`; prices 7126, 1953 and 19999 (the offered price, not the struck-through 299.99); all in stock.

### Check: listing-read-empty-barcode-stays-empty

**Requirement:** A page that was read is reported with what it says
**Surface:** `readListingPage` (Newegg)
**Automated:** test/read-run.spec.ts

**Do**

Read `pdp-barcode-empty`.

**Expect**

`barcode` is `""`, not `null`, and the price 42999 is still read.

### Check: listing-read-amazon-featured-offer

**Requirement:** A page that was read is reported with what it says
**Surface:** `readListingPage` (Amazon)
**Automated:** test/read-run.spec.ts

**Do**

Read `amazon-pdp-gtin-labelled`, and run a one-listing Amazon job over it.

**Expect**

Barcode `04713294232687`, price 47200 (the open buying option, not the second at $479.99), in stock, ASIN `B0BFGB2D2Z`. The job files the same price.

### Check: listing-read-zero-price-is-no-price

**Requirement:** A page that was read is reported with what it says
**Surface:** `readListingPage` (both)
**Automated:** test/read-run.spec.ts

**Do**

Read the Amazon page with its first option showing `$0.00` and currently unavailable; and `pdp-barcode-12` with `FinalPrice` 0 and out of stock.

**Expect**

`priceCents` is `null` on both. 🔴 Mutation: letting Amazon's 0 through turns this red.

### Check: listing-read-out-of-stock-is-a-page

**Requirement:** A page that was read is reported with what it says
**Surface:** `readListingPage` (Newegg)
**Automated:** test/read-run.spec.ts

**Do**

Read `pdp-barcode-12` with its price nulled and its stock set false.

**Expect**

A page, with `priceCents: null` and `inStock: false`. The control for the unreadable-offer refusal.

### Check: listing-read-resolution-parse-unchanged

**Requirement:** A page that was read is reported with what it says
**Surface:** `parseProductPage` (Newegg)
**Automated:** test/read-run.spec.ts

**Do**

Parse `pdp-barcode-empty` and `pdp-barcode-12` with the resolution parse.

**Expect**

The empty barcode is still `null` there, and price, stock and title are still `null`.

### Check: listing-read-page-names-itself

**Requirement:** A reading says which listing the page is
**Surface:** `readListingPage` (both)
**Automated:** test/read-run.spec.ts

**Do**

Read each Newegg page and the Amazon page.

**Expect**

`pdp-barcode-12` says `N82E16886949047` — its product `86-949-047` in public form, not the marketplace offer `9SIA6ZPK9U9854` it shows; `-14` says `N82E16826197074`; the Amazon page says `B0BFGB2D2Z`. 🔴 Mutations: Newegg taking `Item` instead of `ParentItem`, and Amazon missing the ASIN field, each turn this red.

### Check: listing-read-reports-the-page-identity

**Requirement:** A reading says which listing the page is
**Surface:** `readListing`
**Automated:** test/read-run.spec.ts

**Do**

Read `pdp-barcode-12` for a listing whose id is `N82E16899999999`.

**Expect**

`itemId` is the asked id and `pageItemId` is `N82E16886949047`. 🔴 Mutation: echoing the job's id as the page's turns this red.

### Check: listing-read-amazon-one-buying-option

**Requirement:** Amazon's offer is read from one buying option
**Surface:** `readListingPage` (Amazon)
**Automated:** test/read-run.spec.ts

**Do**

Remove the first option's price, leaving the second option's $479.99 on the page; separately, make the second option say currently unavailable.

**Expect**

The first is `unreadable-offer`, not $479.99; the second still reads in stock. 🔴 Mutations: reading the whole page instead of the buy box, and the whole buy box instead of its first option, each turn this red.

### Check: listing-read-amazon-back-order-is-not-stock

**Requirement:** Amazon's offer is read from one buying option
**Surface:** `readListingPage` (Amazon)
**Automated:** test/read-run.spec.ts

**Do**

Make the first option say "In stock soon. Order it now.", "In Stock on November 3, 2026.", and "Temporarily out of stock."

**Expect**

`inStock: false` for each, price still 47200. 🔴 Mutation: dropping the back-order wording turns this red.

### Check: listing-read-amazon-out-of-stock-page

**Requirement:** Amazon's offer is read from one buying option
**Surface:** `readListingPage` (Amazon)
**Automated:** test/read-run.spec.ts

**Do**

Remove the first option's price and make it say "Currently unavailable."

**Expect**

A page: `inStock: false`, `priceCents: null`.

### Check: listing-read-failed-fetch-is-a-failure

**Requirement:** A page nobody could read is a failed reading, never a finding
**Surface:** `readListing`
**Automated:** test/read-run.spec.ts

**Do**

Read a listing whose fetch fails with `status=403`.

**Expect**

`failure` starts `fetch-failed:` and carries `status=403`; `pageFound`, `pageItemId`, `inStock`, `priceCents` and `barcode` are all `null`. 🔴 Mutation: `pageFound: false` on a failure turns this red.

### Check: listing-read-relayed-gone-is-not-found

**Requirement:** A page nobody could read is a failed reading, never a finding
**Surface:** `readListing`, `LiveFetcher`
**Automated:** test/read-run.spec.ts

**Do**

Read a listing the vendor answers with 404, then 410; and fetch with the live fetcher against a stubbed 404, and against a 404 followed by a dropped connection.

**Expect**

`pageFound: false` and `not-found:` for both; the live fetcher's `FetchFailed` carries 404, and `null` when the last attempt got no response. 🔴 Mutations: dropping 410, the live fetcher not passing its status, and keeping an earlier attempt's status, each turn this red.

### Check: listing-read-other-statuses-stay-failures

**Requirement:** A page nobody could read is a failed reading, never a finding
**Surface:** `readListing`
**Automated:** test/read-run.spec.ts

**Do**

Read a listing the vendor answers with 400, 403, 429, 500 and 503, and one failing with no status.

**Expect**

`fetch-failed:` every time. 🔴 Mutation: treating every status as gone turns this red.

### Check: listing-read-not-found-against-the-live-vendor

**Requirement:** A page nobody could read is a failed reading, never a finding
**Surface:** `LiveFetcher` against the real proxy
**Automated:** Manual

**Do**

This spends real requests, so the lead decides whether to run it. Fetch a known-delisted product url at each retailer through the live proxy, once each, and record the status and body length the vendor answers with.

**Expect**

A 404 or 410 confirms the `not-found` mapping holds live. Anything else — a 200 block page, a 502 — means delisted pages arrive as `fetch-failed` or `not-a-product-page`, and the capability's 🔴 note stays.

### Check: listing-read-not-a-product-page-is-a-failure

**Requirement:** A page nobody could read is a failed reading, never a finding
**Surface:** `readListing`
**Automated:** test/read-run.spec.ts

**Do**

Read a listing whose url answers with a Newegg search page.

**Expect**

`failure` starts `not-a-product-page:`; `pageFound`, `inStock` and `priceCents` are `null`.

### Check: listing-read-search-page-is-not-a-product-page

**Requirement:** A page nobody could read is a failed reading, never a finding
**Surface:** `readListingPage` (both)
**Automated:** test/read-run.spec.ts

**Do**

Read a committed search page with each retailer's reader.

**Expect**

Both answer `not-a-product-page`.

### Check: listing-read-block-or-truncated-page-is-not-a-product-page

**Requirement:** A page nobody could read is a failed reading, never a finding
**Surface:** `readListingPage` (both)
**Automated:** test/read-run.spec.ts

**Do**

Read a block-page body, an empty body, and `pdp-barcode-12` cut inside its embedded state.

**Expect**

All `not-a-product-page`.

### Check: listing-read-unreadable-offer-is-a-failure

**Requirement:** A page nobody could read is a failed reading, never a finding
**Surface:** `readListingPage`, `readListing`
**Automated:** test/read-run.spec.ts

**Do**

Read `pdp-barcode-12` with its price made unreadable, and the Amazon page with its first option's price removed; then read the Amazon one through `readListing`.

**Expect**

Both `unreadable-offer`; the reading's failure starts `unreadable-offer:`.

### Check: listing-read-both-missing-is-a-failure

**Requirement:** A page nobody could read is a failed reading, never a finding
**Surface:** `readListingPage` (both)
**Automated:** test/read-run.spec.ts

**Do**

Make both price and availability unreadable on `pdp-barcode-12` and in the Amazon page's first option; then add Amazon's "No featured offers available" text to the latter.

**Expect**

Both `unreadable-offer`; with the marker, a page with `priceCents` and `inStock` both `null`. 🔴 Mutations: dropping the both-missing refusal, and ignoring the marker, each turn this red.

### Check: listing-read-failure-does-not-stop-the-job

**Requirement:** A page nobody could read is a failed reading, never a finding
**Surface:** `runReadJob`
**Automated:** test/read-run.spec.ts

**Do**

Run the four-listing job with the second page failing.

**Expect**

The second reading is a `fetch-failed` failure, the first still reads 7126, and the run ends `completed`. 🔴 Mutation: skipping failed readings turns this red.

### Check: listing-read-time-is-when-the-page-arrived

**Requirement:** Every reading carries when its page was read
**Surface:** `readListing`, `runReadJob`
**Automated:** test/read-run.spec.ts

**Do**

Read through a fetcher that stamps each page's arrival, then lets the clock run five seconds (the cache write and jitter) before handing it back.

**Expect**

Each `readAt` equals its page's arrival, not the later time, nor the job's start; four pages, four distinct times. 🔴 Mutation: taking `now()` instead of the fetcher's stamp turns this red.

### Check: listing-read-fetcher-stamps-arrival

**Requirement:** Every reading carries when its page was read
**Surface:** `LiveFetcher`
**Automated:** test/read-run.spec.ts

**Do**

Fetch with 60 ms of politeness jitter against a stubbed vendor.

**Expect**

`fetchedAt` is at or after the call began, and at least 45 ms before the page was handed back. 🔴 Mutation: stamping after the jitter turns this red.

### Check: listing-read-carries-every-field

**Requirement:** Every reading carries when its page was read
**Surface:** `readListing`
**Automated:** test/read-run.spec.ts

**Do**

Read one Newegg listing.

**Expect**

The reading equals, field for field, `itemId`, `pageItemId`, `readAt`, `pageFound: true`, barcode, `additionalBarcodes`, price, stock and `failure: null` — the whole contract, nothing extra.

### Check: listing-read-cost-on-every-event

**Requirement:** Every event carries what the container bought
**Surface:** `runReadJob`
**Automated:** test/read-run.spec.ts

**Do**

Run four listings on one worker, batches of two, the fourth page failing.

**Expect**

Events are `readings` (2, spent 2), `readings` (2, spent 3), `completed` (spent 3). 🔴 Mutations: 0 on a batch, 0 on completion each turn this red.

### Check: listing-read-undelivered-ends-in-error

**Requirement:** Every event carries what the container bought
**Surface:** `runReadJob`
**Automated:** test/read-run.spec.ts

**Do**

Run the job against a gateway refusing every batch with a 400.

**Expect**

Four readings undelivered; the last event is `error`, its message names 4 and it carries `requests_spent` 4.

### Check: listing-read-crash-reports-what-was-spent

**Requirement:** Every event carries what the container bought
**Surface:** `runReadJob`
**Automated:** test/read-run.spec.ts

**Do**

Run a job for a retailer this image has no adapter for.

**Expect**

Exactly one event, `error`, naming the retailer, with `requests_spent`; then the error is rethrown.

### Check: listing-read-payload-refuses-an-organization

**Requirement:** A read run carries no organization
**Surface:** `queueDispatchFromPayload`
**Automated:** test/read-run.spec.ts

**Do**

Dispatch a read payload carrying `tenant_id`, then `organization_id`, then `watchlist_id`.

**Expect**

Each refused at start, naming the key.

### Check: listing-read-events-carry-no-organization

**Requirement:** A read run carries no organization
**Surface:** `ReadRunClient`
**Automated:** test/read-run.spec.ts

**Do**

Send a readings batch, a completion and an error through a recording fetch.

**Expect**

Every body goes to `/runtime/insights/reads/:id/events` and has no `tenant_id`, `organization_id`, `watchlist_id` or `resolution_run_id`; each has `runtime_version`. 🔴 Mutation: adding `tenant_id` to the body turns this red.

### Check: listing-read-mode-selects-read

**Requirement:** The payload picks the mode, and an ambiguous payload is refused
**Surface:** `queueDispatchFromPayload`
**Automated:** test/read-run.spec.ts

**Do**

Dispatch `{ listing_read_run_id }`, and one with it empty.

**Expect**

Read mode with that id; the empty one refused.

### Check: listing-read-mode-keeps-resolution

**Requirement:** The payload picks the mode, and an ambiguous payload is refused
**Surface:** `queueDispatchFromPayload`, `bootstrapFromQueue`
**Automated:** test/read-run.spec.ts, test/queue-task-record.spec.ts

**Do**

Dispatch the resolution payload directly, and through the queue bootstrap.

**Expect**

Resolution mode, with every field exactly as `dispatchFromPayload` maps it.

### Check: listing-read-mode-refuses-both-or-neither

**Requirement:** The payload picks the mode, and an ambiguous payload is refused
**Surface:** `queueDispatchFromPayload`
**Automated:** test/read-run.spec.ts

**Do**

Dispatch a payload with both run ids, one with neither, and `null`.

**Expect**

All refused; the first says both, the second names both keys.

### Check: listing-read-job-404-is-gone

**Requirement:** A read stops when the gateway says the read run has ended
**Surface:** `ReadRunClient.fetchJob`
**Automated:** test/read-run.spec.ts

**Do**

Fetch the job against a gateway answering 404, and against one answering a job.

**Expect**

A `ReadRunGone` for the 404; for the job, a GET to `/runtime/insights/reads/:id` with Basic auth, parsed.

### Check: listing-read-stops-when-gone

**Requirement:** A read stops when the gateway says the read run has ended
**Surface:** `runReadJob`
**Automated:** test/read-run.spec.ts

**Do**

Run ten listings, batches of two, against a gateway answering every batch with 404.

**Expect**

Fewer than ten fetches, `stoppedEarly`, and no completion or error sent.

### Check: listing-read-status-contract

**Requirement:** A read stops when the gateway says the read run has ended
**Surface:** `ReadRunClient`
**Automated:** test/read-run.spec.ts

**Do**

Post a completion against two 503s then a 200, a 400, and a 404.

**Expect**

Applied after three calls; refused after one; run-gone. The same contract as a resolution run, from the same code.

### Check: listing-read-batch-cap

**Requirement:** A read stops when the gateway says the read run has ended
**Surface:** `ReadRunClient`, `runReadJob`
**Automated:** test/read-run.spec.ts

**Do**

Send 251 readings in one call; run 257 listings with a flush threshold above the cap.

**Expect**

The call is refused locally with nothing sent; the run sends no batch over 250 and delivers all 257.

### Check: listing-read-53-row-replay-unchanged

**Requirement:** Reading changes nothing about resolution
**Surface:** `resolveItem` over the committed corpus
**Automated:** test/exit-criterion-53-rows.spec.ts

**Do**

Run the 53-row replay before and after this change, and dump every resolution to JSON.

**Expect**

The 12 checks pass and the two dumps are byte-identical (sha256 `99818116…cdeb0` on 2026-10-23: 19 verified, 4 unverifiable, 1 unconfirmed, 16 not found, 13 not in the corpus).
