---
type: Capability
title: A run can say what it spent, and on which item
description: How a request is charged to exactly one item, why a delta on a shared counter was not an attribution, and what a failed item is charged.
---

# What a run spent, and on what

A run is tens of thousands of paid requests. Two numbers come out of it that
somebody acts on: what the whole run cost, and what one pairing cost. The first
prices the run at the approval gate; the second is
`insights_matches.requests_spent`, which a reviewer sees beside a pairing.

Both were wrong, in opposite directions, and neither was wrong in a way any test
could see.

## What was wrong

`resolveItem` reported `fetcher.liveRequestCount - startedAt` — a delta on the
counter belonging to the fetcher it was handed. `runList` runs **three** of those
concurrently over **one** fetcher, so each item's delta absorbed its two peers.

Measured over the committed corpus through a counting fetcher:

| Concurrency | Attributed | Actually bought |
|---|---|---|
| 1 | 44 | 58 |
| 3 | **117** | 58 |

The live queue run on 2026-09-11 showed the same shape: the gateway stored
**171** where the container's own counter said **62**.

The under-count at concurrency 1 is a second, independent bug: `runList`'s catch
branch reported `requests: 0`, so an item whose pipeline threw was charged
nothing for pages it had already bought.

#### Scenario: Every request a run buys is charged to exactly one item
- GIVEN a run over nine items with three workers in flight
- WHEN each item buys a search-engine lookup, a search and one or more product pages
- THEN the per-item figures sum to exactly what the fetcher bought
- AND that holds at concurrency 1 and at concurrency 3

**Checked by:** attribution-sums-to-the-fetcher-total

#### Scenario: An item resolved on its own is charged only for its own requests
- GIVEN three items resolved concurrently through one shared fetcher, without a run around them
- WHEN each reports what it spent
- THEN the three figures sum to exactly what the fetcher bought

**Checked by:** attribution-holds-for-a-direct-caller

#### Scenario: An item whose pipeline fails is charged what it had already bought
- GIVEN an item whose search-engine lookup and search succeed and whose product probe throws
- WHEN the run records the failure
- THEN the item is charged for the two pages it bought, not zero
- AND the resolution carries a `failure` rather than reading as a clean miss

**Checked by:** a-failed-item-is-charged-what-it-bought

#### Scenario: A page a previous run bought is not charged to this one
- GIVEN a fetcher that serves a page it already holds, reporting it as cached
- WHEN an item fetches it
- THEN nothing is charged for it

**Checked by:** a-cache-hit-is-not-a-purchase

#### Scenario: Two items measuring the same fetcher cannot see each other
- GIVEN two meters over one fetcher
- WHEN one buys a page and the other buys two
- THEN each reports its own count and the fetcher reports three

**Checked by:** meters-are-isolated-from-each-other

## Why a meter rather than better arithmetic

A counter per item, not a subtraction on a shared one. Two meters over one
fetcher cannot see each other, so nothing has to be subtracted and no correction
is needed when the concurrency changes.

`resolveItem` wraps the fetcher it is handed, **and** `runList` wraps one per
item. That looks redundant and is not:

- `runList`'s meter is the only one its catch branch can reach, because
  `resolveItem`'s is unreachable once it has thrown.
- `resolveItem`'s meter protects **direct callers**, of which this repo has
  several — the 53-row exit criterion and the outcome-branch spec both pass a
  fetcher of their own.

Double-wrapping is harmless: each level counts the calls made through it.

🔴 **That second reason is not speculative.** A mutation restoring the delta
inside `resolveItem` alone reported GREEN, because `runList`'s meter had already
made the delta honest — the suite was proving a property of `runList` and calling
it a property of `resolveItem`. The direct-caller scenario above exists because
of that green.

## What a request means, and where the definition lives

A charge happens when a fetch returns **not cached**. `LiveFetcher` reads a
previously bought page off disk and reports `cached: true`; that page cost money
once, on the run that bought it. The replay fetcher serves its whole corpus the
same way, which is why a replayed run correctly reports zero.

⚠️ **The rule is stated in two places** — the meter and `LiveFetcher.fetch` — and
it is pinned rather than commented: the per-item figures are asserted against the
fetcher's own total, so the two definitions cannot drift apart without turning a
check red.

## What this capability does NOT claim

⚠️ **It does not claim the total is what the vendor will invoice.** `LiveFetcher`
increments only on a success: a request that was made, answered `200`, and then
rejected for carrying too short a body is not counted, and neither is any of the
attempts a failing fetch makes. That is a known under-count of the vendor's side
of the ledger and it is a separate change — roadmap row
`resolution-runtime-counts-a-bought-request`.

⚠️ **And the money is still not validated.** `USD_PER_1000_REQUESTS` has never
been checked against an invoice. Attribution makes the request counts
trustworthy; it says nothing about the rate they are multiplied by.
