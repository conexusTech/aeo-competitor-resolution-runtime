---
type: QA Checklist
title: QA — a run is taken from the queue, streamed back, and resumable
description: One check per requirement in the resolution-run-dispatch capability, with what to do and what to expect.
---

# QA — a run is taken from the queue, streamed back, and resumable

Checks for [resolution-run-dispatch](/capabilities/resolution-run-dispatch.md).
Written at plan time, before the code existed.

🔑 **Every check but one is automated, and that is a property of the change
rather than of diligence.** The queue, the gateway, the retailer, the clock and
the cluster's SIGTERM are all reached through seams with doubles behind them,
so nothing here needs a person, a credential or a card. Run the lot with:

```bash
npm test
```

⚠️ **The exception is `dispatch-stop-in-a-real-process`**: the entry point's
own `process.on` and `process.exit` can only be shown with a real signal to a
real process, so it is a script a person runs against the built code. It
needs no credential and buys nothing.

🔑 **Thirteen invariants were each broken deliberately and shown to turn exactly
the right check red, then reverted** — the acknowledge-before-accept inversion,
re-sending what was accepted, dropping what was not, reporting before
journalling, ignoring the early stop, both terminal-before-flush orderings, the
missing crash report, retrying a 4xx, not retrying a 5xx, an over-cap batch,
accepting `org_id`, and starting on an empty job. All five source files were
confirmed byte-identical to their pre-break state afterwards.

⚠️ **Nothing here is a deployed check.** Registering the image in the
`conqrse-queue` catalog is a write to a live system and belongs to a runbook, so
the end-to-end journey belongs to the phase's exit check rather than to this
list.

## Checks

### Check: dispatch-is-by-reference

**Requirement:** The job comes from the queue by reference, never from the environment or a file
**Surface:** `bootstrapFromQueue`
**Automated:** `test/queue-task-record.spec.ts`

**Do**

Start with only a task reference and a queue address, and inspect what is asked for.

**Expect**

One unauthenticated `GET {QUEUE_API_URL}/api/tasks/{id}`, and the run, tenant, organization, watchlist and retailer taken from its `payload`. Queue mode is selected by `TASK_RECORD_ID` alone — an environment carrying a gateway url or a job file is not queue mode.

### Check: dispatch-list-comes-from-the-gateway

**Requirement:** The job comes from the queue by reference, never from the environment or a file
**Surface:** `runDispatchedJob`
**Automated:** `test/queue-run.spec.ts`

**Do**

Dispatch with an `items_total` that disagrees with what the gateway serves, and see which list is worked.

**Expect**

The gateway's items drive the run and the disagreement is logged, not fatal. A list can change between dispatch and fetch, and an item withdrawn mid-dispatch is ordinary.

### Check: dispatch-partial-payload-refused

**Requirement:** The job comes from the queue by reference, never from the environment or a file
**Surface:** `dispatchFromPayload`
**Automated:** `test/queue-task-record.spec.ts`

**Do**

Offer a payload missing each required field in turn, and one missing four at once.

**Expect**

Refused every time, naming **every** absent field rather than the first, and listing the keys that did arrive. A container proceeding on partial input would spend money producing findings it could not file — the worst outcome available, because the money is gone either way.

### Check: dispatch-wrong-field-name-refused

**Requirement:** The job comes from the queue by reference, never from the environment or a file
**Surface:** `dispatchFromPayload`
**Automated:** `test/queue-task-record.spec.ts`

**Do**

Offer `org_id` in place of `organization_id`.

**Expect**

Refused. The scanner's own bootstrap records this exact trap — *"it is `organization_id`, not `org_id`, which is the sort of detail that costs a run"* — and a reader accepting either would hide the disagreement instead of surfacing it.

### Check: dispatch-missing-queue-url-refused

**Requirement:** A container that cannot report refuses before it spends
**Surface:** `bootstrapFromQueue`
**Automated:** `test/queue-task-record.spec.ts`

**Do**

Set `TASK_RECORD_ID` and leave `QUEUE_API_URL` unset.

**Expect**

Refused at start, naming both variables and saying to declare the second on the catalog entry's `envFrom`. The payload is by reference, so without it there is no way to reach the job at all.

### Check: dispatch-missing-credential-refused

