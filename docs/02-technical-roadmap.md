# Modelry Technical Roadmap

## Objective

The technical route exists to support the product route:

Community first -> production-ready Enterprise -> managed Modelry Cloud.

## Baseline selection

### Runtime Core

Go.

Why it fits Modelry:

- stable long-running backend runtime;
- simple deployment and cross-platform distribution;
- strong concurrency and HTTP/runtime engineering;
- predictable resource use;
- suitable for both self-hosted and managed project runtimes;
- keeps the runtime core independent from the user's extension language.

### Community Database

SQLite.

Why it fits Community:

- no external database setup;
- excellent first-run and local self-hosted experience;
- easy packaging, backup and project portability;
- reinforces the product promise that the Community edition starts simply.

### Enterprise / Cloud Database

PostgreSQL, introduced later.

PostgreSQL is a real planned target, not an abstract theoretical database. Therefore the V0.1 core must preserve product semantics above the SQLite implementation.

V0.1 does not need to implement PostgreSQL.

### Admin

React + TypeScript + Vite.

Admin is a first-class product surface, not a generated internal console.

### Extension Runtime

JavaScript / TypeScript-facing runtime boundary.

Go is the internal runtime language. It must not force project Hooks, Custom APIs or future extensions to be authored in Go.

The exact embedded engine / worker / process mechanism is an ADR + spike decision, but the product-facing language and capability boundary are separate from the Go core.

## Architecture direction

Start as a modular monolith.

Major internal modules:

- Backend Model / Schema
- Changes / Migration
- Records / Query
- Application API
- Auth
- Policy
- Files
- Realtime
- Hooks / Events
- Secrets
- Observability
- Audit / Activity
- Admin Control Plane
- MCP / CLI.

Do not create service boundaries merely because Cloud exists in the future.

## Storage boundary

The rule is:

Modelry semantics -> storage implementation.

Not:

SQLite schema -> Modelry semantics.

Collection, Field, Relation, Index, Query and Change must exist as domain concepts before SQL generation/execution.

V0.1 may use SQLite-native implementation deeply for correctness and simplicity, but SQLite-specific behavior must stay inside the storage/migration boundary.

A future PostgreSQL backend must be able to implement the same supported Modelry contract without rewriting product concepts or Admin workflows.

Do not build a generic arbitrary-database plugin framework in V0.1.

## Schema evolution

The technical core should preserve:

Backend Model
-> ChangeSet
-> Structured Diff
-> Risk / Preconditions / Impact
-> Apply Attempt
-> physical migration
-> Migration History / Ledger
-> generated projection.

Applied migrations are immutable facts.

Risk and preconditions are runtime-derived, not UI-provided.

## Data and Control Plane

Application Data Plane includes:

- application auth;
- records;
- files;
- realtime;
- public application API.

Modelry Control Plane includes:

- Admin authentication;
- schema/model changes;
- runtime settings;
- secrets;
- access management;
- audit;
- administrative data access;
- MCP management operations.

These authorization models must not collapse into one role system.

## Auth model

Maintain:

Principal != Credential.

Keep distinct:

- Admin / Control Plane Principal;
- Application Principal from Auth Collection;
- Agent / Service Principal.

Application users do not become Modelry administrators.

## Query and policy

Use one declarative expression model where practical for:

- record filtering;
- record policy;
- realtime subscription filtering;
- administrative filtering.

Policy is fail-closed.

Relation expansion must re-check target view policy.

## Events and reliability

Lifecycle Hooks execute synchronously around transactions for deterministic validation and mutation.

External irreversible side effects happen after commit.

Features promising reliable asynchronous delivery must persist delivery intent atomically with the business mutation.

Realtime remains best effort unless a later contract explicitly adds replay guarantees.

## Files

Community begins with Local Storage.

File remains a Field-level product capability.

S3-compatible storage belongs to later Community maturity and commercial/cloud operation.

## Observability

Keep three concepts separate:

- API Requests: application HTTP operational telemetry;
- Audit: durable security / governance facts;
- Activity: operational cross-module timeline and diagnostics.

A shared requestId should connect runtime errors, API Runner results and request logs.

## Contract First

Externally observable behavior is frozen before implementation.

Expected progression:

Product model
-> ADR
-> domain Spec
-> HTTP Contract / OpenAPI
-> Go implementation
-> React client
-> browser acceptance.

## Technical phases

1. Domain + contract foundation
2. Go runtime skeleton + SQLite
3. Schema / Changes / Records / API
4. Auth / Policy / Files / Realtime
5. Hooks / Secrets / Observability / Audit
6. Admin product closure
7. MCP / CLI closure
8. Community hardening
9. PostgreSQL backend for Enterprise / Cloud
10. Cloud Control Plane and managed operations.

## Non-goals for V0.1

- PostgreSQL implementation;
- microservices;
- Kubernetes-first architecture;
- distributed queue;
- generic database adapter marketplace;
- hostile multi-tenant serverless sandbox;
- HA cluster;
- multi-project runtime inside one Community process.
