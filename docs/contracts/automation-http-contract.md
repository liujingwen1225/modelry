# Webhooks & Jobs HTTP Contract

- **Status:** Accepted — Community V0.1.x Work Package #24
- **Canonical schema:** [OpenAPI](./openapi.yaml)
- **Domain semantics:** [Webhooks & Jobs Domain Spec](../specs/0006-webhooks-jobs-domain-spec.md)
- **Issue:** [#24](https://github.com/liujingwen1225/modelry/issues/24)

All routes are under `/admin/api/v1` and require the active Owner session. Mutations use the existing same-origin CSRF protection, canonical `X-Request-Id`, and redacted RequestRecord behavior. Request bodies, Webhook URL paths, Record payloads, Secret values, signatures, response bodies and raw network errors are never copied into RequestRecord or Audit.

## Webhooks

### `GET /webhooks`

Returns up to 100 Webhook summaries, newest updated first: `id`, `name`, `targetUrl`, `signingSecretId`, `signingSecretName`, `signingConfigured`, `enabled`, `revision`, and timestamps. It never returns a Secret value. If a selected Secret was deleted, the Webhook retains its unavailable `signingSecretId`, returns an empty `signingSecretName` and `signingConfigured: false`, and stays disabled until the Owner selects another configured Secret and enables it.

### `POST /webhooks`

Creates a disabled endpoint from `{name,targetUrl,signingSecretId}`. The HTTPS URL has a DNS name and path only, without user info, query, or fragment. The referenced Project Secret must exist and be configured. Returns `201` with detail metadata.

### `GET /webhooks/{webhookId}` and `PUT /webhooks/{webhookId}`

Read or replace `{name,targetUrl,signingSecretId}`. A successful replacement increments `revision`; it does not retarget existing Deliveries or their active automatic retry round. A later manual redrive snapshots the currently enabled Webhook revision. Returns the same safe detail DTO. The signing Secret is write-only and selected by ID; replacement never accepts a value.

### `POST /webhooks/{webhookId}/enable` and `POST /webhooks/{webhookId}/disable`

Explicitly enable or disable the endpoint. Disable cancels pending Event Hook and Job Deliveries with `webhookDisabled` and requests cancellation of their in-flight attempts. It does not change associated Event Hook or Job configuration. While disabled, Record Events produce no Delivery and due slots consumed by enabled Jobs are skipped while advancing `nextRunAt`. A disabled Job retains its due slot even if the Webhook is disabled; after the Job is enabled, the scheduler consumes that slot according to the Webhook state at that time. Re-enabling the Webhook resumes future triggers and does not replay skipped work or revive cancelled Deliveries. Success returns `{id,enabled}`.

Enabling requires an existing, configured signing Secret. An Owner may still configure or enable Event Hooks and Jobs while their Webhook is disabled; they remain dormant until the Webhook is enabled.

### `POST /webhooks/{webhookId}/test`

Persists and dispatches a signed synthetic `webhook.test` Delivery. It contains no Record values and may be sent while the endpoint is disabled if its signing Secret is available. If the pending or payload quota is full, it still returns `202` with a terminal `capacityExceeded` Delivery that has no payload and made no network request. A disabled state does not cancel this explicit test; Secret revocation does. Poll `GET /deliveries/{deliveryId}` for attempts and terminal status.

## Event Hooks

### `GET /event-hooks` and `POST /event-hooks`

List up to 100 Event Hooks or create one from `{name,collectionId,eventType,webhookId}`. `eventType` is `record.created`, `record.updated`, or `record.deleted`. Collection and Webhook must exist. One Event Hook per `(collectionId,eventType,webhookId)` is allowed. New hooks start disabled. Returns `201` with metadata.

### `GET /event-hooks/{eventHookId}` and `PUT /event-hooks/{eventHookId}`

Read or replace the full `{name,collectionId,eventType,webhookId}` configuration. Replacement does not alter already accepted Deliveries. Returns the current metadata.

### `POST /event-hooks/{eventHookId}/enable` and `POST /event-hooks/{eventHookId}/disable`

Explicitly start or stop future event triggers. A Delivery is created only if both the Event Hook and its Webhook are enabled. Previously accepted Deliveries continue independently unless their Webhook is disabled or its signing Secret is revoked. Success returns `{id,enabled}`.

## Jobs

### `GET /jobs` and `POST /jobs`

List up to 100 Jobs or create one from `{name,webhookId,cron}`. `cron` is a standard five-field minute-level expression and always runs in UTC. Second/year fields, descriptors, and timezone prefixes are rejected. The response includes `nextRunAt`. New Jobs start disabled.

### `GET /jobs/{jobId}` and `PUT /jobs/{jobId}`

Read or replace `{name,webhookId,cron}`. A valid edit recalculates `nextRunAt` from the current UTC time and preserves enabled state. Existing Deliveries remain unchanged.

### `POST /jobs/{jobId}/enable` and `POST /jobs/{jobId}/disable`

Explicitly start or stop future schedule triggers. While the Job is disabled, its past due slot is preserved even when the Webhook is also disabled. Re-enabling the Job lets the scheduler consume that slot: it coalesces it to at most one catch-up Delivery if the Webhook is enabled in the scheduling transaction; otherwise it skips the slot and advances `nextRunAt`. Enabling the Webhook after that skip does not catch it up. For an enabled Job, any due slot consumed while the Webhook is disabled is skipped and advances `nextRunAt`. Previously accepted Deliveries continue independently unless their Webhook is disabled or its signing Secret is revoked. Success returns `{id,enabled,nextRunAt}`.

## Delivery history

### `GET /deliveries?cursor={cursor}&limit={limit}&sourceType={sourceType}&status={status}`

Returns a bounded page of safe Delivery summaries, newest first. `limit` defaults to 50 and is at most 100. `cursor` is opaque and stable. Filters are optional and limited to `eventHook`, `job`, `test`, `pending`, `running`, `succeeded`, `failed`, and `cancelled` values as appropriate.

### `GET /deliveries/{deliveryId}`

Returns one safe Delivery summary plus bounded processing-attempt history: `attempt`, `round`, `webhookRevision`, status, start/end timestamps, duration, optional HTTP status, and safe `errorCode`. Each processing attempt is recorded before preflight and can issue zero or one HTTP request; a preflight failure has no HTTP status and sends no request. The summary's `webhookRevision` is the revision captured when the Delivery was first created; each attempt reports the revision captured for its attempt round. It does not return the immutable payload or target URL.

### `POST /deliveries/{deliveryId}/retry`

Starts a new manual attempt round for a terminal failed Delivery if it has fewer than three manual redrives, retains its payload, and its Webhook is enabled with a configured signing Secret. A `capacityExceeded` Delivery with no payload cannot be redriven. The Delivery ID, idempotency key, payload and prior attempt history remain unchanged. The round snapshots the Webhook's current URL, signing Secret reference and configuration revision; automatic retries in that round keep this snapshot. Each attempt reports the revision it used. If the current Webhook revision differs from the latest attempt's revision, the Owner UI warns that configuration changed. The warning says that if the URL changed, both receivers may have acted and the key cannot deduplicate across different receiver systems. Returns `202` with its pending summary. If the pending quota is full, returns `429 DELIVERY_CAPACITY_EXCEEDED` without changing the Delivery or consuming a redrive. Invalid state or retry exhaustion returns `409 DELIVERY_NOT_RETRYABLE`.

## Safe errors

Validation errors use `422 VALIDATION_FAILED` with allowlisted JSON Pointer violations. Stable codes include `invalidName`, `invalidWebhookUrl`, `invalidSecretReference`, `invalidCollection`, `invalidEventType`, `duplicateEventHook`, `invalidCron`, `tooManyWebhooks`, `tooManyEventHooks`, and `tooManyJobs`. Failed or cancelled attempts use only `capacityExceeded`, `secretNotAvailable`, `secretKeyUnavailable`, `secretRevoked`, `webhookDisabled`, `originNotAllowed`, `externalRequestFailed`, `deliveryRejected`, `attemptInterrupted`, or `hookFailed` (for an unexpected host failure). Raw transport errors and remote response text are excluded.

All list/read/write routes are bounded. IDs and cursors are opaque; no SQL, arbitrary filters, arbitrary headers, response-body inspection, manual event replay, or application-user access is exposed.

Deleting a selected Project Secret disables every referencing Webhook, retains the unavailable Secret ID on its configuration, cancels pending Deliveries with `secretRevoked`, and requests cancellation of in-flight attempts. Secret value replacement preserves the Secret ID and does not cancel deliveries; attempts that start later use the replacement value. If the Project encryption key is missing or invalid, selecting another Secret cannot decrypt existing ciphertext; restore the matching `.modelry/secrets.key` with its protected permissions and restart Runtime before retrying an eligible failed Delivery. Cancellation cannot undo a request already accepted by the receiver.
