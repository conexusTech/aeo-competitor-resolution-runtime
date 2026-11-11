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
  - phase-ci-2
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

A queued container runs one of two jobs, picked by its payload: a
**resolution run** (`resolution_run_id`), described here, or a **listing read**
(`listing_read_run_id`), which fetches each page of listings the gateway
already knows once and reports what each says. Same image, same catalog entry.
Full behaviour: [listing-reads](/capabilities/listing-reads.md).

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

🔴 **Both journals are files on the container's own disk.** The next
container for a run — after this one was evicted, stopped or handed the run
back — starts with neither. So what protects
paid work across containers is what reached the gateway, and findings are
sent **at least every minute** as well as at every 100: the minute counts from
the oldest waiting finding, and a finished run cancels it. Measured
2026-11-11: an evicted 20-row run had reported 0 of 20, because a short list
never filled a batch. ⚠️ **Sends are serialised.** A timed send can be in
flight when the run ends, and the gateway drops a batch that lands after a
terminal event, so every flush waits for the one before it.

⚠️ **File mode is kept deliberately.** Every offline proof — including the 53-row
replay that is the previous change's exit criterion — runs through it, with no
queue, no gateway and no network.

## A long run is handed back, not lost — since 2026-11-11

A container ends before its run does in two ways, and both now end with
`yielded` rather than nothing (`insights-long-run-continues-past-the-job-timeout`).
Full behaviour: the last three scenarios of
[resolution-run-dispatch](/capabilities/resolution-run-dispatch.md).

| Ending | What the runtime does |
|---|---|
| **The job's time limit** (`stopTakingItemsAfterSec`) is spent | takes no new item, finishes the one in flight, still retries the items it held back after a failed first attempt — for up to 30 minutes past the limit, filing any not reached with their first attempt — files every finding, sends `yielded` |
| **SIGTERM** — eviction, the queue's deadline, a cancel, a node drain | takes no new item; items in flight get 20 s; held-back items are not retried but filed with their first attempt, if the first pass ends inside those 20 s; every closing step ends 27 s after the signal; exit 0 |

🔴 **What `yielded` leaves unfinished is only what this container never took**
(the lead, 2026-11-11, from the architecture review). Held-back items used to
be left unfiled on a budget yield, so unfinished; the gateway serves
unfinished items first, so every later container bought every persistent
failure again before reaching new work, and around the fiftieth container of
a 9,000-item list with 2% persistent failures one could file nothing. Now a
held-back item is retried or filed with its first attempt — a failure with
its reason, never "not carried". The one exception is SIGTERM with an item
stuck in flight: the held-back items are then never reached, stay
unfinished, and the log says how many.

🔑 **`yielded` carries exactly `completed`'s fields and this container's own
totals**, and comes after every finding it filed: the gateway sums the spend
across a run's containers and gives the items with no finding to a fresh one.
A run that finished everything says `completed` instead, limit or signal
notwithstanding. No limit in the job means none, exactly as before.

🔑 **Every run event names the container that sent it.** A run can now span
several containers, so the job may carry `legId`, a uuid. When it does, every
run event this container posts — `progress`, `resolutions`, `completed`,
`yielded`, `error` — carries it back as `leg_id`, and the gateway matches each
callback to its container. With none named, every body is byte for byte what
it was. A `legId` that is not a uuid string is refused before anything is
bought. Evidence uploads and read runs carry no leg id.

🔴 **Nothing may outlast Kubernetes' 30-second grace.** Once the run is under
way, every wait after the signal is bounded from the signal itself: items in
flight at 20 s, the last findings and `yielded` at 27 s. A gateway that never
answers the hand-back is abandoned at 27 s and the process still **exits 0** —
so exit 0 says the shutdown ran its steps, never that `yielded` reached the
gateway. The **backstop** (exit 1 at 28.5 s) catches only waits nothing else
bounds: the task record and the job fetch before the run starts, and the
journal loads. A second SIGTERM is ignored. The limits live in `SHUTDOWN`. The
real-process proof is `node scripts/sigterm-smoke.mjs`.

🔴 **Nothing is sent after the end is decided.** Once the run settles on
`completed`, `yielded` or `error`, the reporter is sealed: what was buffered is
sent, a progress tick still on its way is waited for, then the terminal event
goes, and afterwards no finding, flush or tick is sent. An item abandoned in
flight that finishes late is dropped whole — no finding, and no evidence
upload either, which would be an orphan charged to the organization's
allowance. The next container buys it again.
Found in review, 2026-11-11: without the seal such an item was filed after
`yielded`, reported twice, and its pages were missing from `yielded`'s spend.
A read run seals the same way after its in-flight wait.

