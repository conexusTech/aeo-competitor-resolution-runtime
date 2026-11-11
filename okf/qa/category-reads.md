---
type: QA Checklist
title: QA — one read of a competitor's category page prices every product it lists
description: One check per requirement in the category-reads capability, with what to do and what to expect.
---

# QA — category reads

Checks for [category-reads](/capabilities/category-reads.md). Written with the
tests, before the readers passed them.

🔑 **Every check is automated and offline**: real category and product pages
from `test/raw` (B&H's Mice & Touchpads at pages 1, 2, 15 and 16, Newegg's
Desktop and Laptop Memory, an Amazon results grid), distilled and proven
parse-identical to their captures, and small hand-built bodies — each said to
be synthetic where it is built — for the cases no capture shows. No credential,
no network, no request bought.

```bash
npx vitest run test/category-reads.spec.ts test/breadcrumb-category.spec.ts
```

🔴 **Fourteen mutations, each shown red, then reverted**: each rule below names
the mutation that turned its check red. Both distillers were also shown to
refuse a page whose trim changes a parse.

⚠️ **Not captured, so checked only on hand-built bodies**: Newegg's and
Amazon's answers past a category's last page, and a refusal served for a
category page at any competitor.

---

### Check: category-read-bh-pages

**Requirement:** One category page reports the price of every product it lists
**Surface:** `bhAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read B&H's Mice & Touchpads pages 1, 2 and 15 (the last) as pages 1, 2 and 15.

**Expect**

28, 28 and 20 products; 76 distinct ids across the three; each page states 412 products and last page 15; page 1's first card is `1910635` at 11999 cents, in stock. Stock B&H calls dynamic is `null` (8 of page 15's 20), never false.

### Check: category-read-newegg-pages

**Requirement:** One category page reports the price of every product it lists
**Surface:** `neweggAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read Newegg's Desktop Memory pages 1 and 2 and Laptop Memory page 1.

**Expect**

36 products on each, every one priced above 0; 72 distinct ids across Desktop Memory's two pages; counts 3564, 3568 and 2017; last page 20 on each; the first card is `N82E16820236991` at 46999 cents, in stock.

### Check: category-read-amazon-pages

**Requirement:** One category page reports the price of every product it lists
**Surface:** `amazonAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read the Amazon results grid's pages 1 and 2.

**Expect**

16 products on each; the first is `B0BFGB2D2Z` at 47200 cents with stock `null`; no count and no last page.

### Check: category-read-bh-ids-match-search

**Requirement:** A product on a category page is named as its listing is named
**Surface:** `bhAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read each B&H category page, and parse the same body with B&H's search parse.

**Expect**

The two id lists are equal, in order.

### Check: category-read-newegg-ids-match-search

**Requirement:** A product on a category page is named as its listing is named
**Surface:** `neweggAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read each Newegg category page, and parse the same body with Newegg's search parse, which is how every Newegg listing the platform holds got its id.

**Expect**

The two id lists are equal, in order; warehouse ids in public form (`N82E16820156314`), marketplace ids as they are (`0RM-005A-000T8`). 🔴 Mutation: naming a card by its own `Item` instead of `ParentItem` turns this red.

### Check: category-read-newegg-offer-named-by-product

**Requirement:** A product on a category page is named as its listing is named
**Surface:** `neweggAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read a hand-built Newegg category page with an offer `9SIA6ZPK9U9854` of product `86-949-047`, a warehouse item and a combo.

**Expect**

Two products, `N82E16886949047` and `N82E16811222333`; the combo is not one.

### Check: category-read-amazon-ids-match-search

**Requirement:** A product on a category page is named as its listing is named
**Surface:** `amazonAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read each Amazon grid page, and parse the same body with Amazon's search parse.

**Expect**

The two ASIN lists are equal, in order.

### Check: category-read-bh-withheld-price

**Requirement:** A card that shows no price has no price, never a price of 0
**Surface:** `bhAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read B&H's pages 1, 2 and 15, and look at the cards with no price.

**Expect**

Page 1's are exactly `1431406`, `1760693` and `1849969`, page 2's exactly `1760694` — the MAP items, whose state holds a number beside the flag — and every other card is priced above 0. 🔴 Mutation: reading the state's number for a MAP card turns this red.

