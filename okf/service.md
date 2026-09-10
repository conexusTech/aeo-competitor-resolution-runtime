---
type: Service
title: aeo-competitor-resolution-runtime
description: Resolves each item on a client's watchlist to a listing at a competitor retailer and proves the pairing by barcode, reporting an unproven candidate as unconfirmed rather than as a match.
resource: git@github.com:conexusTech/aeo-competitor-resolution-runtime.git
owners:
  - joe@conexus-tech.com
tags:
  - competitor-insights
  - phase-ci-1
  - runtime
  - queue-dispatched
timestamp: 2026-09-10
---

# aeo-competitor-resolution-runtime

Answers one question, per item, for a whole client list: **does this product exist
at this retailer, and is the pairing proven?**

It is dispatched as a container image through
[conqrse-queue](/index.md) exactly as `configurable-prospect-scanner` is. One
resolution run over a real client list is tens of thousands of fetches and hours
of work — not request-scoped, and it must not share a process with the API.

Input is a watchlist owned by `aeo-backend`; findings go back through that repo's
runtime-callback controller. **This runtime owns no database schema.**

## How a run starts and reports — since 2026-09-10

⚠️ **This section describes real behaviour. Until `resolution-run-dispatch` it
was aspirational**: the container read its job from a file path on disk, reported
by writing to standard output, and contained no HTTP call at all outside the
proxy — so the sentence above about findings going back through the callback
controller described an intention rather than a code path.

Two ways in, one pipeline. Full behaviour:
[resolution-run-dispatch](/capabilities/resolution-run-dispatch.md).

| Mode | Selected by | Job from | Findings to |
|---|---|---|---|
| **Queue** | `TASK_RECORD_ID` present | the queue by reference, then the gateway | the gateway, in batches, as the run goes |
| **File** | its absence | `RESOLUTION_JOB_FILE` | standard output |

🔑 **The queue injects exactly one variable and keeps the job in the portal's
database.** So the container reads the task record for the run, tenant and
organization, then fetches the client's list from
`GET /runtime/insights/runs/:runId`. The list is deliberately **not** in the
dispatch payload: the real client export is 8,926 rows, and the queue persists
a payload in its own tables.

## Evidence — since 2026-09-11

After each finding the run offers the **page that finding was decided on** to
`POST /runtime/insights/runs/:runId/captures`, and the gateway answers with the
key it stored it under. Full behaviour:
[resolution-evidence-capture](/capabilities/resolution-evidence-capture.md).

🔴 **The artefact is the page's bytes, not a picture of it, and that is
structural rather than provisional.** This runtime has no browser and cannot
usefully have one: the proxy exists because the retailer refuses a plain
request, so a headless browser in a Kubernetes Job would fail on exactly the
sites this is for. `png` is in the format vocabulary and **no code path produces
one** — a job asking for it is refused by name rather than served HTML labelled
as an image.

🔑 **The bytes cost nothing**: the chosen page was fetched moments earlier, so
re-reading it is a cache hit. That is what makes evidence free rather than a
second paid request per item, and it is why captures are offered per
**resolution** rather than per fetch.

⚠️ **The budget travels with the job.** The organization's quota, the retailer's
registry capability and which items qualify are the gateway's to know; the
per-run ceiling is this container's to keep. A job carrying no capture policy
means captures are **off** — never on.

🔑 **Two journals, and they answer different questions.**
`resolutions.jsonl` is what the run **found** — it stops a resume re-buying
pages. `reported.jsonl` is what the gateway **accepted** — it stops a resume
re-sending findings already filed. The acknowledgement is written only **after**
the gateway's 200: written before, a container dying in that window would lose
the finding permanently, since it is journalled (so never re-resolved) and
marked reported (so never re-sent). At-least-once delivery to an idempotent
receiver is the only pair that cannot lose data.

⚠️ **File mode is kept deliberately.** Every offline proof — including the 53-row
replay that is the previous change's exit criterion — runs through it, with no
queue, no gateway and no network.

## The strategy, and why it is not the obvious one

