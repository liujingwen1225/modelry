# Policy, Activity, Drift, and Runtime Settings

- **Status:** Accepted — Community V0.1.x
- **Date:** 2026-09-25
- **Issue:** [#27](https://github.com/liujingwen1225/modelry/issues/27)
- **Parent Goal:** [#22](https://github.com/liujingwen1225/modelry/issues/22)
- **Depends on:** [ADR-0001](../adr/0001-runtime-storage-architecture.md), [ADR-0007](../adr/0007-policy-activity-drift-and-settings.md), [Operations Domain Spec](../specs/0009-operations-domain-spec.md)

## User problem

A self-hosted operator can build, secure, and observe a project, but four operational questions still have no product answer. Which Access Rule actually decided a request? What has my runtime been doing across Record changes, automation, extensions, mail, and storage? Is my database still what the applied model says it is? And how do I change runtime behavior without editing a shell script and guessing whether a restart is needed? Today those answers come from reading raw tables or from trial and error.

## Product terms

- **Policy Simulation** is a non-authoritative preview of one Access Rule decision. The operator states a hypothetical request: Collection, operation, principal kind, and either an existing Record or an inline Record payload. Simulation uses the same evaluator that real requests use, states explicitly that only a real request is authoritative, and never writes anything.
- **Activity** is a curated, bounded timeline of operational product facts: applied and pending model changes, automation deliveries, extension runs, mail deliveries, storage migrations, and account recovery facts. Activity is not the Request log and not the Audit trail; it never shows payloads, tokens, credentials, or App User email addresses.
- **Drift** is a difference between three things the product claims to know: the applied model, its physical projection in SQLite, and runtime-managed state such as interrupted applies or leftover projection tables.
- An **Expected pending change** is a change the operator already saved but did not apply. It is reported as information, never as drift, so the operator can tell "not applied yet" from "actually inconsistent".
- A **Runtime Setting** is a durable runtime value with a value source, validation, and an explicit restart requirement. Some settings apply immediately through bounded, restart-aware behavior; others only take effect after a restart, and Modelry never pretends otherwise.

## Owner workflow

1. In a Collection's Security surface, the Owner selects an operation, a principal kind, and a Record source, then reads the Allow or Deny decision with its reason and a clear "this is a preview" notice.
2. The Owner opens Activity and reads what the runtime did recently, with a deep link to the surface that owns each fact.
3. The Owner opens Drift and sees every difference, classified as applied model, physical projection, or runtime-managed state, each with a remedy and a deep link. Expected pending changes appear separately as information.
4. The Owner repairs a physical projection difference with **Reconcile**, or follows the deep link to the surface that owns the real decision.
5. The Owner edits Runtime Settings, sees where each value comes from, and sees whether a restart is required before the value takes effect.

## Product behavior

- Simulation returns the decision, the deciding rule, and the reason, and repeats that it is non-authoritative in the response itself, not only in the UI.
- Simulation never writes a RequestRecord, never appears in Activity, and never changes Access Rules.
- Activity is one bounded, paginated, read-only timeline. Facts are structured: kind, status, resource, Collection, and a deep link. Text that the product cannot localize stays structured instead of being generated on the server.
- Activity hides sensitive material by construction: no payload bodies, no tokens, no credentials, and no App User email addresses. App User recovery facts reference the App User Record, not the address.
- Drift detection names the expected value and the observed value for every finding, and distinguishes expected pending change from real inconsistency.
- Reconcile repairs only the physical projection of the applied model. It never applies a pending change, never changes the applied model, and is audited.
- Runtime Settings are revision guarded. A save that would change a restart-required value reports the requirement instead of silently applying it.
- Every detected problem carries a deep link to the surface that can correct it.

## Boundaries

- No Cloud or Enterprise fleet configuration, no remote settings push, and no multi-Runtime coordination.
- No hypothetical cascade, batch, or "what if I change the rules" simulation.
- No arbitrary debug log streaming, no log file tailing, and no free-text server-side summaries in Activity.
- No automatic repair of the applied model, no automatic apply of pending changes, and no destructive repair that drops Record data.
- No policy simulator that bypasses the runtime evaluator, and no Activity fact that repeats the Request log or the Audit trail.