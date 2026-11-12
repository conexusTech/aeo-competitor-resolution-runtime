---
type: Capability
title: One read of a competitor's category page prices every product it lists
description: A competitor's category page is read whole — every product it lists, named as its listing is named, with the price its card shows or none — and a body that is not a category page is a failure, never an empty category. Past the last page is the end. Product pages name the category their product sits in. B&H, Newegg and Amazon have category reads; Best Buy and Costco do not. A read job can ask for a category's walk or its size; only a whole walk prices a watched listing from its card, a size read only counts, and every listing a walk cannot price is read from its own page the same day. Every reading says which kind of page its price came from.
---

# One read of a category page prices every product it lists

Part of Phase CI-2. A monitoring day can read a whole category page — 28
products at B&H, 36 at Newegg — for the price of one request, where reading
each watched product costs one request apiece. `insights-reads-category-pages`
built the parsing half: an address for each page, and what one body says.
`insights-monitor-by-category-where-cheaper` built the rest in this runtime:
the walk across a category's pages, the read job that asks for it, and the
events that report it. Which categories to walk, and when, is the gateway's
plan (`aeo-backend`).

## What a reading says

Each competitor states a `categoryReader`, or `null` where its category pages
carry no products a server-side read can see. A reader builds page `n`'s
address from the category's (`null` off the competitor's own host, off a
category, or for no whole page number) and reads one body as exactly one of:

| Answer | Means | Carries |
|---|---|---|
| `page` | a page of the category | every product on it: its listing id, the price its card shows or `null`, its stock or `null`; the category's stated product count and last page, each or `null` |
| `end` | the competitor saying there is no such page — never page 1 | why |
| `not-a-category-page` | anything else: a refusal, a robot check, a product page, a search page, an empty body, a page cut short, a page 1 listing no products whatever count it states | why |

| Competitor | A page | Count and last page | Past the last page | Measured on |
|---|---|---|---|---|
| B&H | 28 | stated (`count`, `itemsPerPage`) | a search for the url's slug | Mice & Touchpads, pages 1, 2, 15 (last) and 16 |
| Newegg | 36 | stated (`TotalItemCount`, "Page k/M"); M is its 20-page browse ceiling | not captured; read off the page's own "Page k/M" | Desktop Memory pages 1 and 2, Laptop Memory page 1 |
| Amazon | as the grid shows (16 to 24) | not stated: Amazon's "over N results" shifts between pages | an empty grid Amazon says is empty; not captured | a results grid, pages 1 and 2 |

⚠️ **An Amazon walk the job gives no last page can only fail.** Its pages state
no count and no last page, so the walk reads until the page past the end — and
that page is a failure unless it shows Amazon's no-results widget, which no
captured page has. So it fails, and its listings are read from their own
pages. Amazon's category mode is off in the gateway's registry for this
reason.

A product page's reading — resolution's and the read run's — also names the
category its product sits in, the deepest level of its breadcrumb, as an id, a
name and an address, or `null`. A read run's reading carries it to the
gateway, which is how a watched listing is placed in a category a walk can
price.

## A monitoring day reads a category whole where it was planned

A read job may carry categories beside its listings. Each is a **walk** —
every page, to price its watched listings from their cards — or a **size** —
page 1 only, to learn its count and last page, pricing nothing. A category's
watched listings are not also among the job's listings: each is read exactly
once, from its card or from its own page. Cards price listings only on a walk
that is whole.

| A watched listing whose… | is |
|---|---|
| card shows a price, on a whole walk | priced from the card: `priceSource: "category_page"`, no barcode, no category |
| card is missing, or shows no price — or a price the gateway would refuse (not a whole number of cents from 1 to 1,000,000,000) | read from its own page, in the same container, as soon as a worker is free |
| walk is not whole — page 1 listing nothing or being the end, a page that is not one of the category, a page that could not be had after its re-reads, fewer than 90% of the stated products seen, more than 60 pages, the job's 600 category pages spent — or whose competitor has no category reads, or whose category was only sized | read from its own page, its card ignored if seen |

