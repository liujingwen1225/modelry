# Modelry Community / Commercial / Cloud 产品策略

## 产品体系

Modelry 是同一个 Backend Platform 的不同运行与商业形态，而不是三套互不兼容的产品。

## Community Edition

### 定位

开源、自托管、简单、完整。

### Database

**SQLite Only**

### 产品承诺

Community 至少应具备完整 Backend 核心闭环：

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
- API Request Logs
- Audit / Activity
- CLI
- MCP

Community 不能被设计成 Demo Edition。

它的核心差异化是：

> 下载、运行、打开 Admin，即可开始构建完整 Backend。

## Commercial / Enterprise Edition

### 定位

面向正式生产、团队和组织的商业 Self-hosted 产品。

### Database

**PostgreSQL**

### 商业价值来源

商业价值应该来自生产和组织复杂度，而不是人为切断 Community 基础功能。

优先方向：

- Enterprise Identity / SSO
- Advanced Organization RBAC
- Centralized Audit / Retention
- Enterprise Secrets / KMS Integration
- Advanced Backup / Restore / DR
- Production Observability
- HA / Scaling
- Fleet Management
- Compliance Integration
- Enterprise Support / SLA

Commercial / Enterprise 继续使用与 Community 相同的 Backend Model 和 Project Admin Semantics。

## Modelry Cloud

### 定位

官方 Managed SaaS。

### Database

**PostgreSQL**

### Cloud Control Plane

Cloud 新增独立管理域：

- Account
- Organization
- Team / Member
- Project
- Environment
- Region
- Plan
- Usage / Quota
- Billing
- Backup / Restore
- Runtime Health
- Support
- Operational Lifecycle

## Cloud Console 与 Project Admin 分层

不要把所有 Cloud 管理能力塞进 Project Admin Sidebar。

### Cloud Console

管理：

- Organizations
- Projects
- Members
- Environments
- Usage
- Billing
- Managed Operations

### Project Admin

管理：

- Overview
- Collections
- API
- Changes
- Hooks
- Access
- Settings
- Activity

Cloud Console 管“Modelry 资源”。

Project Admin 管“应用 Backend”。

## Identity 分离

Cloud Account / Organization Identity 与 Application Auth 是两套不同 Identity Domain。

必须明确区分：

~~~text
Cloud / Enterprise User
→ Organization / Project Permission
~~~

和：

~~~text
Application User
→ Auth Collection
→ Application Session
→ Record Policy
~~~

Enterprise SSO 保护 Modelry 管理面，不能替代用户应用自身的 Application Auth。

## Project / Environment Model

V0.1 Community 可以把 Project 隐式化，只让用户看到一个 Backend。

长期产品模型可以演进为：

~~~text
Organization
→ Project
→ Environment
→ Project Backend
~~~

Environment 只在 Commercial / Cloud 真正需要 Development / Staging / Production 时显示。

## Database Boundary

当前 Edition Boundary：

~~~text
Community
→ SQLite

Commercial / Enterprise
→ PostgreSQL

Modelry Cloud
→ PostgreSQL
~~~

PostgreSQL 不能成为商业版唯一价值。

真正的商业能力必须解决：

- Team
- Governance
- Production
- Operations
- Scale
- Compliance
- Support

## 成长路径

未来应该形成自然升级体验：

~~~text
Community SQLite Project
→ 项目成熟
→ Migrate to Commercial / Enterprise PostgreSQL
~~~

或者：

~~~text
Community SQLite Project
→ Deploy to Modelry Cloud
→ Managed PostgreSQL Project
~~~

Migrate to PostgreSQL / Deploy to Modelry Cloud 本身可以成为重要产品能力。

## Packaging / Licensing 原则

Edition Boundary 必须简单、清晰、容易解释。

Open-source Community 保持真正可用。

Commercial / Cloud 在不破坏 Backend Core Semantics 的前提下增加组织、生产和托管能力。
