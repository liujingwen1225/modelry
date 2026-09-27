# ADR-0007: Policy Simulation, Activity, Drift, and Runtime Settings

- **Status:** Accepted — Community V0.1.x
- **Date:** 2026-09-25
- **Scope:** Non-authoritative Access Rule simulation, the Activity timeline, Drift detection and projection reconcile, durable Runtime Settings, and the Control Plane operations that guard them
- **Depends on:** [ADR-0001](./0001-runtime-storage-architecture.md), [ADR-0002](./0002-durable-record-events.md), [ADR-0003](./0003-extension-runtime-lifecycle-secrets.md), [ADR-0004](./0004-local-webhook-delivery-and-cron.md), [ADR-0005](./0005-file-values-and-storage-providers.md), [ADR-0006](./0006-administrators-and-account-recovery.md), [Policy, Activity, Drift, and Runtime Settings](../product-model/0004-operations-and-governance.md)
- **Issue:** [#27](https://github.com/liujingwen1225/modelry/issues/27)

## Context

V0.1 gave the operator Request logs, Audit records, Pending changes, and read-only diagnostics. Those answer "what did the API do" and "what is my runtime's health", but not "which rule decided this", "what has my runtime been doing across subsystems", "is my physical database still the applied model", or "may I change this runtime value, and when does it take effect".

Two risks shape this decision. A policy simulator that re-implements the evaluator will eventually disagree with production and teach the operator something false. A drift detector that reports an unapplied pending change as corruption, or that repairs by guessing, turns a monitoring surface into a data-loss surface.

## Decisions

### Policy simulation

- Simulation calls `accesscontrol.Service.Evaluate` / `EvaluateInTransaction`, the same evaluator the Application API uses. No second rule interpreter is introduced, and no rule is resolved in the HTTP layer.
- The request names a Collection, an operation, a principal kind (`anonymous`, `owner`, `applicationUser`, `serviceAccount`), an optional principal id, and a Record source: either an existing Record id, or an inline payload of field values.
- An inline payload is evaluated as supplied. Simulation never fills defaults, never validates the payload against the applied model's constraints, and never persists it; the response therefore states `authoritative: false` and explains that a real request evaluates stored data and the full pipeline.
- An unknown Collection, an unknown operation, an unknown principal kind, or an unknown Record id is rejected with a validation error instead of being silently treated as a denial, so a typo cannot be mistaken for a policy decision.
- Simulation performs no writes: it is not recorded as a RequestRecord, it appends no Audit fact, and it never appears in Activity. An Administrator without the required Permission is still denied and audited by the existing fail-closed path.
- The response includes the deciding rule when the evaluator exposes one, so the operator can jump to the Security surface that owns it.

### Activity

- Activity is a curated read model over operational facts that owning modules already persist: model changes (applied, pending, failed), automation deliveries and job runs, extension runs, mail deliveries, storage migrations, and App User recovery facts.
- Activity is explicitly not the Request log and not the Audit trail. It never selects from `modelry_request_records` or `modelry_audit_records`, so it cannot duplicate those surfaces.
- Each owning module exposes its own fact query over a caller-supplied executor. The Activity service never reaches into another module's tables, and never owns a table of its own.
- Facts are structured (`kind`, `status`, `occurredAt`, resource, Collection, deep link). The server does not generate localized prose; the Admin localizes from the structured fields.
- Facts never carry payload bodies, message bodies, tokens, credentials, Secret values, or App User email addresses. Recovery facts reference the App User Record id.
- Listing is bounded (`limit` at most 50), cursor paginated by `(occurredAt, id)`, read-only, and safe to call while other subsystems are writing. Activity performs no writes and needs no background worker.

### Drift

- Drift compares three sources: the applied model metadata, the physical SQLite projection (`PRAGMA table_info` / `PRAGMA index_list` for each Record table), and runtime-managed state.
- Findings are classified as `appliedModel`, `physicalProjection`, or `runtimeState`, each with `severity`, `expected`, `actual`, `remedy`, and a deep link.
- A saved but unapplied pending change is reported as an expected pending change with `expected: true`, never as drift. An interrupted apply attempt is real runtime state and is reported.
- Reconcile repairs the physical projection of the **applied** model only: it re-creates a missing Record table, missing columns, and missing indexes using the same projection code as Apply. It never applies a pending change, never changes the applied model, never deletes a Record, and never drops a column or table.
- Reconcile requires the `drift.reconcile` Permission, which is Owner-only, and appends an Audit fact (`drift.reconciled`) in the same transaction as the repair.
- Differences that cannot be repaired without a decision (a stale column, an unexpected table, an interrupted apply) report `remedy: manual` and link to the owning surface.

### Runtime settings

- One durable singleton row holds the Project Runtime Settings: `listenAddress` and `requestRetentionDays`. The row is revision guarded and audited (`runtimeSettings.updated`).
- Every setting reports its value, its `source`, its validation bounds, and `restartRequired`.
- Source precedence is explicit: an explicit runtime flag (`--listen`) wins over the Project value, the Project value wins over the built-in default, and the reported source names the winner. A flag-provided value is reported as `flag` and is never silently overwritten by a save.
- `listenAddress` requires a restart. Saving it persists the value, reports `restartRequired: true`, and leaves the running listener untouched.
- `requestRetentionDays` applies without a restart through a bounded, cancellable, restart-aware pruner owned by the Request log module. The pruner deletes only Request records older than the configured retention and never touches Audit records.
- Validation is enforced on save: the listen address must be a `host:port` pair that binds to a TCP port, and retention must be between 1 and 3650 days. Invalid values are rejected instead of clamped.

### Control Plane operations

- New operations extend the shared Permission vocabulary: `activity.read`, `drift.read`, `drift.reconcile`, `policy.simulate`, `settings.read`, `settings.write`.
- Read-only preset membership: `activity.read`, `drift.read`, `policy.simulate`, `settings.read`.
- `settings.write` and `drift.reconcile` are Owner-only resources, matching the fail-closed default for values that change the Runtime or its physical projection.
- Unmapped Control Plane routes still require the Owner.

## Bounds

- Simulation: one Collection, one operation, one principal, one Record source, at most 64 inline field values, and a 256 KiB request body. No batch simulation.
- Activity: `limit` at most 50, cursor pagination, and at most 500 candidate facts read per source per page from each owning module.
- Drift: at most 512 Collections and 2,048 findings per report; reconcile repairs at most one Collection per call.
- Runtime settings: two settings, revision guarded, one audited write per save.
- Retention: 1 to 3650 days, prune at most 5,000 Request records per pass, at most one prune pass per minute.

## Consequences

- Operators get an answer to "who can do this" that cannot drift from production semantics, because there is exactly one evaluator.
- Activity stays honest and cheap: it is a read model over facts other modules already own, so it cannot become a second source of truth.
- Drift detection becomes safe to trust: expected pending work is separated from real inconsistency, and the only automatic repair is the idempotent projection of the applied model.
- Runtime Settings introduce the first durable control-plane configuration for the Runtime itself. The flag-wins rule keeps local self-hosted operation predictable, and the restart requirement is reported rather than hidden.

## Rejected alternatives

- **A simulator that re-implements rule matching.** It would eventually disagree with production. Rejected.
- **Recording simulation as a RequestRecord so it appears in history.** Simulation is not a request, and recording it would pollute the Request log and the Audit trail with non-events. Rejected.
- **Building Activity from Request logs and Audit records.** That duplicates two existing surfaces and would expose payload-adjacent data. Rejected.
- **Deriving Activity from a new append-only event table.** It adds a second write path and a compaction problem for information the owning modules already store. Rejected.
- **Reporting an unapplied pending change as drift.** It trains the operator to ignore drift. Rejected.
- **Auto-repairing drift by re-running Apply.** Apply changes the applied model and can destroy Record data. Rejected.
- **Silently applying a restart-required setting.** The running listener would disagree with the reported configuration. Rejected.
- **A generic key/value settings bag.** It invites unvalidated, untested runtime configuration. Rejected.