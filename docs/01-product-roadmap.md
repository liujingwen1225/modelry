# Modelry 产品路线

## 路线原则

Modelry 的产品路线不是“不断堆功能”。

每个阶段都应该明显改善至少一个结果：

- 更快上手；
- 更完整的真实 Backend 工作流；
- 更安全的生产运行；
- 更成熟的团队和 Cloud 使用体验。

## Phase A — 产品与架构基础

目标：在大规模实现前先冻结产品模型。

主要产物：

- Product Vision
- Product Architecture
- V0.1 Community Scope
- Product-grade Admin Information Architecture
- Runtime ADR
- Foundation Spec
- HTTP Contract
- Browser Acceptance Spec

这一阶段最重要的结论是：

> Community、Commercial / Enterprise 和 Modelry Cloud 共享同一套 Project Backend Product Semantics，但可以拥有不同的数据库、部署模式和 Control Plane。

## Phase B — V0.1 Community

目标：交付一个第一次使用就具有正式产品感的开源 Backend Platform。

核心用户路径：

~~~text
启动 Modelry
→ Bootstrap Admin
→ 创建 Normal / Auth Collection
→ 定义 Schema
→ Review Changes
→ Apply
→ 管理 Records
→ Application Register / Login
→ 调用 API
→ 配置 Policy
→ 使用 Local Files
→ 使用 Realtime
→ 执行 Lifecycle Hook
→ 查看 API Requests / Audit / Activity
→ 使用 MCP
→ Restart
→ 验证 Durable State
~~~

V0.1 **只支持 SQLite**。

重点不是功能数量，而是每一个进入 V0.1 的能力都必须完成完整产品闭环。

## Phase C — Community 成熟

目标：让 Community 适合长期 Self-hosted 项目，而不仅仅是初次体验。

后续优先考虑：

- 更完整 Backup / Restore UX
- OAuth 与更丰富 Auth Lifecycle
- S3-compatible Files
- Event Hooks / Webhooks
- Simple Jobs / Cron
- SDK Generation
- 更成熟的 Diagnostics / Observability
- Import / Export
- Migration Ergonomics
- 更顺滑的 Local → Production 成长路径

Community 默认继续围绕 SQLite 保持简单产品定位。

## Phase D — Commercial / Enterprise

目标：解决团队和企业的正式生产问题，而不是通过削弱 Community 制造付费点。

主要方向：

- PostgreSQL Runtime
- Organization / Team Governance
- Enterprise Identity / SSO
- Advanced RBAC
- Centralized Audit / Retention
- Enterprise Secrets / KMS Integration
- Backup / Restore / Disaster Recovery
- Production Observability
- HA / Scale
- Fleet / Multi-instance Operations
- Compliance Integration
- Support / SLA

Enterprise 继续使用与 Community 相同的 Project Backend Model 和 Project Admin Semantics。

## Phase E — Modelry Cloud

目标：提供真正的 Managed Backend Platform，而不是简单“托管一个 Community Binary”。

Cloud 产品分层：

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
→ Collection
→ Records
→ API
→ Auth
→ Policy
→ Files
→ Realtime
→ Hooks
→ Changes
→ Observability

Developer Interfaces
→ Admin
→ HTTP
→ OpenAPI
→ SDK
→ CLI
→ MCP
~~~

Cloud Console 与 Project Admin 是两个不同产品层。

Cloud Console 管理“你的 Modelry 资源”。

Project Admin 管理“你用 Modelry 构建的 Backend”。

## Environment 演进

Development / Staging / Production 在真正进入 Enterprise / Cloud 环境管理后，应该成为一等产品概念。

Changes 能力可以自然演进为：

~~~text
Development Change
→ Review
→ Promote
→ Staging
→ Verify
→ Promote
→ Production
~~~

V0.1 Community 不实现 Environment Complexity。

但 Project Identity、ChangeSet 和 Migration Artifact 的定义不能阻断未来 Promotion 模型。

## 路线 Guardrails

不要：

- 把 Organization / Billing 等 Cloud-only 概念塞进所有 Community 页面；
- 把 Community 做成残缺 Trial Edition；
- 把 PostgreSQL 变成 V0.1 前置条件；
- 把 SQLite 变成 Modelry 永久产品语义；
- 在没有真实产品需求前引入 Distributed System；
- 默认拆成 Microservices；
- 为商业化主动破坏 Community 核心开发体验。
