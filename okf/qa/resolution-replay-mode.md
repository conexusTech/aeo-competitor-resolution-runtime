---
type: QA Checklist
title: QA — replaying a dispatched run against the committed corpus
description: One check per requirement in the resolution-replay-mode capability, with what proves it.
---

# QA — replay mode

Covers [resolution-replay-mode](/capabilities/resolution-replay-mode.md).

**Fourteen of fifteen checks are automated; the fifteenth runs the container and
says so.** ⚠️ **Eight mutations were run and all eight turned exactly the check
named here red**, against a green baseline with a classifier control (a
deliberate syntax error) scoring NOTESTS rather than RED.

🔴 **Two of those mutations are the ones the row exists for**: making replay the
default, and taking the stamp off **one** of the gateway's two report bodies
while leaving the other.

---

### Check: resolution-replay-unset-is-live

**Requirement:** A run with no corpus named is a live run
**Surface:** `fetcherFromEnv`
**Automated:** test/replay-mode.spec.ts

**Do**

Select a fetcher with an empty environment.

**Expect**

It refuses naming `BRIGHTDATA_API_KEY` — which is how we know the **live** path
was taken rather than a replay. 🔴 The mutation inverts the condition, making a
paid run silently replay.

### Check: resolution-replay-empty-is-live

**Requirement:** A run with no corpus named is a live run
**Surface:** `isReplaying`
**Automated:** test/replay-mode.spec.ts

**Do**

Ask whether an environment with the variable set to `""` is replaying.

**Expect**

`false`. ⚠️ Empty is the shape an unset-but-declared variable actually takes — a
catalog entry naming the key with no value must not turn a paid run into a
replay.

### Check: resolution-replay-path-selects-replay

**Requirement:** A run with no corpus named is a live run
**Surface:** `isReplaying`
**Automated:** test/replay-mode.spec.ts

**Do**

Ask with a path named.

**Expect**

`true`. The control — without it a predicate that always said `false` would
pass both checks above.

### Check: resolution-replay-serves-the-corpus

**Requirement:** A replayed run buys nothing
**Surface:** `fetcherFromEnv`
**Automated:** test/replay-mode.spec.ts

**Do**

Point it at a gzipped one-entry corpus.

**Expect**

A `ReplayFetcher` holding one entry.

### Check: resolution-replay-buys-nothing

**Requirement:** A replayed run buys nothing
**Surface:** `fetcherFromEnv`
**Automated:** test/replay-mode.spec.ts

**Do**

Read the fetcher's live request count.

**Expect**

Zero. 🔑 The cost estimate reads this — a replay reporting requests would put a
dollar figure on pages nobody bought.

### Check: resolution-replay-container-reproduces-the-split

**Requirement:** A replayed run buys nothing
**Surface:** The built image
**Automated:** Manual

**Do**

Build the image, write a job envelope from all 53 rows of
`test/fixtures/measured-run-53.json`, and run the container with
`RESOLUTION_JOB_FILE` and `RESOLUTION_REPLAY_CORPUS=/app/corpus/launch-retailer-53.json.gz`.

**Expect**

`requests: 0`, `verified 19`, and `failures: 13`.

🔑 **19 verified is the number the exit criterion records**, reproduced in the
container rather than in the suite. ⚠️ **The 13 failures are the documented
corpus-coverage gap, not defects** — this pipeline plans different queries than
the spike did, so those pages were never captured, and the replay fetcher raises
a distinct error for them precisely so they cannot be read as network failures.
40 of 53 replayable, which is what the runtime's own row recorded.

**Measured 2026-09-11:** `resolution-runtime e5e4411@replaytest+replay`, 53
items, 0 requests, verified 19 / not-found 29 / unverifiable 4 / unconfirmed 1,
failures 13.

⚠️ `Manual` because it needs a Docker build and a container run. Every decision
it exercises is covered by an automated check above; what this adds is that the
**image** carries what it needs and the wiring holds end to end.

### Check: resolution-replay-stamps-the-version

**Requirement:** A replayed run is identifiable after the fact, not only while it runs
**Surface:** `buildVersion`
**Automated:** test/replay-mode.spec.ts

