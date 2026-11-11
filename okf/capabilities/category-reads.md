---
type: Capability
title: One read of a competitor's category page prices every product it lists
description: A competitor's category page is read whole — every product it lists, named as its listing is named, with the price its card shows or none — and a body that is not a category page is a failure, never an empty category. Past the last page is the end. Product pages name the category their product sits in. B&H, Newegg and Amazon have category reads; Best Buy and Costco do not.
---

# One read of a category page prices every product it lists

Part of Phase CI-2 (`insights-reads-category-pages`), the parsing half. A
monitoring day can read a whole category page — 28 products at B&H, 36 at
Newegg — for the price of one request, where reading each watched product
costs one request apiece. The walk across a category's pages, the job that
asks for it and the events that report it are the next change's
(`insights-monitor-by-category-where-cheaper`); what is here is pure: an
address for each page, and what one body says.

## What a reading says

Each competitor states a `categoryReader`, or `null` where its category pages
carry no products a server-side read can see. A reader builds page `n`'s
address from the category's (`null` off the competitor's own host, off a
category, or for no whole page number) and reads one body as exactly one of:

| Answer | Means | Carries |
|---|---|---|
| `page` | a page of the category | every product on it: its listing id, the price its card shows or `null`, its stock or `null`; the category's stated product count and last page, each or `null` |
| `end` | the competitor saying there is no such page | why |
| `not-a-category-page` | anything else: a refusal, a robot check, a product page, a search page, an empty body, a page cut short | why |

| Competitor | A page | Count and last page | Past the last page | Measured on |
|---|---|---|---|---|
| B&H | 28 | stated (`count`, `itemsPerPage`) | a search for the url's slug | Mice & Touchpads, pages 1, 2, 15 (last) and 16 |
| Newegg | 36 | stated (`TotalItemCount`, "Page k/M"); M is its 20-page browse ceiling | not captured; read off the page's own "Page k/M" | Desktop Memory pages 1 and 2, Laptop Memory page 1 |
| Amazon | as the grid shows (16 to 24) | not stated: Amazon's "over N results" shifts between pages | an empty grid Amazon says is empty; not captured | a results grid, pages 1 and 2 |

A product page's reading — resolution's and the read run's — also names the
category its product sits in, the deepest level of its breadcrumb, as an id, a
name and an address, or `null`. Nothing here sends a category to the gateway
yet.

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
- GIVEN a body that is not the category page asked for — a refusal, a robot check, an empty or short body, a product page, a search page, a hub page, a page cut short, or a page naming another page number
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

#### Scenario: A page address is built only for a category on the competitor's own host
- GIVEN a category's address and a page number
- WHEN page n's address is asked for
- THEN it is the competitor's own form for that page
- AND there is none for an address off the competitor's host, one that is not a category, or a page number that is not a whole number from 1

**Checked by:** category-read-bh-page-addresses
**Checked by:** category-read-newegg-page-addresses
**Checked by:** category-read-amazon-page-addresses

#### Scenario: A product page names the category its product sits in
- GIVEN a real product page of B&H, Newegg or Amazon
- WHEN it is read, by resolution or by a read run
- THEN it names the deepest category of its breadcrumb: its id, its name and its address
- AND at Newegg never the brand-narrowed crumb after it
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

#### Scenario: The committed category pages read as the captured pages did, and carry no session value
- GIVEN a real category or product page committed as a test page
- WHEN it was cut down to what the parsers read
- THEN every parser read it exactly as the captured page
- AND no session id, token, address, cookie or vendor id survives in it

**Checked by:** category-read-distilled-pages-parse-as-captured
**Checked by:** category-read-pages-carry-no-session