**Requirement:** A container that cannot report refuses before it spends
**Surface:** `gatewayFromEnv`
**Automated:** `test/gateway-client.spec.ts`

**Do**

Omit each of the three gateway variables.

**Expect**

Refused, naming what is missing, and saying that it refuses at start rather than after spending — because a run that cannot report is a run whose findings never reach the client, and the money is spent either way.

### Check: dispatch-ended-run-has-no-job

**Requirement:** A run that has already ended is never started again
**Surface:** `GatewayClient.fetchJob`
**Automated:** `test/gateway-client.spec.ts`

**Do**

Answer the job request with a 404.

**Expect**

`RunGone`, on the first attempt with no retry, and nothing fetched from the retailer. The queue deleting a Job is not instantaneous and its retry policy is not ours, so this is the guard that stops a restarted container from spending again.

### Check: dispatch-ended-run-is-not-a-failure

**Requirement:** A run that has already ended is never started again
**Surface:** `main`
**Automated:** `test/gateway-client.spec.ts` — the distinct `RunGone` type it asserts is what the entry point branches on

**Do**

Inspect what a `RunGone` produces at the entry point.

**Expect**

A logged line and a normal exit, not a thrown failure. The run ended before this container started; there is nothing to report and nothing to retry, and a non-zero exit would ask the queue to retry a container with no work.

### Check: dispatch-streams-in-batches

**Requirement:** Findings reach the gateway as they are made, not at the end
**Surface:** `GatewayReporter.offer`
**Automated:** `test/reporting-reporter.spec.ts`

**Do**

Offer findings up to and past the flush threshold, then flush the remainder.

**Expect**

One batch per threshold crossing, while the run is still going, and the remainder sent on demand. A run over 8,926 items that reported only at the end would show nothing for hours and lose everything to one crash.

### Check: dispatch-batch-respects-the-gateway-cap

**Requirement:** Findings reach the gateway as they are made, not at the end
**Surface:** `MAX_RESOLUTIONS_PER_EVENT`
**Automated:** `test/gateway-client.spec.ts`, `test/reporting-reporter.spec.ts`

**Do**

Ask for a batch of 251, and separately configure a flush threshold of 10,000.

**Expect**

The over-cap batch is refused **here** rather than sent and answered with a non-retryable 400, and the buffer never exceeds the cap however it is configured. The number matches the gateway's `@ArrayMaxSize(250)` exactly, following the precedent the prospect scanner set for the scan-event cap.

### Check: dispatch-progress-does-not-block

**Requirement:** Findings reach the gateway as they are made, not at the end
**Surface:** `runDispatchedJob`
**Automated:** `test/queue-run.spec.ts`

**Do**

Make a progress report take a minute, then finish the run.

**Expect**

The run completes with that report still outstanding. Awaiting it would put the gateway's latency inside the fetch loop of a run that already takes hours; losing a tick costs a stale number on a screen.

### Check: dispatch-journal-precedes-the-report

**Requirement:** A report never describes a finding that is not on disk
**Surface:** `runList` / `onResolved`
**Automated:** `test/queue-run.spec.ts`

**Do**

Read the journal from inside the hook and look for the finding being reported.

**Expect**

It is already a line in the journal, for every item. ⚠️ The assertion is on **this** finding's presence rather than on a line count — a count would be asserting the concurrency, not the ordering, since two items can both journal before either hook runs.

### Check: dispatch-acknowledged-only-after-acceptance

**Requirement:** What the gateway accepted is remembered, and only that
**Surface:** `GatewayReporter.flush`
**Automated:** `test/reporting-reporter.spec.ts`

**Do**

Let the gateway accept a batch, then read the acknowledgement journal.

**Expect**

One line per finding, written **after** the 200. 🔴 Written before, a container dying in that window loses the finding permanently — journalled so never re-resolved, marked reported so never re-sent, and the client's item stays unresolved with nothing anywhere explaining why.

### Check: dispatch-unreachable-records-nothing

**Requirement:** What the gateway accepted is remembered, and only that
**Surface:** `GatewayReporter.flush`
**Automated:** `test/reporting-reporter.spec.ts`

**Do**

Make the gateway unreachable and offer a finding.

**Expect**

