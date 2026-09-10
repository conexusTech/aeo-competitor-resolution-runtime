# `competitor-resolution-runtime` — plan

**Exit criterion (roadmap):** One client item resolves to a competitor listing and
the pairing is proven by UPC; a run over the 53 measured rows reproduces or beats
the recon's outcome split **from configuration alone**, with **no customer** named
in a code path and every retailer-varying behaviour behind the adapter seam.

`artifacts/` is deleted when the change lands. The permanent record is the
capability, the QA checklist and the roadmap row.

---

## 1. Ground truth — measured 2026-09-10, not read

### 1.1 The handover spike is the algorithm, and it is on disk

`~/Downloads/meriwether-data-scraper/` — a TypeScript npm-workspaces monorepo.
The resolution pipeline is **`recon/newegg/02-upc-lookup.mjs`, 615 lines**, and it
is the thing that produced the 53-row measured run. It is competent work with its
reasoning written down; this row is a port behind a seam, not a rewrite.

Three steps per UPC:

1. **resolve** — Google `"<upc>"` through Bright Data Web Unlocker, product
   identity from `<h3>` titles + model-shaped tokens recurring across retailers
2. **search** — Newegg `/p/pl?d=<identity>`, candidates out of
   `window.__initialState__.Products[].ItemCell`
3. **verify** — fetch candidate PDPs, match `"UPCCode":"…"`

Tunables, all of which become configuration: `MAX_PDP_PROBES 8`,
`CANDIDATE_FLOOD 15`, `PROBABLE_MIN_SCORE 10`, `CONCURRENCY 3`, jitter 500–1500 ms.

### 1.2 🔑 611 cached HTTP responses survive — the exit criterion can be a free test

`recon/captures/newegg-upc/cache/` holds the whole run's raw traffic:

| tag | n | total | avg |
|---|---|---|---|
| `serp` (Google) | 71 | 22.2 MB | 320 KB |
| `search` (Newegg) | 271 | 67.3 MB | 254 KB |
| `pdp` (Newegg) | 255 | 65.6 MB | 263 KB |
| `mcsearch` / `mcpdp` | 14 | 5.6 MB | — |
| **total** | **611** | **160.6 MB** | |

So the 53-row outcome split is reproducible **offline, deterministically, at zero
request cost**. That is the same property `aeo-howto-generation-runtime` has and
the roadmap singles out for praise: a runtime that can only be exercised against a
live paid endpoint does not get exercised.

⚠️ **160 MB cannot be committed**, and the cache is not in git anywhere — it lives
in one Downloads folder on one machine. The roadmap's own
`commit-eap-parity-fixtures` lesson is exactly this shape: **a fixture that lives
on one machine makes a test that only runs there.** So the corpus has to be
distilled down to something committable, and the distillation script committed
beside it.

### 1.3 🔴 Newegg's `UPCCode` is not fixed-width — it zero-pads

Measured off the 53-row results, where `pdpUpc` **is** the value read from
Newegg's page:

| | count |
|---|---|
| rows carrying a `UPCCode` | 22 of 53 |
| 12-digit | 18 |
| 13-digit | 2 |
| 14-digit | 2 |
| **byte-equal to the client's value** | **18 of 22** |

All four of the longer ones are zero-padded forms of the same UPC-A —
`097855114693` → `00097855114693`, `619659075538` → `0619659075538`. **A byte
comparison would report 4 of 22 verified pairings as mismatches: 18%.** A false
mismatch is the worst output this product has, because it reads exactly like a
real one.

🔑 **The spike already gets this right, and the way it does is the design
decision worth carrying:** `upcCore()` strips *all* leading zeros and
`upcVariants()` builds `{core, pad12, pad13, pad14}`; verification normalises
Newegg's value the same way and tests set membership. **The comparison key is
derived at compare time and never stored.** That is why row 2 storing the client's
barcode faithfully — EAN-13 kept at 13 digits — was right: storage is the record,
the comparison key is a function of it.

### 1.4 ⚠️ The EAN-13 question is still open, and this sample cannot close it

The phase's one cross-row dependency. Of the 53 rows, **exactly one** carries a
13-digit client value (`6933337311393`) and it came back `not-found` — no Newegg
page, so no `UPCCode` to compare. **A 0-for-1 record is not evidence either way.**

