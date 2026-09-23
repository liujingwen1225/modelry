# Modelry Reboot Context

## Project identity

Modelry is a self-hosted application backend designed for both human developers and Coding Agents.

This repository is the clean **Modelry Reboot** implementation. The previous implementation is preserved in `liujingwen1225/modelry-bf` and is not a code compatibility baseline.

## Reboot baseline

- Backend: **Go**
- Frontend: **React + TypeScript + Vite**
- Storage: **SQLite First**
- Packaging: **Single Binary**
- Topology: **One Instance / One Project**
- Architecture: **Modular Monolith**
- Discipline: **Contract First**

## Current phase

The project is currently in **documentation consolidation and V0.1 re-planning**.

Do not begin production implementation until Product Vision, V0.1 Scope, Reboot ADRs, Foundation Spec, Contract, Admin Product UX and Browser Acceptance are rewritten and accepted.

## Documentation authority

When documents disagree:

1. accepted Reboot decisions / ADRs / Specs / Contracts;
2. current `docs/reboot/**`;
3. `docs/archive/pre-reboot/**`;
4. `docs/archive/legacy-v0.1/**`;
5. legacy implementation/prototype/spike evidence.

Nothing under `docs/archive/**` is automatically authoritative for the Go Reboot.

## Implementation principle

Do not translate the old TypeScript backend into Go.

```text
product semantics
  -> accepted scope
  -> ADR
  -> contract
  -> spec
  -> Go / React implementation
  -> acceptance
```
