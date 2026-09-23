# Modelry Admin Core UI — V4 Industrial Elegance 设计规范

> **Status:** Accepted IA / Interaction / Visual Reference  
> **版本:** V4 Industrial Elegance  
> **设计基调:** 优雅浅色工业级 Developer Console  
> **核心使命:** 让 Data Usage 与 API Usage 成为日常主工作面，同时保留 Backend Modeling、Change Management 与 Agent 协同的工业级安全感。

---

## 1. 设计原则

### 1.1 产品优先级

```text
Data Usage -> API Usage -> Backend Modeling -> Change Management -> Operations
```

视觉与交互必须体现这个顺序：

- Records 是 Collection 默认工作面；
- API 是 Collection 内高频使用能力；
- Schema / Relations / Indexes / Policy / Auth 属于二级建模与治理能力；
- Changes 对模型变化提供独立安全审查；
- Operations 信息不抢占日常数据工作空间。

### 1.2 现代工业美学

- Light：`#F8FAFC` 工作区、`#FFFFFF` Surface、`#0F172A` 主文字；
- Dark：`#0B0F19` 背景、`#111827` Surface；
- 主强调色：Indigo `#4F46E5 / #6366F1`；
- Agent 语义：Violet `#7C3AED / #A78BFA`；
- SAFE：Emerald；
- Warning：Amber；
- Destructive / Irreversible：Rose；
- 容器主要使用 8px 圆角，输入与按钮主要使用 6px；
- 使用轻量 Elevation，不回到粗重边框或高饱和装饰风格。

### 1.3 i18n 与主题

原型支持：

- 简体中文 `zh-CN`；
- English `en`；
- Light / Dark Theme。

语言切换应保持术语一致，不维护两套产品语义。

---

## 2. Accepted Admin IA

### 2.1 一级导航

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

设计规则：

- 不新增顶层 `Data`；
- 不设置独立顶层 `API`；
- Sidebar 面向大量 Collection 仍保持稳定，不把 Collection 实例直接铺满一级导航；
- 一级 IA 已确认，Frontend Completion 不重新探索新的菜单架构。

### 2.2 Collections Master-Detail

Collections Hub 负责：

- Collection 搜索与筛选；
- 类型与状态识别；
- Records / Fields / Relations 等轻量摘要；
- 快速进入具体 Collection。

进入 Collection 后，通过 Breadcrumb Switcher 在不同 Collection 间快速切换，无需返回 Hub。

### 2.3 Collection Workspace

Collection 二级 IA 固定为：

```text
Records       <- default
Schema
Relations
Indexes
Policy
Auth          <- Auth Collection only
API
```

其中当前 V4 Prototype 已表现 Records、Schema、Relations、Policy、API 的主要形式；`Indexes` 与 `Auth` 在 Frontend Completion 中补齐。

#### Records

Records 作为日常工作面，应优先承载：

- Query / Filter / Pagination；
- Record Inspect / Create / Update / Delete；
- Context Drawer；
- Pending ChangeSet / Risk / Drift 提示；
- 批量选择与高影响 Data Mutation Safety。

高影响批量操作固定采用：

```text
Target Selection
-> Impact Preview
-> Confirmation
-> Execute
-> Result Summary
-> Audit
```

不使用 ChangeSet。

#### API

API Explorer 收归当前 Collection 工作区，不在 Sidebar 设置独立一级入口。

API 工作面围绕当前 Collection 展示：

- Data API；
- OpenAPI Contract；
- Realtime；
- Auth API（Auth Collection 时）。

Project-wide OpenAPI / machine contract 可以存在，但不是独立 Admin API Hub 的理由。

#### Backend Modeling

`Schema / Relations / Indexes / Policy / Auth` 使用低于 Records / API 的视觉权重。

模型编辑产生受管 Backend Model Change 时必须进入 ChangeSet，不允许 UI 直接静默改变 Runtime Backend Model。

---

## 3. Changes — PR / Plan Mode

Changes 页面必须同时表达 Proposal 与 Execution 两层事实。

