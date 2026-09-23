# Modelry Reboot — Source Inventory & Migration Plan

- **Status:** Planning / Source Consolidation
- **Date:** 2026-09-23
- **Branch:** `docs/reboot-source-consolidation`
- **Purpose:** consolidate the complete pre-Reboot product/documentation baseline before authoring new Reboot specifications.
- **Not a runtime specification:** this document does not itself freeze API or implementation behavior.

## 1. Reboot authority

The following decisions are the new top-level authority for Modelry Reboot:

- Backend: **Go**
- Frontend: **React + TypeScript + Vite**
- Storage: **SQLite First**
- Packaging: **Single Binary**
- Topology: **One Instance / One Project**
- Architecture: **modular monolith**
- Product discipline: **Contract First**
- Old Bun/TypeScript implementation is reference material, not a code compatibility target.

When an old document conflicts with the above, the Reboot decision wins.

## 2. Source set

The planning review compares the current `main` and `develop` documentation and contract assets.

Project-relevant comparison set:

- 17 paths are identical in `main` and `develop`.
- 19 paths existed only in `develop`.
- 7 shared paths have different content.
- 3 paths existed only in `main` (the recovered Admin V2 / Global API archive and its README).

The consolidation intentionally excludes package locks, localization payloads, CI workflow implementation, and `.agents/skills/**` from the product decision set. They remain repository history but are not product authority.

The newer/different `develop` documents and machine-contract artifacts are preserved under:

`docs/archive/legacy-v0.1/develop/**`

The latest pre-Reboot Admin planning is preserved under:

`docs/archive/pre-reboot/**`

## 3. Decision precedence for Reboot planning

Use the following order when old documents disagree:

1. Explicit Reboot decisions in this document / subsequent accepted Reboot ADRs.
2. Latest accepted user/product decisions preserved in pre-Reboot Admin V2 and Global API planning.
3. Latest `develop` product/business baseline.
4. Stable accepted ADR semantics that are not implementation-stack-specific.
5. Frozen V0.1.0 machine contract as a **candidate compatibility/reference baseline**, not automatic Reboot authority.
6. Implementation specs 0004–0007 as behavior, edge-case, and acceptance evidence.
7. Old prototype/UI audit and Bun spike as historical implementation evidence only.

## 4. Product semantics to carry forward

These are strong candidates to remain part of Reboot V0.1 unless a new Reboot spec explicitly changes them.

### Product identity

- self-hosted application backend designed for both humans and Coding Agents;
- AI native, not AI dependent;
- explicit over magic;
- human Admin and machine interfaces operate the same backend semantics;
- not a PocketBase compatibility layer.

### Runtime shape

- Single Binary First;
- SQLite First;
- One Instance / One Project;
- no Kubernetes-first, microservice-first, cluster-first, or distributed queue requirement in V0.x;
- do not introduce hypothetical database adapters before a second real database implementation exists.

### Core domain

- Normal Collection and Auth Collection;
- Field / Relation / Index / Validation / Default;
- Record CRUD and query;
- Record Policy;
- File as a Field;
- Application Auth;
- Realtime;
- Secret;
- Hook / extension mechanism;
- OpenAPI / API usage;
- ChangeSet / Structured Diff / Risk / Preconditions / Apply / Migration;
- Admin UI, CLI and MCP.

### Change governance

Keep the core chain:

`Inspect -> Propose -> ChangeSet -> Structured Diff + Risk -> Apply Attempt -> Migration -> Audit`

Keep ChangeSet separate from Apply Attempt.

Keep risk vocabulary as a candidate baseline:

- SAFE
- DATA_REWRITE
- DESTRUCTIVE
- IRREVERSIBLE

Keep explicit Human Confirmation for higher-risk or access-expanding changes.

### Data Plane / Control Plane

Keep the conceptual separation:

- Application Data Plane: Application Principal -> Record Policy -> Records.
- Control Plane: Admin / Agent Principal -> Capability -> management resources.
- Administrative Data Access is explicit and audited; it does not impersonate `auth.id`.

### Identity

Keep:

- Principal != Credential;
- Admin Principal, Application/Auth Principal and Agent/Service Principal are distinct;
- Password is a Credential, not a normal Record field;
- Control Plane Admin auth and Application Auth remain separate;
- revocable server-side Session semantics.

### Expression engine

Keep one declarative expression language for:

- filter;
- policy;
- realtime subscription filtering;
- administrative data filtering where applicable.

Keep fail-closed semantics and policy-aware relation expansion.

### Durable behavior

Keep:

