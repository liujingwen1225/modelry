# Modelry Community / Commercial / Cloud 产品策略

## 产品体系

Modelry 是同一个 Backend Platform 的不同运行与商业形态，不是三套互不兼容的产品。

## Community Edition

### 定位

开源、自托管、简单、完整。

### Database

**SQLite Only**

### 产品承诺

Community 长期围绕以下 Project Backend Product Semantics 成长：

- Collections / Schema / Records
- Changes / Applied History
- REST API / OpenAPI
- Application Auth
- Access Rules
- Files
- Realtime
- Extensions / Hooks
- Secrets
- Request Observability
- Audit / Diagnostics
- CLI
- MCP

“Community 完整”不表示这些能力全部进入 V0.1。

V0.1 先完成：

~~~text
Model
→ Data
→ Secure
→ API
→ Observe
→ Evolve
~~~

Realtime、Hooks、Secrets 等在 V0.1.x 继续扩展。

Community 不能被设计成 Demo Edition，也不应为了追求 Feature Checklist 把第一个版本做成不可发布的大工程。

## Commercial / Enterprise Edition

### 定位

面向正式生产、团队和组织的商业 Self-hosted 产品。

### Database

**PostgreSQL**

### 商业价值来源

- Enterprise Identity / SSO
- Organization / Team Governance
- Advanced RBAC
- Centralized Audit / Retention
- Enterprise Secrets / KMS
- Advanced Backup / Restore / DR
- Production Observability
- HA / Scaling
- Fleet Management
- Compliance Integration
- Support / SLA

商业价值来自组织和生产复杂度，而不是切断 Community 的基础开发闭环。

## Modelry Cloud

### 定位

官方 Managed SaaS。

### Database

**PostgreSQL**

### Cloud Control Plane

Cloud 新增：

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

## Cloud Console 与 Project Admin

Cloud Console 管：

- Organizations
- Projects
- Members
- Environments
- Usage
- Billing
- Managed Operations

Project Admin 管 Project Backend。

Project Admin 的 Exact IA 由 Admin Product UX Spec 定义，不在本文件重复冻结 Sidebar。

## Identity 分离

必须区分：

~~~text
Cloud / Enterprise User
→ Organization / Project Permission
~~~

和：

~~~text
Application User
→ Auth Collection
→ Application Credential / Session
→ Access Rule
~~~

Enterprise SSO 保护 Modelry 管理面，不能替代 Application Auth。

## Project / Environment Model

V0.1 Community：

~~~text
One Runtime
→ One implicit Project
→ SQLite
~~~

长期：

~~~text
Organization
→ Project
→ Environment
→ Project Backend
~~~

Environment 只在 Commercial / Cloud 真正需要 Development / Staging / Production 时显示。

## 成长路径

~~~text
Community SQLite Project
→ Commercial / Enterprise PostgreSQL
~~~

或：

~~~text
Community SQLite Project
→ Modelry Cloud
→ Managed PostgreSQL Project
~~~

迁移本身可以成为重要产品能力。

## Packaging / Licensing 原则

- Edition Boundary 简单清晰；
- Open-source Community 真正可用；
- Commercial / Cloud 不破坏 Backend Core Semantics；
- Community 的版本收敛不等于人为阉割。
