# ADR-0008: Backup, Restore, Import, Export, and Generated Artifacts

- **Status:** Accepted — Community V0.1.x
- **Date:** 2026-09-25
- **Scope:** Backup bundles, restore preflight and apply, Collection export and import, the typed Application API contract, and generated SDK artifacts
- **Depends on:** [ADR-0001](./0001-runtime-storage-architecture.md), [ADR-0003](./0003-extension-runtime-lifecycle-secrets.md), [ADR-0005](./0005-file-values-and-storage-providers.md), [ADR-0006](./0006-administrators-and-account-recovery.md), [ADR-0007](./0007-policy-activity-drift-and-settings.md), [Project Portability and Developer Interfaces](../product-model/0005-portability-and-developer-interfaces.md)
- **Issue:** [#28](https://github.com/liujingwen1225/modelry/issues/28)

## Context

Modelry Community stores everything that matters in one SQLite database plus a file object store, all inside one project root. That makes backup look trivial — copy the directory — and that is exactly the trap. A live copy of a WAL database can be torn, the object store can be copied in a different order than the database, and nothing records which Modelry version or which applied model the copy belongs to. The same trap exists on the way back in: a restore that overwrites a running project destroys the only copy of state that the operator still trusts.

Data movement has a second trap. An import that writes rows directly will happily create Records that the product itself would reject, and a generated SDK that invents its own request shapes will drift from the contract the Runtime enforces.

## Decisions

### Backup bundles

- A backup is a product operation. The database payload is produced with SQLite `VACUUM INTO` against the live database, which yields a single consistent snapshot including committed WAL content while the Runtime keeps serving requests. Copying `project.sqlite` is never used. The referenced file objects, counts, and applied model hash are read from that same snapshot, never from the live Runtime, so a Record, File, or schema mutation that lands mid-backup cannot make the manifest disagree with the payload.
- The bundle is a `tar` archive with a deterministic layout: `manifest.json` first, then `database/project.sqlite`, then `objects/<key>` sorted by key.
- `manifest.json` records `format` (`modelry.community.backup`), `formatVersion`, `projectId`, `runtimeVersion`, `createdAt`, `appliedModelHash`, a `database` entry (path, bytes, `sha256`, SQLite version), an `objects` array (key, bytes, `sha256`), and `counts`. Every payload the archive contains has a digest in the manifest.
- The archive is streamed to the response body and, for the CLI, to a file. Backup therefore does not buffer a project in memory.
- Backup is Owner-only and audited (`backup.created`). The temporary snapshot directory lives under the managed directory and is removed on completion or failure.

### Restore

- Restore has two phases that never overlap: **preflight** (read-only) and **apply** (explicit, destructive).
- Preflight validates the format name and version, that every archive entry listed in the manifest is present with a matching digest, that no unlisted entry exists, that the database payload opens and exposes Modelry's internal migration table, and that the database format is not newer than the Runtime. It reports the project id, Runtime version, dates, counts, and any incompatibility as structured findings.
- Apply refuses to run while another process holds the project runtime lock, and refuses to replace an existing project unless the operator passes `--force`. When it does run, it extracts into a staging directory inside the managed directory, re-validates the staged database, and only then replaces the database and object store. The replacement has three phases backed by a write-ahead journal in the managed directory: new content is prepared first, the originals are moved to same-directory backups second, and everything is activated last — so the window in which a project has no database contains only renames, and any failure or killed process rolls back to byte-identical original state. Rollback only deletes a destination when the journal's backup file actually exists; otherwise the destination is still the original and is left untouched. Replacing the database also removes its `-wal`/`-shm` sidecars so a stale log cannot be replayed into the new file. A Runtime refuses to start while an unfinished journal exists, and an interrupted restore is rolled back before the "already contains state" check, so that check cannot be bypassed.
- The Admin surface exposes **preflight only**. Applying a restore in place remains a CLI operation on a stopped project, so a live Runtime can never be silently overwritten by an upload.
- Restore is audited when it runs through a Runtime (`restore.preflight`), and the CLI reports the same structured findings.

### Export and import

- Export streams NDJSON for one Collection: a `collection` header carrying the Collection id, name, type, applied model hash, and field list, followed by one `record` line per committed Record.
- Export reads through the Records service and the applied model, and writes every product field of a Record verbatim: a field merely named `token`, `secret`, or `password_hash` is ordinary data and survives a round trip. File values are exported as object keys, never bytes. Password Credentials, Sessions, and Secret values are never exported, and their exclusion comes from the domain boundary — they live in their own tables and never appear in Record Values — not from a name-based filter.
- Import accepts the same NDJSON shape and creates every Record through `records.Service.Create`, so Field Validation, Required, Unique, Relation targets, and File references are enforced by the same code path the Application API uses. Import never writes SQL directly.
- Import requires the header to carry a non-empty applied model hash (`INVALID_ARGUMENT` when absent), compares it with the current applied model, and refuses the whole request on a mismatch (`MODEL_MISMATCH`), so a schema change cannot silently drop or reinterpret fields and an omitted hash cannot bypass the gate. The applied model is always read completely — `appliedModelHash` covers every Collection, never a truncated prefix — so the gate can never be satisfied by a partial projection. The typed contract's own 512-Collection limit is enforced where it belongs, when the contract is generated or read, and is not applied to backup, export, or import.
- Import is bounded (1,000 records and 8 MiB per request), cancellable, and reports a per-record result with a stable error code. A failed Record is reported and skipped; the caller decides whether to continue. A request-level failure — a malformed header, a model mismatch, an oversized body, or too many Records — is always a structured error and is never disguised as a partial success; because each Record keeps its own transaction, such a response reports how many Records were already committed in its `details`. Record lines are decoded with exact-number semantics so a JSON field's integer or high-precision decimal survives a round trip byte for byte.
- Bulk operations are not wrapped in one SQLite transaction: each Record keeps the same transaction and side-effect boundaries it has through the API, so a long import cannot hold the write lock for the whole file.

### Typed Application API contract and generated artifacts

- The canonical contract is a projection of the applied Backend Model: Collection name, type, fields with type/required/unique/relation, file rules, the applied Access Rule summary, and the Application API endpoint templates that already exist. It is served by `GET /admin/api/v1/developer/contract` with the Runtime version and a `contentHash` computed over the canonical document.
- `modelry generate --out DIR` writes `application-api.json` and `modelry-client.ts`. Both are derived from the contract, sorted deterministically, and contain no timestamps, so the same applied model produces byte-identical files. The generated client exposes one typed function per Collection operation and calls only the existing `/api/v1/...` routes.
- Generated artifacts are projections. When a generated file disagrees with the Runtime contract, the Runtime wins; the content hash makes that detectable.

### Operations

- New Control Plane operations join the shared vocabulary: `backup.create`, `restore.preflight`, `records.export`, `records.import`, `developer.read`.
- `backup.create`, `restore.preflight`, `records.import`, and `developer.read` are Owner-only resources; `records.export` is granted to the Read only preset.

## Bounds

- Backup: at most 100,000 file objects in one bundle; the snapshot is written to the managed directory; the archive is streamed with a 32 KiB buffer.
- Restore: at most 100,002 archive entries (the manifest, the database payload, and up to 100,000 file objects); a manifest of at most 64 MiB; one file object payload of at most 128 MiB (the product's single-file limit; a zero-byte object is valid); one database payload and one bundle of at most 4 GiB of declared payload. Each bound applies only to what it describes — the manifest limit is never a bundle or payload limit — and preflight tightens its read budget to the byte lengths the manifest itself declares. Backup enforces the same set of bounds, so it can never emit a bundle it would itself refuse to restore. Preflight is read-only and cancellable.
- Export: at most 100,000 Records per stream; import: at most 1,000 Records and 8 MiB per request.
- Contract generation: at most 512 Collections and 4,096 fields per Collection.

## Consequences

- An operator can take a consistent, self-describing backup without stopping the Runtime, and can prove before a restore that the bundle is complete and compatible.
- A restore cannot destroy a live or unexamined project: the lock check, the explicit `--force`, and the staging directory each prevent a different failure mode.
- Data movement keeps product semantics: import is a thin client of the same Record creation path, so it cannot create Records the product would reject.
- Generated artifacts give developers typed access without creating a second contract to maintain.

## Rejected alternatives

- **Copying `project.sqlite` with the Runtime running.** A live copy can tear and can miss WAL content. Rejected.
- **Backing up only the database.** Records would reference file objects that the restore cannot find. Rejected.
- **Restoring through the Admin UI while the Runtime is serving.** It overwrites the database of a live process. Rejected.
- **A merge or partial restore.** Merging two applied models silently changes product semantics. Rejected.
- **Importing with direct INSERTs for speed.** It bypasses validation, relations, and file references. Rejected.
- **One transaction per import file.** A large import would hold the SQLite write lock for its whole duration. Rejected.
- **Generating the SDK from a hand-maintained template.** It becomes a second source of truth. Rejected.
- **Embedding timestamps or environment paths in generated artifacts.** They break reproducibility and leak host details. Rejected.