### Check: category-read-newegg-zero-price

**Requirement:** A card that shows no price has no price, never a price of 0
**Surface:** `neweggAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read a hand-built Newegg category page whose cards are priced 0, not priced, and priced 12.50 with no stock stated.

**Expect**

No price, no price, and 1250 cents with stock `null`. 🔴 Mutation: dropping the above-0 rule turns this red.

### Check: category-read-amazon-unpriced-card

**Requirement:** A card that shows no price has no price, never a price of 0
**Surface:** `amazonAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read the Amazon grid's page 2; then a hand-built grid with a card showing $0.00 and one at $12.34 saying "Currently unavailable".

**Expect**

Page 2's one unpriced card is `B0D2P1CVQD`, with no price; the hand-built cards read as no price, and 1234 cents not in stock. 🔴 Mutation: dropping the above-0 rule turns this red.

### Check: category-read-bh-past-the-end

**Requirement:** The page past the last is the end of the category
**Surface:** `bhAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read B&H's answer to page 16 of 15 as page 16; read page 15's body as page 16.

**Expect**

Both are the end of the category. 🔴 Mutation: treating a search past page 1 as a failure turns this red.

### Check: category-read-bh-page-one-search-is-a-failure

**Requirement:** The page past the last is the end of the category
**Surface:** `bhAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read the page-16 search answer as page 1, and page 2's body as page 1.

**Expect**

Both are not-a-category-page, never the end. 🔴 Mutation: reading a search to page 1 as the end turns this red.

### Check: category-read-newegg-past-the-last-page

**Requirement:** The page past the last is the end of the category
**Surface:** `neweggAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read Desktop Memory's page 1 ("Page 1/20") as page 21.

**Expect**

The end of the category. 🔴 Mutation: never reading the end off the page's last page turns this red.

### Check: category-read-amazon-says-empty

**Requirement:** The page past the last is the end of the category
**Surface:** `amazonAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read a hand-built grid holding Amazon's no-results message and no cells, as page 3.

**Expect**

The end of the category.

### Check: category-read-bh-not-a-category

**Requirement:** A page that is not a category page is a failure, never an empty category
**Surface:** `bhAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read B&H's M310 product page, its M310 text search, an empty body, a short body, a refusal and a robot check.

**Expect**

Each is not-a-category-page; the product page says it has no listing payload.

### Check: category-read-newegg-not-a-category

**Requirement:** A page that is not a category page is a failure, never an empty category
**Surface:** `neweggAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read a Newegg product page, the most populated search page, a search with no results, a hand-built hub page, an empty body, a short body, a refusal and a robot check.

**Expect**

Each is not-a-category-page: the product page as "a product page", the search as "a search results page, not a category", the hub as having no listing pagination. 🔴 Mutation: accepting a search page's breadcrumb as a category turns this red.

### Check: category-read-newegg-other-page-is-a-failure

**Requirement:** A page that is not a category page is a failure, never an empty category
**Surface:** `neweggAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read Desktop Memory's page 1 as page 2.

**Expect**

Not-a-category-page: "Newegg served page 1 when page 2 was asked".

### Check: category-read-amazon-not-a-category

**Requirement:** A page that is not a category page is a failure, never an empty category
**Surface:** `amazonAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read Amazon's committed product page, an empty body, a short body, a refusal and a robot check.

**Expect**

Each is not-a-category-page; the product page as having no results grid. 🔴 Mutation: reading a body with no grid as the end turns this red.

### Check: category-read-amazon-empty-grid-unsaid

