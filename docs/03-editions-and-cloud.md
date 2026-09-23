# Modelry Editions and Cloud Strategy

## Product family

Modelry is one backend product with multiple operating models.

### Community Edition

Purpose: open-source, self-hosted, simple and complete.

Database: SQLite only.

Community should include the core application-backend workflow:

- Collections / Schema / Records
- Relations / Indexes
- Changes / Migrations
- REST API / OpenAPI
- Application Auth
- Record Policy
- Local Files
- Realtime
- Lifecycle Hooks
- Secrets
- Request Logs
- Audit / Activity
- CLI / MCP.

Community must not be positioned as a demo.

Its differentiator is simplicity: install, run, open Admin, build backend.

### Enterprise Edition

Purpose: self-hosted production operation for teams and organizations.

Database: PostgreSQL.

Commercial value should come from organizational complexity and production operation, for example:

- SSO / enterprise identity;
- advanced organization RBAC;
- centralized audit and retention;
- advanced secrets and external key management;
- backup / disaster recovery;
- advanced observability;
- HA and scaling;
- fleet management;
- compliance integrations;
- enterprise support and SLA.

Enterprise uses the same Backend Model and Project Admin semantics as Community.

### Modelry Cloud

Purpose: official managed SaaS.

Database: PostgreSQL.

Cloud adds a dedicated Cloud Control Plane:

- Account
- Organization
- Team / Members
- Project
- Environment
- Region
- Plan
- Usage / Quota
- Billing
- Backup / Restore
- Runtime health
- Support and operational lifecycle.

## Product-layer separation

Do not put Cloud management into the Project Admin sidebar.

Use two product layers.

Cloud Console:

Organizations
Projects
Members
Environments
Usage
Billing
Managed operations.

Project Admin:

Overview
Collections
API
Changes
Hooks
Access
Settings
Activity.

This preserves a simple backend-building experience even as Cloud grows.

## Identity separation

Cloud Account / Organization identity is not Application Auth.

The product must distinguish:

Cloud user
-> organization / project permissions

from:

Application user
-> Auth Collection / Record Policy.

Likewise, Enterprise SSO secures Modelry administration and does not replace the authentication model of applications built on Modelry.

## Project and environment model

V0.1 Community may expose a single project implicitly.

The broader product model should allow:

Organization
-> Project
-> Environment
-> Project Backend.

Environment becomes visible only when Enterprise / Cloud needs Development, Staging and Production workflows.

## Database boundary

Community = SQLite.

Enterprise = PostgreSQL.

Cloud = PostgreSQL.

Do not use PostgreSQL support as the only commercial value. The paid product must solve production, team, governance and operational problems.

## Growth path

A desirable future journey is:

Community SQLite project
-> mature locally
-> migrate to Enterprise PostgreSQL

or:

Community SQLite project
-> Deploy to Modelry Cloud
-> managed PostgreSQL project.

Migration experience itself can become a strong product feature.

## Packaging and licensing principle

Edition boundaries should be easy to explain.

Open-source core capabilities remain genuinely useful.

Commercial code and Cloud Control Plane can add enterprise and hosted capabilities without forking the basic backend semantics into incompatible products.