It matters because 1,081 of the client's 8,926 items (12%) are genuine EAN-13s.
If Newegg's field never carries EAN-13 for an import, those items are
**unverifiable rather than mismatched** — a different outcome needing its own
state, and a coverage limit no document states.

**This row must not guess.** Two things follow, and neither is "assume it works":
`unverifiable` is a first-class outcome from the first commit, and the question
gets answered by a deliberate probe of EAN-13 client values (which costs real
requests and so is its own decision), not by inference from this sample.

### 1.5 🔴 Step 1 is the inference §8 rejected

The Google `<h3>` scrape is not an implementation detail to be tidied up — the
roadmap records that **every observed mis-resolution originated in that step**,
and D-6's resolution turned on the fact that "enrich the part numbers" and "the
inference §8 rejected" are the same option. The spike's own comment records the
cost: a junk SERP identity once matched a **$3,727 server to a $13 accessory**.

`PROBABLE_MIN_SCORE` exists for that, and `probable` is deliberately never
presented as a match. Both properties are load-bearing and both need a check that
fails when they are removed.

### 1.6 The outcome split to reproduce or beat

Measured, from the committed 53-row sample:

| status | n | share |
|---|---|---|
| `upc-verified` | 22 | 41.5% |
| `probable` | 12 | 22.6% |
| `not-found` | 14 | 26.4% |
| `error` | 5 | 9.4% |

⚠️ **41.5% is a sample of 53 — 0.6% of the client file.** Cost from the same run:
4.70 requests/row, ~$42 for a full 8,926-row run at $1 per 1,000. **That rate has
never been checked against an invoice** and must not be quoted as a price.

### 1.7 What the adapter seam has to hide

