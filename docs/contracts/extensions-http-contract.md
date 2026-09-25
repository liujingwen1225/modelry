# Extension, Lifecycle Hook and Secret HTTP Contract

- **Status:** Accepted — Community V0.1.x
- **Date:** 2026-09-25
- **Depends on:** [ADR-0003](../adr/0003-extension-runtime-lifecycle-secrets.md), [Domain Spec 0005](../specs/0005-extension-runtime-domain-spec.md)
- **Base path:** `/admin/api/v1`
- **Authorization:** active Modelry Owner session cookie; unsafe browser requests retain the existing same-origin/CSRF checks

These endpoints are Control Plane APIs. Application Sessions, Service Account API Keys and Application Record Access Rules cannot authorize them. Secret values are accepted only on create/replace and never returned.

## 1. Extensions

### `GET /extensions`

Returns the Owner's Extension list. Each item contains `id`, `name`, `language`, `activeRevision`, `enabled`, `bindingCount`, `secretBindingCount`, `originGrantCount`, `updatedAt`. It never returns Secret values or Hook input/output.

### `POST /extensions`

Creates an Extension with `enabled: false` and its first active Revision. The request body is:

```json
{
  "name": "Normalize profile",
  "language": "typescript",
  "source": "export function beforeCreate(context) { return { action: 'allow' }; }"
}
```

Returns `201` and the same metadata as the detail response. Source validation/transformation happens before persistence. Invalid source creates no Extension.

### `GET /extensions/{extensionId}`

Returns metadata, active `source`, current `bindings`, `secretBindings`, and `allowedOrigins`. Secret binding items contain only `alias`, `secretId`, `secretName`, and `configured`.

### `PUT /extensions/{extensionId}`

Replaces the editable Extension configuration:

```json
{
  "name": "Normalize profile",
  "language": "typescript",
  "source": "export function beforeCreate(context) { return { action: 'allow', values: context.values }; }",
  "bindings": [
    { "collectionId": "col_profile", "operation": "create", "phase": "before" },
    { "collectionId": "col_profile", "operation": "create", "phase": "afterCommit" }
  ],
  "secretBindings": [{ "alias": "MAIL_API_KEY", "secretId": "sec_123" }],
  "allowedOrigins": ["https://api.example.test"]
}
```

Bindings, aliases and origins are replaced as a whole. An Extension accepts at most 18 bindings. Secret values are not accepted. Each tuple `(collectionId, operation, phase)` is unique among enabled Extensions. Collection must exist and support the requested Record operation. The origin list is empty by default. A changed source creates the next immutable Revision only after complete validation; a failed replacement leaves the prior configuration and active Revision intact. Replacing the configuration of an enabled Extension validates all resulting bindings atomically; a conflict returns `409 BINDING_CONFLICT` without changing any configuration or Revision.

Returns `200` with detail metadata and active source, but no Secret value. `409 BINDING_CONFLICT` includes `details.collectionId`, `details.operation` and `details.phase` for the occupied slot. `422 VALIDATION_FAILED` includes `details.violations` entries with JSON Pointer `path`, stable safe `code`, and a generic safe `message`; it never includes source compiler diagnostics, stack traces, Secret values, or submitted Secret fields.

### `POST /extensions/{extensionId}/enable`

Enables future invocations only if every configured `(collectionId, operation, phase)` slot is unoccupied by another enabled Extension. This check and the enabled-state change are atomic. A conflict returns `409 BINDING_CONFLICT`, leaves the Extension disabled and does not change its bindings or Revision. Success returns `200` with `enabled: true`. It does not replay old Record Events or unfinished intents.

### `POST /extensions/{extensionId}/disable`

Disables new invocations and cancels matching `pending` intents that have not started. It requests cancellation of matching in-flight work; a network request already sent cannot be undone. Returns `200` with `enabled: false`.

### `GET /extensions/{extensionId}/runs?cursor={cursor}&limit={limit}`