**Do**

Read the reported version with a corpus named.

**Expect**

The build plus `+replay`. 🔴 The gateway **persists** this on
`insights_runs.runtime_version`, so a replayed run stays identifiable; a log
line would be gone by the time anybody asks.

### Check: resolution-replay-stamp-is-a-suffix

**Requirement:** A replayed run is identifiable after the fact, not only while it runs
**Surface:** `buildVersion`
**Automated:** test/replay-mode.spec.ts

**Do**

Read the stamped version and look for the build inside it.

**Expect**

The build is still there. ⚠️ *Which image was this* and *was it paid for* are
different questions and both get an answer. The mutation replaces the build with
the marker.

### Check: resolution-replay-live-is-unstamped

**Requirement:** A replayed run is identifiable after the fact, not only while it runs
**Surface:** `buildVersion`
**Automated:** test/replay-mode.spec.ts

**Do**

Read the version with no corpus named.

**Expect**

The build alone. **The control** — a version that always carried the marker
would pass the stamp check and mean nothing.

### Check: resolution-replay-stamp-fits-the-column

**Requirement:** A replayed run is identifiable after the fact, not only while it runs
**Surface:** `buildVersion`
**Automated:** test/replay-mode.spec.ts

**Do**

Stamp a 100-character build version.

**Expect**

At most 120 characters — the width of the column the gateway stores it in. A
stamp that overflowed would be rejected at the callback, losing the **finding**
rather than the marker.

### Check: resolution-replay-stamp-reaches-every-report

**Requirement:** A replayed run is identifiable after the fact, not only while it runs
**Surface:** `main.ts`, `gateway/client.ts`
**Automated:** test/replay-mode.spec.ts

**Do**

Search both sources for a direct read of `RESOLUTION_BUILD_VERSION`.

**Expect**

None. 🔴 It was read in **three** independent places, so stamping one would
leave a replayed capture upload or a replayed terminal event reporting a clean
version. ⚠️ **A source check, which this repo normally avoids** — it is here
because the property is "no other copy exists", and an absence has no natural
failure mode: exercising the three call sites proves they agree today and
nothing about a fourth tomorrow. The mutation reverts exactly one of the two
gateway bodies.

### Check: resolution-replay-missing-corpus-refuses

**Requirement:** A corpus that cannot be replayed is refused at the start
**Surface:** `fetcherFromEnv`
**Automated:** test/replay-mode.spec.ts

**Do**

Name a corpus path that does not exist.

**Expect**

It throws. This runtime's convention: a run that cannot do its job says so
before spending, not after.

### Check: resolution-replay-wrong-shape-refuses

**Requirement:** A corpus that cannot be replayed is refused at the start
**Surface:** `loadCorpus`
**Automated:** test/replay-mode.spec.ts

**Do**

Point it at valid JSON that is not a corpus.

**Expect**

It throws naming the problem. 🔴 An empty or wrong-shaped corpus would report
every item as **not-found** — a plausible answer and the wrong one, which is the
failure mode this repo has recorded twice.

### Check: resolution-replay-gzip-by-bytes

**Requirement:** A corpus that cannot be replayed is refused at the start
**Surface:** `loadCorpus`
**Automated:** test/replay-mode.spec.ts

**Do**

Load a plain `.json` corpus, then a gzipped one misnamed `.json`.

**Expect**

Both read. 🔑 The gzip magic number rather than the file extension — a corpus
copied without its suffix is a mistake worth surviving.

### Check: resolution-replay-image-carries-the-corpus

**Requirement:** The image carries the corpus the environment can name
**Surface:** `Dockerfile`, `.dockerignore`
**Automated:** test/replay-mode.spec.ts

**Do**

Assert the `COPY` exists, that `.dockerignore` carries the `!test/corpus`
exception, and that the bundled-path constant names the committed file.

**Expect**

All three. 🔴 **Both halves, because the `COPY` is dead without the second** —
`.dockerignore` excludes `test` wholesale, so the first build failed with
`/test/corpus: not found`. Loud, which is how it was found; the exception is
checked so a later tidy-up cannot quietly remove it.
