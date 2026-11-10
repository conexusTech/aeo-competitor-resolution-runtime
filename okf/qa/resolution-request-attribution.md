---
type: QA Checklist
title: Checks for what a run says it spent
description: One check per requirement in the request-attribution capability, each proven able to fail against the code that shipped.
---

# Checks — what a run says it spent

Every check below was **run against the shipped code first** and turned red. The
mutations and their verdicts are in the change's commit message; the one that
matters is "both meters gone", which is exactly the code the live queue run
exercised, and which turns three of these red.

### Check: attribution-sums-to-the-fetcher-total

**Requirement:** Every request a run buys is charged to exactly one item
**Surface:** `runList`
**Automated:** `test/request-attribution.spec.ts`

**Do**

Run nine items through `runList` against a fetcher that counts what it
sells and suspends on every call, once at `concurrency: 1` and once at
`concurrency: 3`. Sum `requests` across the resolutions.

**Expect**

The sum equals `fetcher.liveRequestCount` exactly, at both
concurrencies. The fetcher sold more than nine pages, so the check is not
satisfied by a run that bought one page per item.

⚠️ **The fetcher's `await` before it counts is load-bearing.** Without a
suspension point each worker runs to completion before the next starts, the
shared counter never interleaves, and a delta on it looks honest. The defect only
exists when work overlaps.

### Check: attribution-holds-for-a-direct-caller

**Requirement:** An item resolved on its own is charged only for its own requests
**Surface:** `resolveItem`
**Automated:** `test/request-attribution.spec.ts`

**Do**

Call `resolveItem` three times concurrently through one shared fetcher,
with no `runList` around them. Sum the three `requests`.

**Expect**

The sum equals `fetcher.liveRequestCount`.

🔴 **This check exists because a mutation reported GREEN.** Restoring the delta
inside `resolveItem` alone left every other check passing, because `runList`
wraps each item first. Direct callers have no such protection and this repo has
several.

### Check: a-failed-item-is-charged-what-it-bought

**Requirement:** An item whose pipeline fails is charged what it had already bought
**Surface:** `runList`'s failure branch
**Automated:** `test/request-attribution.spec.ts`

**Do**

Resolve one item against a fetcher that serves the search-engine lookup
and the search, then throws a plain `Error` — not `FetchFailed`, which the
pipeline swallows into a clean miss — on the product probe.

**Expect**

The resolution carries a non-null `failure`, and its `requests`
equals what the fetcher sold, which is greater than zero.

### Check: a-batch-carries-the-running-counter

**Requirement:** A findings batch carries what the run has bought so far
**Surface:** `GatewayClient.reportResolutions`
**Automated:** test/gateway-client.spec.ts

**Do**

Report one finding with a counter of 62 and read the posted body.

**Expect**

`requests_spent` is `62`.

### Check: an-absent-counter-is-omitted-not-zeroed

**Requirement:** A run that reports no counter is not reporting zero
**Surface:** `GatewayClient.reportResolutions`
**Automated:** test/gateway-client.spec.ts

**Do**

Report one finding with no counter and read the posted body.

**Expect**

The body has no `requests_spent` key at all. ⚠️ Not `0` — the gateway reads an
absent counter as an older container and falls back to the per-item sum, while a
zero would tell it the run bought nothing.

### Check: an-error-event-carries-the-counter

**Requirement:** A run that fails reports what it spent before it died
**Surface:** `GatewayClient.reportError`
**Automated:** test/gateway-client.spec.ts

**Do**

Report an error with a counter of 31 and read the posted body.

**Expect**

`type` is `error` and `requests_spent` is `31`.

### Check: the-counter-is-read-at-send-time

**Requirement:** The counter is read when the batch goes, not when the reporter was built
**Surface:** `GatewayReporter`
**Automated:** test/request-attribution.spec.ts

**Do**

Build a reporter over a thunk reading a mutable total, flushing every finding.
Offer one at 11, one at 26, then report an error at 26.

