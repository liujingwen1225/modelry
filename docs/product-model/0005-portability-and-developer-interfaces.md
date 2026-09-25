# Project Portability and Developer Interfaces

- **Status:** Accepted — Community V0.1.x
- **Date:** 2026-09-25
- **Issue:** [#28](https://github.com/liujingwen1225/modelry/issues/28)
- **Parent Goal:** [#22](https://github.com/liujingwen1225/modelry/issues/22)
- **Depends on:** [ADR-0001](../adr/0001-runtime-storage-architecture.md), [ADR-0008](../adr/0008-backup-restore-import-export-and-generated-artifacts.md), [Portability Domain Spec](../specs/0010-portability-domain-spec.md)

## User problem

A self-hosted project is only as useful as the operator's ability to move it, restore it, and build on it. Today an operator who wants a copy of a project has to stop the Runtime, guess which files matter, and hope the copy is consistent. Moving data in or out means writing scripts against the API. A developer who wants typed access to their own Collections reads the OpenAPI document and hand-writes bindings. Nothing tells the operator whether a copy is complete, current, or safe to restore.

## Product terms

- A **Backup bundle** is an archive the Runtime produces from a running project: a consistent database snapshot, the file objects the applied model references, and a manifest that records the format version, the project identity, the Runtime version, and a SHA-256 for every payload.
- **Restore** is an explicit operator action that replaces a stopped project's state with the contents of a verified Backup bundle. It never merges and never runs against a live project.
- **Preflight** is the validation pass that runs before anything is written: format version, payload digests, project identity, and database compatibility.
- An **Export** is a stream of one Collection's applied model header plus its committed Records, in a line-delimited format that preserves field names and file references.
- An **Import** is the inverse stream. Every imported Record is created through the same Record creation path the Application API uses, so Validation, Relations, Required, Unique, and File rules behave identically.
- The **Application API contract** is a typed projection of the applied Backend Model: the operations, fields, relations, and Access Rule summary a developer's client can rely on.
- **Generated artifacts** are files produced from that contract — a canonical contract document and a typed TypeScript client. They are projections, reproducible byte for byte, and never a second source of truth.

## Owner workflow

1. The Owner stops nothing to take a backup: the Runtime produces the bundle while the project keeps serving requests.
2. The Owner downloads the bundle, or runs `modelry backup` on the server, and stores it wherever the operator keeps artifacts.
3. To move the project, the Owner stops the Runtime on the target machine and runs `modelry restore --from bundle.tar --project-root …`; the CLI validates the bundle, reports what it found, and only then replaces the project.
4. To move data between projects, the Owner exports a Collection and imports it into another project whose applied model matches.
5. To build a client, the developer runs `modelry generate --out ./client` and commits the generated contract and typed client next to their application.

## Product behavior

- A backup always contains a consistent database snapshot even while requests are being served; it is never a copy of a live file.
- The manifest is machine readable and human readable: format version, Runtime version, project id, creation time, database digest, every object digest, and the applied model hash.
- Preflight never writes. It reports incompatibilities as structured findings instead of failing halfway through a restore.
- Restore refuses to touch a project whose Runtime is running, and refuses to replace an existing project without an explicit `--force`.
- Import never bypasses product semantics: a Record that would be rejected through the Application API is rejected during import and reported by index.
- Import refuses to run when the exported model header does not match the applied model, so a schema change cannot silently drop fields.
- Generated artifacts carry the Runtime version and a content hash, and regenerating them from the same model produces byte-identical files.
- Generated clients call the same Application API endpoints as any other client, so Access Rules, Sessions, Secrets, and Audit semantics are unchanged.

## Boundaries

- No Cloud, Enterprise, fleet, or scheduled backup service; no remote storage target and no retention policy engine.
- No partial or merging restore, no restore into a running project, and no silent overwrite of a newer project format.
- No import of file bytes: file fields reference existing objects, and an import that references a missing object fails that Record.
- No SQL-level import or export, no table dump, and no direct database write path.
- No generated SDK published to a package registry, and no generated artifact treated as canonical when it disagrees with the Runtime contract.