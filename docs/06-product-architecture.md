# Modelry Product Architecture

## Architecture goal

Keep the product simple for Community users while preserving a clean path to Enterprise and Modelry Cloud.

The product is organized into three conceptual layers.

## 1. Developer Interfaces

Human and machine entry points:

- Project Admin
- Application HTTP API
- OpenAPI
- CLI
- MCP
- future generated SDKs.

These interfaces share the same backend semantics.

No interface receives a hidden bypass around authorization, changes or audit.

## 2. Project Backend Plane

This is the core Modelry product and is shared across Community, Enterprise and Cloud.

Major domains:

### Backend Model

- Collection
- Field
- Relation
- Index
- Validation
- Default
- Policy
- Auth capability
- File capability.

Backend Model is the canonical product semantic layer.

### Runtime Data

- Records
- Files
- Sessions
- runtime metadata.

### Changes

- ChangeSet
- Structured Diff
- Risk
- Preconditions
- Impact
- Apply Attempt
- Migration History / Ledger
- Drift / Recovery.

### Application Platform

- REST API
- OpenAPI
- Auth
- Policy
- Files
- Realtime.

### Extension Platform

- Lifecycle Hooks
- later Event Hooks / Webhooks / Jobs
- Secrets
- future typed Custom API.

### Observability

- API Requests
- Audit
- Activity
- health / diagnostics.

## 3. Cloud Control Plane

Not implemented in V0.1 Community.

Future Cloud / Enterprise concepts:

- Account
- Organization
- Team / Member
- Project
- Environment
- Region
- Deployment
- Plan
- Usage / Quota
- Billing
- Backup
- Support / lifecycle.

Cloud Control Plane manages Modelry deployments and organizations.

It does not replace Project Admin and does not become the Application Data Plane.

## Product topology

Community V0.1:

one runtime
-> one implicit project
-> SQLite
-> Project Admin.

Enterprise:

organization/fleet management
-> one or more project runtimes
-> PostgreSQL
-> Project Admin.

Cloud:

Cloud Control Plane
-> Organization
-> Project
-> Environment
-> managed Project Backend Plane
-> PostgreSQL
-> Project Admin.

The one-project Community runtime is therefore a deployment topology, not the permanent global product model.

## Storage architecture

The product model must remain above storage.

Conceptual direction:

Backend Model / Query / Change semantics
-> storage and migration boundary
-> SQLite in Community
-> PostgreSQL later in Enterprise / Cloud.

Do not expose a generic arbitrary database plugin in V0.1.

Only preserve the boundaries needed by the known SQLite-to-PostgreSQL roadmap.

## Admin architecture

Project Admin is a Backend workspace, not a Cloud Console.

Primary Project Admin navigation remains:

Core
- Overview
- Collections
- API

Control
- Changes
- Hooks
- Access

System
- Settings
- Activity.

Cloud management appears outside this navigation in the future.

## Identity architecture

Keep at least four conceptual identities separate:

- Cloud Account / Enterprise administrator;
- Modelry Admin Principal;
- Agent / Service Principal;
- Application Principal from Auth Collection.

Credentials are attached mechanisms, not the identity itself.

## Change architecture

Every managed Backend Model mutation follows one governance model regardless of source:

Admin / CLI / MCP
-> propose
-> ChangeSet
-> canonical runtime diff/risk/preconditions
-> apply authorization / confirmation
-> Apply Attempt
-> migration
-> durable history
-> audit.

This is both a safety feature and a product differentiator.

## Extension architecture

The Go runtime hosts an extension boundary designed for JavaScript / TypeScript project code.

Project extension APIs should expose capabilities such as:

- record read/write through controlled APIs;
- request context;
- current principal;
- secrets by reference;
- outbound HTTP when allowed;
- event emission / future jobs;
- logging.

Do not expose raw unrestricted database/file/process handles as the normal extension API.

## Environment architecture

Environment is deferred from Community V0.1 UI.

Future Enterprise / Cloud should reuse ChangeSet and Migration artifacts for promotion between Development, Staging and Production rather than inventing a separate schema deployment product.

## Design principle

Whenever a future Cloud need conflicts with Community simplicity:

- keep Community UI simple;
- preserve the shared domain boundary underneath;
- expose Cloud complexity only in Cloud Control Plane;
- avoid forcing SaaS concepts into every self-hosted workflow.