- external side effects happen after commit;
- reliable delivery intent must be durable before commit completes;
- Realtime is best-effort rather than a reliable queue;
- required Audit facts must not depend on best-effort projection.

### Git / migration model

Keep as candidate product behavior:

- Project Source separated from Runtime Data;
- declarative migration artifacts;
- Migration Ledger;
- drift detection;
- immutable migration history;
- explicit preconditions and impact preview;
- high-risk recovery/checkpoint semantics;
- system migrations separate from project migrations.

### Startup UX

Keep the successful Zero-Config direction:

- running `modelry` from an empty valid project root can initialize and start;
- explicit `modelry init` / `modelry serve` remain available for scripting;
- init is atomic and idempotent;
- partial project state fails explicitly rather than silently repairing.

### Quality model

Carry forward the strongest Browser Acceptance principles:

- real standalone binary;
- real SQLite;
- real HTTP;
- real Admin UI;
- real Chromium mandatory path;
- durable-state assertions, not Toast-only assertions;
- browser console/page error/5xx health gate;
- no fixed sleeps;
- business closure flows;
- restart persistence;
- regression tests for discovered P0/P1 defects.

## 5. Decisions that must be rewritten for Go Reboot

### ADR-0003 Bun + TypeScript Core

**Superseded.**

Replace with a new Go Core ADR covering:

- Go HTTP runtime;
- SQLite integration;
- embedded Admin assets;
- Single Binary build;
- cross-platform packaging;
- CLI composition;
- extension runtime boundary.

The old Bun spike remains historical evidence only.

### ADR-0005 Trusted TypeScript Project Hooks

**Product intent retained; runtime mechanism must be redesigned.**

Carry forward:

- Project extension code is trusted project code, not arbitrary hostile sandbox code;
- extension failures must not crash the backend;
- lifecycle hooks need deterministic error/timeout behavior.

Re-specify implementation as a Go-hosted extension runtime. Current leading direction:

`Go Core -> internal lifecycle event bus -> embedded JavaScript runtime -> project hooks`

Do not use Go dynamic plugins as the default extension model.

The exact JavaScript engine and module model require a dedicated Reboot ADR/spike.

### TypeScript Custom API implementation

The typed-contract principle from ADR-0013 remains valuable, but its TypeScript handler API is not authoritative.

Reboot must define a language-neutral Route Contract and then decide how JavaScript extension handlers bind to it.

### Repository / frontend adapter contracts

The old `frontend-repository-mapping.json` captures useful UI/backend boundaries, but its repository names and TypeScript adapter architecture are implementation-specific.

Do not carry them forward as machine authority.

## 6. Decisions requiring fresh scope review

### Application Auth scope

Old documents conflict between broad V0.1 capability planning and the later Runtime Completion boundary.

Reboot V0.1 must explicitly re-freeze which of these are V0.1.0 vs later:

- email/password;
- username/password;
- password reset;
- email verification;
- OTP;
- OAuth;
- anonymous auth.

Do not inherit the broadest older ADR wording automatically.

### Event Hook / Webhook / Cron

The domain architecture is useful, but later V0.1 implementation specs deferred reliable Event Hook, Webhook and Cron.

Reboot should keep their domain boundary but decide separately whether they belong in V0.1.0.

### Backup / Restore

Keep the safety model, but re-decide whether full productized backup/restore is V0.1.0 or V0.1.x.

### MCP

The human/agent shared semantics remain a product differentiator.

Reboot should re-specify MCP only after the new domain and HTTP contracts stabilize; the old tool list is a reference, not an automatic frozen list.

## 7. Admin decisions to migrate from the latest planning

The recovered Admin V2 planning is newer than Spec 0003 and should be treated as the current UX direction where it does not conflict with Reboot.

Carry forward:

### Primary navigation

```text
Core
  Overview
  Collections
  API

Control
  Changes
  Hooks
  Access

System
  Settings
  Activity
```

### Collection workspace

```text
Records        <- default
Schema
Policy
Auth           <- Auth Collection only
API
```

Schema owns local views:

```text
Fields
Relations
Indexes
```

Relations and Indexes are not separate Collection second-level pages.

### Collections

- Card + List modes;
- Card is default;
- both views share search/filter/sort state.

### UI architecture

Keep:

- React + TypeScript + Vite;
- TanStack Query;
- TanStack Table;
- React Hook Form + Zod;
- Design System primitives;
- Neutral Developer Console direction;
- URL state for deep-linkable workspace state;
- one obvious primary action per work surface;
- durable result remains visible after mutation;
- Capability-driven UI, not role-name inference.

### Global API

The newer planning intentionally supersedes the older “no top-level API” decision.

