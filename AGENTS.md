# AGENTS.md — Modelry Reboot

## Read first

1. `CONTEXT.md`
2. `docs/reboot/0000-source-inventory-and-migration-plan.md`
3. `docs/reboot/v0.1-capability-decision-matrix.md`
4. the accepted Reboot Scope / ADR / Spec / Contract for the task.

## Authority

- `docs/archive/**` is reference material only.
- Do not copy the old Bun/TypeScript implementation into the Go core.
- If a legacy decision is useful, migrate its semantics into a Reboot document first.

## Reboot invariants

- Go backend
- React + TypeScript + Vite
- SQLite First
- Single Binary
- One Instance / One Project
- Modular Monolith
- Contract First
- no premature distributed architecture
- no hypothetical database adapter
- no Go dynamic plugin system as the default project Hook model

## Contract First

Define/freeze externally observable behavior before implementation. Then implement Go runtime, wire clients, and prove behavior with real integration/browser acceptance.

## Quality

Prefer real compiled binary, real SQLite, real HTTP, real Admin browser, restart persistence and durable-state assertions.
