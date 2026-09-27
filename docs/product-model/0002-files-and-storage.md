# Local File Values and Storage Providers

- **Status:** Accepted — Community V0.1.x
- **Date:** 2026-09-25
- **Issue:** [#25](https://github.com/liujingwen1225/modelry/issues/25)
- **Parent Goal:** [#22](https://github.com/liujingwen1225/modelry/issues/22)
- **Depends on:** [ADR-0001](../adr/0001-runtime-storage-architecture.md), [ADR-0005](../adr/0005-file-values-and-storage-providers.md), [Files and Storage Domain Spec](../specs/0007-files-storage-domain-spec.md)

## User problem

An Owner needs to keep one file or an ordered list of files on a Collection Record, and needs that Record to keep working after the Project moves from Local Storage to S3-compatible Storage. The Owner should not have to learn buckets, object keys, filesystem paths, or storage credentials, and the Runtime must never pretend that a database write and an object upload are one transaction.

## Product terms

- A **File value** is a Collection Field capability value that refers to stored bytes. A `file` Field holds one File value; a `files` Field holds an ordered list of File values. A File value stores only an opaque Runtime object reference. It never stores the caller filename, a filesystem path, a bucket name, or a credential.
- A **File object** is one immutable set of bytes written to the active Storage Provider under an opaque object reference. An object is never overwritten; replacing a file produces a new object and leaves the previous object unreferenced.
- A **Staged upload** is a file the Owner or an Application API caller submitted but has not yet bound to a Record. Staged uploads live only in the Runtime-managed staging area and in Runtime memory; they are not File values and are never referenced by a Record.
- A **Storage provider** is the implementation that actually stores File objects: currently `Local` (Project filesystem) and `S3-compatible` (HTTPS object endpoint). The Provider is a Runtime implementation detail. It is not Backend Model semantics, and no Provider concept appears in Record values, Access Rules, or the Application API.
- **File constraint** is the durable per-Field limit on File values: maximum bytes per file, allowed MIME types, and for `files` fields the maximum number of File values. Constraints are validated on upload and re-validated when a Pending schema change is applied to existing Records.
- A **Storage health** snapshot describes whether the active Provider is currently reachable and internally consistent (referenced objects present, staging writable). Health is diagnostic; it never blocks Record mutations that do not touch File values.
- **Provider migration** copies every File object referenced by a Durable Record from the active Provider to a target Provider, verifies the copies, and only then switches the Project to the target Provider.

## Owner workflow

1. Add a `file` or `files` Field to a Collection and optionally set size, MIME, and count constraints.
2. Upload a file on a Record. The Runtime stages the bytes, derives the content type from the bytes rather than the filename, and enforces the Field constraints before anything is durable.
3. Save the Record. The Runtime binds each staged upload into an immutable File object and stores only its opaque reference.
4. Read the file from the Admin Record view or from the Application API. The Runtime streams the bytes with a safe content type and never reveals a path, bucket, object URL, or credential.
5. Open **Settings → Files & storage** to see the active Provider, its health, and the bounded migration state.
6. To move to S3-compatible Storage: choose the Provider, enter the endpoint, bucket, region, key prefix, and select Project Secrets for the access key and secret key, test the connection, then start the migration. When the migration reports `completed`, the Provider has switched and every existing file read still works. A failed, cancelled, or interrupted migration leaves the previous Provider active.

## Product behavior

- A File Field is an ordinary Collection Field capability. Files do not become a separate asset library, and there is no File page, File collection, or File-level permission model beyond the record's Access Rules.
- An upload that violates size or MIME constraints is rejected with a field-level error and leaves no durable state. A `files` list may hold at most its configured number of entries; the Runtime never silently truncates a list.
- Binding is not a distributed transaction. Object bytes are written outside the SQLite transaction. A Record that fails to commit may leave an unreferenced object, which reconciliation collects after a grace period. A Record never commits with a missing object.
- Replacing or removing a File value dereferences the previous object. The previous object stays readable until reconciliation, so a crash during the write cannot destroy data that a Durable Record still references.
- Deleting a Record dereferences its File values the same way. Files are not deleted synchronously with the Record delete.
- Reading a File value always goes through the Runtime authorization path: Admin reads require an Owner session, Application reads require the Collection view Access Rule for the owning Record. There are no anonymous object URLs and no presigned URLs handed to the browser.
- Migration only moves objects referenced by Durable Records. Staged uploads and unreferenced objects are not migrated. During migration the active Provider stays unchanged, so reads and writes keep working; the switch happens only after every referenced object exists in the target Provider with the expected size.
- Migration is bounded, cancellable, and restart-aware. It copies one object at a time with a per-object deadline, records durable progress, and never runs more than one migration at once. After a Runtime restart an interrupted migration is reported as `interrupted` and can be started again; already copied objects are reused.
- A Provider that is unreachable at startup degrades the Runtime instead of preventing it from starting. Records without File values keep working, File operations fail closed with an actionable error, and diagnostics show the degraded Provider.
- File diagnostics and Audit records never contain file bytes, credentials, the raw provider endpoint with user information, or filesystem paths outside the Owner-only Settings view.

## Boundaries

V0.1.x keeps one Runtime and one Project on SQLite. There is no DAM, no image transformation, no virus scanning service, no CDN, no multi-region replication, no client-side direct upload to the Provider, no presigned URL API, and no arbitrary provider plugin marketplace. Storage Provider credentials are Project Secrets; the Runtime never writes them into SQLite, logs, Request Records, Audit records, or browser responses.
