---
type: Capability
title: A dispatched run can be driven against the committed corpus instead of the live proxy
description: How a run is exercised end to end at zero cost, why the live path stays the default, and how a replayed run stays identifiable after the fact.
---

# A run can be replayed, and a replayed run says so

The replay fetcher has existed since this repo's first row. It serves a
committed corpus of 534 real responses, it is what the 53-row exit criterion
replays, and it costs nothing.

🔴 **But nothing in the container could select it.** `main.ts` built
`liveFetcherFromEnv()` on **both** paths — the queue path and the file path — so
a dispatched run always required `BRIGHTDATA_API_KEY`, and the whole
queue-to-gateway path was unexercisable anywhere that credential was not set.
Which is everywhere it has ever been looked for.

⚠️ **Found by writing the local end-to-end playbook**, not by reading the code:
the playbook had to name the step that could not be performed, and there was no
honest way to write it down.

## The direction is the safety argument

🔴 **Live is what an absent variable gets.** A replay silently preferred in
production would report findings nobody paid for as though they were fresh — on
the screens a customer is most likely to quote back. So the default is asserted
rather than assumed, and mutation-tested in both directions.

#### Scenario: A run with no corpus named is a live run
- GIVEN no replay corpus is named in the environment
- WHEN the run selects its fetcher
- THEN it builds the live fetcher
- AND an empty variable is a live run too, not a replay

**Checked by:** resolution-replay-unset-is-live
**Checked by:** resolution-replay-empty-is-live
**Checked by:** resolution-replay-path-selects-replay

#### Scenario: A replayed run buys nothing
- GIVEN a corpus is named
- WHEN the run completes
- THEN no requests are bought and the live request count is zero

**Checked by:** resolution-replay-serves-the-corpus
**Checked by:** resolution-replay-buys-nothing
**Checked by:** resolution-replay-container-reproduces-the-split

#### Scenario: A replayed run is identifiable after the fact, not only while it runs
- GIVEN a replayed run reports to the gateway
- WHEN its reports are read later
- THEN every one carries a version marked as a replay
- AND the marker names the build it replayed on rather than replacing it
- AND a live run carries no marker
- AND the marker fits the column the gateway stores it in

**Checked by:** resolution-replay-stamps-the-version
**Checked by:** resolution-replay-stamp-is-a-suffix
**Checked by:** resolution-replay-live-is-unstamped
**Checked by:** resolution-replay-stamp-fits-the-column
**Checked by:** resolution-replay-stamp-reaches-every-report

#### Scenario: A corpus that cannot be replayed is refused at the start
- GIVEN a corpus path that does not exist, or a file that is not a corpus
- WHEN the run starts
- THEN it refuses before doing any work
- AND a corpus is recognised by its bytes rather than by its file name

**Checked by:** resolution-replay-missing-corpus-refuses
**Checked by:** resolution-replay-wrong-shape-refuses
**Checked by:** resolution-replay-gzip-by-bytes

#### Scenario: The image carries the corpus the environment can name
- GIVEN the built image
- WHEN a catalog entry names the bundled corpus path
- THEN the file is there to be read

**Checked by:** resolution-replay-image-carries-the-corpus

## Why a log line is not the mechanism

🔑 **The mode is stamped into `runtime_version`, which the gateway persists** on
`insights_runs.runtime_version`. A log line would be gone by the time anybody
asks "was that measured today?"; a column is not. The stamp is a **suffix**, so
the underlying build is still traceable to a pushed commit — *which image was
this* and *was it paid for* are different questions and both get an answer.

🔴 **And the stamp had to be centralised, because the version was read in three
independent places** — `main.ts` and two separate request bodies in
`gateway/client.ts`. Stamping one would have left a replayed capture upload, or
a replayed terminal event, reporting a clean version, and those are the two
records an auditor reaches for.

## Why the corpus ships in the image

⚠️ **The queue's catalog entry declares no volumes.** It carries `command`,
`resources`, `retry`, `timeoutSec`, `namespace`, `envFrom`, `payloadFields` and
`serviceAccountName` — and nothing else — so there is no way to mount a corpus
into a dispatched Job. Baking it in is the only shape that lets the dispatch
path be exercised without a paid credential.

It is ~1 MB against a 233 MB image, and the bodies are public retailer pages
already committed to this repo, so shipping them discloses nothing new.

🔴 **`.dockerignore` excluded `test` wholesale**, so the first build failed with
`/test/corpus: not found`. Loudly, which is how it was found — and the
exception it now carries is checked, because the `COPY` is dead without it.

## What this does not do

⚠️ **It does not make a replayed run a substitute for a paid one.** The corpus
is 534 responses captured on one day against one retailer; 13 of the 53 measured
rows are not covered, because this pipeline plans different queries than the
spike did. A replayed row those pages do not cover is recorded as
**un-replayable** rather than counted as a miss — a distinct error type, so it
cannot be confused with a network failure.

⚠️ **It is not a test-mode flag.** Nothing about the run changes except where
bytes come from: the same adapter, the same ranking, the same evidence gates,
the same reporting.