Returns the newest Hook Run summaries in reverse start-time order, bounded to 100 items. `cursor` is opaque and preserves stable pagination. Each summary contains `runId`, `revision`, `collectionId`, `recordId`, `eventId`, `operation`, `phase`, `status`, `startedAt`, `completedAt`, `durationMs`, `errorCode`, and a `correlationId` in the form `cor_` followed by 36 lowercase hexadecimal characters. `errorCode` is `none` when no safe error category applies; otherwise it is one of `extensionDisabled`, `bindingOrGrantRevoked`, `secretRevoked`, `invocationCancelled`, `extensionRuntimeUnavailable`, `budgetExceeded`, `capacityExceeded`, `changeRejected`, `invalidOutput`, `secretNotAvailable`, `secretKeyUnavailable`, `originNotAllowed`, `externalRequestFailed`, `runtimeRestarted`, or `hookFailed`. It contains no source, Record values, error message, stdout/stderr, full HTTP URL, headers, body, response or Secret data.

### `GET /extensions/{extensionId}/runs/{runId}`

Returns the same safe Hook Run summary. Unknown or expired IDs return `404 NOT_FOUND`.

There is no manual replay endpoint in #23.

## 2. Secrets

Secret names are trimmed and compared using Unicode simple case folding. Names that differ only by letter case cannot be created or renamed to collide.

### `GET /secrets`

Returns `[{id,name,configured,createdAt,updatedAt}]`. The cleartext value and ciphertext are never returned.

### `POST /secrets`

Creates a Secret from `{ "name": "Mail provider", "value": "..." }`. Value is non-empty UTF-8 and at most 16 KiB when encoded as UTF-8 bytes. Returns `201` with `{id,name,configured:true,createdAt,updatedAt}`. Request bodies are not persisted to RequestRecord or Audit.

### `PATCH /secrets/{secretId}`

Renames a Secret using `{ "name": "New name" }`. It cannot modify or reveal its value. Returns the metadata response.

### `PUT /secrets/{secretId}/value`

Replaces the value using `{ "value": "..." }`. Value is non-empty UTF-8 and at most 16 KiB when encoded as UTF-8 bytes. Returns `200` with metadata only. Existing value is not required or accepted in the response. The UI clears the write-only field after success.

### `DELETE /secrets/{secretId}`

Revokes and deletes a Secret. Future Hook calls cannot resolve it and fail safely. Matching pending intents that have not started become `cancelled`; in-flight guest execution is cancelled where possible. Returns `204`.

## 3. Shared errors

Errors use the existing `ApiError` envelope with `code`, safe `message`, optional `hint`, and `requestId`. Codes added by this contract:

- `EXTENSION_RUNTIME_UNAVAILABLE` — before Hook unavailable; mutation did not commit.
- `CHANGE_REJECTED_BY_EXTENSION` — Before Hook denied the change; no mutation or Record Event committed.
- `EXTENSION_BUDGET_EXCEEDED` — before budget exhausted; no mutation committed.
- `BINDING_CONFLICT` — another enabled Extension already owns that Collection / operation / phase.
- `SECRET_KEY_UNAVAILABLE` — an encrypted Secret could not be opened safely; no dependent invocation starts.
- `SECRET_NOT_AVAILABLE` — a configured alias cannot be resolved; no dependent invocation starts.
- `ORIGIN_NOT_ALLOWED` — HTTP origin is not explicitly granted or fails address validation.
- `VALIDATION_FAILED` — Extension source/configuration fails safe validation.
- `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `INTERNAL_ERROR` — existing shared error semantics.

Post-commit Hook failure does not become an error response to the already-committed Record mutation. Its status appears in Hook Runs. Script-controlled messages, stack traces, raw network errors, Secret values and HTTP contents never appear in an `ApiError`.

There is no guest-controlled log API. Hook Run diagnostics contain only host-generated metadata and allowlisted error categories. Post-commit intent metadata pins the active Revision, Binding, Secret alias-to-ID mapping and allowed Origin Grant IDs from the committing transaction; it does not store cleartext values. The worker executes an intent only while its pinned resources remain usable. Disable/revoke actions cancel unstarted matching intents, and in-flight cancellation is best effort. The project admits at most four invocations; when full, a newly committed After Hook is immediately recorded as failed with `capacityExceeded` and is not queued.

## 4. Compatibility and limits

- Same-root restart retains active Extension Revisions, bindings, encrypted Secret values, key file and run history.
- A missing key with encrypted rows returns `SECRET_KEY_UNAVAILABLE` and never creates a replacement key.
- Existing V0.1 Projects have no Extension or Secret rows. Upgrade creates the empty feature store and may create a key only when the first Secret is written.
- Limits and phase semantics are normative in [Domain Spec 0005](../specs/0005-extension-runtime-domain-spec.md). This Contract does not add public Application API routes.