⚠️ **A read run has no `yielded`.** Told to stop, it files its readings and
ends its batch in `error`, saying how many listings it read — the terminal the
gateway already records from the queue for a killed batch, now at once and
with the readings filed.

⚠️ **A container may yield having filed nothing.** On SIGTERM before its
first finding, and when one item outlasts the time limit — whose clock starts
before the job fetch — it still says `yielded`, with whatever it spent. The
gateway's continuation rule handles a hand-back with no progress.

⚠️ **The limit is a whole number of seconds from 1 to 86,400 (a day).**
Anything else is refused before anything is bought: no container lives a day,
so a larger figure is two builds disagreeing, most likely about the unit.

## Five competitors behind one seam — since 2026-11-11

Newegg and Amazon were joined on 2026-11-11 by Best Buy, B&H and Costco
(`insights-bestbuy-competitor`, `insights-bh-competitor`,
`insights-costco-competitor`). Each competitor is one adapter in
`src/adapters/`, registered by its own `slug` in `src/main.ts`; a job naming a
slug the image does not carry is refused before anything is bought. Behaviour:
[competitor-resolution](/capabilities/competitor-resolution.md) and
[listing-reads](/capabilities/listing-reads.md).

| Slug | Found by | Barcode search | Pages at once (fallback) | Country | One attempt | Probes per item | Hosts |
|---|---|---|---|---|---|---|---|
| `newegg` | search | no | 3 | vendor's | vendor's | run default, 8 | `newegg.com`, `www.newegg.com` |
| `amazon` | search | no | 3 | vendor's | vendor's | run default, 8 | `amazon.com`, `www.amazon.com` |
| `bestbuy` | search, barcode first | yes | 4 | `us` | 150 s | 3 | `bestbuy.com`, `www.bestbuy.com` |
| `bh` | search, barcode first; a part number needs its brand | yes | 4 | `us` | 150 s | 3 | `www.bhphotovideo.com` |
| `costco` | its product index | no | 4 | `us` | 280 s | 3 | `www.costco.com` |

🔑 **Every field of the seam is required**, so the next adapter must state an
answer rather than inherit one: `querySupport` (including
`barcodeIsSearchable` and `partNumberNeedsBrand`), `pacing`, `hosts`,
`fetchProfile`, `maxProbes`, `productIndex` and `categoryReader`, and on the
product page `sellerName`, `isFirstParty`, `unverifiableReason` and
`category`.
`parseProductPage` may return `null`, meaning the body is not a product page;
that is a probe nobody answered, never a listing without a barcode.

**Barcode first.** Where `barcodeIsSearchable` is true, the barcode is asked
before anything is bought to identify the item: its core zero-padded to 12
digits, or 13 when longer. The barcode stage opens at most two of its results,
from its own allowance, and never one the competitor marks as only a partial
match. A miss carries its candidates and its answered or unanswered tally into
the ordinary part-number path, and the barcode is not asked twice. Where false,
every plan is byte-identical to before.