The send is attempted and **nothing** is recorded. At-least-once delivery to an idempotent receiver is the only pair that cannot lose data, and this is the "at least once" half.

### Check: dispatch-refused-records-nothing

**Requirement:** What the gateway accepted is remembered, and only that
**Surface:** `GatewayReporter.flush`
**Automated:** `test/reporting-reporter.spec.ts`

**Do**

Have the gateway refuse a batch with a 400.

**Expect**

Nothing recorded as accepted. The findings stay journalled, so a resume re-sends them once the two builds agree about the shape.

### Check: dispatch-resume-buys-nothing-again

**Requirement:** A run killed part-way resumes without re-buying or re-reporting
**Surface:** `runList` / `readJournal`
**Automated:** `test/queue-run.spec.ts`

**Do**

Run a list, then run the same list again over the same run directory.

**Expect**

Nothing re-resolved and no page re-fetched, while the full result set still comes back from the journal. A run killed at hour three must not restart at hour zero and pay for the first three hours again.

### Check: dispatch-resume-reports-nothing-twice

**Requirement:** A run killed part-way resumes without re-buying or re-reporting
**Surface:** `GatewayReporter.offer`
**Automated:** `test/reporting-reporter.spec.ts`

**Do**

File two findings, then start a fresh reporter over the same directory and offer both again.

**Expect**

Neither is sent. ⚠️ Dropping them here rather than letting the gateway dedupe is the difference the exit criterion asks for: relying on the receiver's idempotency is *safe* but still re-sends, and a resumed run over 8,926 items would re-post every finding it had already filed.

### Check: dispatch-resume-resends-the-unaccepted

**Requirement:** A run killed part-way resumes without re-buying or re-reporting
**Surface:** `GatewayReporter.offer`
**Automated:** `test/reporting-reporter.spec.ts`

**Do**

Fail to deliver a finding, then resume and offer it again. Separately, resume over a journal holding one of two findings.

**Expect**

The undelivered one **is** sent, and only the unacknowledged half of the mixed case. 🔑 This is what makes the check above safe: dropping these too would mean a gateway outage silently lost every finding made during it.

### Check: dispatch-truncated-record-survives

**Requirement:** A run killed part-way resumes without re-buying or re-reporting
**Surface:** `readReported`
**Automated:** `test/reporting-reporter.spec.ts`

**Do**

Leave a half-written final line in the acknowledgement journal, as a killed process does, and read it.

**Expect**

The complete lines are read and the partial one skipped — never a refusal to start. The cost of skipping is one re-sent finding the gateway drops; the cost of refusing is the whole resume.

### Check: dispatch-outage-does-not-end-the-run

**Requirement:** A reporting problem never throws away paid work
**Surface:** `GatewayReporter`
**Automated:** `test/reporting-reporter.spec.ts`

**Do**

Make the gateway unreachable mid-run, then keep offering findings. Separately, make the client throw.

**Expect**

The run continues and keeps trying, and a throw from the client is swallowed rather than propagated. A resolution run spends real money over hours; a reporting problem must not throw that away when the findings are safely on disk.

### Check: dispatch-transient-is-retried

**Requirement:** A reporting problem never throws away paid work
**Surface:** `GatewayClient.postEvent`
**Automated:** `test/gateway-client.spec.ts`

**Do**

Answer with a 5xx twice, then a 200. Separately, throw a transport error once.

**Expect**

Retried with backoff and applied on the later attempt; four attempts before giving up as unreachable, with a message saying the findings stay journalled. ⚠️ The backoff is injectable precisely so this case is tested — seven real seconds per retry case is a suite nobody runs, so the retry policy would end up the one untested part of the file.

### Check: dispatch-refusal-is-not-retried

**Requirement:** A reporting problem never throws away paid work
**Surface:** `GatewayClient.postEvent`
**Automated:** `test/gateway-client.spec.ts`

**Do**

Answer with a 400, a 401 and a 403.

**Expect**

One attempt each, reported as refused with the gateway's own detail. 🔴 A container that retries a 400 retries forever; a shape mismatch and a wrong credential do not improve by asking again.

### Check: dispatch-lost-progress-is-harmless

**Requirement:** A reporting problem never throws away paid work
**Surface:** `GatewayReporter.reportProgress`
**Automated:** `test/reporting-reporter.spec.ts`

