# Modelry Product Vision

## One sentence

Modelry is a productized Backend Platform that lets developers create, operate and safely evolve an application backend through one coherent visual and programmable experience.

## The problem

Building an application backend usually means combining a database, schema tooling, API framework, auth, authorization, files, realtime, hooks, migrations, observability and deployment conventions.

Each individual tool may be good, but the developer still has to design the seams and maintain the operational model.

Modelry turns these concerns into one product.

## Product promise

A new user should be able to move through this path without first becoming a database or infrastructure expert:

download or create project
-> start Modelry
-> enter Admin
-> create Collection
-> define Fields / Relations / Indexes
-> review and apply Changes
-> create Records
-> use generated API
-> configure Auth / Policy
-> add Files / Realtime / Hooks
-> inspect Requests / Audit / Activity
-> evolve the backend safely.

The product succeeds when this workflow is easy, understandable, visually coherent and durable.

## Product principles

### Productization first

Easy to use, useful, polished and complete is more important than technical novelty.

### Complete workflows over feature checklists

A feature is not complete because an endpoint exists. It is complete when configuration, execution, result, feedback, recovery and observability form a usable workflow.

### Default simple, advanced progressive

Common tasks should have strong defaults. Advanced database, policy, runtime or deployment options should appear only when relevant.

### Modelry concepts over database concepts

Users work with Collection, Field, Relation, Policy, Change and API concepts. The database is an implementation detail unless the user explicitly enters an advanced database-specific surface.

### Explicit change, not invisible magic

Backend model changes must be inspectable and reviewable.

The core lifecycle is:

Inspect -> Propose -> ChangeSet -> Structured Diff + Risk -> Apply Attempt -> Migration/History -> Audit.

### Human and Agent share one backend semantics

Admin, HTTP API, CLI and MCP must observe and mutate the same product model and authorization rules.

### AI-native, not AI-dependent

Coding Agents are first-class clients, but the runtime remains fully useful without an AI provider.

### Safe by default

Authentication, policy, destructive schema changes, secrets and external side effects must fail safely and present clear recovery paths.

## Core product domains

- Collections and Records
- Schema: Fields, Relations, Indexes, Validation, Defaults
- Changes and Migration History
- Application API and OpenAPI
- Application Auth
- Record Policy
- Files
- Realtime
- Hooks and Events
- Secrets
- API Request observability
- Audit and Activity
- CLI
- MCP

## What Modelry is not

Modelry is not:

- a visual SQL client;
- a generic database administration console;
- a workflow/DAG platform;
- a Kubernetes management product;
- a headless CMS with backend features added later;
- a PocketBase compatibility layer;
- an AI tool that stops working without AI.

## North-star experience

For humans:

start -> model -> data -> API -> secure -> extend -> observe -> evolve.

For Coding Agents:

inspect -> understand -> propose -> diff -> apply -> verify -> audit.

Both paths converge on the same Backend Model and Runtime.
