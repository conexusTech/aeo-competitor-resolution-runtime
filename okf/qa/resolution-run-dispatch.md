---
type: QA Checklist
title: QA — a run is taken from the queue, streamed back, and resumable
description: One check per requirement in the resolution-run-dispatch capability, with what to do and what to expect.
---

# QA — a run is taken from the queue, streamed back, and resumable

Checks for [resolution-run-dispatch](/capabilities/resolution-run-dispatch.md).
Written at plan time, before the code existed.

🔑 **Every check is automated, and that is a property of the change rather than
of diligence.** The queue, the gateway and the retailer are all reached through
seams with doubles behind them, so nothing here needs a person, a credential or
a card. Run the lot with:

```bash
npm test
```

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