**The product-index seam.** A competitor that cannot be searched states a
`ProductIndex`: the urls of its index (Costco's sitemap index), the least body
that list may be, the fewest products and the most files a whole index may
hold, and pure functions that parse the list, parse each product file, and pick
candidates for an item. The index is read through a run-scoped, single-flight
`IndexCache` (`src/product-index.ts`): one fetch of each file per run, awaited
by every worker and charged to one item. A failed or short read fails every
item with the reason, never a miss; the failure is dropped before the retry
after the run, which reads it once more. A lookup is recorded as
`index:<brand>`, and Costco's `parseSearchResults` is never called.

**The category-read seam** (`insights-reads-category-pages`, since
2026-11-12). Three seams now sit side by side, each pure: `RetailerAdapter`
(resolution), `ListingReader` (a page already known) and `CategoryReader` (a
category page, every product on it). Each adapter states `categoryReader`, or
`null`: B&H, Newegg and Amazon have one; Best Buy (only a category page's first
few cards carry a price) and Costco (a client-rendered shell) do not.

```ts
interface CategoryReader {
  pageUrl(categoryUrl: string, n: number): string | null; // null: off-host, not a category, n not a whole number >= 1
  readCategoryPage(html: string, n: number): CategoryPageResult;
}
type CategoryPageResult =
  | { kind: "page"; page: { products: { itemId: string; priceCents: number | null; inStock: boolean | null }[];
                            total: number | null; lastPage: number | null } }
  | { kind: "end"; detail: string }                    // the competitor says there is no such page
  | { kind: "not-a-category-page"; detail: string };   // a failure, never an empty category
```

A card's `itemId` is the id a search gives the same listing; a card with no
price is `null`, never 0. B&H answers a page past the last with a search, which
is `end` past page 1 and a failure on page 1. Product pages (`ParsedProduct`
and the read run's `ListingPageReading`) carry `category: { id, name, url } |
null`, the deepest level of their breadcrumb — B&H's primary category path,
Newegg's last `SubCategory`/`Category` crumb, Amazon's last browse node — and
`null` at Best Buy and Costco. A read run's reading carries it to the
gateway; the walk that uses the reader is the section below.
Behaviour: [category-reads](/capabilities/category-reads.md).

**Pages at once comes from the job.** The gateway sends the competitor's
`pagesAtOnce` from its retailer registry, on the resolution job and on the read
job, so it can be retuned without a rebuild and a re-pin. The adapter's
`pacing.pagesAtOnce` applies only when an older gateway sends none. Either is
clamped to `MAX_PAGES_AT_ONCE`, 4, and to at least 1, by one function used by
both run kinds. Pages within one item are fetched one after another, so pages
at once is the number of items (or listings) worked at once. Each worker still
waits 0.5–1.5 s after each page.

**The fetch profile.** `Fetcher.fetch(url, profile?)` takes the competitor's
`fetchProfile`: a `country` the live fetcher adds to the vendor's request body
(a request parameter, not a zone setting) and a client `timeoutMs` after which
an attempt is abandoned and retried as an ordinary failure. An optional
`minBodyBytes` lowers the shortest accepted body for one request, used only for
Costco's 1,547-byte sitemap index. Resolution passes the profile on the
competitor's own pages only (searches, probes, the index), never on the
client's catalogue or the search engine; a read run and a capture pass the
reader's. Newegg's and Amazon's requests are byte for byte what they were.

**The client's part number and brand are on the job.** Each job item may carry
`partNumber` and `brand` from the client's own list. They are the item's
identity ahead of anything derived: the part number is asked right after the
barcode, and the brand is the brand, including the brand a B&H part number
needs and the brand Costco's index is asked by. Absent or `null` means not
supplied, so an older gateway's job runs exactly as before. A value that is not
a string, or is longer than the gateway's own 128 (part number) or 160 (brand)
characters, refuses the job.

**Every attempt is a request.** The meter counts each attempt sent to the
vendor, retries, short bodies, timeouts and failures included, and reports
`requests_spent` as attempts with `pages_delivered` beside it. See
[resolution-request-attribution](/capabilities/resolution-request-attribution.md).

### The wire limits, in one place

🔴 **A value past one of the gateway's limits costs a whole batch.** The
gateway validates every finding in a resolutions event, and one string too long
answers the event with a 400 the runtime never retries. So every limit the
runtime posts against lives in `src/wire-limits.ts`, each the gateway's own
`@MaxLength`, rather than beside each use, where two spellings of one limit
drift:

| Limit | Characters | Held by |
|---|---|---|
| a resolution's `failure` | 512 | cut, ending "…" |
| the evidence's `title`, `sellerName`, `brand`, `model`, `itemId` | 512, 255, 160, 128, 128 | `withinEvidenceLimits`, on the chosen listing and every alternative |
| one query in a finding's trail | 500 | cut |
| `unverifiableReason` | 200 | every adapter's reasons are held to it in a test; a longer one is sent as `null` and logged |
| a category's `error` in a read run's `categories` event | 512 | cut, ending "…" — a requirement on the gateway's DTO |

A job item's `partNumber` and `brand` are checked on the way in against the
gateway's own 128 and 160. Two ceilings guard the way in from the vendor: a
response larger than 12 MB is refused while it streams (Costco's product pages,
the largest, are 2.8–3.8 MB), and a product index naming more files than its
`maxFiles` is refused before any is fetched.

## A category is read whole where the gateway planned it — since 2026-11-12

`insights-monitor-by-category-where-cheaper`, the runtime half. A read job may
carry `categories` beside its `listings`: which categories to read, and which
of the competitor's watched listings each should price, is the gateway's plan;
reading them is this container's. Behaviour:
[category-reads](/capabilities/category-reads.md).

```ts
categories?: { categoryId: uuid; url: string; kind: "walk" | "size";
               lastPage: number | null;
               listings: { listingId: uuid; itemId: string; url: string }[] }[]
```

- **`walk`** reads pages 1 to the last page the category itself states (the
  job's `lastPage` where it states none, or until the reader says the end),
  never more than `MAX_WALK_PAGES`, 60. **`size`** reads page 1 only. A card
  whose `itemId` equals a watched listing's prices it — on a walk that is
  whole.
- 🔴 **Everything else is read from its own page, in this container, today**:
  a card missing or unpriced; every listing of a walk with a page that is not
  a category page or could not be had after its re-reads, that saw fewer than
  90% of the products the category states, or that is longer than 60 pages;
  every listing at a competitor whose `categoryReader` is `null`. Hence each
  category listing carries its own `url` — required, checked like a read
  listing's (contract point 8, 2026-11-12) — and a job missing one is refused.
- 🔑 **One listing, one read, per job.** A category's listings are never also
  in the job's `listings`; a listing named twice anywhere, or a category named
  twice, refuses the job, as does more than 200 categories
  (`MAX_CATEGORIES_PER_JOB`) or any malformed field. Absent or empty
  `categories` is the read exactly as before.
- **Pages at once is shared.** A walk is one worker, its pages read one after
  another, so walks and product reads together never hold more pages open
  than the job's `pagesAtOnce` (at most 4). Walks are taken first, since the
  listings a walk leaves can only be read after it. A walk page uses the same
  fetcher, profile and request count as a product read; a throttled one is
  read again after the same 20/40/80 s, from the same job-wide budget, which
  is now sized by every watched listing in the job.

**What the gateway hears.** Every reading carries `priceSource` —
`product_page` (failed and gone readings included) or `category_page` — and
`category`, the breadcrumb a product page names (`null` for a card or a
failure). A card's reading is `pageFound: true` with its price and stock, no
barcode and `pageItemId` the card's id. After the last readings, one
`categories` event carries each finished category in job order — `status`
(`valid` | `invalid` | `failed`), `pagesRead`, `productsSeen`,
`watchedFound`, `total`, `lastPage`, `error` — with the run's
`requests_spent`, and only then the terminal event. A categories event the
gateway refuses ends the batch in `error`; one answered as a run gone sends
nothing more. A job with no categories sends no such event.

🔴 **A walk told to stop just stops.** It buys no further page, reports no
outcome and prices nothing; the gateway plans the category again next cycle.
Categories that finished are still reported before the batch's `error`, within
the shutdown's 27 s.

**Resolution findings say where their price came from too**:
`match.priceSource` is `product_page` where the probed page stated the price,
`search_results_page` where only the search card did, `null` with no price
(contract point 9: inside the match, none on alternatives). Newegg and Amazon
report `search_results_page` throughout, since their product pages state no
price.

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

The category walk keeps a job, and it is a different one: pricing listings
already paired, in monitoring, where reading a category whole is cheaper than
reading its watched products one by one — never finding an item, since a walk
that misses a listing proves nothing about it.

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
refinement.** 12% of the launch client's list are genuine EAN-13s. **Whether the
launch retailer's barcode field carries EAN-13 for an import product was answered
on 2026-09-10: it does.** Across all 255 captured product pages it published 6
distinct genuine EAN-13s, all with non-US GS1 prefixes — check
`resolution-reads-genuine-ean13`. Amazon publishes them too, under labels other
than `UPC`. `unverifiable` stays for the listings that publish no barcode at all
(91 of those 255 pages); collapsing it into `not-found` would report "not carried"
for items the retailer sells.

🔴 **"Not carried" needs an answer to every search.** An item is `not-found`
without a failure only when every search it attempted came back as a real results
page. One search that could not be fetched, or that came back as a robot check, an
error page or a page cut short, makes the item a failure with its reason, which the
gateway records as `error`. Every resolution carries the two counts, and a run
prints their totals in its summary. Until 2026-10-22 the search step dropped those
searches silently, and a run whose every fetch failed filed every item as not
carried.

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
src/adapters/        the seam; every retailer specific lives behind it (newegg, amazon, bestbuy, bh, costco)
src/query-plan.ts    which searches to ask, in what order, barcode first where answered
src/product-index.ts the run-scoped, single-flight read of a competitor's product index
src/own-hosts.ts     the gateway's rule for a competitor's own urls
src/wire-limits.ts   the gateway's limits on what a run posts, in one place
src/fetcher/         the live fetcher, and the offline replay behind one interface
src/run.ts           journal, resume, concurrency, cost meter
src/queue/           the task record — the queue's by-reference handover
src/gateway/         the gateway seam: the job in, the findings out
src/reporting/       batching, the one-minute send, remembering what was accepted
src/queue-run.ts     the sequence a dispatched run follows — testable
src/stop-signal.ts   SIGTERM, the shutdown's limits, and waits bounded by them
src/clock.ts         the clock every limit and wait is measured on — injectable
src/read-run.ts      a listing read: one fetch per listing, readings out
src/category-walk.ts a category walk or size read, and which listings it prices
src/job-file.ts      a job from a file, for a run with no services
src/main.ts          reads the environment, picks a mode. No logic.
```

🔑 **Everything above `fetcher/` is pure and offline**, which is what makes the
53-row outcome split a free, deterministic test rather than a paid manual run. The
sibling `aeo-howto-generation-runtime` has the same property for the same reason: a
runtime that can only be exercised against a live paid endpoint does not get
exercised.