**Do**

Fail a progress report.

**Expect**

Reporting stays on. Losing a tick costs a stale number on a screen; disabling reporting over it would cost the findings.

### Check: dispatch-gone-run-stops-the-work

**Requirement:** A run the gateway says is gone stops rather than spending more
**Surface:** `shouldContinue`
**Automated:** `test/queue-run.spec.ts`, `test/reporting-reporter.spec.ts`

**Do**

Have the gateway answer 404 to a findings batch, then let the run continue. Separately, run five items with a stop after two.

**Expect**

The reporter reports the run gone, and the run stops taking new items — costing at most the one already in flight. ⚠️ A **control** asserts that without the stop every item is worked, because a stop that fired unconditionally would pass this check while truncating every run.

### Check: dispatch-gone-run-is-not-a-completion

**Requirement:** A run the gateway says is gone stops rather than spending more
**Surface:** `runDispatchedJob`
**Automated:** `test/queue-run.spec.ts`

**Do**

Finish a run whose reporter reports the run gone.

**Expect**

`stoppedEarly` and **no** completion event. The gateway already knows the run ended, and calling it finished would claim work that was cut short.

### Check: dispatch-clean-finish-reports-completion

**Requirement:** However a run ends, the gateway is told
**Surface:** `runDispatchedJob`
**Automated:** `test/queue-run.spec.ts`

**Do**

Let a run finish normally.

**Expect**

One completion event and no error event.

### Check: dispatch-crash-reports-the-failure

**Requirement:** However a run ends, the gateway is told
**Surface:** `runDispatchedJob`
**Automated:** `test/queue-run.spec.ts`

**Do**

Throw from inside the run.

**Expect**

An error event, the original error re-thrown, and no completion event. 🔴 A crash that reported nothing would leave the run live until the gateway's five-minute poller reconciled it — and a resolution run holds its whole watchlist in `resolving` until it ends, so a silent death locks the list rather than merely misreporting one row.

### Check: dispatch-findings-sent-before-the-terminal-report

**Requirement:** However a run ends, the gateway is told
**Surface:** `GatewayReporter.reportCompleted` / `reportError`
**Automated:** `test/reporting-reporter.spec.ts`, `test/queue-run.spec.ts`

**Do**

Buffer a finding, then close the run out — once cleanly, once with an error. Separately, crash a run and inspect what ran last.

**Expect**

The buffered finding is sent **before** either terminal event, and a flush runs last whatever happened. 🔑 The gateway's terminal guard drops a data event that arrives after a terminal one, so a `completed` sent first would discard the last batch — and a crash after 4,000 items should file those 4,000, which were paid for.

### Check: dispatch-requests-exclude-cache-hits

**Requirement:** However a run ends, the gateway is told
**Surface:** `Fetcher.liveRequestCount`
**Automated:** `test/queue-run.spec.ts`

**Do**

Report completion with a known meter reading.

**Expect**

That number, taken from the fetcher's own meter, which excludes cache hits by contract. A cache hit cost nothing, so charging for it would overstate what a run spent — and the figure is a **request count**, never money, because the runtime's dollar rate has never been checked against an invoice.

### Check: dispatch-file-mode-needs-no-services

**Requirement:** A run can still be driven with no queue and no gateway
**Surface:** `readJobEnvelope` / `runList`
**Automated:** `test/job-file.spec.ts`

**Do**

Write a job to a file and run it with no task reference, no queue address and no gateway credential.

**Expect**

The list is worked and nothing is bought. ⚠️ The reader also refuses a file that is not JSON, is not an object, or names no retailer, and an absent job file is explained by pointing at the queue path instead.

### Check: dispatch-unknown-retailer-refused-by-name

**Requirement:** The retailer is named by the job, and refused early if unsupported
**Surface:** `requireAdapter`
**Automated:** `test/queue-run.spec.ts`

**Do**

Serve a job naming a retailer this image carries no adapter for.

**Expect**

Refused before anything is spent, naming the retailer and listing what the image does carry. Discovering it mid-run would waste whatever had already been paid for.

### Check: dispatch-adapter-comes-from-the-job

**Requirement:** The retailer is named by the job, and refused early if unsupported
**Surface:** `runDispatchedJob`
**Automated:** `test/queue-run.spec.ts`

