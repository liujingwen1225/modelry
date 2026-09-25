# ADR-0003：受控 Extension Runtime、Lifecycle Hooks 与 Secrets

- **Status:** Accepted — Community V0.1.x
- **Date:** 2026-09-25
- **Scope:** Project Extensions、Collection Record Lifecycle Hooks、Secret 与受限 Post-commit HTTP

## Context

Community Extensions must run without moving Record business rules into Go scripts or exposing Modelry's SQLite, Project files, host environment, or process. Record pre-commit behavior must be deterministic and rollback-safe. Post-commit side effects cannot share the Record transaction, yet their intent and restart state must be visible. Secrets must remain separate from ordinary Records, Requests and Audit.

The upstream QJS adapter is not used with its defaults. It mounts a host directory through `WithDirMount`, whose parent traversal escapes the mount, lacks a Wazero memory page ceiling, does not enforce `MaxExecutionTime`, and can panic during cleanup after Wazero cancels and closes a module. An executable temporary adapter spike passed the memory, cancellation and empty-filesystem probes only after those boundaries were patched.

## Decisions

### Extension resource and activation

- An Extension belongs to one Project and has one JavaScript or TypeScript source. Saving valid code creates a new immutable Revision and makes that Revision active for enabled bindings. Disabling an Extension prevents new calls. V0.1.x does not load imports, npm packages, filesystem packages or remote code.
- Source and transformed output are each limited to 256 KiB. TypeScript uses esbuild as a syntax transform; Modelry does not promise type checking. Syntax or unsupported import failures reject activation without replacing the current active Revision.
- Each Collection operation and Hook phase has at most one enabled binding. The six phases are `beforeCreate`, `beforeUpdate`, `beforeDelete`, `afterCommitCreate`, `afterCommitUpdate` and `afterCommitDelete`; there is no implicit ordering among multiple scripts.
- Bindings reference an Extension and its active Revision. A successful Revision update changes what later calls use; an invocation already in progress finishes with the Revision it loaded.
- Enabling an Extension validates all of its bindings against currently enabled Extensions in one transaction. If any `(Collection, operation, phase)` is already occupied, the request fails with `409 BINDING_CONFLICT` and the Extension remains disabled. Replacing the configuration of an enabled Extension applies the same all-or-nothing check.

### Execution boundary and Runtime API

- Run one fresh QuickJS-NG runtime through the checked-in, narrowly maintained QJS adapter for every invocation. Pass JSON only. Do not expose arbitrary Go objects, project paths, file handles, SQLite, environment variables, process APIs, Record-write APIs or ambient network.
- Configure a 32 MiB QuickJS heap, 1 MiB stack, 128 MiB Wazero linear memory, 2-second pre-commit deadline, 5-second post-commit deadline, and four concurrent invocations project-wide. Source, input, output, HTTP, and run-history quotas are also enforced at the host boundary. Cancelled Wazero modules are discarded and never reused.
- Configure Wazero context cancellation and a fixed memory-page limit for every runtime. Mount an empty, read-only, in-memory `fs.FS` at guest `/`; do not use `WithDirMount`. Guest stdout and stderr go to `io.Discard`. The QJS adapter must skip guest cleanup once Wazero has closed the module and must close its host runtime safely.
- The versioned `modelry` global exposes only the functions documented in the Extension Domain Spec. There is no guest-controlled logging API: arbitrary guest strings cannot be safely scrubbed for embedded or encoded Secret values. Before Hooks have no Secret or HTTP functions. Post-commit Hooks can use only explicitly bound Secret aliases and Owner-granted HTTPS origins. HTTP requires HTTPS, exact origin matching, no redirects or environment proxy, public unicast DNS results, a 2-second request deadline, at most three requests and 64 KiB request / 256 KiB response bodies per invocation. Every resolved address is checked and the selected address is dialed directly.
- This protects the Runtime from accidental extension access to host resources; it is not a hostile-code serverless sandbox and cannot prevent an Owner-written post-commit script from sending a Secret to an origin the Owner authorized.

### Lifecycle transaction semantics