### 3.1 ChangeSet

ChangeSet 展示：

- Before / After Diff；
- Risk；
- Impact；
- Preconditions；
- proposer / intent；
- 当前状态。

产品状态：

```text
Ready / Applying / Applied / Cancelled
```

不设计 `Failed ChangeSet`。

### 3.2 Apply Attempt

一次真实 Apply 形成一次 Apply Attempt。

失败只属于 Apply Attempt；Retry 创建新的 Attempt，并保留 Principal、Confirmation Context、Preconditions、错误与执行结果。

### 3.3 风险 Gate

- SAFE：具备 `changeset:apply` 与所需 Scope 时可以直接 Apply；
- DATA_REWRITE / DESTRUCTIVE / IRREVERSIBLE：Human Confirmation；
- `expandsAccess=true`：Human Confirmation；
- Agent / Service Principal 不可自我确认高风险操作。

### 3.4 Review UI

V4 延续 GitHub PR / Terraform Plan 风格：

- Impact Overview；
- Pre-flight Checks；
- Unified Diff；
- Apply Gate；
- Apply Attempt History。

“Dry Run”是 Precondition / Impact 验证能力，不应被误解为所有 SAFE ChangeSet 都必须人工进行两阶段确认。

---

## 4. Access & Audit / Activity

### Access & Audit

聚焦：

- Admin Principal；
- Agent / Service Principal；
- Credential / API Key；
- Capability Scope；
- 与管理访问、权限变化和关键 Control Plane 操作直接相关的 Audit Fact。

### Activity

聚焦跨模块 Operations 时间线：

- Runtime 状态；
- Migration / Apply 结果；
- Hook Error；
- Delivery / Webhook 状态；
- Recent Activity。

Activity 可深链 Audit，但不复制 Access 管理模型。

---

## 5. Context Drawer

点击 Record 行后使用右侧 Drawer 保持数据上下文。

Drawer 适合：

- Record Inspect / Edit；
- JSON Raw；
- Relation / File 摘要；
- Validation 提示；
- Audit / Transaction metadata；
- 普通 Delete。

高影响批量操作可以复用 Drawer / Modal 视觉语言，但必须完整展示 Impact Preview 与 Confirmation。

---

## 6. Agent 协同

Agent UI 不只是状态 Badge，而应呈现：

```text
Intent
-> Analysis
-> Proposal
-> Human / Policy Gate
-> Apply / Result
-> Audit
```

优先表现：

- Agent 状态；
- ChangeSet 意图解释；
- Proposal / Diff / Risk 关联；
- 执行 Trace；
- 明确的受控动作入口。

Prototype 中的自由输入 Copilot 属于交互探索，不意味着 V0.1 必须内置依赖 AI Provider 的 Admin Chat。正式 Feature Scope 以 `docs/01-v0.1-scope.md` 为准。

Agent 的视觉语义使用 Violet，与普通主操作 Indigo 分离。

---

## 7. Prototype Fixture

当前 V4 使用电商 fixture：

```text
orders
customers
products
refund_requests
```

Fixture 只服务 UI 验证，不改变 V0.1 正式 Blog Reference Application：

```text
users
posts
comments
categories
```

---

## 8. Frontend Completion 原则

后续补页面时：

1. 保持当前一级 IA；
2. 保持 V4 视觉方向；
3. 补齐 `Indexes` 与 Auth Collection `Auth`；
4. 将 Hooks & Events、Access & Audit、Settings、Activity 从占位交互补成真实 Mock 页面；
5. 补齐 Loading / Empty / Error / Permission / Confirmation / Result 状态；
6. 优先让 Collections / Records / API / Changes 形成完整可点击前端闭环；
7. 不因为某个缺页重新引入 Project-wide API 一级页面或顶层 Data；
8. 不因为 Prototype 中存在探索性交互而扩大 V0.1 Feature Scope。

Prototype HTML/CSS/JS 仍然是 throwaway implementation。正式 Admin 代码应重新实现已确认的 IA、交互与设计 token。