**Do**

Dispatch naming `newegg` while the gateway's job names something else.

**Expect**

The **job** decides, and the mismatch is refused. The gateway's registry is the authority on what a run resolves against; the dispatch payload is a reference to it, not a second copy of it.


### Check: dispatch-time-limit-read-from-the-job

**Requirement:** A run given a time limit hands back what it has not reached
**Surface:** `parseJob`
**Automated:** test/job-time-budget.spec.ts

**Do**

Parse a job with no `stopTakingItemsAfterSec`, with `null`, with `3600`, `1` and `86400`, and with each of `0`, `-1`, `2.5`, `"3600"`, `true`, `{}`, `NaN`, `86401`, `3600000` and the largest safe integer.

**Expect**

Absent and `null` are no limit; whole numbers from 1 to 86,400 (a day) arrive as sent; every other value is refused naming the field and the range, the way a bad `pagesAtOnce` is. ⚠️ Reading a malformed value as "no limit" would hide two builds disagreeing behind a run that never hands back — and a figure above a day, most likely milliseconds, would be no limit in practice. 🔴 Mutations: dropping the field from the parse, or dropping the upper bound, each turn this red.

### Check: dispatch-time-limit-takes-no-new-item

**Requirement:** A run given a time limit hands back what it has not reached
**Surface:** `runDispatchedJob` with the real `runList`
**Automated:** test/time-budget-yield.spec.ts

**Do**

Run five items at one at a time, each taking ten minutes on a fake clock, with a 25-minute limit.

**Expect**

Items 0 to 2 are filed (the third is taken at minute 20), items 3 and 4 are never fetched, and the run ends with `yielded`, not `completed`. 🔴 Mutation: a `shouldContinue` that ignores the limit turns five checks red.

### Check: dispatch-time-limit-finishes-the-item-in-flight

**Requirement:** A run given a time limit hands back what it has not reached
**Surface:** `runDispatchedJob` with the real `runList`
**Automated:** test/time-budget-yield.spec.ts

**Do**

Let the whole hour pass while the third item's first page is being fetched.

**Expect**

The third item is finished and filed; the fourth is never started; the run ends with `yielded`.

### Check: dispatch-time-limit-skips-the-second-attempt

**Requirement:** A run given a time limit hands back what it has not reached
**Surface:** `runList`'s retry pass
**Automated:** test/time-budget-yield.spec.ts

**Do**

Fail item 0's first page so it is held for the end-of-run retry, and let items 1 and 2 spend the limit. Then, as a control, the same with an hour of limit.

**Expect**

With the limit spent: items 1 and 2 filed, item 0 not filed, not one fetch after the last finished item, and `yielded`. With time left: all three filed and `completed`. ⚠️ Two guards hold this — the pass-level check and the per-item check inside the retry worker — so only breaking both turns it red; each alone is unobservable.

### Check: dispatch-hand-back-files-findings-first

**Requirement:** A run given a time limit hands back what it has not reached
**Surface:** `GatewayReporter.reportYielded`
**Automated:** test/reporter-yield-and-timed-flush.spec.ts, test/time-budget-yield.spec.ts

**Do**

Buffer two findings, hold the gateway's answer to their batch, and hand the run back.

**Expect**

`yielded` is not sent until the batch is answered, then follows it. 🔑 The gateway works out the next container's items from the findings it holds when `yielded` arrives, so a finding still buffered would be bought again. Not sent at all once the gateway has refused findings or says the run is gone, exactly as `completed` is not. 🔴 Mutation: sending before the flush turns seven checks red.

### Check: dispatch-hand-back-carries-the-spend

**Requirement:** A run given a time limit hands back what it has not reached
**Surface:** `GatewayClient.reportYielded`
**Automated:** test/gateway-client.spec.ts, test/time-budget-yield.spec.ts

**Do**

Send `completed` and `yielded` with the same figures, and one `yielded` with no pages figure; separately, end a time-limited run.

**Expect**

`yielded` goes to the same events route with exactly `completed`'s fields — `type`, `requests_spent`, `pages_delivered` beside the identity — and omits `pages_delivered` rather than sending a zero. A run's `yielded` carries the fetcher's own counters. 🔴 Mutation: sending `type: "completed"` turns this red.