- A Before Hook executes outside a SQLite write transaction. It receives the operation, immutable Collection/Applied Model version, and a JSON snapshot of the Record. It may return `allow`, `reject`, or a replacement of the mutable field values. It cannot change Record identity or system timestamps. Before execution, time and random APIs are disabled; no HTTP, Secret, or asynchronous host API is available.
- After a Before Hook returns, Modelry validates its replacement with the same Applied Model and current Access Rule semantics as the underlying mutation. Update/Delete also verify the source Record revision and Applied Model version inside the write transaction. A stale snapshot, rejection, timeout, script error, or failed revalidation leaves the Record and Record Event unchanged.
- All supported Create/Update/Delete call paths use the same Hook contract, including Application Auth profile writes. Callers that own a broader transaction prepare Before Hooks before opening that transaction, then revalidate and persist the prepared Record in the caller's transaction.
- The record transaction writes the Record, Record Event and one Post-commit Hook intent atomically. The intent pins the Extension Revision, Binding ID, Secret alias-to-ID bindings, HTTPS Origin Grant IDs and Event ID from that transaction; it never copies cleartext Secret values. Disabling the Extension or removing a pinned binding/origin cancels unstarted intents; deleting/replacing a bound Secret cancels matching unstarted intents. After the commit, Modelry runs an admitted intent once outside the transaction. Hook failure never converts a successful mutation into an error and never rolls it back. #23 makes no automatic retry; an unfinished intent is marked `interrupted` on startup. If all four project-wide invocation slots are occupied, the new intent is recorded as failed with `capacityExceeded` instead of entering a queue. #24 owns future durable retry/delivery policy.
- A Hook cannot call Modelry Record mutation APIs. This prevents direct recursive lifecycle dispatch. An Owner-authorized public HTTP origin remains an explicit external side effect and must be treated as such.
- Hook Run history records only phase, operation, Extension Revision, binding, Record/Event identity where authorized, timestamps, status and a safe error category. Do not persist guest-controlled messages, source exceptions, stack traces, stdout, request/response contents, headers or Secret values. Keep the most recent 5,000 runs per Project; deleting old diagnostics never changes Records or pending transaction facts.

### Secret resource and key storage

- A Secret has a stable ID, unique display name, encrypted value, format version and timestamps. It is never a Record field. Create/replace accepts a write-only value; list/detail APIs return metadata and configured state only. Secret values are not included in Audit, RequestRecord, Activity or Hook Run details.
- A Secret becomes available only through an Extension-local alias explicitly bound by the Owner, and only in that Extension's Post-commit Hook. There is no global Secret lookup. Replacing or deleting a bound Secret immediately changes future calls; in-flight invocations use the value snapshot loaded when they started.
- Encrypt values with AES-256-GCM. The 32-byte random key lives in `.modelry/secrets.key`; ciphertext authentication binds Project ID, Secret ID and Secret version. Create the file exclusively, reject symlinks and verify its private permissions on every Runtime start. Use POSIX `0600`; on Windows create and verify a protected DACL for the file owner because Go `0600` mode bits do not restrict Windows ACLs.
- If encrypted Secrets exist and the key is missing, malformed, inaccessible or fails authentication, do not generate a replacement key and do not run dependent Hooks. Owner recovery requires the matching database and key. This key file protects a separately disclosed SQLite database; protecting/restoring the entire Project directory is a later Backup contract.

### Authorization and failure behavior

- Only the active Modelry Owner may manage Extensions, bindings, Secret metadata/values and authorized origins in this package. Application Auth users, Service Accounts and API Keys cannot access these Control Plane APIs.
- Fail closed: if Hook configuration, Extension Revision, Secret key, permission, host budget or Applied Model state is unavailable, a Before Hook fails the requested mutation safely; an After-commit Hook records a generic failed/interrupted status while the mutation stays successful.
- External HTTP errors and script exceptions are reduced to safe categories and a correlation ID. They never include raw transport errors, response payloads, URLs with credentials, or script-controlled error text.

## Consequences

- Community users can write bounded JavaScript/TypeScript around Record lifecycle facts, but cannot use Extensions as an alternate data access layer or arbitrary host plugin system.
- Post-commit hooks are immediate, best-effort, synchronous to the mutation response within a five-second aggregate budget, and at-most-once for #23. A Runtime crash can leave a visibly interrupted run with no automatic retry.
- Secrets survive same-root restart and can be recovered only with their matching local key file. The #28 Backup/Restore design must preserve or deliberately rotate this key as part of a protected, validated backup pair.
- QJS/Wazero and the Secret file ACL implementation require cross-platform tests. The local adapter is an isolated implementation dependency and not a public extension API.

## References

- [Issue #23](https://github.com/liujingwen1225/modelry/issues/23)
- [Extension runtime spike](../research/extension-runtime-spike.md)
- [Go FileMode](https://pkg.go.dev/os#FileMode)
- [Wazero filesystem configuration](https://github.com/tetratelabs/wazero/blob/v1.9.0/fsconfig.go)
