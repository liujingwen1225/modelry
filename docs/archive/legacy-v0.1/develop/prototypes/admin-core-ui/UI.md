# Modelry Admin Core UI Prototype — V4 Industrial Elegance

> **Status: Accepted IA / Interaction / Visual Reference.**
>
> 本目录仍是 Throwaway Prototype：HTML/CSS/JS 只用于验证信息架构、交互与视觉，不具备生产代码继承权。后续正式前端应按已确认规则重新实现，而不是直接复制 Prototype 代码。

## 当前基线

Admin 原型与后续 Frontend Completion 以以下文档为准：

- `CONTEXT.md`
- `docs/01-v0.1-scope.md`
- `docs/02-product-business-design.md`
- `docs/specs/0002-v0.1.0-business-baseline-alignment-amendment.md`
- `docs/specs/0003-v0.1.0-admin-ia-prototype-alignment-amendment.md`

核心体验优先级：

```text
Data Usage -> API Usage -> Backend Modeling -> Change Management -> Operations
```

`Collection` 是 Admin 的一级业务入口，不新增顶层 `Data`，也不设置独立一级 `API`。

## Accepted Prototype

当前确认版本：**V4 Industrial Elegance**

- 设计文档：`DESIGN-V4-INDUSTRIAL.md`
- 原型入口：`index-v4-industrial.html`
- 设计基调：浅色工业级 Developer Console
- 主强调：Indigo
- Agent 语义：Violet
- 风险语义：Emerald / Amber / Rose
- 支持 Light / Dark 与中英文切换

## 一级导航

```text
Core
  Overview
  Collections

Governance & Security
  Changes
  Hooks & Events
  Access & Audit

Project
  Project Settings
  Activity
```

一级 IA 已确认。后续补页面时不再重新讨论是否增加 `Data` 或独立 `API`。

## Collections 工作区

默认路径：

```text
Collections
-> Collection
-> Records
```

单个 Collection 的二级 IA：

```text
Records       <- default
Schema
Relations
Indexes
Policy
Auth          <- Auth Collection only
API
```

当前 V4 已表现 Records、Schema、Relations、Policy 与 Collection API 的主要交互；`Indexes` 与 Auth Collection 的 `Auth` 页面属于 Frontend Completion 待补项，不改变已确认 IA。

### Records

Records 是日常 Data Usage 工作面，支持：

- Collection 快速切换；
- Record 查询、筛选、分页；
- 查看、新增、编辑、普通删除；
- 行点击进入 Context Drawer；
- Pending ChangeSet / Risk / Drift 提示；
- 高影响批量操作的 Impact Preview / Confirmation / Execute / Audit 链路。

普通 Record CRUD 属于 Administrative Data Access，使用 `data:inspect` / `data:mutate`，进入 Audit，不创建 ChangeSet。

### API

API 属于当前 Collection 的二级工作面，不存在独立 Project-wide API 一级页面。

Collection API 工作面用于理解和调试与当前 Collection 直接相关的：

- Data API；
- OpenAPI Contract；
- Realtime；
- Auth API（Auth Collection 时）。

Project 可以继续生成统一 OpenAPI / Machine-readable Contract，但“Project-wide contract”不等于“Project-wide Admin API 页面”。

## Changes 工作区

Changes 同时区分：

1. **ChangeSet** —— Backend Model / 受管配置的变更提案；
2. **Apply Attempt** —— 针对某个 ChangeSet 的一次实际执行尝试。

ChangeSet 产品状态：

```text
Ready / Applying / Applied / Cancelled
```

失败属于 Apply Attempt。Retry 创建新的 Apply Attempt，不创建语义重复的 ChangeSet。

风险规则：

- `SAFE`：Principal 拥有 `changeset:apply` 及所需 Scope 时可以直接 Apply；
- `DATA_REWRITE / DESTRUCTIVE / IRREVERSIBLE`：必须 Human Confirmation；
- `expandsAccess=true`：即使数据风险为 `SAFE` 也必须 Human Confirmation；
- Agent / Service Principal 不能自我充当 Human Confirmation actor。

## Access & Audit / Activity

`Access & Audit` 聚焦谁能管理 Backend、拥有什么 Capability，以及关键 Control Plane 管理访问的 Audit Fact。

`Activity` 聚焦跨模块运行时间线、Migration / Apply 结果、Hook Error、Delivery 状态等 Operations 事实，并可深链到对应 Audit。

两者职责相关但不重复。

## Prototype Fixture

当前 V4 使用电商数据作为 UI Fixture：

```text
orders
customers
products
refund_requests
```

它只用于验证页面密度、Records、Relation、API、Agent Proposal 与 ChangeSet 交互。

V0.1 正式 E2E Reference Application 仍为 Blog：

```text
users       (Auth Collection)
posts
comments
categories
```

Prototype Fixture 不改变正式验收应用。

## Agent 协同边界

V4 中的 Agent Copilot / 自由输入用于探索 Agent Intent、Proposal、Trace 与 Handoff 的呈现方式。它不是 V0.1 必须内置 AI Provider Chat 的承诺。

Frontend Completion 应优先实现 Agent 状态、提案解释、执行 Trace 与明确动作入口；是否保留自由对话输入受 `docs/01-v0.1-scope.md` 约束。

## 视觉方向

V4 视觉基线：

- `#F8FAFC` 浅灰工作区 + 白色 Surface；
- `#0F172A` 高对比主文字；
- Indigo 作为主操作与选中态；
- Violet 专用于 Agent 协同语义；
- Emerald / Amber / Rose 表达安全、警告与危险；
- 6px / 8px 精致圆角与轻量 Elevation；
- Sidebar / Workspace / Drawer 层级明确；
- 模型编辑入口不与 Records / API 的日常工作抢夺视觉优先级。

## Frontend Completion 边界

下一阶段是在保持当前 IA / 视觉方向的前提下补完整前端，不再做新一轮原型方向探索。

优先补齐：

```text
Collection
  Indexes
  Auth

Governance & Security
  Hooks & Events
  Access & Audit

Project
  Settings
  Activity
```

同时完善 Records / API / Changes 的 Loading、Empty、Error、Permission、Confirmation 与结果状态。

## Prototype Rules

- No SQLite；
- No real HTTP API；
- No production auth implementation；
- No Backend persistence；
- Mock state 可在刷新后恢复初始值；
- No production component abstraction；
- Prototype HTML/CSS/JS 不直接 merge 为生产 Admin 实现；
- 已验证的信息架构、交互规则与视觉原则通过 Product/Spec/Tickets 进入正式实现。