A walk reads to the last page the category states (the job's figure where it
states none, or until the category says it ends), never more than 60 pages,
and one job buys at most 600 category pages: a job planning more — a size
read plans 1, a walk its last page or 60 where it has none — is refused, and
a walk that grew past its plan stops when they are spent. A job is refused
too for a walk with no listings, or for one category named twice, however its
address is spelled or whichever of its pages it names.
Walks and product reads share the job's pages at once (never more than 4); a
walk's pages are read one after another. After the readings, one `categories`
event says what became of each category — status `valid`, `invalid` or
`failed`, pages read, products seen, watched listings found, the stated count
and last page, and why — then the terminal event. A walk the container is told
to stop part-way says nothing and prices nothing; the gateway plans it again.

## Scenarios

#### Scenario: One category page reports the price of every product it lists
- GIVEN a real category page of B&H, Newegg or Amazon
- WHEN it is read as the page number it was asked as
- THEN every product the page lists is reported, once each, in page order
- AND each carries the price its card shows, or no price
- AND the category's stated product count and last page come with it where the competitor states them

**Checked by:** category-read-bh-pages
**Checked by:** category-read-newegg-pages
**Checked by:** category-read-amazon-pages

#### Scenario: A product on a category page is named as its listing is named
- GIVEN a product a category page lists
- WHEN it is reported
- THEN its id is exactly the id a search of the same competitor gives the same listing
- AND a Newegg card showing a seller's offer is named by its product, as a search names it

**Checked by:** category-read-bh-ids-match-search
**Checked by:** category-read-newegg-ids-match-search
**Checked by:** category-read-newegg-offer-named-by-product
**Checked by:** category-read-amazon-ids-match-search

#### Scenario: A card that shows no price has no price, never a price of 0
- GIVEN a category page with a card whose price is withheld, missing or reads 0
- WHEN it is read
- THEN that card is reported with no price
- AND every card that is priced is priced above 0

**Checked by:** category-read-bh-withheld-price
**Checked by:** category-read-newegg-zero-price
**Checked by:** category-read-amazon-unpriced-card

#### Scenario: The page past the last is the end of the category
- GIVEN a category read past its last page
- WHEN the competitor answers that page
- THEN the reading is the end of the category, not a failure and not a page
- AND at B&H, whose answer past the end is a search for the url's slug, that answer to page 1 is a failure instead

**Checked by:** category-read-bh-past-the-end
**Checked by:** category-read-bh-page-one-search-is-a-failure
**Checked by:** category-read-newegg-past-the-last-page
**Checked by:** category-read-amazon-says-empty

#### Scenario: A page that is not a category page is a failure, never an empty category
- GIVEN a body that is not the category page asked for — a refusal, a robot check, an empty or short body, a product page, a search page, a hub page, a page cut short, a page naming another page number, or a page 1 listing no products whatever count it states
- WHEN it is read
- THEN the reading is not-a-category-page, with why
- AND never a page with no products, and never the end of the category

**Checked by:** category-read-bh-not-a-category
**Checked by:** category-read-newegg-not-a-category
**Checked by:** category-read-newegg-other-page-is-a-failure
**Checked by:** category-read-amazon-not-a-category
**Checked by:** category-read-amazon-empty-grid-unsaid
**Checked by:** category-read-amazon-other-page-is-a-failure
**Checked by:** category-read-cut-short
**Checked by:** category-read-empty-page-one-is-a-failure

#### Scenario: A page address is built only for a category on the competitor's own host
- GIVEN a category's address and a page number
- WHEN page n's address is asked for
- THEN it is the competitor's own form for that page
- AND there is none for an address off the competitor's host, one that is not a category, or a page number that is not a whole number from 1

**Checked by:** category-read-bh-page-addresses
**Checked by:** category-read-newegg-page-addresses
**Checked by:** category-read-amazon-page-addresses

