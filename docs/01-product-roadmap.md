# Modelry 产品路线

## 路线原则

Modelry 不以“不断堆功能”作为路线。

每一阶段都应该明显改善：

- 上手速度；
- 核心 Backend 工作流完整性；
- 安全演进；
- 长期 Self-hosted 使用；
- 团队 / Enterprise / Cloud 生产体验。

## Phase A — 产品与架构基础

目标：冻结产品语义、V0.1 范围和交互基线。

主要产物：

- Product Vision
- Product Architecture
- V0.1 Community Scope
- Admin Product UX
- Runtime / Storage ADR
- Foundation Spec
- HTTP Contract
- Browser Acceptance Spec

关键结论：

> Community、Commercial / Enterprise 与 Modelry Cloud 共享 Project Backend Product Semantics，但可以拥有不同数据库、部署模式和 Control Plane。

## Phase B — V0.1 Community

目标：交付第一个真正好用、完整、可发布的 Community Backend Platform。

核心用户路径：

~~~text
Start Modelry
→ Bootstrap Owner
→ Create Normal / Auth Collection
→ Define Initial Schema
→ Create / Edit Records
→ Configure Access Rules
→ Create / Login Application User when needed
→ Discover / Run Application API
→ Inspect Requests / Audit
→ Evolve Schema with Pending Changes
→ Apply / Recover
→ Restart
→ Verify Durable State
~~~

V0.1 只支持 SQLite。

V0.1 必须保留：

- Model / Records / Auth / Access Rules
- REST API / OpenAPI / Runner / Request Logs
- Local Single-file Field
- Safe Schema Evolution
- Owner + Service Account / API Key
- Minimal Audit / Runtime Diagnostics
- Minimal CLI
- Core MCP

V0.1 不以 Realtime、Hooks 或完整 Extension Runtime 证明产品成立。

## Phase C — Community V0.1.x / Mature（已交付）

目标：在核心闭环稳定之后扩展长期 Community 能力。

状态：以下方向已全部交付并通过真实 Runtime / SQLite / HTTP / Chromium 验收（详见 ADR-0002 ~ ADR-0008 与 Spec 0004 ~ 0010）：

已交付方向：

- SSE Realtime
- Lifecycle Hooks
- Secrets UI
- Policy Simulation
- Additional Administrator Management
- Event Hooks / Webhooks
- S3-compatible Files
- Multiple File Values
- Simple Jobs / Cron
- Better Backup / Restore UX
- Import / Export
- SDK Generation
- More complete Activity / Diagnostics
- Drift Detection
- Editable Runtime Settings
- Migration Ergonomics
- Local → Production growth path

Community 默认继续围绕 SQLite 保持简单产品定位。

## Phase D — Commercial / Enterprise

目标：解决团队、治理和正式生产问题，而不是通过削弱 Community 制造付费点。

主要方向：

- PostgreSQL Runtime
- Organization / Team Governance
- Enterprise Identity / SSO
- Advanced RBAC
- Centralized Audit / Retention
- Enterprise Secrets / KMS
- Backup / Restore / Disaster Recovery
- Production Observability
- HA / Scale
- Fleet / Multi-instance Operations
- Compliance Integration
- Support / SLA

Enterprise 继续使用与 Community 相同的 Project Backend Model 和 Project Admin Semantics。

## Phase E — Modelry Cloud

Cloud 是 Managed Backend Platform，而不是简单托管 Community Binary。

~~~text
Cloud Control Plane
→ Organization
→ Team
→ Project
→ Environment
→ Region
→ Usage
→ Billing
→ Backup
→ Support

Project Backend Plane
→ Shared Modelry Backend Semantics

Developer Interfaces
→ Admin
→ HTTP
→ OpenAPI
→ SDK
→ CLI
→ MCP
~~~

Cloud Console 管“Modelry 资源”。

Project Admin 管“用户构建的 Backend”。

## Environment 演进

V0.1 Community 不实现 Development / Staging / Production Environment Complexity。

未来 Changes 可以演进为：

~~~text
Development Change
→ Review
→ Promote
→ Staging
→ Verify
→ Promote
→ Production
~~~

因此 Project Identity、Change Artifact 与 Applied History 的定义不能阻断未来 Promotion。

## Guardrails

不要：

- 把 Cloud-only 概念提前塞进 Community；
- 把 Community 做成残缺 Trial Edition；
- 把 PostgreSQL 变成 V0.1 前置条件；
- 把 SQLite 变成永久 Modelry 语义；
- 为了“完整”把所有长期能力一次塞进 V0.1；
- 提前拆 Microservices / Distributed System；
- 让内部 Change / Security Object Model 主导用户操作路径。