**Requirement:** A page that is not a category page is a failure, never an empty category
**Surface:** `amazonAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read a hand-built body with Amazon's results container and no cells and no no-results message.

**Expect**

Not-a-category-page: "a results grid with no cells and no word that it is empty". 🔴 Mutation: reading it as the end turns this red.

### Check: category-read-amazon-other-page-is-a-failure

**Requirement:** A page that is not a category page is a failure, never an empty category
**Surface:** `amazonAdapter.categoryReader.readCategoryPage`
**Automated:** test/category-reads.spec.ts

**Do**

Read the grid's page 2 as page 1.

**Expect**

Not-a-category-page: "Amazon served page 2 when page 1 was asked".

### Check: category-read-cut-short

**Requirement:** A page that is not a category page is a failure, never an empty category
**Surface:** `categoryReader.readCategoryPage`, B&H and Newegg
**Automated:** test/category-reads.spec.ts

**Do**

Read the first half of B&H's page 1 and of Newegg's Desktop Memory page 1.

**Expect**

Each is not-a-category-page.

### Check: category-read-bh-page-addresses

**Requirement:** A page address is built only for a category on the competitor's own host
**Surface:** `bhAdapter.categoryReader.pageUrl`
**Automated:** test/category-reads.spec.ts

**Do**

Ask for pages 1 and 16 of `…/ci/18369`, page 3 and page 1 of its `/pn/2` address; then for an address off B&H's host, an `http:` one, a product page's, a string that is no url, page 0 and page 1.5.

**Expect**

The category's address, `…/pn/16`, `…/pn/3` and the category's address again; then no address for each of the six.

### Check: category-read-newegg-page-addresses

**Requirement:** A page address is built only for a category on the competitor's own host
**Surface:** `neweggAdapter.categoryReader.pageUrl`
**Automated:** test/category-reads.spec.ts

**Do**

Ask for pages 1 and 2 of `…/SubCategory/ID-147`, page 3 of its `/Page-2` address and page 1 on the bare `newegg.com`; then for an address off Newegg's host, a search, a product page, page 0 and page -1.

**Expect**

The category's address, `…/Page-2`, `…/Page-3` and the `www` address; then no address for each of the five.

### Check: category-read-amazon-page-addresses

**Requirement:** A page address is built only for a category on the competitor's own host
**Surface:** `amazonAdapter.categoryReader.pageUrl`
**Automated:** test/category-reads.spec.ts

**Do**

Ask for pages 1 and 2 of a results grid, page 1 of its `page=2` address, page 2 of an address off Amazon's host, and page 0.

**Expect**

The grid's address, the same with `&page=2`, the grid's address, then no address twice.

### Check: category-read-bh-breadcrumb

**Requirement:** A product page names the category its product sits in
**Surface:** `bh.parseProductPage`, `bh.readListingPage`
**Automated:** test/breadcrumb-category.spec.ts

**Do**

Parse B&H's M310, G Pro kit, Z623 and BK350 product pages, read the M310 as a read run does, and ask for page 2 of the M310's category.

**Expect**

Mice & Touchpads (`18369`) for the M310 and the kit, Computer Speakers (`6565`), UPS Backup (`12831`), each with its `/ci/` address; the reading names Mice & Touchpads; page 2 is `…/ci/18369/pn/2`. 🔴 Mutation: taking the root of the path instead of its leaf turns this red.

### Check: category-read-newegg-breadcrumb

**Requirement:** A product page names the category its product sits in
**Surface:** `newegg.parseProductPage`, `newegg.readListingPage`
**Automated:** test/breadcrumb-category.spec.ts

**Do**

Parse and read Newegg's four committed product pages; parse a hand-built breadcrumb whose name carries `&#x27;` and `&amp;`.

**Expect**

TV Mounts & Install Accessories (`696`), Internal Power Cables (`2820`), Driving Simulators (`3929`) and Audio Video Converters (`3048`), each its `SubCategory` address, never the brand crumb after it; the hand-built name decodes to "Ruth's Cables & More". 🔴 Mutation: accepting the brand crumb turns this red.

### Check: category-read-amazon-breadcrumb

**Requirement:** A product page names the category its product sits in
**Surface:** `amazon.parseProductPage`, `amazon.readListingPage`
**Automated:** test/breadcrumb-category.spec.ts

**Do**

Parse and read Amazon's committed product page.

**Expect**

Memory (`172500`), at `https://www.amazon.com/b?node=172500`. 🔴 Mutation: keeping the first crumb instead of the last turns this red.

### Check: category-read-no-breadcrumb-is-none

**Requirement:** A product page names the category its product sits in
**Surface:** the three breadcrumb readers
**Automated:** test/breadcrumb-category.spec.ts

**Do**