The obvious design is to walk the retailer's categories into a local corpus and
match the client list against it. **The handover recon kills that**: the launch
retailer caps unfiltered subcategory browsing at 20 pages ≈ 720 items, against
3,564 in one subcategory alone. A bulk walk reaches roughly a fifth of a
subcategory, so an item absent from the corpus is **indistinguishable from one the
retailer does not sell** — the product would report "not carried" and be wrong,
silently, across the long tail. That is worse than a review queue, because nobody
checks an answer.

It also kills the counter-proposal — walk once and harvest every barcode into an
index — because the walk is capped, so the index inherits the same ceiling.

So each item is resolved individually, and the pairing is proven by barcode. The
recon settles what that costs: **a barcode verifies but does not locate.** The
retailer routes long numeric queries to an error page (measured: the constraint is
**10 or more digits**, not "numeric") and embeds the barcode only on the product
page. Hence three steps: derive an identity, search on it, then verify by barcode.

The category walk keeps a job, and it is a different one — assortment intelligence.

## Three outcomes, and the third is not a match

| outcome | means |
|---|---|
| `verified` | the retailer's page carries a barcode equal to the client's |
| `unconfirmed` | a candidate with model-level evidence, no barcode agreement — **a human adjudicates; never presented as a match** |
| `unverifiable` | a listing was found but the retailer publishes no comparable barcode for it |
| `not-found` | no candidate with model-level evidence |

🔴 **`unconfirmed` being distinct from `verified` is load-bearing.** Identity is
derived by scraping search-result titles, and **every observed mis-resolution
originated in that step** — a junk identity once matched a $3,727 server to a $13
accessory. A minimum evidence score exists for exactly that, and reporting nothing
beats reporting something wrong.

⚠️ **`unverifiable` is a first-class outcome from the first commit, not a later
refinement.** 12% of the launch client's list are genuine EAN-13s, and **nobody has
yet measured whether the retailer's barcode field carries EAN-13 for an import
product.** If it does not, those items are unverifiable rather than mismatched —
a different answer, and a coverage limit no document states. Collapsing it into
`not-found` would report "not carried" for items the retailer sells.

## Things that will bite you

- 🔴 **The retailer's barcode field is not fixed-width — it zero-pads.** Measured
  across the 22 verified rows of the 53-row run: 18 twelve-digit, 2 thirteen, 2
  fourteen, and **only 18 of 22 are byte-equal to the client's value.** A byte
  comparison reports **4 of 22 verified pairings as mismatches — 18%** — and a
  false mismatch is the worst output available here, because it reads exactly like
  a real one. **The comparison key is derived at compare time and never stored**:
  strip leading zeros from both sides. Storage stays faithful, which is why
  `aeo-backend` keeps an EAN-13 at 13 digits.
- **A marketplace listing carries the *seller's* barcode**, not the
  manufacturer's — observed on a network switch offer reporting an unrelated
  barcode. So a first-party listing outranks a marketplace one for probing: a
  first-party match is strong evidence while a marketplace mismatch is weak.
- ⚠️ **The cost rate has never been checked against an invoice.** The run meter
  prices requests at $1 per 1,000, measured at 4.70 requests per row without a
  manufacturer part number — about $42 for a full 8,926-row list. Treat it as an
  estimate, never as a price.
- **41.5% verified is a sample of 53 rows** — 0.6% of the one real client file.

## Layout

```
src/gtin.ts          the comparison key — pure
src/identity/        search results -> candidate identities — pure
src/ranking.ts       candidate scoring — pure
src/resolve.ts       the three-step pipeline, adapter-agnostic
src/adapters/        the seam; every retailer specific lives behind it
src/fetcher/         the live fetcher, and the offline replay behind one interface
src/run.ts           journal, resume, concurrency, cost meter
src/queue/           the task record — the queue's by-reference handover
src/gateway/         the gateway seam: the job in, the findings out
src/reporting/       batching, and remembering what was accepted
src/queue-run.ts     the sequence a dispatched run follows — testable
src/job-file.ts      a job from a file, for a run with no services
src/main.ts          reads the environment, picks a mode. No logic.
```

🔑 **Everything above `fetcher/` is pure and offline**, which is what makes the
53-row outcome split a free, deterministic test rather than a paid manual run. The
sibling `aeo-howto-generation-runtime` has the same property for the same reason: a
runtime that can only be exercised against a live paid endpoint does not get
exercised.
