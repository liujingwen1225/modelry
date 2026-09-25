# Extension Runtime Domain Spec

- **Status:** Accepted — Community V0.1.x
- **Date:** 2026-09-25
- **Depends on:** [ADR-0001](../adr/0001-runtime-storage-architecture.md), [ADR-0002](../adr/0002-durable-record-events.md), [ADR-0003](../adr/0003-extension-runtime-lifecycle-secrets.md)
- **Issue:** [#23](https://github.com/liujingwen1225/modelry/issues/23)

## 1. Product boundary

An Extension is a Project-owned, versioned JavaScript or TypeScript program attached to Record lifecycle events. It does not replace the Go Runtime, become a second data API, or expose the Project's files, database, process, environment or arbitrary Go values.

The Owner is the only principal that can create, edit, activate, bind, disable or inspect Extension configuration and Hook Runs in V0.1.x. Extension code is Owner-managed code; Community bounds its resources and host capabilities but does not promise a hostile-code serverless sandbox.

## 2. Domain resources

### 2.1 Extension and Revision

An Extension has a stable ID, display name, source language (`javascript` or `typescript`), current source, active Revision, enabled state, and timestamps. Saving an Extension validates and activates a new immutable Revision. A failed validation leaves the prior active Revision unchanged. Hook invocations capture one Revision and never change code mid-run.

Source and transformed output are each at most 256 KiB as UTF-8 encoded bytes. Source is standalone; imports, dynamic imports, package resolution, file modules and remote modules are unsupported. TypeScript is syntax-transformed with esbuild; Modelry does not type-check it. A source file exports named Hook functions; esbuild wraps those exports as the `ModelryExtension` global, and the Runtime calls the function matching the Binding phase. Hooks are synchronous; Promise/async results are rejected. An Extension can be disabled without deleting its Revisions, bindings or Secret aliases.

### 2.2 Lifecycle binding

A Binding associates one Extension Revision with a Collection operation and phase. Supported phases are:

| Phase | Operation | Input | Result |
|---|---|---|---|
| `beforeCreate` | Create | Collection ID, Applied Model version, proposed field values | Allow, reject, or replacement field values |
| `beforeUpdate` | Update | Collection ID, Applied Model version, prior Record snapshot, proposed field values | Allow, reject, or replacement field values |
| `beforeDelete` | Delete | Collection ID, Applied Model version, prior Record snapshot | Allow or reject |
| `afterCommitCreate` | Create | Immutable committed Record Event and resulting Record snapshot | Completion status |
| `afterCommitUpdate` | Update | Immutable committed Record Event and resulting Record snapshot | Completion status |
| `afterCommitDelete` | Delete | Immutable committed Record Event and deleted Record identity | Completion status |

An Extension has at most 18 bindings. Each Collection operation and phase has at most one enabled Binding. Enabling and replacing the configuration of an enabled Extension checks all resulting slots and changes state atomically; a conflict returns `409 BINDING_CONFLICT` and preserves the prior disabled state/configuration. Thus the Runtime never needs an undocumented ordering rule. A Collection can have separate Before and After-commit bindings for the same operation.

Hooks can affect only application Records. They do not run for Backend Model edits, RequestRecords, AuditRecords or Hook Run rows. Record values passed to a Hook are field values only; Record IDs and system timestamps are immutable metadata and cannot be changed by a Hook.

### 2.3 Secret and Secret Binding

A Secret has a stable ID, a trimmed name whose uniqueness key uses Unicode simple case folding, an encrypted value, format version and timestamps. Owner-visible names preserve their entered letter case. Values are UTF-8 and at most 16 KiB. Creating or replacing a value is write-only. List, detail, create and replace responses return only `configured: true`, metadata and a stable ID. The value is never returned after the write.

A Secret Binding associates one Secret with one Extension under a unique Extension-local alias matching `[A-Za-z][A-Za-z0-9_]{0,63}`. An Extension cannot look up another Extension's Secret by ID or name. Only an `afterCommit*` Hook receives `modelry.secrets.get(alias)`; `before*` has no Secret function. Rotating or revoking a Secret affects future invocations. An invocation uses one value snapshot loaded when it starts.

### 2.4 Allowed HTTPS Origin

An Origin Grant belongs to one Extension and consists only of a normalized HTTPS scheme, DNS hostname and optional port. Wildcards, URL paths, query, fragment, user information, IP literals, and non-HTTPS schemes are rejected. At most 32 grants may be configured; grants are explicit and default empty.

Every request must exactly match one granted origin. The Runtime rejects loopback, private, link-local, unspecified, multicast and otherwise non-global unicast IPv4/IPv6 destinations; it checks all DNS answers and dials a checked address directly. Environment proxies and redirects are disabled. The host API is unavailable to Before Hooks.

## 3. Versioned Runtime API

Every invocation receives `globalThis.modelry` with API version `modelry.extension/v1` and JSON-only input. No filesystem, database, Record mutation, process, environment or ambient fetch API is exposed.

### Before Hook

```ts
type BeforeResult =
  | { action: "allow" }
  | { action: "allow"; values: Record<string, unknown> }
  | { action: "reject" };

export function beforeCreate(context: BeforeContext): BeforeResult;
```

`context` includes the phase, operation, Collection ID, Applied Model version, proposed `values`, and, for Update/Delete, a `previous` snapshot. Values and snapshots use the normal Record field semantics. `values` replaces the mutable field values; system fields and identity are ignored/rejected. The host validates the final result against the current Applied Model and ordinary mutation authorization. Only synchronous completion is supported. `Date`, `Math.random`, asynchronous APIs, module imports, Secret access and HTTP are unavailable to a Before Hook.

`{action:"reject"}` produces the safe `CHANGE_REJECTED_BY_EXTENSION` error and a correlation ID. Script-controlled messages and exceptions never reach the caller. Before Hooks are synchronous; a returned Promise is an invalid result. Source validation rejects import statements and dynamic import expressions; `eval` and `Function` are unavailable during execution. Time and randomness APIs are unavailable, so a Before Hook result depends only on its active Revision and supplied input.

### After-commit Hook

```ts
export function afterCommitCreate(context: AfterCommitContext): void;
```

The context is an immutable committed fact with API version, phase, Record Event ID, Collection ID, operation, Applied Model version and operation-appropriate Record snapshot. A delete includes only the deleted Record identity and immutable Event metadata. It contains no credential, Secret ciphertext or unrelated Project data.

After Hooks are synchronous. The `modelry` API additionally provides:

- `modelry.secrets.get(alias: string): string | undefined`, restricted to the Extension's configured aliases.
- `modelry.http.request(request)`, restricted to the Extension's exact Origin Grants and the caps below.

The HTTP API is synchronous and accepts `{ origin, path, method, headers?, body? }`; it returns `{ status, headers, body }`. Input and output object shapes are exact; unknown properties are rejected. `origin` must exactly match a configured HTTPS Origin Grant. `path` must begin with one `/`, may include a query, and cannot contain a fragment, backslash, `//` prefix, or `.` / `..` path segment. Methods are `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. Request headers are limited to `Accept`, `Content-Type`, `Authorization`, `X-Api-Key`, `If-Match` and `If-None-Match`; at most 16 headers, each UTF-8 value at most 8 KiB, and CR/LF are rejected. Response headers are limited to `Content-Type`, `ETag`, `Last-Modified`, `Retry-After` and `X-Request-Id`. Bodies are UTF-8. At most three requests are allowed per Hook Run. Each request has a 2-second deadline; aggregate execution still stops at 5 seconds. Request bodies are at most 64 KiB and response bodies at most 256 KiB, measured as UTF-8 bytes. Redirects, proxies, local/private destinations and ungranted origins fail closed. HTTP status codes, including 4xx/5xx, are returned in `status`; a transport, address, timeout, or byte-limit failure raises only a generic `externalRequestFailed` error. Modelry never writes request/response bodies, headers, full URLs or raw transport errors to diagnostics.

## 4. Mutation and transaction rules

1. The shared Records service loads the active Binding/Revision and snapshots the Applied Model and source Record.
2. A Before Hook runs outside the SQLite write transaction. Its wall-clock and random APIs are disabled; it has no Secret or network access. Its result is bounded JSON.
3. Modelry validates the Hook result with the current Applied Model and normal Record validation. Update/Delete retain the source Record revision and Model version for compare-before-write.
4. The owning mutation transaction verifies that the source Record and Model version still match, persists the Record and Record Event, and inserts the bound After-commit intent in that same transaction. Any validation, comparison, Event, or intent write failure rolls back the Record and Event together.
5. After commit, the Runtime invokes the immutable intent once outside the transaction. Hook failure does not alter the successful mutation result. No automatic retry is performed in #23.

Application Auth profile creation uses a caller-owned transaction to commit a Profile Record and Credential together. It must prepare its Before Hook before opening that transaction, then revalidate and persist the prepared Profile in the caller's transaction. Hook callbacks are not executed while a SQLite write transaction is open.

The host exposes no Record write function, so a Hook cannot directly invoke another lifecycle Hook. A network call is an explicit external side effect; it never shares the SQLite transaction. The API does not guarantee idempotency of an external endpoint.

## 5. Hook Run states and restart behavior

Hook Run history stores only host-generated safe metadata: Run ID, Extension/Revision/Binding, phase, operation, Record/Event identity when present, status, start/end time, duration and an allowlisted error category. There is no guest logging API. Arbitrary guest strings cannot be safely scrubbed for embedded or encoded Secret values. Source text, guest-controlled messages, stack trace, raw errors, stdout/stderr, Secret values, HTTP URLs/headers/bodies/responses and Record values are not logged.

Every Run has a `correlationId` formed by `cor_` plus 36 lowercase hexadecimal characters. Its `errorCode` is `none` when no category applies, otherwise one of `extensionDisabled`, `bindingOrGrantRevoked`, `secretRevoked`, `invocationCancelled`, `extensionRuntimeUnavailable`, `budgetExceeded`, `capacityExceeded`, `changeRejected`, `invalidOutput`, `secretNotAvailable`, `secretKeyUnavailable`, `originNotAllowed`, `externalRequestFailed`, `runtimeRestarted`, or `hookFailed`.

States are:

- `running`: invocation started and is durable.
- `succeeded`: Hook returned successfully.
- `rejected`: Before Hook explicitly rejected the mutation.
- `failed`: bounded execution, validation, Secret or HTTP failure.
- `interrupted`: Runtime restart or shutdown ended the invocation before a terminal result.
- `cancelled`: Owner disabled the Extension or revoked a required Secret/Origin before execution began.

The post-commit intent is inserted with its Record Event and starts as `pending`. It pins the Extension Revision, Binding ID, Secret alias-to-ID bindings, allowed Origin Grant IDs and immutable Event ID as they existed in the Record transaction. It does not copy a Secret value. On admission, Secret values are read from the pinned Secret IDs; replacement affects invocations admitted after the replacement, and an invocation keeps the snapshot read at its start. The pinned Revision and grants are used even if a newer Revision is activated. Disabling an Extension or removing a pinned Binding/Origin Grant cancels unstarted intents; removing or replacing a pinned Secret value cancels unstarted intents for that Secret. In-flight work receives cancellation and may already have completed an external request.

Once execution starts, the intent becomes `running`; terminal Hook Run state and intent status are updated together. Startup marks every leftover `running` or `pending` intent `interrupted`. It does not automatically replay side effects. The Runtime admits at most four invocations project-wide; if all slots are occupied, a newly committed After Hook immediately becomes `failed` with `capacityExceeded` and does not wait in an unbounded queue. The latest 5,000 Hook Runs per Project are retained; pruning runs does not affect Record Events or Records.

Before Hook success/failure is recorded independently of the Record mutation outcome. If the later mutation fails, the Hook Run remains `succeeded` because the Hook itself succeeded; the mutation error is reported by the normal Record API. A failed Before Hook is durable in Hook Run history but produces no Record Event.

## 6. Failure and recovery

- A disabled/missing Extension or Binding has no effect and produces no Hook call.
- An enabled Before Hook that cannot load its Revision, run within its budgets, validate its output or read current durable state rejects the mutation safely. No durable Record or Event is left behind.
- A post-commit Hook may fail or be interrupted after its Record is committed. The mutation remains successful; the Hook Run surface shows a safe status and recovery explanation. V0.1.x offers no retry action in this package.
- Secret key absence or corruption never generates a replacement when encrypted Secret rows exist. Bound Secret use fails closed until the matching key is restored.
- Same-root restart preserves active Extension Revision, binding, Secret ciphertext/key pair and Hook Run history. Pending/running post-commit work becomes `interrupted`; current V0.1 projects have no Extension or Secret rows and upgrade without data conversion.

## 7. Resource limits

| Resource | Limit |
|---|---:|
| Source / transformed source | 256 KiB UTF-8 bytes each |
| Bindings per Extension | 18 |
| Before input / output | 1 MiB JSON UTF-8 bytes each |
| QuickJS heap / stack | 32 MiB / 1 MiB |
| Wazero guest memory | 128 MiB per invocation |
| Concurrent invocations | 4 per Project Runtime |
| Before / After-commit execution | 2 s / 5 s |
| Secret value | 16 KiB UTF-8 bytes |
| HTTP requests per Hook Run | 3 |
| HTTP body / response | 64 KiB / 256 KiB |
| Hook Run history | 5,000 newest runs per Project |

Exceeding a limit returns or stores a safe category and releases the Runtime slot. The limits do not promise a hard CPU quota for host callbacks; each callback must honor its own context and byte budget.

## 8. Admin behavior

- The Extensions surface provides source language, source editor, activation errors, enabled state, Collection/phase bindings, explicit Secret aliases and explicit HTTPS Origin grants. Save/activate retains the last valid active Revision when validation fails.
- The Secrets surface accepts create/replace values once and clears the input after a successful write. Existing values are never shown. A Secret in use can be revoked; affected future Hooks fail closed with a safe run status.
- Hook Runs show phase, time, status, Extension Revision, Collection/Record/Event context where authorized, safe error category, and a direct link to the Extension or Collection. They never show guest source, values, raw errors or HTTP content.
- Every Admin string, empty/error/loading state, command and link uses the shared English / Simplified Chinese message catalog and #30 Command Registry. Route/query context survives locale and theme changes.

## 9. Acceptance scenarios

1. A JavaScript and a TypeScript Extension can be saved, activated, disabled and reactivated; invalid TypeScript/import preserves the prior active Revision.
2. An enabled Before Hook can normalize a valid field value; a rejected/throwing/timeout/over-limit Hook leaves Record and Record Event unchanged and produces a safe Hook Run.
3. A Before Hook cannot use `Date`, randomness, Secrets, HTTP, host files, host environment, database or Record write APIs.
4. An After-commit Hook sees a committed immutable Event, can read only its bound Secret alias and can call only an explicitly granted safe HTTPS Origin.
5. A post-commit failure/timeout or process restart never rolls back the Record; no pending work is automatically repeated; restart marks unfinished work `interrupted`.
6. Secret value is absent from SQLite plaintext, Admin reads, RequestRecord, Audit, Hook Run, logs and safe API errors. Create/replace clears the input and has no reveal endpoint.
7. Missing/invalid key with stored Secrets prevents dependent execution; restoring the same key and restarting recovers access.
8. Application Auth Profile create hooks run before the caller-owned Credential transaction; a Hook failure leaves no Profile or Credential, while a successful Profile Record and Credential remain atomic.
9. Same-root restart preserves Extension/Secret state; a fresh V0.1 project upgrades without manual secret setup until its first Secret is created.
