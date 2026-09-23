# Modelry Product Roadmap

## Roadmap rule

The roadmap is driven by product maturity, not by adding as many capabilities as possible.

Each phase should improve one of four outcomes:

- easier onboarding;
- more complete real-world backend workflows;
- safer production operation;
- better team and cloud operation.

## Phase A — Product foundation

Goal: freeze the product model before implementation expands.

Deliverables:

- Product Vision
- Product Architecture
- V0.1 Community Scope
- product-grade Admin information architecture
- Runtime ADR set
- Foundation Spec
- HTTP Contract
- Browser Acceptance specification

The key decision is that Community, Enterprise and Cloud share backend product semantics even though their deployment and storage choices differ.

## Phase B — V0.1 Community

Goal: deliver an open-source backend that feels like a real product on first use.

Primary user journey:

start Modelry
-> bootstrap Admin
-> create Normal/Auth Collection
-> define Schema
-> review Changes
-> apply
-> manage Records
-> register/login an application user
-> call API
-> configure Policy
-> use Local Files
-> use Realtime
-> run Lifecycle Hook
-> inspect API Requests / Audit / Activity
-> use MCP
-> restart and verify durable state.

V0.1 is SQLite-only.

The emphasis is not breadth. Every included capability must close its full user workflow.

## Phase C — Community maturity

Goal: make Community credible for long-running self-hosted projects.

Likely additions after the V0.1 core is stable:

- stronger backup / restore UX;
- OAuth and richer auth flows;
- S3-compatible files;
- Event Hooks and Webhooks;
- jobs / simple cron;
- SDK generation and developer tooling;
- richer diagnostics and observability;
- import/export and migration ergonomics;
- improved local-to-production workflows.

Community remains SQLite-focused unless the edition strategy is explicitly changed.

## Phase D — Commercial / Enterprise

Goal: solve organizational production problems rather than remove basic Community capabilities.

Primary themes:

- PostgreSQL backend;
- team and organization governance;
- enterprise identity and SSO;
- advanced RBAC;
- centralized and longer-retention audit;
- enterprise secrets and key management integration;
- advanced backup / restore / disaster recovery;
- production observability;
- HA / scale where required;
- fleet and multi-instance operations;
- support, SLA and enterprise integration.

Enterprise must continue to use the same Project Backend semantics as Community.

## Phase E — Modelry Cloud

Goal: provide the same Backend Platform as a managed SaaS rather than merely hosting the Community binary.

Cloud product layers:

Cloud Control Plane
-> Organization / Team / Project / Environment / Region / Usage / Billing / Backup / Support

Project Backend Plane
-> Collection / Records / API / Auth / Policy / Files / Realtime / Hooks / Changes / Observability

Developer Interfaces
-> Admin / HTTP / OpenAPI / SDK / CLI / MCP.

Cloud Console and Project Admin are separate product experiences.

The Cloud Control Plane manages Modelry resources. Project Admin manages the user's backend.

## Environment evolution

Development / Staging / Production should become a first-class Cloud and Enterprise concept when environment promotion is implemented.

The existing Changes model should evolve naturally into:

Development Change
-> review
-> promote
-> Staging
-> verify
-> promote
-> Production.

Do not implement environment complexity in V0.1 Community, but do not define ChangeSet or Project identity in a way that prevents this evolution.

## Roadmap guardrails

Do not:

- add Cloud-only organization concepts to every Community screen;
- turn Community into a crippled trial edition;
- make PostgreSQL a V0.1 requirement;
- make SQLite the permanent definition of Modelry semantics;
- add distributed systems before a product capability needs them;
- split the runtime into microservices by default;
- make enterprise commercialization the reason to weaken the core developer experience.
