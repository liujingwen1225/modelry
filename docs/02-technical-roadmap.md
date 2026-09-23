# Modelry 技术路线

## 目标

技术路线服务于产品路线：

~~~text
Community
→ Commercial / Enterprise
→ Modelry Cloud
~~~

当前技术选择必须保证 V0.1 简单，同时不把未来 PostgreSQL、Enterprise 和 Cloud 的演进路径堵死。

## Runtime Core：Go

Go 适合作为 Modelry Runtime Core，因为：

- 适合长期运行的 Backend Runtime；
- HTTP / Networking / Concurrency 能力成熟；
- Runtime Resource 使用可控；
- Cross-platform Distribution 简单；
- Self-hosted 与 Cloud Project Runtime 可以共用；
- Runtime Core 与用户 Extension Language 可以保持分离。

Go 是内部 Runtime Implementation Language，不是用户必须面对的扩展语言。

## Community Database：SQLite

SQLite 是 Community 的正式数据库边界，而不仅仅是“V0.1 临时数据库”。

价值：

- 不要求用户先安装外部数据库；
- 支持真正 Zero-config-first；
- 非常适合 Local / Self-hosted / 小团队；
- 备份、分发和项目可移植性好；
- 与 Community“简单完整”的产品定位一致。

## Commercial / Enterprise / Cloud Database：PostgreSQL

PostgreSQL 是明确的后续真实 Target，不是假想 Adapter。

因此 V0.1 必须做到：

> 只实现 SQLite，但不让 Modelry Domain Model 依赖 SQLite 私有语义。

V0.1 不实现 PostgreSQL。

## Admin：React + TypeScript + Vite

Admin 是核心产品，不是内部管理工具。

前端技术选择必须优先支持：

- Complex Workspace
- Data Table
- Form
- Diff
- Drawer / Sheet
- API Runner
- Query State
- URL State
- Design System
- Browser Acceptance

## Admin UI / Design System 技术基线

Modelry 需要明确的 UI Framework / Component System，不能只写 React + TypeScript。

V0.1 Admin 推荐固定为：

- **Tailwind CSS v4**：样式与 Design Token 表达层；
- **shadcn/ui**：Open Code Component Layer，用于建立 Modelry 自己的组件体系，而不是把默认视觉直接当成最终产品视觉；
- **Base UI**：Headless / Accessible Primitive Layer，作为 Dialog、Popover、Select、Combobox、Menu、Drawer 等复杂交互基础；
- **TanStack Query**：Server State；
- **TanStack Table**：Data Table State / Sorting / Filtering / Pagination 等 Headless Table 能力；
- **React Hook Form + Zod**：Form State、Validation 与 Schema；
- **Modelry Design System**：在上述基础上形成自己的 Token、Component Variant、Layout、Interaction Pattern 和产品视觉。

关系固定为：

~~~text
Modelry Product UI
        ↓
Modelry Design System
        ↓
shadcn/ui Open Code Components
        ↓
Base UI Primitives
        ↓
Tailwind CSS v4
~~~

TanStack Query / Table、React Hook Form / Zod 属于应用状态与复杂业务 UI 基础设施，不替代 Design System。

### 为什么不直接采用 Ant Design / MUI 作为产品视觉

Modelry Admin 是核心产品体验，需要形成自己的 Developer Tool 视觉语言。

因此不采用强视觉预设的大型组件库作为最终产品外观，避免：

- 产品天然呈现通用企业后台风格；
- 为修改基础视觉持续覆盖默认 Theme；
- Component API 与产品交互被 Framework Opinion 锁死；
- Agent / Developer 维护时同时存在 Library Wrapper 与 Product Component 两层抽象。

shadcn/ui 的 Open Code 模式允许组件源码直接进入仓库，并由 Modelry 自己维护产品级组件；Base UI 提供可访问性、Keyboard、Focus、Popover Positioning 等复杂基础行为。

### 使用规则

- 页面不得直接自由组合 Primitive 形成新的视觉模式；
- 高频基础组件优先进入 Modelry Design System；
- shadcn/ui 提供的是起点和组件结构，不是最终视觉规范；
- 禁止直接复制 shadcn Demo 页面作为 Modelry 页面设计；
- Tailwind Utility 可以用于业务布局，但 Design Token、Button、Input、Dialog、Sheet、Table、Tabs、Status 等核心组件必须统一；
- 新增组件必须同时考虑 Accessibility、Keyboard、Loading、Disabled、Error 和 Browser Acceptance。

## Extension Runtime：JavaScript / TypeScript-facing Boundary

Go Core 不意味着 Hook / Custom API 必须写 Go。

用户侧应该保留易于开发的 JavaScript / TypeScript Extension Experience。

具体采用 Embedded Engine、Worker、Subprocess 还是其他机制，由独立 ADR + Spike 决定。