#### Scenario: A B&H walk pages from the canonical address its first page states
- GIVEN a B&H category whose job address is not the canonical one, so B&H answers `/pn/N` of it with page 1
- WHEN the walk reads page 1, which states `<link rel="canonical">` as exactly `/c/buy/<slug>/ci/<id>` on B&H's host, with no query and the same `ci` id as the category asked for
- THEN pages 2 and on are asked of that canonical address and the walk ends valid
- AND a canonical that is anything else (another id, host or path shape, a query), or any canonical where the job's own address carries a query, is not followed: the walk pages from the job's address

**Checked by:** category-read-bh-canonical-paging

#### Scenario: A product page names the category its product sits in
- GIVEN a real product page of B&H, Newegg or Amazon
- WHEN it is read, by resolution or by a read run
- THEN it names the deepest category of its breadcrumb: its id, its name and its address
- AND at Newegg never the brand-narrowed crumb after it
- AND at Newegg its id carries its kind, `cat-<n>` for a Category and `sub-<n>` for a SubCategory, since Newegg numbers the two separately
- AND a page naming no category reads as none, the rest of it unchanged

**Checked by:** category-read-bh-breadcrumb
**Checked by:** category-read-newegg-breadcrumb
**Checked by:** category-read-amazon-breadcrumb
**Checked by:** category-read-no-breadcrumb-is-none

#### Scenario: Best Buy and Costco have no category reads
- GIVEN Best Buy, whose category pages carry a price on only their first few cards, and Costco, whose category pages carry none
- WHEN their category reads are asked for
- THEN each has none
- AND their product pages name no category

**Checked by:** category-read-none-for-bestbuy-and-costco

#### Scenario: A walk prices each watched listing from its card
- GIVEN a read job asking for a category's walk, and the watched listings in it
- WHEN every page of the category is read and the walk is whole
- THEN each watched listing whose card shows a price is priced from that card, as a category-page reading with no barcode and no category
- AND no product page is bought for it
- AND its reading's time is when the page carrying its card arrived
- AND a card seen on two pages prices its listing once

**Checked by:** category-walk-prices-from-cards, category-walk-card-twice-once

#### Scenario: A card's price the gateway would refuse is no price
- GIVEN a whole walk in which a watched listing's card reads as more than 1,000,000,000 cents, a fraction of a cent, or below 1
- WHEN the walk ends
- THEN that card prices nothing, and its listing is read from its own page
- AND a card at exactly 1,000,000,000 cents still prices its listing

**Checked by:** category-walk-out-of-range-price-is-no-price

#### Scenario: A listing its card cannot price is read from its own page, the same day
- GIVEN a whole walk in which a watched listing's card is missing or shows no price
- WHEN the walk ends
- THEN that listing is read from its own product page in the same container
- AND a worker with nothing to read starts on it at once, not after the walk's readings are sent
- AND it has exactly one reading, never also one from the category

**Checked by:** category-walk-missing-or-unpriced-falls-back, category-walk-leftovers-read-at-once

#### Scenario: A walk that cannot be trusted prices nothing
- GIVEN a walk in which page 1 lists no products or is the end, a page is not a page of the category, a page could not be had after its re-reads, or the walk saw fewer than 90% of the products the category states
- WHEN it ends
- THEN every watched listing in it is read from its own page, one whose card was seen included
- AND no page after the bad one is bought
- AND the category is reported failed or invalid, saying why — never valid with nothing seen
- AND a walk that ends on an empty page past page 1 keeps the count page 1 stated, so the 90% rule still judges it

**Checked by:** category-walk-bad-page-falls-back-whole, category-walk-failed-page-falls-back, category-walk-thin-walk-falls-back, category-walk-throttled-page-then-fails, category-walk-empty-page-one-fails

#### Scenario: A size read buys page 1 only, and prices nothing
- GIVEN a read job asking for a category's size
- WHEN it runs
- THEN page 1 alone is bought
- AND the category's stated count and last page are reported
- AND no card prices anything: every watched listing in it is read from its own page

**Checked by:** category-size-reads-page-one