Read a B&H product page with its category path renamed away; a body with no breadcrumb, one with only "Home", and one whose crumb is off Newegg's host; an Amazon breadcrumb with no links.

**Expect**

No category for each; the B&H page still reads its barcode `097855066237`.

### Check: category-read-none-for-bestbuy-and-costco

**Requirement:** Best Buy and Costco have no category reads
**Surface:** `bestbuyAdapter`, `costcoAdapter`
**Automated:** test/category-reads.spec.ts, test/breadcrumb-category.spec.ts

**Do**

Look at each adapter's category reader, and parse Best Buy's M310 and Costco's SL900UC product pages.

**Expect**

Best Buy and Costco have none; B&H, Newegg and Amazon each have one; neither product page names a category. 🔴 Mutation: giving Best Buy a reader turns this red.

### Check: category-read-distilled-pages-parse-as-captured

**Requirement:** The committed category pages read as the captured pages did, and carry no session value
**Surface:** `scripts/distil-bh.mjs`, `scripts/distil-category.mjs`
**Automated:** scripts/distil-category.mjs

**Do**

Distil each committed category page and each re-distilled B&H product page from its capture in `meriwether-data-scraper`.

**Expect**

Each run prints its sizes and exits 0, having required the category reader (at several page numbers), the search parse and the product-page parses to give identical JSON on the capture and the distilled page. 🔴 Shown to refuse: a distiller that dropped a card's price, or a category's address, exits with "distilled page parses differently from the raw".

### Check: category-read-pages-carry-no-session

**Requirement:** The committed category pages read as the captured pages did, and carry no session value
**Surface:** `test/raw/newegg-category-*`, `test/raw/amazon-grid-*`, `test/raw/bh-*`
**Automated:** test/category-reads.spec.ts, test/bh-fixtures.spec.ts

**Do**

Scan every committed Newegg and Amazon category page, and every B&H page, for session ids, tokens, uuids, addresses, cookies and vendor ids; feed the same markers synthetic samples.

**Expect**

No marker in any committed page; each synthetic sample is found.

---

## The walk, its job and its events

Checks for the walk (`insights-monitor-by-category-where-cheaper`, the
runtime half), written with its tests.

🔑 **Every check is automated and offline.** The category pages are
SYNTHETIC — a JSON body a test reader parses — because no real walk of more
than four pages has been captured; the fetcher double, the job parser, the
gateway port and the read run are the real ones. One check reads B&H's real
Mice & Touchpads page 1 through the B&H reader.

```bash
npx vitest run test/category-monitoring.spec.ts
```

🔴 **Twenty-two mutations, each shown red, then reverted**: an invalid walk
still pricing; an unpriced card pricing; the 90% share lowered, and its
boundary moved by one; a size read buying two pages; either 60-page ceiling
unchecked; the job's last page preferred over the category's; the walk
ignoring the stop; a throttled page not re-read; workers not capped by pages
at once; a categories event sent for a job with none; a refused categories
event completing; the lost wake-up (a worker waiting on a walk that ended
while it sent a batch); fallbacks dropped; a category's host unchecked; a
category listing's url not required; a listing allowed twice; the 200 cap
lifted; a reading naming no category; and both of a finding's price sources.

### Check: category-walk-prices-from-cards

**Requirement:** A walk prices each watched listing from its card
**Surface:** `runReadJob`, `walkCategory`, `settleWalk`
**Automated:** test/category-monitoring.spec.ts — "prices each watched listing from its card and buys no product page"

**Do**

Walk a two-page category stating 6 products and last page 2, watching A (page 1, 1299 cents) and D (page 2, 899 cents).

**Expect**

Exactly the two category pages are bought. A and D each have one reading, equal field for field to `pageFound: true`, `pageItemId` their own id, `barcode: null`, `additionalBarcodes: []`, the card's price and stock, `failure: null`, `priceSource: "category_page"`, `category: null`, with `readAt` the arrival of the page their card was on (06:00:01 and 06:00:02). The categories event is `valid`, 2 pages, 6 products, 2 watched found, total 6, last page 2, no error; the events are readings, categories, completed.

### Check: category-walk-card-twice-once

**Requirement:** A walk prices each watched listing from its card
**Surface:** `walkCategory`
**Automated:** test/category-monitoring.spec.ts — "CONTROL: the same card twice prices its listing once"

