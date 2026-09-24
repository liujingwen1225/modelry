# Modelry 当前上下文

## 产品定位

Modelry 是一个面向人类开发者与 Coding Agent 的产品化 Backend Platform。

V0.1 的核心用户路径统一为：

~~~text
First Run
→ Create Backend Model
→ Manage Data
→ Secure
→ Use API
→ Observe
→ Evolve
~~~

扩展能力是重要方向，但不作为第一个 V0.1 Release Gate 的前置条件。

Modelry 不能演变成“数据库管理工具 + 一堆附加功能”。

## 产品化要求

所有产品和技术决策必须优先服务：

- **易用**：少理解一个内部概念、少一次跳转、少一次无意义确认。
- **好用**：真实工作流连续，默认值合理，结果原地可见。
- **好看**：视觉、信息层级与交互统一。
- **功能完整**：核心 Backend 工作流真正闭环，而不是拥有很多未闭环能力。

技术纯粹性、提前抽象和内部对象模型不得凌驾于产品体验。

## 产品体系

### Community

开源、自托管、SQLite Only、零配置优先。

Community 的长期产品可以持续拥有 Files、Realtime、Hooks、Secrets 等能力，但 V0.1 不要求一次完成所有长期 Community 能力。

### Commercial / Enterprise

面向正式生产、团队和组织的商业 Self-hosted 产品。

PostgreSQL、Organization / Team Governance、Enterprise Identity、Advanced RBAC、Backup / Restore、Production Observability、HA / Scale、Fleet Operations、Compliance 与 Support 属于这一阶段。

### Modelry Cloud

官方 Managed SaaS。

Cloud 使用独立 Cloud Control Plane 管理 Organization、Team、Project、Environment、Region、Usage、Billing、Backup 和托管运维。

Project Backend Plane 的核心产品语义继续与 Self-hosted Modelry 共用。

## V0.1 Community 固定基线

- Go Runtime
- SQLite Only
- React + TypeScript + Vite
- Modular Monolith
- Contract First
- Zero-config-first
- 简单 Self-hosted Delivery
- 一个 Runtime 服务一个 Project

## V0.1 产品范围原则

必须优先完成：

~~~text
Model
→ Data
→ Security
→ API
→ Observe
→ Evolve
~~~

V0.1 保留：

- Collections / Fields / Relations / Basic Index / Validation / Defaults
- Records
- Durable Pending Schema Changes / Apply / Recovery / Applied History
- REST API / OpenAPI / Runner / Request Logs
- Auth Collection / Email + Password / Sessions
- Access Rules
- Local Single-file Field
- Owner + Service Account / API Key
- Minimal Audit
- Runtime / Storage Diagnostics
- Minimal CLI
- Core MCP

V0.1.x 再进入：

- Realtime
- Lifecycle Hooks
- Secrets UI
- Event Hooks / Webhooks
- Policy Simulation
- Additional Administrator Management
- Full Activity Timeline
- Drift Product
- Editable Runtime Settings
- Multiple File Values
- S3-compatible Storage

## 架构不变量

- Backend Model 定义 Modelry 产品语义，SQLite 不能反过来定义产品。
- V0.1 只实现 SQLite，但未来 PostgreSQL 不应要求重写 Domain Model、Admin 或 Contract。
- Application Data Plane 与 Modelry Control Plane 分离。
- Admin Identity 与 Application User Identity 分离。
- Principal 与 Credential 在 Domain 中分离，但 UI 使用 Administrator、Service Account、App User、Password、API Key、Session 等自然术语。
- 受管 Backend Model Mutation 统一经过显式 Change Lifecycle。
- Admin、HTTP、CLI 与 MCP 操作同一套 Backend Semantics。
- Go 是 Runtime 实现语言，不是用户必须面对的扩展语言。
- Domain Language 不等于 UI Language。

## Record Events and Realtime

**Record Event**：一个已提交的 Collection Record 创建、更新或删除事实。它属于 Project 的数据变更历史，与 API 请求遥测和管理审计分别建模。
_Avoid_：Audit Event、Request Event、Activity Event

**Event ID**：标识一个 Record Event，并确定它在同一 Project 事件序列中的位置。它可作为该 Event 之后恢复接收的游标值。
_Avoid_：SQLite Row ID、Request ID

**Event Cursor**：标识订阅者从 Project 事件序列继续接收的位置。它通常取最近已接收 Event 的 Event ID；首次订阅时也可表示尚无 Event 的空序列边界。
_Avoid_：Page Cursor、Request ID

**Realtime Subscription**：应用通过 Collection 订阅已授权的 Record Event，并在连接恢复后从 Event Cursor 继续接收。
_Avoid_：Record polling、Activity Timeline

## Change UX 不变量

底层继续保留：

~~~text
ChangeSet
→ Structured Diff
→ Risk / Preconditions / Impact
→ Apply Attempt
→ Migration / Ledger
~~~

用户主界面优先使用：

~~~text
Pending
Needs review
Failed
Applied
~~~

Schema 的 Pending Changes 必须耐久保存。用户离开 Collection、刷新页面或切换 Fields / Relations / Indexes 时不应丢失。

Policy 与 Auth Configuration 不与 Schema 共用一个隐形 Collection-wide Draft。

## 权威文档阅读顺序

1. docs/00-product-vision.md
2. docs/01-product-roadmap.md
3. docs/02-technical-roadmap.md
4. docs/03-editions-and-cloud.md
5. docs/04-v0.1-community-scope.md
6. docs/05-product-experience-and-acceptance.md
7. docs/06-product-architecture.md
8. docs/specs/0001-admin-product-ux-spec.md
9. 后续 Accepted ADR
10. 后续 Accepted Spec
11. 后续 Accepted Contract

历史文档不具备当前权威性。

## 当前实施 Gate

Admin Product UX Spec 已完成本轮范围和 UX 收敛。

在大范围生产实现前仍需建立并接受：

- Runtime / Storage ADR
- Foundation Spec
- HTTP Contract / OpenAPI
- Browser Acceptance Spec
