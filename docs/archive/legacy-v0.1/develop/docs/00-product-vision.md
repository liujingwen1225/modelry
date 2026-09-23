# Modelry 产品愿景

## 一句话定义

**Modelry 是一个为 AI Coding 重新设计的自托管应用后端。**

## 产品定位

Modelry 不是“给 PocketBase 加上 AI”，也不是 PocketBase API 兼容项目。

它借鉴轻量、自托管 Backend 的产品形态——简单部署、内置数据、认证、文件、API 和管理后台——并围绕一个新的前提重新设计：

> 人类开发者和 Coding Agent 都需要一等公民级、可理解、可控制的 Backend 操作能力。

## 北极星体验

对人类开发者：

`download -> run modelry -> open Admin -> model data -> use API`

首次运行 `modelry` 会在当前 Project Root 自动完成初始化并启动 Runtime；需要脚本化分步控制时，仍可显式使用 `modelry init -> modelry serve`。

对 Coding Agent：

`inspect -> propose -> diff -> apply -> audit`

两条路径最终操作同一套 Backend Model。

## 产品原则

### Single Binary First

默认体验应保持为单一可执行文件部署，并尽量减少外部运行依赖。

### Human-friendly Admin + Agent-friendly Backend

Admin UI 不是附属品，MCP 也不是附属品。人和 Agent 都以一等公民身份操作同一套 Backend 语义。

### AI Native, Not AI Dependent

未配置任何 AI Provider 时，Modelry 仍然必须是完整可用的 Backend。AI 用于增强开发体验，而不是成为运行时依赖。

### Explicit over Magic

Schema、Policy、Migration、Hook 和 Agent 变更都应可检查、可解释。仅仅告诉用户“AI 已经改好了”不是可接受的控制模型。

### Backend Model is the Source of Truth

Collection、Schema、Policy 等产品语义由声明式 Backend Model 定义；SQLite 只是物理存储实现。

### One Instance, One Project

V0.1 主动保持克制。一个 Modelry Runtime 只服务一个 Project，不演变为多 Project 托管控制面。

## V0.1 能力方向

当前目标能力集包括：

- Normal Collection 与 Auth Collection
- Record
- 声明式 Field、Relation、Validation、Index 与 Policy
- Schema Diff 与 Migration
- REST API 与 OpenAPI
- 可撤销的认证与 Session 模型
- Local First / S3-compatible File Storage
- SSE Realtime
- Secret
- TypeScript Hook 与 Custom API
- MCP
- ChangeSet、风险评估、确认与 Audit
- 内嵌 Admin UI

## V0.1 明确非目标

除非后续 Accepted ADR 修改范围，V0.1 不应演变为：

- Kubernetes First 平台
- 微服务架构
- 通用 Workflow / DAG Engine
- 数据仓库或 BI 产品
- 分布式数据库
- 多 Project SaaS Control Plane
- 通用不可信代码 / Serverless Sandbox
- PocketBase Compatibility Layer

## 当前实现方向

首选技术路线为 **Bun + TypeScript**，Storage 采用 **SQLite First**，目标发布形态为单一可执行文件。

在正式进入生产实现前，仍需通过 `docs/spikes/0001-bun-runtime-validation.md` 中定义的 Bun Runtime 技术 Spike。
