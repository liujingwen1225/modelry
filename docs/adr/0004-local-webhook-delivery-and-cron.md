# ADR-0004: Local Durable Webhook Delivery and Cron

- **Status:** Accepted — Community V0.1.x
- **Date:** 2026-09-25
- **Scope:** Event Hooks, signed Webhooks, scheduled Jobs/Cron, and delivery recovery
- **Depends on:** [ADR-0001](./0001-runtime-storage-architecture.md), [ADR-0002](./0002-durable-record-events.md), [ADR-0003](./0003-extension-runtime-lifecycle-secrets.md), [Local Automation Product Model](../product-model/0001-local-automation.md)
- **Issue:** [#24](https://github.com/liujingwen1225/modelry/issues/24)

## Context

Record Events are already committed durably with their Record mutation. A Webhook request cannot be included in that SQLite transaction: a remote receiver can be slow, unavailable, or accept the request before the local process observes a timeout. Jobs also need a durable schedule and must recover without a separate scheduler or broker.

## Decisions

### Domain and outbox

- An Owner configures a Webhook endpoint, an Event Hook from one Collection event type to one endpoint, or a UTC Cron Job that emits one `job.scheduled` webhook. Jobs run no shell, Go, Extension, or arbitrary user code.
- When a matching Event Hook and its Webhook are enabled, the Record Event creates its immutable Webhook Delivery intent in the same SQLite transaction as the Record and Event. The transaction stores the delivery body and endpoint configuration snapshot. A disabled Webhook causes the trigger to be skipped. It performs no network I/O.
- One local, cancellable dispatcher claims persisted pending deliveries and durably records each bounded worker attempt before preflight. Four attempts may execute concurrently per Project Runtime. Network work is always outside SQLite transactions.
- A persisted Job stores its Cron expression and `next_run_at`. In one transaction the scheduler creates the due Delivery and advances the next run. A unique `(job_id, scheduled_at)` constraint prevents a second logical Delivery for the same slot.
- Startup turns leftover running attempts into interrupted attempt history. Event Hook and Job Deliveries return to `pending` only if their processing budget remains, their Webhook is enabled, and the selected Secret row exists; a disabled Webhook or missing/revoked Secret cancels them. A synthetic test may resume while its Webhook is disabled if its Secret row exists. Startup does not generate or replace the Project encryption key; if that key is unavailable, the next worker attempt records `secretKeyUnavailable` and fails before network access. If no processing budget remains, the Delivery becomes terminal `failed` with `attemptInterrupted`. Startup coalesces overdue slots for each enabled Job with an enabled Webhook into one catch-up Delivery and computes the next future UTC slot. An overdue slot is retained while a Job is disabled, even if its Webhook is also disabled. When the Job is enabled, its oldest due slot produces at most one catch-up Delivery if the Webhook is enabled in the scheduler transaction; otherwise it is skipped and `next_run_at` advances. Slots reached while an enabled Job's Webhook is disabled are skipped, advance to the next future UTC slot, and do not catch up when the Webhook is enabled. No backlog is replayed without bound.

### Delivery guarantees

- Each non-cancelled round is eligible for at least one persisted, bounded worker attempt while the Runtime dispatcher is running. The attempt is recorded before preflight and can fail without issuing an HTTP request when the Secret, encryption key, or destination is unavailable. This is at-least-once processing-attempt semantics; it does not guarantee an HTTP send or successful delivery. When preflight succeeds, one attempt issues one HTTP request. A remote success followed by a local crash can be sent again. Every HTTP request in a round reuses the Delivery ID, `Idempotency-Key`, target URL, Secret reference, and exact JSON body, so that receiver can deduplicate. Explicit Webhook disable or Secret revocation cancels affected Event Hook/Job Deliveries. A manual redrive can target a different receiver; the stable key does not coordinate deduplication between different receiver systems.
- A request is successful only for HTTP 2xx. Network failures, timeouts, 408, 429 and 5xx are retried after `1m`, `5m`, `15m`, `1h`, `3h`, `6h`, and `12h`; each of at most four rounds has eight bounded processing attempts before terminal failure. A preflight failure is terminal and sends no request. Other HTTP status codes fail immediately. Each issued request uses the safe bounded HTTPS transport and a 2-second deadline. The total is at most 32 processing attempts and at most 32 HTTP requests per Delivery.
- An Owner may redrive a failed Delivery at most three times. A redrive preserves the Delivery ID, idempotency key, payload and original attempt history, and appends a new attempt round. At the start of each manual redrive, snapshot the current enabled Webhook URL, signing Secret reference, and configuration revision for the new round. All automatic retries in that round use its snapshot. This lets an Owner correct an endpoint or replace a revoked Secret before retrying while retaining the original Delivery intent and idempotency key.
- Event Hooks and Jobs produce a Delivery only when both the trigger and its Webhook are enabled. Disabling a trigger stops future intents and keeps accepted Deliveries unchanged. Disabling a Webhook cancels pending Event Hook and Job Deliveries, requests cancellation of their in-flight requests, and skips future Event Hook triggers. Due slots consumed by enabled Jobs while their Webhook is disabled advance without creating Deliveries. A disabled Job retains its due slot even if its Webhook is also disabled; after the Job is enabled, the scheduler consumes that slot according to the Webhook state at that time. Re-enabling the Webhook resumes future triggers without replay. An explicit Owner-requested synthetic test may be sent while the Webhook is disabled and is not cancelled by that disabled state. A request already accepted by a remote receiver cannot be undone.
- Deleting a signing Secret disables each Webhook that references it, cancels its pending Deliveries, and requests cancellation of in-flight requests. Secret value replacement preserves the Secret ID; later attempts resolve its current value. A request never starts with a deleted Secret.
- A missing or unavailable Project Secret produces a safe terminal failure and no network call. The Secret value is resolved for one attempt, never written to SQLite or diagnostics, and cleared after signing.

### Signing and egress

- Every Webhook requires an existing Project Secret as its HMAC-SHA256 signing key. The destination receives `Idempotency-Key`, `X-Modelry-Delivery-Id`, and `X-Modelry-Signature: t=<Unix seconds>,v1=<lowercase hex>`. The signature is HMAC-SHA256 over `timestamp + "." + exact UTF-8 request body`.
- Destination URLs must be HTTPS and contain no user information, query or fragment. Use the shared safe HTTP transport: no redirects or proxies, verify every DNS answer, reject non-global destinations, and pin the selected public address for each request.
- Persist only safe attempt metadata and HTTP status. Do not persist response bodies, response headers, the signing value, request authorization data, or a transport error string.

### Bounds and degradation

- Limits are 32 Webhooks, 64 Event Hooks, 32 Jobs, 1,000 pending deliveries, 5,000 retained Deliveries, 64 MiB retained payload bytes, 1 MiB per payload, four active requests per Project, eight bounded processing attempts per round, four total rounds, and three manual redrives per Delivery.
- When pending or payload capacity is exhausted, persist an immediately failed `capacityExceeded` Delivery without payload and continue the Record transaction or Runtime startup. An Owner-requested synthetic test returns `202` with this terminal Delivery. Capacity failures are visible and do not enter the retry queue; a capacity Delivery with no payload cannot be redriven.
- Prune the oldest terminal delivery history to its configured limit. Pending and running work is never pruned. Release an immutable payload when no retained delivery references it.
- Scheduler, dispatcher and cancellation work share the Runtime lifetime. Shutdown cancels work and waits only within the Runtime shutdown deadline; restart recovery handles remaining rows.

## Consequences

- A Record write waits only for its normal SQLite transaction and bounded local outbox inserts; an unavailable remote endpoint cannot hold the transaction open.
- Each non-cancelled attempt round has at-least-once processing-attempt semantics while the Runtime dispatcher is running. Preflight can fail before any HTTP request, and bounded retries do not guarantee successful delivery. Receivers can use the stable idempotency key to deduplicate repeated HTTP requests, but that key cannot ensure delivery or coordinate different receiver systems. Modelry cannot know whether a timed-out receiver completed the side effect.
- Bounded retention means old terminal history expires. Pending work remains durable; a full bounded outbox produces an explicit capacity failure instead of silently growing storage or blocking Record writes.
- Jobs are intentionally useful, observable scheduled Webhook triggers rather than a general-purpose code execution system.
- SQLite and one Runtime are sufficient; no distributed queue, leader election, or network scheduler is introduced.

## References

- [Local Automation Product Model](../product-model/0001-local-automation.md)
- [Realtime & Record Event Domain Spec](../specs/0004-realtime-event-domain-spec.md)
- [Extension Runtime Domain Spec](../specs/0005-extension-runtime-domain-spec.md)
- [Issue #24](https://github.com/liujingwen1225/modelry/issues/24)
