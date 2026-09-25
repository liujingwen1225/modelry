# Community V0.1.x Product Model: Local Automation

- **Status:** Accepted for Work Package #24
- **Issue:** [#24 — Event Hooks, Webhooks & Jobs/Cron](https://github.com/liujingwen1225/modelry/issues/24)
- **Parent:** [#22 — Community V0.1.x Product Maturity Closure](https://github.com/liujingwen1225/modelry/issues/22)

## User problem

An Owner needs to notify an external service when a Record changes and to send a recurring scheduled signal. Those actions must survive a process restart, show their outcome, and remain independent of the Record mutation's success.

## Product terms

- A **Webhook** is a Project-owned HTTPS destination with a Project Secret selected as its signing key. The URL and Secret reference are configuration; the Secret value is never returned or copied into delivery history.
- An **Event Hook** connects one Collection event type to one Webhook. It observes the durable `record.created`, `record.updated`, or `record.deleted` fact. It is not an Extension lifecycle Hook and cannot change a Record.
- A **Job** connects a UTC five-field Cron schedule to one Webhook. Each due schedule slot emits one `job.scheduled` webhook. Jobs do not execute shell commands, Go code, Extension source, or arbitrary user code.
- A **Webhook Delivery** is the durable, immutable attempt intent produced by an Event Hook, Job, or Owner-requested test. It has one stable Delivery ID and idempotency key across automatic retries and manual redrives. An Owner-requested synthetic test is the only send allowed while its Webhook is disabled.
- A **Delivery Attempt** is one durable, bounded unit of worker processing. It records the claim before URL/Secret/egress preflight and issues at most one outbound HTTP request; a preflight failure issues none. History stores timing, safe outcome, and optional HTTP status only; it never stores response content, request headers, endpoint query data, or a Secret value.

## Owner workflow

1. Create a Project Secret for signing.
2. Create a Webhook by entering an HTTPS URL and selecting that Secret.
3. Send a synthetic test delivery and inspect its status and attempt history. Enable the Webhook before enabling automatic triggers.
4. Add an Event Hook for a Collection and Record event, or create a Cron Job in UTC.
5. Inspect delivery history. Correct the URL or Secret on a failed Delivery's Webhook, enable it if needed, then retry the failed Delivery. If the current Webhook revision differs from the latest attempt's revision, the UI warns that its configuration changed; if the URL changed, both receivers may have acted and the key cannot deduplicate across different receiver systems.
6. Disable an Event Hook or Job to stop its future triggers. Disable a Webhook to cancel pending Event Hook and Job deliveries, stop their in-flight requests where possible, and skip future Event Hook triggers until it is enabled again. Missed Record Events are not replayed. Due slots consumed by enabled Jobs while the Webhook is disabled are skipped and do not catch up; a disabled Job retains its due slot even if the Webhook is disabled, then consumes it after the Job is enabled according to the Webhook state at that time. Explicit synthetic tests remain available while disabled.

The UI makes clear that an Event Hook sends the selected Record Event snapshot, including its applicable before/after field values, to the configured destination. The Owner is responsible for choosing a destination authorized to receive those values.

## Product behavior

- A Record Event is committed with the Record mutation. When a matching Event Hook and its Webhook are enabled, its durable Delivery intent is committed in the same SQLite transaction. Network work starts only after commit. A network timeout or receiver failure never rolls back a Record mutation.
- Every non-cancelled attempt round is eligible for at least one persisted, bounded worker attempt while the Runtime dispatcher is running. An attempt may fail during preflight and issue no HTTP request; when preflight succeeds, that attempt issues one request. Modelry therefore provides at-least-once processing-attempt semantics, not a guarantee of an outbound send or successful delivery. Explicit Webhook disable or Secret revocation cancels affected Event Hook/Job Deliveries. A crash after a receiver accepts a request but before Modelry records success can cause a duplicate. Every HTTP request within a round uses the same Delivery ID, `Idempotency-Key`, body, target URL, and Secret reference, so that receiver can deduplicate it.
- Transient network errors, timeouts, HTTP 408, HTTP 429, and HTTP 5xx receive at most eight bounded processing attempts per round with bounded backoff; an unavailable Secret or encryption key fails before network access. A Delivery has at most four rounds: one initial round and up to three Owner redrives, for at most 32 processing attempts and no more than 32 HTTP requests. Other non-2xx responses become an actionable failed Delivery. A redrive keeps the Delivery ID, key, body, and history, and snapshots the currently enabled Webhook's URL, signing Secret reference, and configuration revision. This lets an Owner correct a URL or replace a revoked Secret before retrying without changing the original intent. If the URL changed, both receivers may have applied the same intent; the stable key cannot deduplicate across different receiver systems.
- HMAC-SHA256 signs the exact UTF-8 JSON body with the current value of the selected Project Secret. `X-Modelry-Signature` is `t=<Unix seconds>,v1=<lowercase hex>` for `HMAC-SHA256(secret, timestamp + "." + body)`. Retries use a fresh timestamp/signature and retain the body and idempotency key.
- The Webhook URL must use HTTPS and cannot contain user information, query parameters, or a fragment. Redirects, proxies, loopback, private, link-local, multicast, unspecified, and otherwise non-global destinations are rejected. DNS answers are checked and the selected public address is pinned for the request.
- A missing or unusable signing Secret fails closed before a network request. A Secret value is resolved only in memory for one attempt and cleared afterwards.
- A Job persists its next UTC run. Startup coalesces missed schedule slots into at most one catch-up Delivery per enabled Job whose Webhook is enabled, then persists the next future slot; it does not replay an unbounded backlog. While a Job is disabled, its next due slot is preserved even if its Webhook is also disabled. When the Job is enabled, the scheduler consumes that due slot: it creates at most one catch-up Delivery if the Webhook is enabled in that transaction, otherwise it skips the slot and persists the next future time. Schedule advancement and any Delivery intent commit atomically.
- Disabling a trigger prevents new intents; previously accepted Event Hook deliveries continue. Disabling a Webhook cancels pending Event Hook and Job deliveries and requests cancellation of their in-flight attempts. While it is disabled, Record Events create no delivery and due slots consumed by enabled Jobs are skipped. A disabled Job retains its due slot even if its Webhook is disabled; after the Job is enabled, the scheduler consumes that slot using the Webhook state at that time. Re-enabling the Webhook resumes future triggers without replaying missed events or slots. An Owner-requested synthetic test may still be sent while disabled. An HTTP request already accepted by a receiver cannot be undone.
- Deleting a selected signing Secret disables each Webhook that references it, retains the unavailable Secret ID in that Webhook's metadata, cancels its pending deliveries, and requests cancellation of in-flight attempts. Replacement of a Secret value keeps the Secret ID and does not cancel deliveries; later attempts use its current value. A revoked Secret is never used for a new request.
- Hard local limits apply to endpoint, trigger, job, pending Delivery, retained history, payload bytes, retry count, request duration, and concurrent attempts. When a new intent cannot be queued, Modelry records a terminal `capacityExceeded` Delivery without its payload and still commits the Record mutation. A synthetic test request receives `202` with the same visible terminal Delivery. Capacity failures cannot be redriven because their payload is omitted; the Owner can reduce backlog and test or trigger a new intent. When a manual retry cannot enter a full pending queue, it returns `429` without changing the Delivery or consuming a redrive.

## Delivery envelope

Record Event deliveries contain the Event ID, type, Collection and Record IDs, UTC `occurredAt`, schema version, and the immutable Event's operation-appropriate `before` and `after` values. Job deliveries contain the Job ID and scheduled UTC slot. Test deliveries contain only a generated test ID and timestamp. All envelopes contain the stable Delivery ID and idempotency key. They never contain Modelry Secrets, Passwords, Sessions, API Keys, Authorization values, or internal file paths.

## Boundaries

V0.1.x supports one local Runtime and one Project on SQLite. It has no distributed queue, distributed scheduler, external broker, arbitrary job code, OAuth/OIDC integration, callback URL discovery, or cross-Project automation. Event Hooks consume accepted Record Events and do not create a new Record mutation path.