**Do**

Walk two pages that both list A, at 1299 then 1399.

**Expect**

One reading for A, at 1299 (the first card), and A's product page is never bought.

### Check: category-walk-missing-or-unpriced-falls-back

**Requirement:** A listing its card cannot price is read from its own page, the same day
**Surface:** `runReadJob`, `settleWalk`
**Automated:** test/category-monitoring.spec.ts — "reads an unpriced or missing card's listing from its own page, the same day"

**Do**

Walk a whole one-page category watching A (priced card), B (card with no price) and Z (no card).

**Expect**

The category page and B's and Z's product pages are bought, nothing else. Three readings: A from its card; B and Z `product_page` readings at their page's price with the barcode and the breadcrumb category. Never a price of 0 for B. The category is `valid` with 2 watched found.

### Check: category-walk-bad-page-falls-back-whole

**Requirement:** A walk that cannot be trusted prices nothing
**Surface:** `walkCategory`, `settleWalk`
**Automated:** test/category-monitoring.spec.ts — "a page that is not a category page mid-walk sends every watched listing to its own page"

**Do**

Walk a three-page category whose page 2 is a robot check, watching A (priced on page 1) and D (on page 3).

**Expect**

Page 3 is never bought; A's and D's product pages are. Both readings are `product_page` — A's card is not used. The category is `failed`, 1 page read, 1 watched found, total 6, last page 3, its error starting "page 2" and naming it not a page of the category.

### Check: category-walk-failed-page-falls-back

**Requirement:** A walk that cannot be trusted prices nothing
**Surface:** `walkCategory`
**Automated:** test/category-monitoring.spec.ts — "a page that could not be had fails the walk, and its listings are read from their own pages"

**Do**

Walk a category whose page 2 answers 503.

**Expect**

A's reading is `product_page`; the category is `failed` with "page 2 could not be read: … status=503".

### Check: category-walk-thin-walk-falls-back

**Requirement:** A walk that cannot be trusted prices nothing
**Surface:** `walkCategory`
**Automated:** test/category-monitoring.spec.ts — "a walk that saw fewer than 90% of the category's stated products falls back whole", "CONTROL: a walk that saw exactly 90% is whole"

**Do**

Walk a category stating 10 products whose two pages show 8; then one whose pages show 9.

**Expect**

At 8: both watched listings are read from their own pages and the category is `invalid`, 8 products, total 10, error "the walk saw 8 of the 10 products the category states, fewer than 90%". At 9: no product page is bought, both are priced from their cards, and the category is `valid`.

### Check: category-walk-throttled-page-then-fails

**Requirement:** A walk that cannot be trusted prices nothing
**Surface:** `walkCategory`
**Automated:** test/category-monitoring.spec.ts — "a throttled category page is read again at the measured pace, then fails the walk"

**Do**

Walk a category whose page 2 the vendor answers with an empty 200 every time.

**Expect**

Page 2 is asked for 4 times, after waits of 20, 40 and 80 s (`READ_PACING`), the run counts 3 re-reads from the job's budget, the category is `failed` "throttled on all 4 reads", and the watched listing is read from its own page.

### Check: category-size-reads-page-one

**Requirement:** A size read buys page 1 only
**Surface:** `walkCategory`
**Automated:** test/category-monitoring.spec.ts — "a size read buys page 1 only and reports the category's count and last page", "reads B&H's real category page 1 for its size, pricing the watched card it shows"

**Do**

Size a category whose page 1 states 140 products and 5 pages, watching A (on page 1) and Q (not). Then size B&H's real Mice & Touchpads page 1 watching `1910635` and `1431406` (whose card withholds its price).

**Expect**

Only page 1 is bought. The report is exactly `size`, `valid`, 1 page, 2 products, 1 watched found, total 140, last page 5, no error; A is a `category_page` reading, Q a `product_page` one. At B&H: `valid`, 28 products, 2 found, total 412, last page 15; `1910635` at 11999 cents from its card, `1431406` read from its own page.

### Check: category-walk-reads-to-the-stated-last-page

