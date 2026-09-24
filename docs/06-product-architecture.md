# Modelry 产品架构

## 架构目标

Modelry 架构必须同时支持：

- Community V0.1 足够简单；
- Community 可以持续增加 Realtime / Extension 能力；
- Commercial / Enterprise 可以升级 PostgreSQL 与组织治理；
- Cloud 可以增加独立 Control Plane；
- 各形态共享 Project Backend Product Semantics。

本文件定义 Domain / Plane / Boundary。

Exact Project Admin IA 由 Admin Product UX Spec 定义。

# 1. Developer Interfaces

- Project Admin
- Application HTTP API
- OpenAPI
- CLI
- MCP
- Future SDK

所有 Interface 共享同一 Backend Semantics。

不得拥有绕过 Authorization、Changes 或 Audit 的隐藏通道。

# 2. Project Backend Plane

Community、Enterprise 与 Cloud 共享这一层。

## Backend Model

包含：

- Collection
- Field
- Relation
- Index
- Validation
- Default
- Access Rule / Policy
- Auth Capability
- File Capability

Backend Model 是 Canonical Product Semantic Layer。

## Runtime Data

- Records
- Files
- Application Sessions
- Runtime Metadata

## Change Domain

底层对象：

- ChangeSet
- Structured Diff
- Risk
- Preconditions
- Impact
- Apply Attempt
- Migration History / Ledger
- Recovery

产品 UI 不需要直接以这些对象作为一级心智。

Mapping：

~~~text
ChangeSet       -> Pending change
Apply Attempt   -> Apply details
Migration       -> Applied change / Technical details
~~~

## Application Platform

V0.1：

- REST API
- OpenAPI
- Auth
- Access Rules
- Files

V0.1.x：

- Realtime

## Extension Platform

V0.1.x 以后：

- Lifecycle Hooks
- Secrets
- Future Event Hooks
- Future Webhooks
- Future Jobs
- Future Typed Custom API

Extension Platform 属于长期产品架构，但不进入 V0.1 Release Gate。

## Observability

V0.1：

- API Requests
- Audit
- Health / Contextual Diagnostics

V0.1.x：

- richer Activity / Diagnostics

# 3. Control Plane / Identity

## Modelry Control Plane

包含：

- Owner Authentication
- Backend Model Management
- Changes
- Runtime / Storage Diagnostics
- Service Accounts
- API Keys
- Audit
- MCP Management Operations

## Identity Domain

至少区分：

- Cloud / Enterprise Identity
- Modelry Owner / Administrator Principal
- Service / Agent Principal
- Application Principal

Domain：

~~~text
Principal != Credential
~~~

UI：

~~~text
Owner / Administrator
Service account
App user
Password
API key
Session
Permission
~~~

不要让普通用户为了正确使用产品先理解 Principal / Credential / Capability。

## Auth Collection

Auth Collection Record 与 Credential 分离。

~~~text
App User
├─ Profile Record
└─ Password Credential
~~~

Admin Create User 是一个产品动作，可以内部原子协调 Record + Credential，而不是要求用户分两页初始化。

# 4. Schema Pending Changes Architecture

Schema Editor 的 UX Scope 固定为单 Collection：

~~~text
Fields
+
Relations
+
Indexes
→ one durable pending schema draft
~~~

Policy 与 Auth Configuration 不进入同一个 Draft。

保存 Field / Relation / Index Editor 后：

~~~text
operation becomes durable pending change
~~~

因此：

- Refresh 不丢失；
- 切换 Schema View 不丢失；
- 离开 Collection 不需要 Save for Later；
- local editor 尚未保存的表单仍需要 Leave Protection。

Apply 时 Runtime 生成 canonical Diff / Risk / Preconditions。

# 5. Storage Architecture

~~~text
Backend Model / Query / Change Semantics
→ Storage + Migration Boundary
→ SQLite in Community
→ PostgreSQL in Commercial / Cloud
~~~

V0.1 不做 Generic Arbitrary Database Plugin。

# 6. Files Architecture

V0.1：

- Local Storage
- Single File Field

V0.1.x：

- Multiple File Values
- S3-compatible provider

File 仍是 Collection Field Capability，不成为独立 DAM Product。

# 7. Realtime / Extension Architecture

Realtime 与 Extension Runtime 在 V0.1.x 通过独立 ADR 冻结。

Go Core 不要求用户编写 Go Plugin。

长期目标继续保持 JavaScript / TypeScript-facing Extension Boundary。

默认不暴露：

- Raw unrestricted DB Handle
- Arbitrary Filesystem
- Arbitrary Process Control
- Raw Environment Access

# 8. Cloud Control Plane

V0.1 Community 不实现。

未来包含：

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
- Support / Lifecycle

Cloud Control Plane 管 Modelry Resource，不替代 Project Backend Plane。

# Product Topology

## Community V0.1

~~~text
One Runtime
→ One implicit Project
→ SQLite
→ Project Admin
~~~

## Commercial / Enterprise

~~~text
Organization / Fleet
→ Project Runtime
→ PostgreSQL
→ Project Admin
~~~

## Modelry Cloud

~~~text
Cloud Control Plane
→ Organization
→ Project
→ Environment
→ Managed Project Backend Plane
→ PostgreSQL
~~~

One Instance / One Project 只是 Community V0.1 Runtime Topology。

# Environment Architecture

V0.1 Community UI 不展示 Environment。

未来复用同一 Change Artifact / Applied History 形成 Promotion：

~~~text
Development
→ Review / Promote
→ Staging
→ Verify / Promote
→ Production
~~~

不要为 Environment Deployment 再创造第二套 Schema Change Product。

# 设计原则

当未来复杂度与 Community 简洁性冲突时：

1. Community UI 保持简单；
2. Shared Domain Boundary 保留在底层；
3. Advanced / Cloud Complexity 只在需要的 Surface 暴露；
4. 不让未来能力迫使 V0.1 提前实现低价值页面；
5. 不让 Domain Object 数量决定页面数量。
