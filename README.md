# aeo-competitor-resolution-runtime

Resolves each item on a client's watchlist to a listing at a competitor retailer
and **proves the pairing by barcode**, reporting an unproven candidate as
unconfirmed rather than as a match.

Dispatched as a container image through `conqrse-queue`. Input is a watchlist owned
by `aeo-backend`; findings return through that repo's runtime-callback controller.
This runtime owns no database schema.

**Read [`okf/service.md`](okf/service.md) before changing anything here** — it
carries the strategy, why the obvious bulk-walk design was rejected on
measurement, and the four things that will bite you.

## Commands

```bash
npm ci
npm run gate     # lint · typecheck · build · test · okf:check — CI runs this same entry point
npm test
```

## Requirements

Node 22+. A live run needs a Bright Data Web Unlocker key
(`BRIGHTDATA_API_KEY`, `BRIGHTDATA_UNLOCKER_ZONE`); see `.env.example`. **The test
suite needs neither** — everything above the fetcher is pure, and the 53-row
outcome split is replayed from a committed offline corpus at zero request cost.
