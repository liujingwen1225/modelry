# Modelry 产品架构

## 架构目标

Modelry 的架构必须同时满足：

- Community 用户看到的产品足够简单；
- Commercial / Enterprise 可以升级到 PostgreSQL 与企业治理；
- Modelry Cloud 可以增加成熟 Cloud Control Plane；
- 三种形态共享 Project Backend 核心产品语义。

产品整体分成三个概念层。

# 1. Developer Interfaces

人类与机器入口：

- Project Admin
- Application HTTP API
- OpenAPI
- CLI
- MCP
- Future SDK

所有 Interface 共享同一套 Backend Semantics。

任何 Interface 都不能拥有绕过 Authorization、Changes 或 Audit 的隐藏通道。

# 2. Project Backend Plane

这是 Modelry 的核心产品。

Community、Commercial / Enterprise 与 Cloud 都共享这一层的产品概念。

## Backend Model

包含：

- Collection
- Field
- Relation
- Index
- Validation
- Default
- Policy
- Auth Capability
- File Capability

Backend Model 是 Canonical Product Semantic Layer。

## Runtime Data

包含：

- Records
- Files
- Sessions
- Runtime Metadata

## Changes

包含：

- ChangeSet
- Structured Diff
- Risk
- Preconditions
- Impact
- Apply Attempt
- Migration History / Ledger
- Drift
- Recovery

## Application Platform

包含：

- REST API
- OpenAPI
- Auth
- Policy
- Files
- Realtime

## Extension Platform

包含：

- Lifecycle Hooks
- Future Event Hooks
- Future Webhooks
- Future Jobs
- Secrets
- Future Typed Custom API

## Observability

包含：

- API Requests
- Audit
- Activity
- Health / Diagnostics

# 3. Cloud Control Plane

V0.1 Community 不实现。

未来 Modelry Cloud / Enterprise Control Plane 包含：

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

Cloud Control Plane 负责管理 Modelry Resource 和组织关系。

它不替代 Project Admin，也不进入 Application Data Plane。

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
Organization / Fleet Management
→ One or more Project Runtime
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
→ Project Admin
~~~

因此：

> One Instance / One Project 是 Community V0.1 Runtime Topology，不是永久产品本体。

# Storage Architecture

核心关系：

~~~text
Backend Model / Query / Change Semantics
→ Storage + Migration Boundary
→ SQLite in Community
→ PostgreSQL in Commercial / Cloud
~~~

V0.1 不做 Generic Arbitrary Database Plugin。

只保留已知 SQLite → PostgreSQL Roadmap 所需要的 Domain Boundary。

# Admin Architecture

Project Admin 是 Backend Workspace，不是 Cloud Console。

Project Admin 一级导航：

~~~text
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
~~~

未来 Cloud Management 在 Project Admin 之外呈现。

# Identity Architecture

至少保持以下 Identity 分离：

- Cloud Account / Enterprise Administrator
- Modelry Admin Principal
- Agent / Service Principal
- Application Principal

Credential 是认证机制，不等于 Principal 本身。

# Change Architecture

无论来自：

- Admin
- CLI
- MCP

受管 Backend Model Mutation 都统一走：

~~~text
Propose
→ ChangeSet
→ Runtime-canonical Diff / Risk / Preconditions
→ Apply Authorization / Confirmation
→ Apply Attempt
→ Migration
→ Durable History
→ Audit
~~~

这是 Modelry 的核心安全能力，也是重要产品差异点。

# Extension Architecture

Go Runtime 提供 JavaScript / TypeScript-facing Extension Boundary。

Project Extension API 应暴露受控能力，例如：

- Record Read / Write
- Request Context
- Current Principal
- Secrets by Reference
- Outbound HTTP（受能力限制）
- Event Emission
- Future Jobs
- Logging

默认不暴露：

- Raw unrestricted DB Handle
- Arbitrary Filesystem
- Arbitrary Process Control
- Raw Environment Access

# Environment Architecture

Community V0.1 UI 不展示 Environment。

未来 Commercial / Cloud 复用 ChangeSet / Migration Artifact 实现环境 Promotion：

~~~text
Development
→ Review / Promote
→ Staging
→ Verify / Promote
→ Production
~~~

不要为环境发布再创造第二套 Schema Deployment Product。

# 设计原则

当未来 Cloud 需求与 Community 简洁性发生冲突时：

1. Community UI 保持简单；
2. Shared Domain Boundary 在底层保留；
3. Cloud Complexity 只在 Cloud Control Plane 暴露；
4. 不把 SaaS Concept 强行塞进所有 Self-hosted Workflow。