### Check: dispatch-time-limit-completes-when-nothing-is-left

**Requirement:** A run given a time limit hands back what it has not reached
**Surface:** `runDispatchedJob`
**Automated:** test/time-budget-yield.spec.ts

**Do**

Run three items, ten minutes each, once with an hour of limit and once with 25 minutes, so the limit runs out during the last item.

**Expect**

Both report `completed`. A `yielded` with nothing left would start a container with no work. 🔴 Mutation: yielding whenever the limit is spent turns this red.

### Check: dispatch-no-time-limit-never-hands-back

**Requirement:** A run given a time limit hands back what it has not reached
**Surface:** `runDispatchedJob`
**Automated:** test/time-budget-yield.spec.ts

**Do**

Run five items of ten hours each with no limit field, and again with `null`.

**Expect**

Every item is filed and the run reports `completed` both times — the control that a stop which fired without a limit would fail.

### Check: dispatch-stop-takes-no-new-item

**Requirement:** A run the cluster stops files what it found and hands back the rest before it is killed
**Surface:** `runDispatchedJob` with a `StopSwitch`
**Automated:** test/sigterm-yield.spec.ts

**Do**

Ask for the stop after two of five items are filed; separately, before the first item.

**Expect**

Items 0 and 1 filed, not one page bought after the signal, and `yielded` carrying the container's own totals. Asked before the first item: nothing bought, and `yielded` with `requests_spent` 0. 🔴 Mutation: a `shouldContinue` that ignores the stop turns four checks red.

### Check: dispatch-stop-waits-for-items-in-flight

**Requirement:** A run the cluster stops files what it found and hands back the rest before it is killed
**Surface:** `runDispatchedJob`, `boundAfterStop`
**Automated:** test/sigterm-yield.spec.ts

**Do**

Ask for the stop as the third item's first page is fetched, and hold that page 15 seconds on the fake clock.

**Expect**

Nothing is handed back at 14.999 s; at 15 s the item finishes, all three are filed, then `yielded`.

### Check: dispatch-stop-abandons-a-stuck-item

**Requirement:** A run the cluster stops files what it found and hands back the rest before it is killed
**Surface:** `runDispatchedJob`, `SHUTDOWN.inFlightMs`
**Automated:** test/sigterm-yield.spec.ts

**Do**

As above, but the page is never answered.

**Expect**

Not done at 19.999 s; at 20 s items 0 and 1 are filed and `yielded` is sent, by 27 s at the latest. 🔴 Mutation: an unbounded wait for items in flight hangs this check.

### Check: dispatch-stop-never-outlasts-the-grace

**Requirement:** A run the cluster stops files what it found and hands back the rest before it is killed
**Surface:** `runDispatchedJob`, `SHUTDOWN.finishByMs`
**Automated:** test/sigterm-yield.spec.ts, test/stop-signal.spec.ts

**Do**

After the stop, have the gateway never answer the findings batch; separately, never answer `yielded`.

**Expect**

Either way the run ends at 27 s after the signal, inside the 30 s grace, and the process then exits 0 — so exit 0 is not proof that `yielded` arrived. With the batch unanswered, `yielded` is withheld rather than sent ahead of it. Limits are measured from the signal, so a wait begun after it gets only the remainder. 🔴 Mutations: unbounded closing reports, or a bound measured from the call rather than the signal, turn these red.

### Check: dispatch-stop-ends-the-process-itself

**Requirement:** A run the cluster stops files what it found and hands back the rest before it is killed
**Surface:** `watchForTermination`
**Automated:** test/stop-signal.spec.ts

**Do**

Send SIGTERM through the registered handler and move the fake clock.

**Expect**

No exit at 28.499 s; exit code 1 at 28.5 s, before the 30 s grace. ⚠️ Reached only by a wait nothing else bounds — the task record or the job fetch before the run starts; a hand-back the gateway does not answer is abandoned at 27 s and exits 0 (`dispatch-stop-never-outlasts-the-grace`). The limits are ordered: in flight 20 s, closing 27 s, backstop 28.5 s, grace 30 s. 🔴 Mutation: no backstop turns this red.

### Check: dispatch-stop-ignores-a-second-signal

