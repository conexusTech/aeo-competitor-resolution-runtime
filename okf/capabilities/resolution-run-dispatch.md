---
type: Capability
title: A run is taken from the queue, streamed back to the gateway, and resumable
description: How this container is started, where it gets the client's list, how findings reach the gateway as they are made, and what a run killed part-way does and does not repeat when it starts again.
---

# A run is taken from the queue, streamed back to the gateway, and resumable

The queue starts this container with **one environment variable** and keeps the
job in the portal's own database. So the container fetches its reference,
fetches the client's list from the gateway, and streams findings back as it makes
them — reporting to the same durable callback the gateway built for it.

**Seeded 2026-09-10** by `resolution-runtime-gateway-dispatch`. Every scenario
below was executed, and **thirteen invariants were each broken deliberately and
shown to turn exactly the right check red**, then reverted.

⚠️ **Nothing here decides what a finding *is*.** Resolving one item and proving
the pairing is [competitor-resolution](/capabilities/competitor-resolution.md);
this is about how a run is started, reported and resumed.

⚠️ **Not yet run through the queue in production.** Registering the image in the
`conqrse-queue` catalog is a write to a live system and belongs to a runbook. So
these scenarios are proven against the contract's own surfaces — which is
everything the container can prove about itself, and it is why every check here
is automated.

Module map and the traps: [service.md](/service.md).

## Scenarios

#### Scenario: The job comes from the queue by reference, never from the environment or a file

- GIVEN a container started by the queue with only a task reference
- WHEN it works out what to do
- THEN it reads the task record and takes the run, tenant and organization from it
- AND it fetches the client's list from the gateway rather than from the dispatch
- AND a payload missing any required field is refused before anything is spent, naming every field that is absent
- AND a field name the gateway does not use is refused rather than accepted as a synonym

**Checked by:** dispatch-is-by-reference, dispatch-list-comes-from-the-gateway, dispatch-partial-payload-refused, dispatch-wrong-field-name-refused

#### Scenario: A container that cannot report refuses before it spends

- GIVEN a run whose queue address or gateway credential is not configured
- WHEN it starts
- THEN it refuses, naming the variable that is missing and where to declare it
- AND no request is made to the retailer

**Checked by:** dispatch-missing-queue-url-refused, dispatch-missing-credential-refused

#### Scenario: A run that has already ended is never started again

- GIVEN a run the gateway no longer considers live
- WHEN the container asks for its job
- THEN it stops without spending anything
- AND it exits as a container with nothing to do rather than as a failure

**Checked by:** dispatch-ended-run-has-no-job, dispatch-ended-run-is-not-a-failure

#### Scenario: Findings reach the gateway as they are made, not at the end

- GIVEN a run working through a client's list
- WHEN findings accumulate
- THEN they are sent in batches while the run is still going
- AND a batch never exceeds what the gateway will accept
- AND progress is reported without holding up the work

**Checked by:** dispatch-streams-in-batches, dispatch-batch-respects-the-gateway-cap, dispatch-progress-does-not-block

#### Scenario: A report never describes a finding that is not on disk

- GIVEN a finding the run has just made
- WHEN it is offered for reporting
- THEN the journal already holds it
- AND the ordering holds however many items are worked at once

**Checked by:** dispatch-journal-precedes-the-report

#### Scenario: What the gateway accepted is remembered, and only that

- GIVEN a batch of findings sent to the gateway
- WHEN the gateway accepts them
- THEN they are recorded as accepted
- AND a batch the gateway could not be reached about is recorded as nothing
- AND a batch the gateway refused is recorded as nothing

**Checked by:** dispatch-acknowledged-only-after-acceptance, dispatch-unreachable-records-nothing, dispatch-refused-records-nothing

#### Scenario: A run killed part-way resumes without re-buying or re-reporting

- GIVEN a run that was killed after part of a client's list
- WHEN it is started again over the same list
- THEN nothing already resolved is fetched again, and nothing is spent on it
- AND nothing the gateway already accepted is sent again
- AND findings that were made but never accepted **are** sent again
- AND a record whose last line was truncated mid-write is still usable

**Checked by:** dispatch-resume-buys-nothing-again, dispatch-resume-reports-nothing-twice, dispatch-resume-resends-the-unaccepted, dispatch-truncated-record-survives

#### Scenario: A reporting problem never throws away paid work

- GIVEN a gateway that cannot be reached, or that refuses what it is sent
- WHEN a run is under way
- THEN the run continues and keeps journalling its findings
- AND a transient failure is retried while a refusal is not
- AND a lost progress report costs nothing but a stale number

**Checked by:** dispatch-outage-does-not-end-the-run, dispatch-transient-is-retried, dispatch-refusal-is-not-retried, dispatch-lost-progress-is-harmless

#### Scenario: A run the gateway says is gone stops rather than spending more

- GIVEN a gateway reporting that the run no longer exists
- WHEN the container learns this mid-run
- THEN it stops taking new items
- AND it does not claim the run completed

**Checked by:** dispatch-gone-run-stops-the-work, dispatch-gone-run-is-not-a-completion

#### Scenario: However a run ends, the gateway is told

- GIVEN a run that finishes, and separately one that crashes
- WHEN it ends
- THEN a clean finish reports completion and a crash reports the failure
- AND either way the findings already made are sent first
- AND the requests actually spent are reported, excluding anything served from cache

**Checked by:** dispatch-clean-finish-reports-completion, dispatch-crash-reports-the-failure, dispatch-findings-sent-before-the-terminal-report, dispatch-requests-exclude-cache-hits

#### Scenario: A run can still be driven with no queue and no gateway

- GIVEN a job described in a file
- WHEN the container is started without a task reference
- THEN it runs the list and reports to standard output
- AND it needs neither the queue nor the gateway to do so

**Checked by:** dispatch-file-mode-needs-no-services

#### Scenario: The retailer is named by the job, and refused early if unsupported

- GIVEN a job naming a retailer this image carries no adapter for
- WHEN the run starts
- THEN it refuses by name, before anything is spent
- AND the adapter is chosen from the job rather than from the dispatch

**Checked by:** dispatch-unknown-retailer-refused-by-name, dispatch-adapter-comes-from-the-job