Newegg specifics that leak through the spike and must not appear in the engine:
`window.__initialState__`, `"UPCCode":"…"`, `/p/pl?d=`, the `N82E168` public item
prefix, `^\d{2}-\d{3}-\d{3}$` warehouse item numbers, and the ranking rule that
warehouse items outrank marketplace offers (because a marketplace listing carries
the *seller's* barcode — observed on a TP-Link switch reporting an unrelated UPC).

The handover already has the seam: `packages/scraper/src/adapters/types.ts` with
`newegg.ts` and `autozone.ts` behind it. Keep it.

---

## 1.8 🔑 The client publishes the identity step 1 was guessing — decided 2026-09-10

**Measured, on the 7 client pages the handover spike captured.** They are the
**client's own catalogue**, not a second competitor: 7 of 7 match a client row on
**both** SKU and barcode. ⚠️ I first read them as a second retailer's captures and
said so; that was wrong, and the correction is what produced this finding.

Every one publishes a manufacturer part number **and** a brand in structured JSON:

| client SKU | barcode | published MPN | barcode-derived ref | agrees |
|---|---|---|---|---|
| 82081 | 035286301848 | `30184` | `30184` | **yes** |
| 271361 | 649833101746 | `10174` | `10174` | **yes** |
| 994905 | 035286296489 | `29648` | `29648` | **yes** |
| 314393 | 813810010431 | `63005` | `01043` | no |
| 531814 | 812348010548 | `CF-08LB` | `01054` | no |
| 497966 | 188218000453 | `CRW-UINB` | `00045` | no |
| 531822 | 812348010555 | `CF-012LB` | `01055` | no |

Three things follow, and the third is the design.

**1. The weakest step is replaceable.** Step 1 infers identity from search-engine
`<h3>` titles — the inference §8 rejected, the origin of **every observed
mis-resolution**, the thing that once matched a $3,727 server to a $13 accessory.
The client's own site states it. Authoritative beats inferred.

**2. It answers D-6's open commercial residue by measurement.** The roadmap asks
*"does the client's system hold a part number at all? If it does, the path is ~2
requests/row at far higher verification."* **It does, and it is published.**

**3. The barcode already yields 3 of 7 for free, and that is evidence, not a
shortcut.** The spike's `upcItemRef` — the 5 digits before a UPC-A's check digit —
reproduces the published MPN **exactly** for 3 of the 4 numeric ones, at zero
request cost. It misses `63005` and cannot produce an alphanumeric MPN by
construction. So it is a **corroborator**, not a source to stop at: two
independent derivations agreeing is stronger evidence than either alone, and
trying it first *and stopping* would take a wrong identity when an authoritative
one was one request away.

⚠️ **7 of 8,926 is 0.08%.** That every client SKU publishes an MPN is **unmeasured**
and must not be assumed. The design therefore treats an absent client identity as
ordinary, not exceptional.

✅ **Permission settled by the lead 2026-09-10: reading the client's own public
product pages is within what they are paying for.** Recorded because it is a
question about someone else's property, not an engineering detail.

### The decision — the long-term shape, per the lead: no temporary implementation

**Identity becomes a first-class, provenanced input rather than a hidden step.**

```
IdentitySource         request cost   authority
client-catalogue       1              states the fact
barcode-derived        0              derives it, 3 of 4 numeric correct
search-inference       1+             infers it — §8 rejected, last resort
```

- Sources are **independent evidence**, tried **in order of authority, not cost**,
  and **agreement between them raises confidence** rather than being discarded.
- Every resolved identity carries **which source produced it**. That is not
  bookkeeping: an item paired through an inferred identity deserves different
  treatment from one paired through the client's own published part number, and
  today nothing can tell them apart.
- The client's catalogue is **configuration** — a URL template on the retailer or
  organization registry row, never a named customer in a code path.

**Why not the cheap version.** Building only the search inference now and adding
the seam later means the pipeline's most important input has no provenance for a
release, and every consumer downstream — the review queue, the coverage figure —
would be built against an identity that cannot say where it came from. That is the
kind of thing that is cheap now and expensive later.

## 2. Shape

Stack: **TypeScript + npm**, matching the handover so the algorithm ports rather
than gets rewritten, and matching `aeo-backend`'s runner. Dispatched as a
container image through `conqrse-queue` exactly as `configurable-prospect-scanner`
is — one resolution run over a client list is tens of thousands of fetches and
hours of work, which is not request-scoped and must not share a process with the
API.

```
src/
  gtin.ts              comparison key, variants, check digit — pure
  identity/            SERP -> candidate identities + model tokens — pure
  ranking.ts           candidate scoring — pure
  resolve.ts           the three-step pipeline, adapter-agnostic
  adapters/
    types.ts           the seam
    newegg.ts          every Newegg specific in 1.7
  registry.ts          retailer capability read as data, never a constant
  fetcher/
    unlocker.ts        Bright Data
    replay.ts          the offline corpus — same interface
  run.ts               journal, resume, concurrency, cost meter
test/
  corpus/              the distilled 53-row replay corpus (committed)
  raw/                 a handful of real gzipped responses (committed)
scripts/
  distil-corpus.mjs    160 MB cache -> committed corpus, re-runnable
  okf-check.mjs        identical to the other seven repos
```

**Everything above `fetcher/` is pure and offline.** That is what makes the
outcome-split test free.

---

## 3. Steps

0. **Scaffold and prove the gate can fail.** package.json with the one `gate`
   entry point (lint · typecheck · build · test · `okf:check`), tsconfig, eslint,
   vitest, `.gitattributes` pinning `eol=lf` **from the first commit** — two repos
   in this workspace have a red gate purely from CRLF and both cost a day.
   OKF bundle: `index.md`, `service.md`, `log.md`. CI running the same `gate`.
   Then one deliberate red, reverted.
1. **`gtin.ts`** — the comparison key, with the 4 measured zero-padded pairs from
   §1.3 as the checks, and a check that a genuine EAN-13 is never shortened.
2. **`distil-corpus.mjs` + the replay fetcher.** Distil the 611 responses to what
   the parsers consume, commit that, and make `replay.ts` satisfy the same
   interface as the live fetcher so the pipeline cannot tell them apart.
3. **Port the parsers behind the seam** — SERP titles/models, Newegg search
   candidates, PDP `UPCCode` — each against real gzipped responses from §1.2.
4. **Port ranking and the pipeline.** `unverifiable` as a first-class outcome.
5. **The exit-criterion test:** replay all 53 offline, assert the split is
   22/12/14/5 or better, and assert it came from configuration with no customer
   or retailer named in a code path (a grep, proven able to fail).
6. **The live fetcher + `run.ts`** — journal, resume, cost meter. Not exercised
   in CI.
7. **Dockerfile + queue catalog registration.** ⚠️ Per the workspace runbook: GET
   the catalog entry, change one field, PUT the whole thing back, then diff every
   field — a partial `PUT` nulls `envFrom` and takes every run's secrets with it.

## 4. What this row does not do

No orchestration, no callbacks, no portal — that is `insights-run-orchestration`.
No price observations. No review decisions. It answers one question: does this
client item exist at this retailer, and is the pairing proven?
