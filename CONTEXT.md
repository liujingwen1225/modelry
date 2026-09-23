# Modelry Current Context

## Product identity

Modelry is a productized Backend Platform for human developers and Coding Agents.

Its core job is to let a developer move from an empty backend to a working application backend through one coherent product experience:

start -> model data -> manage records -> use APIs -> configure auth and policy -> add files/realtime/hooks -> evolve schema safely -> observe and diagnose the runtime.

Modelry must not become a database administration tool with extra features attached.

## Product priority

The priority order is:

1. Easy to use
2. Useful in real work
3. Visually polished and coherent
4. Functionally complete
5. Technically elegant

Architecture exists to serve the product experience.

## Product family

### Community

Open-source, self-hosted, SQLite-based and zero-config-first.

Community is expected to provide a complete single-backend workflow including schema, records, API, auth, policy, files, realtime, hooks, changes, observability, OpenAPI and MCP.

### Enterprise

Commercial self-hosted edition for organizations operating production backends.

PostgreSQL and enterprise capabilities belong here when they solve real production, governance, identity, audit, backup, availability and support needs.

### Modelry Cloud

Official SaaS.

Cloud introduces a Cloud Control Plane for Organization, Team, Project, Environment, Region, Usage, Billing, Backup and managed operations. Project Backend Plane semantics remain shared with self-hosted Modelry.

## V0.1 Community baseline

- Go runtime
- SQLite
- React + TypeScript + Vite Admin
- modular monolith
- Contract First
- zero-config-first startup
- embedded Admin / simple distribution
- one runtime serving one project as the V0.1 Community topology

These are V0.1 delivery choices, not permanent product ontology.

## Architectural invariants

- Modelry Backend Model owns product semantics; SQLite does not define the product model.
- Collection, Field, Relation, Index, Policy and ChangeSet are Modelry concepts first.
- The V0.1 implementation only needs SQLite, but the core must not make a later PostgreSQL backend require a product-model rewrite.
- Application Data Plane and Modelry Control Plane remain distinct.
- Admin identity and Application user identity remain distinct.
- Principal and Credential remain distinct concepts.
- Schema/model changes use an explicit reviewable lifecycle.
- Human Admin, API, CLI and MCP must operate the same backend semantics.
- External side effects happen after commit; reliable delivery intent must be durable before commit completes.
- User extensions are not forced to use Go.

## Authoritative read order

1. docs/00-product-vision.md
2. docs/01-product-roadmap.md
3. docs/02-technical-roadmap.md
4. docs/03-editions-and-cloud.md
5. docs/04-v0.1-community-scope.md
6. docs/05-product-experience-and-acceptance.md
7. docs/06-product-architecture.md
8. accepted future ADRs
9. accepted future Specs
10. accepted future Contracts

Historical documents are not authority.

## Current implementation gate

Do not start broad production implementation until the new ADR, Foundation Spec, HTTP Contract and Admin Product UX Spec have been rewritten against this baseline.
