# Modelry

**为 AI Coding 重新设计的应用后端。**

Modelry 是一个面向 AI Coding 的自托管应用后端。

> 单一可执行文件。TypeScript First。对人友好。对 Agent 友好。

## 当前阶段

Modelry 已完成：

- `grill-with-docs`
- Design Gap Closure
- Bun Runtime Spike Gate

Bun Runtime Spike 最终结论：**GO**。

Bun + TypeScript 已通过 Linux x64 / Windows x64 standalone、SQLite、Embedded Admin、REST、SSE、MCP -> ChangeSet、Dynamic TypeScript Hook、Hook Fault Recovery、Hook Reload/Concurrency 与 Transactional Outbox 等关键验证。

当前正式阶段是：**`to-spec`**。

后续固定流程：

`to-spec -> to-tickets -> implement -> code-review`

## 产品定位

Modelry 不是“给 PocketBase 加上 AI”，也不是 PocketBase API 兼容项目。

它借鉴 PocketBase 类产品“轻量、自托管、开箱即用”的体验，但从一开始围绕 AI Coding 重新设计 Backend Model、变更机制、机器接口和运行边界。

核心原则：

- **Single Binary First** —— 默认部署保持单一可执行文件和尽可能少的外部依赖。
- **Human-friendly Admin + Agent-friendly Backend** —— 人类开发者和 Coding Agent 都是一等公民。
- **AI Native, Not AI Dependent** —— 不配置任何 AI 服务时，核心 Backend 仍然完整可用。
- **Explicit over Magic** —— Schema、Policy、Migration、Hook 和 Agent 变更都必须可检查、可解释、可审计。
- **Backend Model is the Source of Truth** —— Agent 和工具修改声明式 Backend Model，而不是直接操作物理数据库。
- **One Instance, One Project** —— 一个运行中的 Modelry Instance 对应一个应用后端 Project。

## 当前设计基线

- Backend Model 变更统一经过 `ChangeSet -> Diff + Risk -> Apply -> Migration -> Audit`。
- Application Data Access 使用 Record Policy；Administrative Data Access 使用 Capability Scope。
- 可靠 Event/Outbox/Audit Fact 与业务 Mutation 原子持久化，外部副作用在 Commit 后执行。
- Project Migration History 是可复现历史来源，Runtime Backend Model 是运行时 Materialized Truth，Schema Snapshot 是 Generated Projection。
- Custom API 必须提供机器可读 Route Contract，不能成为任意 Router 黑盒。
- V0.1 分为 `V0.1.0 Core Closure` 与 `V0.1.x Completion`，后置能力不再无条件阻塞首个端到端版本。

## 当前技术基线

- Runtime / Core：**Bun + TypeScript**，Runtime Spike 已 `GO`。
- Storage：**SQLite First**。
- Admin UI：TypeScript + React 类 Web UI，并入单一可执行文件。
- Realtime：SSE First。
- Extension：Trusted Project Code 形式的 TypeScript Hooks / Custom APIs。
- Hook Isolation：Worker First，self-spawned same executable 作为可行 fallback。
- Reliable Async：SQLite Transactional Outbox。
- Agent 接口：MCP 作为 V0.1 核心能力，并通过 Backend Model / ChangeSet Core 工作。

已确认的领域术语和架构决策见 [`CONTEXT.md`](./CONTEXT.md)、[`docs/01-v0.1-scope.md`](./docs/01-v0.1-scope.md)、[`docs/adr/`](./docs/adr/) 与 [`docs/spikes/0001-bun-runtime-validation-result.md`](./docs/spikes/0001-bun-runtime-validation-result.md)。
