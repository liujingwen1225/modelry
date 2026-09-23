# Modelry 当前上下文

## 产品定位

Modelry 是一个面向人类开发者与 Coding Agent 的产品化 Backend Platform。

它的核心任务，是让用户通过一个统一产品完成：

~~~text
启动
→ 建模
→ 管理真实数据
→ 使用 API
→ 配置 Auth / Policy
→ 使用 Files / Realtime / Hooks
→ 安全演进 Schema
→ 查看 Requests / Audit / Activity
→ 诊断与恢复
~~~

Modelry 不能演变成“数据库管理工具 + 一堆附加功能”。

## 产品化要求

所有产品和技术决策都必须服务以下目标：

- **易用**：用户能快速理解并完成任务。
- **好用**：真实工作流顺畅，默认值合理，错误可恢复。
- **好看**：视觉、交互与信息层级统一，达到正式产品标准。
- **功能完善**：核心 Backend 工作流能够真正闭环，而不是只存在零散能力。

技术纯粹性、架构炫技和提前抽象不应凌驾于这些目标之上。

## 产品体系

### Community

开源、自托管、SQLite Only、零配置优先。

Community 应独立完成一个完整应用后端的核心闭环，包括 Schema、Records、API、Auth、Policy、Files、Realtime、Hooks、Changes、Observability、OpenAPI 与 MCP。

### Commercial / Enterprise

面向正式生产、团队和组织的商业自托管版本。

PostgreSQL 以及组织治理、企业身份、审计、备份恢复、可观测性、HA / Scale、企业支持等能力属于这一阶段。

### Modelry Cloud

官方 SaaS。

Cloud 引入独立的 Cloud Control Plane，用于 Organization、Team、Project、Environment、Region、Usage、Billing、Backup 和托管运维。

Project Backend Plane 的核心产品语义继续与 Self-hosted Modelry 共用。

## V0.1 Community 基线

- Go Runtime
- SQLite
- React + TypeScript + Vite
- Modular Monolith
- Contract First
- Zero-config-first
- 简单自托管交付
- V0.1 中一个 Runtime 服务一个 Project

这些是 V0.1 的交付选择，不是永久产品本体。

## 架构不变量

- Modelry Backend Model 定义产品语义，SQLite 不能反过来定义产品。
- Collection、Field、Relation、Index、Policy、ChangeSet 等首先是 Modelry Domain Concept。
- V0.1 只需要实现 SQLite，但未来增加 PostgreSQL 不应要求重写产品模型、Admin 或 Contract。
- Application Data Plane 与 Modelry Control Plane 必须分离。
- Admin Identity 与 Application User Identity 必须分离。
- Principal 与 Credential 必须分离。
- Backend Model 变更必须使用显式、可审查、可恢复的 Change Lifecycle。
- Admin、HTTP、CLI 与 MCP 必须操作同一套 Backend Semantics。
- 不可回滚的外部副作用发生在 Commit 之后；承诺可靠投递时，Delivery Intent 必须在 Commit 前耐久化。
- Go 是 Runtime 实现语言，不是用户扩展语言。

## 权威文档阅读顺序

1. docs/00-product-vision.md
2. docs/01-product-roadmap.md
3. docs/02-technical-roadmap.md
4. docs/03-editions-and-cloud.md
5. docs/04-v0.1-community-scope.md
6. docs/05-product-experience-and-acceptance.md
7. docs/06-product-architecture.md
8. 后续 Accepted ADR
9. 后续 Accepted Spec
10. 后续 Accepted Contract

历史文档不具备当前权威性。

## 当前实施 Gate

在以下文档重新基于本基线建立并接受之前，不开始大范围生产实现：

- Runtime / Storage / Extension ADR
- Foundation Spec
- HTTP Contract / OpenAPI
- Admin Product UX Spec
- Browser Acceptance Spec