**Requirement:** A run the cluster stops files what it found and hands back the rest before it is killed
**Surface:** `watchForTermination`
**Automated:** test/stop-signal.spec.ts

**Do**

Send SIGTERM, wait 3 s, send it again.

**Expect**

The stop keeps the first signal's time, one backstop is armed, not two, and the second is logged as ignored. 🔴 Mutation: restarting on the second signal turns this red.

### Check: dispatch-stop-after-the-last-item-completes

**Requirement:** A run the cluster stops files what it found and hands back the rest before it is killed
**Surface:** `runDispatchedJob`
**Automated:** test/sigterm-yield.spec.ts

**Do**

Ask for the stop after the last of three items is filed.

**Expect**

`completed`, not `yielded`: there is nothing to hand back. 🔴 Mutation: a stop that never yields turns five checks red; one that always yields turns this one red.

### Check: dispatch-stop-in-a-real-process

**Requirement:** A run the cluster stops files what it found and hands back the rest before it is killed
**Surface:** `main.ts`
**Automated:** Manual — `npm run build`, then `node scripts/sigterm-smoke.mjs yield`, `twice` and `hang`

**Do**

Run the built entry point in queue mode against a local fake queue and gateway with the committed replay corpus, and send it a real SIGTERM mid-run.

**Expect**

`yield` and `twice` print PASS: exit code 0 and one `yielded` event, the second signal logged as ignored. `hang`, where the gateway never answers the job fetch, prints PASS with exit code 1 from the backstop at about 28.6 s. Nothing is bought and nothing leaves the machine. ⚠️ Manual because it needs the built image of the code; the unit checks cover every decision, and this covers only `process.on` and `process.exit`.

### Check: dispatch-findings-wait-at-most-a-minute

**Requirement:** A finding never waits more than a minute to reach the gateway
**Surface:** `GatewayReporter`
**Automated:** test/reporter-yield-and-timed-flush.spec.ts

**Do**

Offer one finding to a reporter whose batch size is 100, and move the fake clock.

**Expect**

Nothing sent at 59.999 s; sent at 60 s. A finding offered after a timed send starts a fresh minute. 100 findings are still sent at once. 🔴 Mutation: no timed send turns six checks red.

### Check: dispatch-minute-counts-from-the-oldest

**Requirement:** A finding never waits more than a minute to reach the gateway
**Surface:** `GatewayReporter`
**Automated:** test/reporter-yield-and-timed-flush.spec.ts

**Do**

Offer a finding, wait 30 s, offer another.

**Expect**

Both are sent in one batch at 60 s, and nothing more at 120 s. 🔴 Mutation: restarting the minute on every finding turns this red.

### Check: dispatch-short-list-reports-as-it-goes

**Requirement:** A finding never waits more than a minute to reach the gateway
**Surface:** `runDispatchedJob` with the real reporter
**Automated:** test/time-budget-yield.spec.ts

**Do**

Run 20 items of 10 s each with no time limit; then the same with the minute set out of reach.

**Expect**

At least three findings batches, and at least 12 of the 20 filed before the last item is finished; the control files nothing before the end. 🔴 The production case this exists for: a 20-row run evicted after seven minutes reported 0 of 20.

### Check: dispatch-end-never-overtakes-a-batch

**Requirement:** A finding never waits more than a minute to reach the gateway
**Surface:** `GatewayReporter.flush`
**Automated:** test/reporter-yield-and-timed-flush.spec.ts

**Do**

Let a timed send go out and hold its answer, offer another finding, and end the run.

**Expect**

Neither the second batch nor `completed` is sent until the first is answered; then batch, batch, `completed`, answered in that order. 🔴 The gateway drops a batch that lands after a terminal event. Mutation: unserialised sends turn this red.

### Check: dispatch-no-wait-left-behind

**Requirement:** A finding never waits more than a minute to reach the gateway
**Surface:** `GatewayReporter.flush`
**Automated:** test/reporter-yield-and-timed-flush.spec.ts

**Do**

Offer one finding, then report completion; separately, offer a full batch.

**Expect**

No timer is left pending either way, so a finished run is never kept alive for a minute by a wait with nothing to send. 🔴 Mutation: a flush that leaves the timer armed turns two checks red.

### Check: dispatch-stop-files-nothing-after-the-hand-back

