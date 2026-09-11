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
