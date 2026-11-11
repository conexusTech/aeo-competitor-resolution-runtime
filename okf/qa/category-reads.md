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