**Requirement:** A run the cluster stops files what it found and hands back the rest before it is killed
**Surface:** `GatewayReporter` (sealed at the terminal decision), `runDispatchedJob`
**Automated:** test/sigterm-yield.spec.ts, test/reporter-yield-and-timed-flush.spec.ts

**Do**

Stop a five-item run after two items, holding the third item's page 22 s and the gateway's answer to `yielded` until after that; then move the clock past the minute. Separately, offer a finding, a progress tick and a flush to a reporter that has already handed the run back.

**Expect**

Events are exactly `resolutions` then `yielded`, with items 0 and 1 filed: the third item, finishing at 22 s while `yielded` was unanswered, is never sent. After the hand-back the reporter sends no finding, flush or tick. 🔴 Found in review: without the seal that item was filed after `yielded` — reported twice, its pages missing from `yielded`'s spend. Mutations: a tick accepted after the seal turns this red; `offer` and `flush` both check the seal, so only breaking both does.

### Check: dispatch-end-is-the-last-event

**Requirement:** A run the cluster stops files what it found and hands back the rest before it is killed
**Surface:** `GatewayReporter.closeOut`
**Automated:** test/reporter-yield-and-timed-flush.spec.ts

**Do**

Start a progress tick, hold its answer, and report completion.

**Expect**

`completed` is not sent until the tick is answered; the gateway answers `progress` then `completed`. A tick is not awaited by the run, so without this one in flight could land after the terminal event. 🔴 Mutation: a terminal that does not wait for ticks turns this red.

### Check: dispatch-stop-uploads-no-evidence-after-the-hand-back

**Requirement:** A run the cluster stops files what it found and hands back the rest before it is killed
**Surface:** `runDispatchedJob`'s `onResolved`, gated on `GatewayReporter.isSealed`
**Automated:** test/sigterm-yield.spec.ts

**Do**

With capture on for every item, stop a five-item run after two items, holding the third item's page 22 s and the answer to `yielded` until after that. As a control, run three items with capture on and no stop.

**Expect**

Evidence is uploaded for items 0 and 1 only; the third item, finishing after the hand-back, has neither a finding nor an upload. The control uploads all three, so the check can see uploads. 🔑 Evidence no finding points at would be an orphan, still charged against the organization's allowance; the next container captures the item with its finding. 🔴 Mutation: removing the gate turns this red.

### Check: dispatch-leg-id-read-from-the-job

**Requirement:** Every report says which container of the run sent it
**Surface:** `parseJob`
**Automated:** test/leg-id.spec.ts

**Do**

Parse a job with no `legId`, with `null`, with a uuid in lower and upper case, and with each of `123`, `true`, `{}`, `""`, `"not-a-uuid"`, a uuid with a trailing character, one with a leading space, and one without hyphens.

**Expect**

Absent and `null` are no leg; a uuid arrives exactly as sent; every other value is refused naming `legId`. 🔴 Mutation: accepting any string turns this red.

### Check: dispatch-every-event-names-its-leg

**Requirement:** Every report says which container of the run sent it
**Surface:** `GatewayClient.fetchJob` / `postEvent`
**Automated:** test/leg-id.spec.ts, test/time-budget-yield.spec.ts

**Do**

Fetch a job naming a leg, then send one of each run event: progress, resolutions, yielded, completed, error. Separately, run a five-item job naming a leg through `runDispatchedJob` until it yields.

**Expect**

Every body carries `leg_id` equal to the job's `legId`, through the real job fetch as well as directly. 🔑 The client remembers the leg from the job it fetched, so no report can be sent without it. 🔴 Mutations: never stamping it, or not remembering the fetched leg, each turn this red.

### Check: dispatch-no-leg-no-change

**Requirement:** Every report says which container of the run sent it
**Surface:** `GatewayClient.postEvent`
**Automated:** test/leg-id.spec.ts, test/time-budget-yield.spec.ts

**Do**

Send one of each run event from a client whose job named no leg, and the same from a client that never fetched a job; separately, run a job naming no leg to completion.

**Expect**

The two clients' bodies are identical, byte for byte, and none contains `leg_id`; no event of the run carries the key. 🔴 Mutation: sending `leg_id: null` when no leg was named turns this red.