**Requirement:** A walk reads to the category's own last page, and never past 60
**Surface:** `walkCategory`
**Automated:** test/category-monitoring.spec.ts — "reads to the last page the retailer states, and never buys the page past it"

**Do**

Walk a category the job knew as 2 pages, whose pages now state 3.

**Expect**

Exactly pages 1, 2 and 3 are bought; the listing on page 3 is priced from its card.

### Check: category-walk-reads-to-the-end

**Requirement:** A walk reads to the category's own last page, and never past 60
**Surface:** `walkCategory`
**Automated:** test/category-monitoring.spec.ts — "reads until the retailer says the end where no page states a last page"

**Do**

Walk a category that states no count and no last page, whose page 3 is the end.

**Expect**

3 requests; the report is `valid`, 2 pages read (the end is not one), 2 products, total and last page `null`.

### Check: category-walk-never-past-sixty

**Requirement:** A walk reads to the category's own last page, and never past 60
**Surface:** `walkCategory`, `MAX_WALK_PAGES`
**Automated:** test/category-monitoring.spec.ts — "never reads past 60 pages"

**Do**

Walk a category that never ends and states no last page.

**Expect**

Exactly 60 pages are bought.

### Check: category-walk-too-long-is-not-a-walk

**Requirement:** A walk reads to the category's own last page, and never past 60
**Surface:** `walkCategory`
**Automated:** test/category-monitoring.spec.ts — "a walk the job says is longer than a walk reads is not started", "a category that states more pages than a walk reads stops after its first page"

**Do**

Ask for a walk the job says has 61 pages; then a walk whose page 1 states 72.

**Expect**

The first buys no category page: `failed`, 0 pages, "a walk of 61 pages is past the 60 one walk reads; not started", and its listing is read from its own page. The second buys page 1 only, is `invalid` with last page 72, and its listing is read from its own page.

### Check: category-walk-none-for-a-competitor-without

**Requirement:** A competitor without category reads reads its watched listings from their own pages
**Surface:** `walkCategory`
**Automated:** test/category-monitoring.spec.ts — "a competitor with no category reads reports every category failed and reads its listings from their pages"

**Do**

Run a job with a walk and a size read against a reader whose `categoryReader` is `null`.

**Expect**

Only the two product pages are bought; both categories are `failed` with 0 pages, the error naming no category reads; the events are readings, categories, completed.

### Check: category-walk-pages-at-once

**Requirement:** Walks and product reads share the job's pages at once
**Surface:** `runReadJob`
**Automated:** test/category-monitoring.spec.ts — "never holds more pages open than the job's figure, however the work divides", "a job asking for 12 at once reads at 4"

**Do**

Run three 4-page walks whose every card is unpriced (12 fallbacks) beside 8 product reads, each fetch held open, at pages at once 1, 2 and 3; then at 12.

**Expect**

32 distinct pages, each bought once, 20 readings; the most open at once is exactly 1, 2 and 3, and 4 for a job asking 12.

### Check: category-walk-none-is-todays-read

**Requirement:** A job with no categories reads exactly as before
**Surface:** `runReadJob`, `parseReadJob`
**Automated:** test/category-monitoring.spec.ts — "buys the same pages in the same order and sends the same events, absent or empty", "parses a job with no categories as none"; test/read-run.spec.ts, test/read-run-sigterm.spec.ts, test/pages-at-once.spec.ts

**Do**

Run five product reads with `categories` absent and again with `[]`; parse a job without the field and with `null`. Run the existing read-run suites, whose only edits are the two new reading fields and the parsed job's empty `categories`.

**Expect**

Both runs buy the five pages in job order and send readings then completed — no categories event — and their events are equal. Every reading is `product_page`. The parsed jobs carry `categories: []`. The existing suites pass.

### Check: category-report-before-the-end

**Requirement:** Every category's outcome reaches the gateway before the end
**Surface:** `runReadJob`
**Automated:** test/category-monitoring.spec.ts — "prices each watched listing from its card and buys no product page", "sends nothing more once the gateway says the run has ended"

**Do**

Run a walk to completion; then one whose categories event the gateway answers as a run that has ended.

**Expect**

Readings, then one categories event, then completed. Against a run that has ended: readings, categories, and nothing more.

### Check: category-report-refused-is-an-error