**Expect**

The three events carry 11, 26 and 26.

🔑 **A batch is sent after the pages that produced it were bought**, so a value
captured at construction is stale by exactly the last batch's cost. The mutation
that captures it once turns this red.

### Check: a-cache-hit-is-not-a-purchase

**Requirement:** A page a previous run bought is not charged to this one
**Surface:** `RequestMeter`
**Automated:** `test/request-attribution.spec.ts`

**Do**

Fetch once through a meter over a fetcher that returns `cached: true`.

**Expect**

The meter reports `0`.

### Check: meters-are-isolated-from-each-other

**Requirement:** Two items measuring the same fetcher cannot see each other
**Surface:** `RequestMeter`
**Automated:** `test/request-attribution.spec.ts`

**Do**

Put two meters over one fetcher. Buy one page through the first and two
through the second, concurrently.

**Expect**

The first reports `1`, the second `2`, the shared fetcher `3`.

### Check: attribution-counts-every-attempt

**Requirement:** Every attempt sent to the vendor is counted, with the pages delivered reported beside it
**Surface:** `LiveFetcher`
**Automated:** `test/counts-every-request.spec.ts` — "a fetch that fails 3 times counts 3", "a short 200 counts 1", "a page that arrives on its second attempt is 2 sent and 1 delivered", "takes the url, the cause, the status and the attempts, none defaulted"

**Do**

```bash
npx vitest run test/counts-every-request.spec.ts -t "fails 3 times counts 3|a short 200 counts 1|2 sent and 1 delivered|none defaulted"
```

**Expect**

Four pass. The fetcher counts 3 for a fetch that fails three times and 1 for a
200 too short to be a page, with 0 delivered for each. A page arriving on its
second attempt is 2 sent and 1 delivered. A `FetchFailed` cannot be built
without the attempts it took, so no failure can reach a meter uncounted.

### Check: attribution-charges-a-failure-its-attempts

**Requirement:** Every attempt sent to the vendor is counted, with the pages delivered reported beside it
**Surface:** `RequestMeter`
**Automated:** `test/counts-every-request.spec.ts` — "charges a failure's attempts, where it used to charge nothing", "charges a retried page for every attempt and one delivery"

**Do**

```bash
npx vitest run test/counts-every-request.spec.ts -t "charges a failure's attempts|charges a retried page"
```

**Expect**

Two pass. A meter over a fetch failing three times reports 3 sent and 0
delivered, where it used to report nothing; over a page retried once, 2 sent and
1 delivered.

### Check: attribution-pages-delivered-beside-spend

**Requirement:** Every attempt sent to the vendor is counted, with the pages delivered reported beside it
**Surface:** `GatewayClient`, `ReadRunClient`
**Automated:** `test/counts-every-request.spec.ts` — "on every resolution-run event that carries a spend", "on every read-run event", "CONTROL: absent when the caller has no figure, never a zero"

**Do**

```bash
npx vitest run test/counts-every-request.spec.ts -t "on every resolution-run event|on every read-run event|absent when the caller has no figure"
```

**Expect**

Three pass. A progress, completed and error event each carry
`requests_spent: 9` and `pages_delivered: 6` when given both; a read run's
events carry both too. Given no delivered figure, the body has
`requests_spent` and no `pages_delivered` key at all, never `0`.

### Check: attribution-sums-with-failures-and-retries

**Requirement:** Every attempt sent to the vendor is counted, with the pages delivered reported beside it
**Surface:** `runList`
**Automated:** `test/counts-every-request.spec.ts` — "per-item figures still sum to the fetcher's total, failures and retries included"

**Do**

```bash
npx vitest run test/counts-every-request.spec.ts -t "per-item figures still sum"
```

**Expect**

Over a run with failures, retries and a second pass, the fetcher sent more
requests than it delivered pages, and the per-item figures sum to exactly what
it sent.
