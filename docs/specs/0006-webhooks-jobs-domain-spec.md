# Webhooks & Jobs Domain Spec

- **Status:** Accepted — Community V0.1.x Work Package #24
- **Scope:** Event Hooks, signed Webhooks, UTC Cron Jobs, durable Delivery history
- **Depends on:** [ADR-0001](../adr/0001-runtime-storage-architecture.md), [ADR-0002](../adr/0002-durable-record-events.md), [ADR-0003](../adr/0003-extension-runtime-lifecycle-secrets.md), [ADR-0004](../adr/0004-local-webhook-delivery-and-cron.md), [Local Automation Product Model](../product-model/0001-local-automation.md), [Realtime & Record Event Domain Spec](./0004-realtime-event-domain-spec.md), [Extension Runtime Domain Spec](./0005-extension-runtime-domain-spec.md)
- **Issue:** [#24](https://github.com/liujingwen1225/modelry/issues/24)

## 1. Product resources

### 1.1 Webhook

A Webhook belongs to one Project and contains a stable ID, name, HTTPS `targetUrl`, referenced Project `signingSecretId`, endpoint configuration revision, enabled state, and timestamps. Its signing key is a Secret value from #23. APIs return Secret ID/name/configured metadata only; they never return the value or derived request signature. If the selected Secret is deleted, the Webhook keeps the now-unavailable Secret ID, reports an empty `signingSecretName` and `signingConfigured: false`, and remains disabled until its Owner selects an existing configured Secret and enables it.

The URL must be an HTTPS URL with a DNS hostname, optional port and absolute path. It cannot contain user information, query parameters, fragment, IP literal, wildcard or unescaped control characters. The shared safe HTTP transport rejects unsafe DNS answers, private/non-global destinations, redirects and environment proxies, and dials the checked address directly. A Webhook target is explicit Owner configuration, but it cannot bypass these network checks. A disabled Webhook blocks Event Hook and Job deliveries; an explicit Owner-requested synthetic test may still send while disabled if its signing Secret is available.

Editing a Webhook increments its configuration revision. New Deliveries use the new revision. Existing automatic retry rounds retain their target URL and Secret ID snapshots. Starting a manual retry round for a failed Delivery snapshots the currently enabled Webhook's target URL, Secret ID, and configuration revision; automatic retries in that round retain this new snapshot. This lets an Owner correct a URL or replace a revoked Secret before retrying. Secret value replacement changes the value used by later attempts but does not change the selected Secret ID for a round. Deleting a selected Secret disables each referencing Webhook, cancels its pending Deliveries with `secretRevoked`, and requests cancellation of in-flight attempts. A request already accepted remotely cannot be undone.

### 1.2 Event Hook

An Event Hook has one Collection, one durable Record Event type (`record.created`, `record.updated`, or `record.deleted`), one Webhook, and an enabled state. One Event Hook is unique for the tuple `(collectionId, eventType, webhookId)`. A Project has at most 64 Event Hooks. A disabled Event Hook or disabled Webhook does not create new Deliveries; Deliveries already committed remain eligible to run unless the Webhook or selected Secret is disabled or revoked.

The outgoing Record Event body uses the immutable committed Event. Create includes `after`; Update includes `before` and `after`; Delete includes `before`. It contains field values, so the UI explicitly tells the Owner that those values are sent to the configured destination. Modelry-owned Passwords, Sessions, API Keys and Secret values are not included.

### 1.3 Job

A Job has a stable ID, name, one Webhook, one five-field Cron expression, enabled state, persisted `nextRunAt`, `lastRunAt`, and timestamps. One Project has at most 32 Jobs. Cron uses minute, hour, day-of-month, month and day-of-week fields with standard numeric, list, range, step and name forms. Seconds, year, descriptors and per-expression timezone prefixes are rejected. Expressions run in UTC.

A due slot for an enabled Job and enabled Webhook creates one `job.scheduled` Delivery and advances `nextRunAt` in the same SQLite transaction. At startup, overdue slots are coalesced: at most one Delivery is created using the oldest unprocessed `nextRunAt`, then the next future slot is calculated. If the Job is disabled, its due slot is preserved even if the Webhook is also disabled. Enabling the Job creates at most one catch-up Delivery if the Webhook is enabled when the scheduler consumes that slot; otherwise it skips the slot and advances `nextRunAt`. If an enabled Job reaches a due slot while the Webhook is disabled, the slot is skipped and `nextRunAt` advances without a Delivery. The scheduler does not replay every missed minute or wait for a remote endpoint during startup. Accepted Deliveries continue unless their Webhook or selected Secret is disabled or revoked.

### 1.4 Delivery and Attempt

A Delivery stores stable ID, source type/id, Webhook ID and original revision, initial target URL and Secret ID snapshot, optional Record Event ID, immutable JSON payload (unless terminal capacity failure), state, created/next-attempt/completion times, automatic attempt round, manual redrive count, last safe error category, and last HTTP status. Each attempt stores the Webhook revision used for its round. Its ID is its stable idempotency key. Delivery APIs return metadata and safe summaries only; never return payload values, request/signature headers, Secret data, response bodies, or raw errors.

States are `pending`, `running`, `succeeded`, `failed`, and `cancelled`. A Delivery Attempt is one bounded worker-processing attempt, recorded durably before preflight, that issues zero or one HTTP request. Attempt rows store attempt/round, start/end time, duration, outcome, safe error category, and optional HTTP status; a missing HTTP status can mean preflight failed before any request or no response was received. They never store headers or body content.

The delivery envelope is:

```json
{
  "deliveryId": "dlv_<36 lowercase hexadecimal characters>",
  "event": {
    "id": "evt_...",
    "type": "record.updated",
    "occurredAt": "2026-09-25T00:00:00Z",
    "collectionId": "col_...",
    "recordId": "rec_...",
    "schemaVersion": 1,
    "before": {"title": "Before"},
    "after": {"title": "After"}
  }
}
```

Only fields applicable to the event are present. A Job envelope has `event.type: "job.scheduled"`, `jobId` and the UTC `scheduledAt` slot. A manual test has `event.type: "webhook.test"`, a generated `testId` and `occurredAt`; it contains no Record data. `Idempotency-Key` equals `deliveryId`. Record Event deliveries also include `X-Modelry-Event-Id`.

## 2. Transaction and delivery guarantees

1. The Record service persists Record and durable Record Event within the existing owner transaction. If matching Event Hooks and their Webhooks are enabled, it also inserts their Delivery rows and one bounded immutable payload per Record Event. No network call occurs in a Record transaction.
2. A Job scheduler transaction advances every due enabled Job's `nextRunAt`; it inserts the scheduled Delivery only if the Webhook is enabled. A unique `(jobId, scheduledAt)` key prevents duplicate logical slots. A disabled Job retains its due slot until it is enabled or its Cron expression is edited, even if the Webhook is also disabled. When an enabled Job consumes a due slot while its Webhook is disabled, that slot is skipped and `nextRunAt` advances.
3. A worker claims a Delivery and durably records a bounded Attempt with a short SQLite transaction. It performs Secret, encryption-key and egress preflight, then issues at most one bounded HTTPS request outside the transaction, and stores the outcome in a later transaction.
4. Each non-cancelled round is eligible for at least one persisted, bounded worker attempt while the Runtime dispatcher is running. Preflight may fail and issue no HTTP request, so this is at-least-once processing-attempt semantics and does not guarantee a send or successful delivery. When preflight succeeds, the attempt issues one request. A crash after the receiver accepts a request but before Modelry commits `succeeded` may produce a duplicate. Every HTTP request in one round uses the same Delivery ID, `Idempotency-Key`, body, target URL, and Secret reference, so that receiver may deduplicate by the key. Explicit Webhook disable or Secret revocation cancels affected Event Hook/Job Deliveries. A manual redrive may change the target URL; the stable key cannot deduplicate across different receiver systems, so both receivers may have applied the intent.
5. A request uses `Content-Type: application/json`, `Idempotency-Key`, `X-Modelry-Delivery-Id`, `X-Modelry-Signature`, and, for Record Events, `X-Modelry-Event-Id`. Signature is `t=<Unix seconds>,v1=<hex(HMAC-SHA256(secret, timestamp + "." + exact UTF-8 body))>`. Retries use a fresh timestamp and signature.
6. HTTP 2xx succeeds. Network errors/timeouts, HTTP 408, 429 and 5xx are transient. Other 3xx/4xx statuses fail immediately. Each round has at most eight bounded processing attempts, with waits of 1 minute, 5 minutes, 15 minutes, 1 hour, 3 hours, 6 hours and 12 hours after attempts 1 through 7; attempt 8 is terminal. A preflight failure is terminal without a request. A Delivery has at most four rounds total: its initial round plus up to three manual redrives, for at most 32 processing attempts and no more than 32 HTTP requests.
7. An Owner may retry a failed Delivery up to three times. A retry starts a new attempt round on the same Delivery ID, keeps its exact body and history, and snapshots the currently enabled Webhook's URL, Secret ID, and configuration revision. Each attempt records that revision and signs with the current value of the selected Secret. Automatic retries in the round keep its URL and Secret ID snapshot. If the selected Secret or encryption key is unavailable, the attempt fails before network access.
8. A Record Event or Job slot creates a Delivery only when its trigger and Webhook are enabled. Disabling a Webhook cancels pending Event Hook and Job Deliveries with `webhookDisabled` and requests cancellation of their in-flight attempts; remote work already accepted cannot be undone. New Record Events are skipped while disabled, and due slots consumed by enabled Jobs advance without Delivery. A disabled Job retains its due slot even if its Webhook is disabled; after it is enabled, the scheduler consumes that slot according to the Webhook state at that time. Re-enabling a Webhook resumes future triggers without replaying skipped events or slots. An explicit Owner-requested test may send while disabled and is not cancelled by the disabled state. Disabling an Event Hook stops future intents and leaves previously accepted rows unchanged.
9. Deleting a selected Secret disables each referencing Webhook, cancels its pending Deliveries with `secretRevoked`, and requests cancellation of in-flight requests. Replacing a Secret value preserves its ID and does not cancel work. Secret deletion or in-flight cancellation cannot undo a request already accepted remotely.
10. At Runtime startup, each leftover `running` attempt becomes `interrupted`. An automatic Delivery returns to `pending` if the automatic attempt budget remains and both Webhook and Secret row remain available; a revoked/missing Secret or disabled Webhook makes it `cancelled`. Startup does not create or replace the Project encryption key. If that key is unavailable, the next bounded worker attempt records `secretKeyUnavailable` and ends the Delivery as `failed` before network access; after restoring the matching key and restarting Runtime, an eligible failed Delivery may be redriven. A synthetic test resumes while its Secret remains available even if the Webhook is disabled. If the attempt budget is exhausted, the Delivery becomes terminal `failed` with `attemptInterrupted`. No startup path waits for remote availability.

## 3. Bounds

| Resource | Limit |
|---|---:|
| Webhooks per Project | 32 |
| Event Hooks per Project | 64 |
| Jobs per Project | 32 |
| Active outbound requests | 4 per Runtime |
| HTTP deadline | 2 seconds per attempt |
| Request body | 1 MiB UTF-8 bytes |
| Pending Deliveries | 1,000 per Project |
| Retained Deliveries | 5,000 per Project |
| Retained Delivery payload bytes | 64 MiB per Project |
| Bounded processing attempts per round | 8 |
| Total rounds per Delivery | 4 |
| Total processing attempts per Delivery | 32 |
| Maximum HTTP requests per Delivery | 32 |
| Manual retry rounds per Delivery | 3 |

When a new Event Hook, Job, or synthetic test intent exceeds a pending or payload limit, Modelry persists a terminal `failed` Delivery with `errorCode: capacityExceeded`, omits its payload, and continues the Record transaction or Runtime startup. A synthetic test still returns `202` with that Delivery. The Owner sees the failed Delivery and can reduce backlog or endpoint load. A Delivery without a payload cannot be redriven because replaying its immutable intent is impossible; manual event replay is not exposed. If a manual retry reaches the pending limit, the API returns `429 DELIVERY_CAPACITY_EXCEEDED` without changing the Delivery or consuming a redrive. Pending/running Deliveries are not pruned. Oldest terminal Deliveries are pruned to the history limit; a payload remains only while a retained Delivery references it.

## 4. Secret, safety, and observability

- Webhook signing Secret selection uses the #23 Owner-only Secret metadata API. The attempt resolves the Secret value through an internal callback, calculates the HMAC, and clears plaintext memory after use. A missing Secret or unavailable/mismatched key fails closed and sends no request.
- The URL itself cannot carry credentials. URL query, response body, response headers, HTTP request body, Authorization values, signing value, and full target URL are excluded from delivery diagnostics and RequestRecord.
- Only the active Owner may manage Webhooks, Event Hooks, Jobs, test and retry Deliveries. Application users, service accounts and API keys have no access to these Control Plane routes.
- Successful configuration changes, enable/disable actions, test requests and retries use the existing redacted RequestRecord and Audit integration where available. RequestRecord stores route template, status, duration and request ID only, not JSON bodies or endpoint URL.
- Audit action identifiers are `webhook.created|updated|enabled|disabled`, `eventHook.created|updated|enabled|disabled`, `job.created|updated|enabled|disabled`, `delivery.testRequested`, and `delivery.redriven`. Each AuditRecord contains the authenticated Owner and resource identity; it excludes target URLs, payloads, and Secret values. A mutation and its AuditRecord commit in the same SQLite transaction.
- English and Simplified Chinese Admin routes use the #30 Shell, shared Command Registry, theme and i18n catalog. The Automation surface keeps its selected resource and history context across reload, theme and locale changes.

## 5. Failure and recovery

- Endpoint unreachable or transient HTTP error: retry within the fixed attempt budget; show `nextAttemptAt`, latest attempt and a safe reason.
- Non-retryable HTTP status: mark the Delivery failed with the status code and let the Owner correct configuration and retry.
- Signing Secret deleted or missing: stop before network access. Secret deletion disables each referencing Webhook and cancels its pending Deliveries; select a configured replacement and re-enable the Webhook. A retained failed Delivery with payload may then be retried, while a cancelled Delivery cannot be retried.
- Project encryption key missing, invalid or inaccessible: stop before network access with `secretKeyUnavailable`. Selecting another Secret cannot decrypt existing ciphertext. Restore the matching `.modelry/secrets.key` for this Project with its protected permissions, restart Runtime, then retry an eligible failed Delivery. Do not generate a replacement key while encrypted Secrets exist.
- Webhook disabled: cancel pending Event Hook and Job rows and cancel their active request contexts. New Event Hook triggers are skipped, and due slots consumed by enabled Jobs advance without Delivery. A disabled Job retains its due slot even if its Webhook is disabled; after it is enabled, the scheduler consumes that slot according to the Webhook state at that time. Re-enabling resumes future triggers only. Explicit synthetic tests remain available while disabled. Already transmitted requests may still complete remotely.
- Secret deleted: disable referencing Webhooks, cancel their pending rows and active request contexts with `secretRevoked`. Select a configured replacement and re-enable the Webhook for future triggers.
- Runtime shutdown/crash: cancel active contexts; startup converts interrupted attempts and resumes their bounded Delivery. If Secret decryption fails because the Project key is unavailable, the next worker attempt ends with `secretKeyUnavailable`; restoring the matching key and restarting Runtime permits an eligible failed Delivery to be redriven.
- Job schedule overdue: while a Job is disabled, preserve its due slot even if its Webhook is disabled. When the Job is enabled, the scheduler consumes that slot; it creates one catch-up Delivery if the Webhook is enabled in that transaction, otherwise skips the slot and advances to the next UTC run. Enabling the Webhook after a skipped slot does not catch it up.
- Target resolves to a private, local, link-local, multicast or unspecified address, redirects, or exceeds limits: fail safely without exposing raw endpoint or network diagnostics.

## 6. Admin closure

The Automation surface provides Webhook, Event Hook, Job and Delivery history views. Webhook forms clearly distinguish the HTTPS URL from the write-only signing Secret selector. Event Hook creation identifies the exact Collection and Record Event type and states that selected event snapshots are sent to that URL. Job creation validates the UTC Cron expression and previews the next run. Delivery details show status, source, Delivery ID, event/job context, attempt times, HTTP status and localized safe error category. A Retry action appears only for retryable terminal failure with a retained payload, within the manual redrive limit, and while the Webhook is enabled. If the current Webhook revision differs from the latest attempt's `webhookRevision`, the UI warns that configuration changed. It says that if the URL changed, both receivers may have acted and the stable idempotency key cannot deduplicate across them. A Test action produces a signed synthetic webhook with no Record values.

All user-visible loading, empty, validation, status and recovery states use the shared English / Simplified Chinese catalog, #30 theme and command registry. Stable query/route context is preserved.

## 7. Acceptance

1. A real Record mutation commits its Record, Event and Event Hook Delivery intent in one SQLite transaction; HTTP begins after commit.
2. A Record transaction rollback leaves no Delivery intent. A successful Record mutation remains successful when a target is slow, unavailable, or rejects its request.
3. A receiver gets the documented JSON, HMAC signature, stable Delivery ID and idempotency key. No Secret value or request/response content is persisted.
4. HTTP success ends a Delivery. Transient errors retry at the bounded schedule, terminal HTTP errors expose safe status and the Owner can retry within the manual limit.
5. Event Hook and Job disable actions stop new triggers; Webhook disable cancels pending Event Hook/Job Deliveries and attempts to cancel running work; Secret revoke disables linked Webhooks and cancels all dependent pending work.
6. A Delivery has at most eight bounded processing attempts in each of four rounds, and no more than 32 HTTP requests; preflight failure may issue none. An in-flight delivery survives same-root restart as interrupted attempt history and is retried within the current round budget. Duplicate remote acceptance is deduplicable by the stable key at the same receiver. Redriving to a changed URL warns that another receiver may also have applied the intent.
7. A UTC Job persists next-run state, emits one Delivery per due slot, coalesces missed slots after restart, and never creates an unbounded execution queue.
8. A full pending/payload quota creates visible `capacityExceeded` state while Record mutations and startup continue; the Owner's synthetic test returns `202` with that terminal state. Redriving a capacity failure is unavailable, and a manual retry at full pending capacity returns `429` without consuming a redrive.
9. Real Owner Browser acceptance covers empty state, create/edit/test, event delivery, retry, disable/revoke, Job next-run, bilingual copy, Theme/Command Palette, and same-root restart with durable SQLite verification.

## 8. Non-goals

No distributed queue/scheduler, multi-Runtime locking, arbitrary job code, app-user endpoint configuration, OAuth/OIDC, non-HTTPS endpoints, unrestricted headers, callback URLs, or PostgreSQL/Cloud/Enterprise behavior.
