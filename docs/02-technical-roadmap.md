# Modelry 技术路线

## 目标

技术路线服务产品路线：

~~~text
V0.1 Community Core
→ Community V0.1.x / Mature
→ Commercial / Enterprise
→ Modelry Cloud
~~~

V0.1 应保持实现简单，同时确保未来 PostgreSQL、Extension Runtime、Enterprise 与 Cloud 不需要推翻 Product Semantics。

## Runtime Core：Go

Go 作为 Runtime Core，用于：

- HTTP / Networking
- Concurrency
- Long-running Runtime
- Cross-platform Distribution
- SQLite Runtime
- Future PostgreSQL Runtime
- Admin / API / MCP shared semantics

Go 是内部实现语言，不是用户扩展语言。

## Community Database：SQLite

SQLite 是 Community 的正式数据库边界。

它支持：

- Zero-config-first
- Local / Self-hosted
- 简单备份与迁移
- 低运维成本
- 小型和中小项目

V0.1 只实现 SQLite。

## Commercial / Enterprise / Cloud Database：PostgreSQL

PostgreSQL 是明确的后续 Target。

正确关系：

~~~text
Modelry Product Semantics
→ Storage / Migration Boundary
→ SQLite
→ future PostgreSQL
~~~

错误关系：

~~~text
SQLite private semantics
→ Product Model
~~~

V0.1 不做任意数据库 Adapter Marketplace。

## Admin：React + TypeScript + Vite

Admin 是核心产品，不是内部管理工具。

固定前端基础：

~~~text
Modelry Product UI
        ↓
Modelry Design System
        ↓
shadcn/ui
        ↓
Base UI
        ↓
Tailwind CSS v4
~~~

业务 UI 基础：

- TanStack Query
- TanStack Table
- React Hook Form
- Zod
- URL State
- React Local State

Modelry Design System 决定真实产品视觉与交互。禁止把 shadcn/ui Demo 当作最终设计。

## Design System 必须先固定的 Contract

至少覆盖：

- semantic color tokens
- typography
- spacing
- radius / elevation
- standard / compact density
- button hierarchy
- form pattern
- table pattern
- standard sheet / wide sheet / focused workspace / split pane boundary
- dialog behavior
- loading / empty / error / partial state
- inline validation
- durable success feedback
- copy interaction
- keyboard / focus
- WCAG 2.2 AA target
- dark mode
- structured JSON viewer
- URL / deep-link behavior

## Modular Monolith

V0.1 从 Modular Monolith 开始。

V0.1 核心模块：

- Backend Model / Schema
- Changes / Migration
- Records / Query
- Application API
- Auth
- Access Rules / Policy
- Files
- Admin Control Plane
- Request Observability
- Audit
- Access / Service Account
- MCP
- CLI

V0.1.x 再增加：

- Realtime
- Extension Runtime
- Lifecycle Hooks
- Secrets UI
- richer Diagnostics / Activity

不要因为未来 Cloud 就提前为模块创建网络服务边界。

## Schema Evolution

底层统一：

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

- Applied Migration 是 Immutable Fact。
- Risk / Preconditions 由 Runtime 计算。
- Retry 创建新的 Apply Attempt。
- Destructive / Irreversible Change 必须有明确确认与恢复策略。

### Pending Changes UX

Schema Editor 中保存一个 Field / Relation / Index 修改时，先形成耐久 Pending Operation，而不是立即修改已应用 Backend Model。

~~~text
Edit field
→ save pending operation
→ pending count increases
→ continue modeling
→ apply once
~~~

Pending Schema Changes：

- 单 Collection scope；
- Fields / Relations / Indexes 共用；
- refresh / navigate 后保留；
- 不要求 Save for Later；
- 不与 Policy / Auth Configuration 合并成 Collection-wide transaction。

## Data Plane 与 Control Plane

### Application Data Plane

- Application Auth
- Records
- Files
- Public Application API

V0.1.x 增加 Realtime。

### Modelry Control Plane

- Admin Authentication
- Backend Model / Changes
- Runtime / Storage Diagnostics
- Access Management
- Service Account / API Key
- Audit
- Administrative Data Access
- MCP Management Operation

## Identity Model

Domain 保持：

~~~text
Principal != Credential
~~~

至少区分：

- Modelry Owner / Administrator Principal
- Service / Agent Principal
- Application Principal

UI 不要求普通用户学习 Principal / Capability / Credential。

UI 使用：

- Owner / Administrator
- Service Account
- App User
- Permission
- Password
- API Key
- Session

## Auth Collection

email 是 Auth Identifier Field。

password 是 Application Credential，不是普通 Field。

Admin 创建 Auth User 时，产品上一次完成：

~~~text
Profile record
+
Credential creation
~~~

底层仍保持 Record 与 Credential 分离。

## Query / Access Rules

底层可以使用统一 Declarative Expression Model。

产品 UI 优先提供：

- No access
- Anyone
- Signed-in users
- Record owner
- Custom rule

高级用户再进入 Expression。

默认 Fail Closed。

Relation Expand 必须重新检查 Target Collection View Rule。

## Files

V0.1：

- Local Storage
- Single File Field
- size constraint
- MIME constraint
- upload lifecycle
- temporary cleanup

V0.1.x：

- Multiple File Values
- S3-compatible Storage

File 不独立演变成 DAM Product。

## Realtime / Extensions

Realtime 与 Lifecycle Hook 都是长期 Community 能力，但不进入 V0.1 Release Gate。

V0.1.x 再通过独立 ADR + Spike 确定：

- SSE Realtime subscription semantics
- JS / TS-facing Extension Runtime
- isolation / timeout
- controlled Runtime API
- secrets
- failure semantics
- delivery semantics

不可回滚外部副作用不得伪装成同步 Pre-commit Hook。

## Observability

V0.1 明确：

- **API Requests**：Application HTTP operational telemetry
- **Audit**：Security / Governance durable fact
- **Overview / contextual diagnostics**：需要用户处理的 runtime 状态

Standalone Generic Activity Timeline 已由 Community V0.1.x 交付（[ADR-0007](adr/0007-policy-activity-drift-and-settings.md)）：
它是由各子系统拥有的事实构成的读模型，明确不读取 RequestRecord 或 AuditRecord。

同批交付的还有 Policy Simulation、Drift Detection、Editable Runtime Settings（#27），
以及 Backup / Restore、Import / Export、Typed Application API 与可复现的 SDK 生成（#28）。

统一 requestId 连接：

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

## 技术阶段

1. Domain + Contract Foundation
2. Go Runtime Skeleton + SQLite
3. Schema / Pending Changes / Records
4. Auth / Access Rules / Files
5. Application API / Requests / Audit
6. Admin Product Closure
7. MCP / CLI Closure
8. V0.1 Hardening
9. Community Realtime / Extensions
10. PostgreSQL Runtime
11. Enterprise / Cloud Control Plane

## V0.1 明确不做

- PostgreSQL
- Realtime
- Lifecycle Hooks
- Secrets UI
- Distributed Queue
- Microservices
- Kubernetes-first
- Generic Database Plugin Marketplace
- HA Cluster
- Multi-project Community Runtime
- Hostile-code Serverless Sandbox