但 Product-facing Language 和 Capability Boundary 必须与 Go Core 解耦。

## 总体架构

V0.1 从 **Modular Monolith** 开始。

主要模块：

- Backend Model / Schema
- Changes / Migration
- Records / Query
- Application API
- Auth
- Policy
- Files
- Realtime
- Hooks / Events
- Secrets
- Observability
- Audit / Activity
- Admin Control Plane
- MCP
- CLI

不要因为未来要做 Cloud，就提前为这些模块创建 Network Service Boundary。

## Storage Boundary

正确关系：

~~~text
Modelry Semantics
→ Storage / Migration Boundary
→ SQLite
→ future PostgreSQL
~~~

错误关系：

~~~text
SQLite Table / Index / SQL
→ 反推出 Modelry Product Semantics
~~~

Collection、Field、Relation、Index、Query、Change 都必须先存在为 Modelry Domain Concept。

V0.1 可以深入使用 SQLite 能力实现正确性和简洁性，但 SQLite-specific Behavior 必须停留在 Storage / Migration Boundary。

未来 PostgreSQL 实现同一受支持的 Modelry Contract，而不是重新设计整个产品。

V0.1 不建立“支持任意数据库”的 Generic Adapter Marketplace。

## Schema Evolution

统一核心：

~~~text
Backend Model
→ ChangeSet
→ Structured Diff
→ Risk / Preconditions / Impact
→ Apply Attempt
→ Physical Migration
→ Migration History / Ledger
→ Generated Projection
~~~

重要规则：

- 已 Apply 的 Migration 是 Immutable Fact。
- Risk 与 Preconditions 由 Runtime 计算，不由 UI 输入。
- Retry 创建新的 Apply Attempt，而不是复制语义相同的 ChangeSet。
- Destructive / Irreversible Change 必须具有明确确认和恢复策略。

## Data Plane 与 Control Plane

### Application Data Plane

包含：

- Application Auth
- Records
- Files
- Realtime
- Public Application API

### Modelry Control Plane

包含：

- Admin Authentication
- Backend Model / Schema Change
- Runtime Settings
- Secrets
- Access Management
- Audit
- Administrative Data Access
- MCP Management Operation

两者不能合并成一套模糊 Role System。

## Identity Model

维持：

~~~text
Principal != Credential
~~~

至少区分：

- Admin / Control Plane Principal
- Application Principal
- Agent / Service Principal

Application User 不能因为存在 Auth Collection Record 就成为 Modelry Administrator。

## Query / Policy

尽可能复用一个 Declarative Expression Model：

- Record Filter
- Record Policy
- Realtime Subscription Filter
- Administrative Filter

Policy 默认 Fail Closed。

Relation Expand 必须再次检查目标 Collection 的 View Policy。

## Events 与 Reliability

Lifecycle Hook 用于 Transaction 周围的同步、确定性逻辑，例如：

- Validation
- Field Mutation
- Reject Mutation

不可回滚的 External Side Effect 必须发生在 Commit 之后。

如果功能承诺 Reliable Async Delivery，则对应 Delivery Intent 必须与 Business Mutation 原子耐久化。

Realtime 在没有显式 Replay Contract 前保持 Best Effort。

## Files

Community 从 Local Storage 开始。

File 作为 Collection Field 能力，不独立演变成复杂 DAM Product。

S3-compatible Storage 后续进入 Community Mature / Commercial / Cloud 阶段。

## Observability

明确分离三个概念：

- **API Requests**：Application HTTP Operational Telemetry
- **Audit**：Security / Governance Durable Fact
- **Activity**：跨模块 Operational Timeline / Diagnostic Event

三者不互相替代。

统一 requestId 用于连接：

- Runtime Error
- API Runner
- Request Log
- Diagnostic Surface

## Contract First

标准实施顺序：

~~~text
Product Model
→ ADR
→ Domain Spec
→ HTTP Contract / OpenAPI
→ Go Implementation
→ React Client
→ Browser Acceptance
~~~

不能从 Handler 反向推导 Contract。

## 技术阶段

1. Domain + Contract Foundation
2. Go Runtime Skeleton + SQLite
3. Schema / Changes / Records / API
4. Auth / Policy / Files / Realtime
5. Hooks / Secrets / Observability / Audit
6. Admin Product Closure
7. MCP / CLI Closure
8. Community Hardening
9. PostgreSQL Runtime for Commercial / Enterprise / Cloud
10. Cloud Control Plane + Managed Operations

## V0.1 明确不做

- PostgreSQL Implementation
- Microservices
- Kubernetes-first
- Distributed Queue
- Generic Database Plugin Marketplace
- Hostile Multi-tenant Serverless Sandbox
- HA Cluster
- One Runtime hosting multiple Community Projects