**Requirement:** Every category's outcome reaches the gateway before the end
**Surface:** `runReadJob`
**Automated:** test/category-monitoring.spec.ts — "ends the batch in error, not completed, when the gateway refuses it"

**Do**

Run a walk whose categories event the gateway refuses with a 400.

**Expect**

Readings, categories, error — never completed — the error saying the categories were not accepted (refused: 400).

### Check: category-report-on-the-wire

**Requirement:** Every category's outcome reaches the gateway before the end
**Surface:** `ReadRunClient.reportCategories`
**Automated:** test/category-monitoring.spec.ts — "is posted with the counter, after the readings, by the read run's client"

**Do**

Post one category report with 4 requests spent and 3 pages delivered, then an empty one.

**Expect**

One body: `runtime_version`, `type: "categories"`, the report verbatim, `requests_spent: 4`, `pages_delivered: 3`. The empty report sends nothing.

### Check: category-job-malformed-refused

**Requirement:** A category the job asks for in a shape this build cannot work is refused before anything is bought
**Surface:** `parseReadJob`
**Automated:** test/category-monitoring.spec.ts — "CONTROL: reads a well-formed category, and a job of categories alone", "refuses every malformed field before anything is bought", "refuses more than 200 categories", "CONTROL: still refuses a job with no listings and no categories"

**Do**

Parse a well-formed category in a job with no listings of its own; then sixteen malformed ones; then 200 and 201 categories; then a job with neither.

**Expect**

The well-formed one is read verbatim. Each malformed one throws: categories not an array, a category not an object, a categoryId not a uuid, no url, an http url, a url with a port, a kind other than walk or size, a last page of 0, 1.5 or "4", no listings array, a listing not an object, a listingId not a uuid, no itemId, **no url** (contract point 8) or an http url. 200 parse; 201 throw "more than the 200". A job with neither listings nor categories throws "carries no listings".

### Check: category-job-listing-once

**Requirement:** A category the job asks for in a shape this build cannot work is refused before anything is bought
**Surface:** `parseReadJob`
**Automated:** test/category-monitoring.spec.ts — "refuses a listing read twice in one job, and a category asked for twice"

**Do**

Parse one listing in two categories; a category listing that is also a product read, by id and by url; one category twice, by id and by address.

**Expect**

The first three throw "at most once per job"; the last two throw "names a category twice".

### Check: category-job-off-host-refused

**Requirement:** A category the job asks for in a shape this build cannot work is refused before anything is bought
**Surface:** `runReadJob`
**Automated:** test/category-monitoring.spec.ts — "refuses a category or a category listing off the competitor's host before buying anything"

**Do**

Run a job whose category, then whose category listing, is on another host.

**Expect**

Each rejects "refused before anything was bought", with no request made and an error as the only event.

### Check: category-walk-told-to-stop

**Requirement:** A walk told to stop just stops
**Surface:** `runReadJob`, `walkCategory`
**Automated:** test/category-monitoring.spec.ts — "stops taking pages, reports no outcome for it, and files nothing after the end"

**Do**

At one page at once, size a category (finishes), then walk a 10-page one; SIGTERM arrives as the walk asks for its fourth page.

**Expect**

5 requests in all — the page in flight finishes, none after. The categories event names only the size read; the only reading is its listing's. Events are readings, categories, error ("told to stop … 1 of 2 listing(s)"), and nothing after; the run reports `stopped`, inside the 27 s the shutdown allows.

### Check: category-reading-says-its-page

**Requirement:** Every reading says which kind of page its price came from
**Surface:** `readListing`, `runReadJob`
**Automated:** test/category-monitoring.spec.ts — "prices each watched listing from its card and buys no product page", "reads an unpriced or missing card's listing from its own page, the same day", "reads B&H's real category page 1 for its size, pricing the watched card it shows"; test/read-run.spec.ts — "carries every field of the contract for a page that was read"

**Do**

Read a listing from its card and others from their own pages; read one real Newegg product page.

**Expect**

A card's reading is `category_page` with `category: null`; a product page's is `product_page` with its breadcrumb category (Newegg's TV Mounts & Install Accessories, id 696, on the real page). A failed reading is `product_page` with `category: null`.