#### Scenario: A walk reads to the category's own last page, and never past 60
- GIVEN a walk
- WHEN its pages are read
- THEN it stops at the last page the category states, at the job's figure where the category states none, or where the category says it ends
- AND it never reads more than 60 pages
- AND a walk the job says has more than 60 pages is not started, and one whose category states more stops after its first page, each reading its listings from their own pages

**Checked by:** category-walk-reads-to-the-stated-last-page, category-walk-reads-to-the-end, category-walk-never-past-sixty, category-walk-too-long-is-not-a-walk

#### Scenario: One job buys at most 600 category pages
- GIVEN a read job whose walks plan more than 600 category pages, or whose categories have grown past what it planned
- WHEN the job is read, and when it runs
- THEN a job planning more than 600 is refused before anything is bought
- AND a walk past the 600th page bought buys nothing more, is reported failed, and its listings are read from their own pages

**Checked by:** category-job-page-plan-refused, category-walk-page-budget-spent

#### Scenario: A competitor without category reads reads its watched listings from their own pages
- GIVEN a read job asking for categories at a competitor with no category reads
- WHEN it runs
- THEN no category page is bought
- AND every category is reported failed, saying so
- AND every watched listing is read from its own page

**Checked by:** category-walk-none-for-a-competitor-without

#### Scenario: Walks and product reads share the job's pages at once
- GIVEN a job with walks, product reads and the listings walks leave, and a pages-at-once figure
- WHEN it runs
- THEN never more pages are open at once than that figure, and never more than 4
- AND every page is bought once

**Checked by:** category-walk-pages-at-once

#### Scenario: A job with no categories reads exactly as before
- GIVEN a read job with no categories, absent or empty
- WHEN it runs
- THEN it buys the same pages in the same order and sends the same events as before category reads, with no categories event
- AND its readings differ only by saying they are product-page readings and naming their category

**Checked by:** category-walk-none-is-todays-read

#### Scenario: Every category's outcome reaches the gateway before the end
- GIVEN a read job asking for categories
- WHEN its readings are filed
- THEN one categories event follows, one entry per category: its status, pages read, products seen, watched listings found, stated count and last page, and why it is not valid
- AND then the terminal event, and nothing after it
- AND a categories event the gateway refuses ends the batch in error, and one for a run that has ended sends nothing more

**Checked by:** category-report-before-the-end, category-report-refused-is-an-error, category-report-on-the-wire

#### Scenario: A category the job asks for in a shape this build cannot work is refused before anything is bought
- GIVEN a read job whose categories are malformed, more than 200, off the competitor's own host, name one category twice, or name one listing twice in the job
- WHEN the job is read
- THEN it is refused, and nothing is bought
- AND a watched listing with no page of its own is refused, since its fallback needs one
- AND a walk with no watched listings is refused, since it would buy pages for nothing
- AND one category named twice is refused however its address is spelled — a trailing slash, the host's case, the query's order — or whichever of its pages it names

**Checked by:** category-job-malformed-refused, category-job-listing-once, category-job-off-host-refused, category-job-one-category-one-walk, category-job-walk-needs-listings

#### Scenario: A walk told to stop just stops
- GIVEN a walk under way when the container is told to stop
- WHEN the stop arrives
- THEN the walk buys no further page
- AND it reports no outcome and prices nothing, so the gateway plans it again
- AND categories that finished are still reported before the batch ends in error

**Checked by:** category-walk-told-to-stop

#### Scenario: Every reading says which kind of page its price came from
- GIVEN a read job
- WHEN a listing is read, from its card or from its own page
- THEN its reading says category page or product page
- AND a product page's reading names the category its breadcrumb places it in, and a card's names none

**Checked by:** category-reading-says-its-page

#### Scenario: The committed category pages read as the captured pages did, and carry no session value
- GIVEN a real category or product page committed as a test page
- WHEN it was cut down to what the parsers read
- THEN every parser read it exactly as the captured page
- AND no session id, token, address, cookie or vendor id survives in it

**Checked by:** category-read-distilled-pages-parse-as-captured
**Checked by:** category-read-pages-carry-no-session