Keep as Reboot candidate:

- Global API -> Endpoints | Requests;
- Collection API remains contextual;
- both share one canonical endpoint model and runner;
- Control Plane endpoints are excluded from the Application API catalog.

### Request logs

Keep the product concept, but re-freeze it in the new contract:

- structured metadata only;
- no body/raw headers/credentials/query values/raw client IP;
- canonical requestId;
- separate from Audit and Activity;
- bounded retention and row cap;
- explicit Control Plane read contract.

## 8. Historical-only material

Do not promote these directly into Reboot authority:

- Bun runtime spike and Bun packaging conclusions;
- old TypeScript runtime composition;
- old frontend component migration audit;
- V4 prototype implementation code;
- old Issue/PR numbers and implementation DAGs;
- old GitFlow branch rules;
- frozen frontend repository adapter names;
- mock-to-real migration history.

Their edge cases and lessons remain useful when writing tests and acceptance criteria.

## 9. Old Frozen Contract migration policy

The old Frozen V0.1.0 Contract is valuable because it already defines:

- Data Plane / Control Plane namespaces;
- 58 routes;
- 71 schemas;
- credential boundaries;
- capability vocabulary;
- ChangeSet / ApplyAttempt state vocabulary;
- risk vocabulary;
- structured errors;
- Auth, Files, Secrets, Hooks, Audit and Runtime surfaces.

However Reboot is not required to preserve it byte-for-byte.

The new contract process is:

```text
old frozen contract
        ↓
route / DTO / error / capability review
        ↓
retain | simplify | rename | defer | remove
        ↓
new Reboot Contract
        ↓
Go implementation + React client + tests
```

No Go handler should be treated as the source from which the contract is reverse-engineered.

## 10. Proposed Reboot documentation structure

After source consolidation is accepted, create a fresh authoritative series.

```text
docs/
├── 00-product-vision.md
├── 01-v0.1-scope.md
├── 02-product-business-design.md
├── 03-community-enterprise-edition-planning.md
│
├── adr/
│   ├── 0001-go-core-and-single-binary.md
│   ├── 0002-sqlite-first-one-instance-one-project.md
│   ├── 0003-backend-model-and-changesets.md
│   ├── 0004-data-and-control-plane.md
│   ├── 0005-principal-credential-and-auth.md
│   ├── 0006-unified-expression-engine.md
│   ├── 0007-project-extension-runtime.md
│   ├── 0008-project-source-migrations-and-drift.md
│   └── 0009-files-events-realtime.md
│
├── specs/
│   ├── 0001-v0.1-foundation.md
│   ├── 0002-admin-product-ux.md
│   └── 0003-browser-acceptance.md
│
└── contracts/
    ├── 0001-v0.1-http-contract.md
    ├── openapi/
    └── manifest/
```

The exact count can be reduced during authoring; this structure is a planning target, not a requirement to create unnecessary documents.

## 11. Authoring order

Do not start implementation yet.

Recommended sequence:

1. **Product baseline merge**
   - rewrite Product Vision;
   - rewrite V0.1 Scope;
   - merge Product Business Design;
   - preserve Community/Enterprise planning as deferred planning.

2. **Reboot ADR set**
   - first resolve Go core + extension runtime;
   - migrate stable domain ADRs;
   - explicitly mark old Bun/TypeScript ADRs superseded.

3. **Spec 0001 — V0.1 Foundation**
   - domain objects;
   - lifecycle/state machines;
   - storage truth boundaries;
   - transaction boundaries;
   - extension/event semantics;
   - no HTTP route details yet except conceptual planes.

4. **Contract 0001**
   - review the old 58-route contract route-by-route;
   - freeze namespaces, DTOs, errors, auth/capability requirements and pagination;
   - add/remove only after explicit review;
   - generate OpenAPI/machine manifest from the accepted contract source.

5. **Admin Product UX**
   - migrate the accepted Admin V2 decisions against the new Contract;
   - no fake UI for undeclared backend capability.

6. **Browser Acceptance**
   - migrate the strongest Spec 0007 business-closure and quality rules;
   - rewrite implementation-specific fixture details for the Go binary.

7. **Only then create Go/React production skeleton.**

## 12. Immediate next deliverable

The next authoritative work should be a **Reboot V0.1 Decision Matrix** produced from this inventory.

For every old domain/capability, it will record:

```text
Capability
Old source(s)
Reboot decision
V0.1.0 / V0.1.x / deferred
Contract required?
Admin surface?
Acceptance flow?
Notes / conflicts
```

That matrix should be reviewed before rewriting `01-v0.1-scope.md`.
