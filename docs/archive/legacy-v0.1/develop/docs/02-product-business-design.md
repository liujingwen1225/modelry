# Modelry 产品业务设计

## 状态

**Accepted — V0.1 Business Baseline**

本文档描述 Modelry **作为一个产品如何被使用**：谁在使用、围绕哪些业务对象工作、核心工作流如何形成闭环，以及哪些业务规则不能被 UI、CLI、MCP 或 API 的具体实现绕开。

本文档不定义数据库表、HTTP 路径、类结构、框架、组件、Migration 文件格式或具体接口参数。这些内容属于 Specification、ADR 或实现。

统一领域术语以仓库根目录 `CONTEXT.md` 为准；Admin 信息架构以本文件与 `docs/specs/0003-v0.1.0-admin-ia-prototype-alignment-amendment.md` 为当前基线。

---

## 1. 产品业务目标

Modelry 的核心任务不是“提供一个可视化数据库编辑器”，而是让 Developer 与 Coding Agent 能够共同完成一个应用后端从建模、数据运行、API 使用、变更到诊断的完整生命周期。

对 Developer 而言，核心价值链是：

`建立 Backend -> 获得并管理真实 Data -> 通过 API 服务 Application -> 安全演进 Backend -> 诊断运行问题`

对 Coding Agent 而言，核心价值链是：

`Inspect -> 理解 Backend -> Propose -> Diff + Risk -> Apply -> Audit`

两条路径操作同一个 Backend Model，并最终服务同一份 Runtime Data 与 Application API。

### 1.1 产品体验主次

V0.1 的产品体验优先级固定为：

1. **Data Usage** —— 用户真实业务数据是否可查看、创建、修改、查询和验证；
2. **API Usage** —— Application 与 Agent 如何清晰、稳定地使用 Backend 能力；
3. **Backend Modeling** —— Collection、Field、Relation、Index、Policy、Auth 等如何定义 Data 与 API；
4. **Change Management** —— Backend Model 如何被安全修改、审查、Apply 和追踪；
5. **Operations** —— Runtime、Hook、Event、Drift、Audit 等如何被诊断和管理。

这里的 Data Usage / API Usage 是**体验优先级**，不代表必须各自成为一级导航或新的顶层领域对象。

`Collection` 继续是 Modelry 的核心数据模型单元，也是 Admin 的一级业务入口。单个 Collection 同时承载 Records、API Usage 与 Backend Model 定义，因此 V0.1 不新增一个与 Collections 并列或替代 Collections 的顶层 `Data`，也不要求独立顶层 `API` 页面。

Field Editor / Schema Editor 是重要能力，但不是 Modelry 的最终产品中心。它服务于真实 Data 与 API 正确工作，而不是反过来。

---

## 2. 核心参与者

### 2.1 Developer

使用 Modelry 构建、调试和演进应用后端的人类开发者。

Developer 主要关注：

- 当前应用拥有哪些 Collection 与真实 Records；
- 当前 Collection 的 Application API 应如何使用；
- Backend Model 如何安全演进；
- 当前 Runtime 是否健康；
- Coding Agent 提出的变化是否可以接受。

### 2.2 Coding Agent

通过机器接口 Inspect 和操作 Modelry Backend 的开发协作者。

Coding Agent 不是默认数据库管理员，也不拥有隐藏的直接修改通道。它与 Developer 共享 Backend Model、ChangeSet、Risk、Apply 与 Audit 语义。

### 2.3 Administrator

拥有 Control Plane 管理能力的 Principal。

Administrator 负责 Backend Model、ChangeSet、Runtime、Credential、Secret、Audit 以及必要的 Administrative Data Access。

Administrator 与业务 Auth Collection 中的 Application User 明确分离。

### 2.4 Application

使用 Modelry Data Plane 的业务应用，包括 Web、Mobile、Desktop、Server 或其他 Client。

Application 依赖 Collection、Auth、API Contract、File 与 Realtime 等能力完成实际业务。

### 2.5 Application User

使用 Application 的最终业务用户。

Application User 在 Modelry 中通过 Auth Collection Record 与 Auth Principal 表达，不进入 Control Plane Access 模型。

---

## 3. 核心业务对象关系

### 3.1 Project 与 Instance

一个 Project 表示一个完整应用后端产品单元。

当前产品模型中：

`One Instance -> One Project`

Developer 与 Agent 围绕同一个 Project 工作，不需要先理解 Workspace、Organization 或 Multi-project Hosting 等额外管理层。

### 3.2 Collection 是 Data、API 与 Model 的共同入口

Collection 是 Modelry 面向 Developer 与 Agent 的核心数据模型单元。

一个 Collection 同时包含三个紧密关联的产品视角：

- **Data View** —— 当前 Collection 中实际存在的 Records 与 Files；
- **API View** —— 当前 Collection 对 Application 暴露的数据、认证和实时接口使用方式；
- **Model View** —— Field、Relation、Index、Validation、Policy、Auth Capability 等。

因此产品上不把 Schema、Data、API 设计成互相独立的三个顶层世界。

标准关系是：

```text
Collection
├─ Records / Files
├─ API Usage
└─ Model Definition
```

Backend Model 定义 Data 与 API 的结构和规则，真实 Data 则反过来影响 Migration Risk、Precondition 与开发诊断。

Project 仍可以生成统一 OpenAPI / machine-readable contract；这属于接口契约能力，不等于 Admin 必须拥有 Project-wide API 一级页面。

### 3.3 Auth Collection 与业务身份

Auth Collection 是带认证能力的 Collection，而不是独立于 Collection 系统之外的一套 User 模块。

标准关系：

`Auth Collection Record -> Authenticate -> Auth Principal -> Record Policy -> Application Data Access`

一个 Project 可以拥有多个 Auth Collection，从而支持多个业务身份域。

### 3.4 ChangeSet 与 Backend Model Change

任何受管 Backend Model Change 都不能通过某个入口直接形成不可追踪状态。

标准链路：

`Inspect -> Propose -> ChangeSet -> Diff + Risk -> Apply Attempt -> Migration -> Audit`

Admin、CLI、MCP 与 Coding Agent 共享这套语义。

### 3.5 Data Plane 与 Control Plane

Application Data Access：

`Auth Principal -> Record Policy -> Records`

Administrative Data Access：

`Admin / Agent Principal -> Capability Scope -> Records -> Audit`

两条路径目的不同，不模拟、不混用。

### 3.6 ChangeSet 与 Apply Attempt

ChangeSet 表达“准备把 Backend 变成什么样”，Apply Attempt 表达“某一次实际执行这个提案的尝试”。

因此：

- ChangeSet 可以经历多个 Apply Attempt；
- 某次 Apply Attempt 失败，不等于 ChangeSet 本身成为永久失败对象；
- Retry 创建新的 Apply Attempt，而不是复制一个语义相同的 ChangeSet；
- 只有 Apply Attempt 成功后，ChangeSet 才进入 Applied，并形成正式 Durable Change / Migration 事实。

---

## 4. 核心业务 Journey

### 4.1 Journey A：第一次建立可用 Backend

目标：从零获得一个 Application 可以直接使用的 Backend。

```text
获得 Modelry
-> 初始化 Project
-> 启动 Instance
-> 创建第一个 Admin
-> 打开 Admin
-> 创建 Collection / Auth Collection
-> 定义必要 Model 与 Policy
-> 创建或验证真实 Records
-> 在 Collection 中查看 API Contract
-> Application 开始调用
```

这条 Journey 成功的关键不是“Schema 保存成功”，而是 Developer 最终能够通过真实 Data 与 API 验证 Backend 已经可用。

### 4.2 Journey B：围绕 Collection 管理真实数据与 API

目标：Developer 能够理解“这个 Collection 现在真实是什么样、Application 如何使用它”。

```text
Collections
-> 选择 Collection
-> Records（默认视图）
-> Query / Filter / Inspect
-> Create / Update / Delete
-> 查看 Relation / File
-> API（需要验证调用时）
-> Audit（需要追溯时）
```

单个 Collection 的默认工作入口是 **Records**，而不是 Fields。

Developer 需要使用或调试接口时，从同一个 Collection 进入：

```text
API
```

Developer 需要修改模型时，从同一个 Collection 进入：

```text
Schema / Relations / Indexes / Policy / Auth
```

如果当前存在会影响该 Collection 的未应用 ChangeSet、Migration Risk 或 Drift，Records 工作面必须能够让用户感知到影响，而不能让“当前真实数据”和“准备发生的模型变化”成为两个完全隔离的世界。

### 4.3 Journey C：Application 使用 Data API

```text
Application
-> Authenticate（需要时）
-> Data API Request
-> Policy Evaluation
-> Validation
-> Lifecycle Hook
-> Mutation / Query
-> Response
```

发生成功 Mutation 时，可继续形成：

```text
Commit
-> Domain Event
-> Realtime / Event Hook / Webhook / Audit
```

Application 不需要理解 Control Plane ChangeSet 即可进行正常业务数据访问。

### 4.4 Journey D：Developer 修改 Backend Model

```text
Inspect Current Model
-> Propose Change
-> ChangeSet
-> Diff
-> Risk + Preconditions
-> Confirmation（需要时）
-> Apply Attempt
-> Apply Success
-> Migration
-> Runtime Backend Model 更新
-> Schema Snapshot 更新
-> Audit
```

Developer 不应通过 UI 直接绕过 ChangeSet 修改受管 Backend Model。

### 4.5 Journey E：Coding Agent 修改 Backend

```text
Connect
-> Inspect Project / Schema / Runtime
-> 理解当前 Backend
-> Propose
-> ChangeSet
-> Diff + Risk
-> Apply Attempt（在权限与风险规则允许时）
-> Migration
-> Git-friendly Artifact
-> Audit
```

Agent 的产品价值来自“安全理解和演进 Backend”，而不是拥有通用 SQL / Shell 超级入口。

### 4.6 Journey F：Developer / Agent 接管已有 Project

```text
Inspect Project
-> Inspect Collections
-> Inspect Collection API Contract
-> Inspect Current Changes / Migration
-> Inspect Runtime Status / Drift
-> 建立 Backend Context
-> 开始后续开发
```

该 Journey 是 Modelry AI Coding 产品定位中的关键场景：新进入项目的 Agent 应能依赖机器可读 Backend Model 与统一接口契约快速建立上下文。

### 4.7 Journey G：诊断 Backend 问题

```text
Overview / Doctor 发现异常
-> 定位 Runtime / Migration / Drift / Hook / Delivery 问题
-> Inspect 相关事实
-> 修复配置、代码或 Backend Model
-> 必要时形成 ChangeSet
-> 验证恢复
-> Audit / Activity
```

诊断体验必须让 Developer 和 Agent 都能回答“现在出了什么问题、影响什么、下一步怎么办”。

### 4.8 Journey H：高影响 Administrative Data Mutation

普通单条 Record 管理不经过 ChangeSet。

当 Administrative Data Access 涉及批量更新、批量删除或其他明显扩大影响面的操作时，标准 Journey 是：

```text
选择目标 Records
-> 影响预览
-> 明确显示预计影响范围
-> Human Confirmation
-> Execute
-> Result Summary
-> Audit
```

该流程属于 Data Mutation Safety，而不是 Backend Model Change，因此不使用 ChangeSet。

---

## 5. 核心业务规则

### 5.1 Backend Model 是共同语义层

所有 Human / Agent 管理入口必须操作同一套 Backend Model，不维护仅 UI 可见或仅 MCP 可见的隐藏结构。

### 5.2 Collection 是一级业务对象

Collection 同时承载真实 Records、API Usage 与模型定义。

产品信息架构不得为了突出 Data 或 API，而制造与 Collection 日常任务重叠的顶层 Data / API 世界。

### 5.3 Records 是 Collection 的默认日常工作面

Developer 打开单个 Collection 时，默认优先进入 Records。

Collection 二级能力固定为：

```text
Records       <- default
Schema
Relations
Indexes
Policy
Auth          <- Auth Collection only
API
```

`API` 属于 Collection 的使用能力，不是 Backend Modeling，但与 Records 一样保持当前 Collection context。

Schema、Relation、Index、Policy、Auth 等属于 Collection 的建模与治理能力，通过二级入口提供。

### 5.4 当前 Data 必须能够感知即将发生的 Model Change

如果某个待处理 ChangeSet 或 Migration 会影响当前 Collection，用户在查看 Records 时必须能够看到相应影响提示，例如存在 Schema Change、Data Rewrite、Destructive Risk 或 Drift。

业务层只要求“可感知”，具体 UI 呈现由产品设计决定。

### 5.5 Application Data Access 必须经过 Record Policy

业务 Application 访问 Records 时，授权不能因为调用者来自 Agent 或特殊 Client 而自动绕过 Policy。

### 5.6 Administrative Data Access 是显式管理行为

Administrator 或 Agent 为开发、诊断、迁移或运营目的管理 Records 时，应通过 Administrative Data Access，并记录真实操作 Principal。

普通 Record CRUD 不进入 ChangeSet。

### 5.7 高影响 Administrative Data Mutation 必须确认

批量删除、批量更新或其他明显扩大数据影响面的管理操作，必须提供影响预览、显式 Human Confirmation 和完整 Audit。

这种确认不把 Data Mutation 伪装成 Backend Model Change，也不额外制造 ChangeSet。

### 5.8 Backend Model Change 必须可追踪

受管 Backend Model Change 统一通过 ChangeSet，不允许形成“Schema 已变但没有对应 ChangeSet / Migration / Audit”的正常产品路径。

### 5.9 Propose 与 Apply 分离

能够提出 Change 不等于能够 Apply Change。

Agent 尤其不能因为具有 Inspect / Propose 能力而隐式获得 Apply 权限。

### 5.10 Agent Apply 的默认风险边界

V0.1 默认规则固定为：

- Agent 必须显式拥有 `changeset:apply` 能力，才可能执行任何 Apply；
- **SAFE** ChangeSet：拥有 Apply 能力的 Agent 可以无需 Human Confirmation 直接发起 Apply Attempt；
- **DATA_REWRITE / DESTRUCTIVE / IRREVERSIBLE**：即使 Agent 拥有 Apply 能力，也必须经过 Human Confirmation；
- `expandsAccess=true`：即使数据风险为 SAFE，也必须 Human Confirmation；
- Human Confirmation 不能被“Agent 本身已经具有高权限”替代。

该规则保证 Agent 自动化能力主要覆盖低风险演进，高风险数据影响仍由人类承担最终决策责任。

### 5.11 Risk 决定确认与恢复要求

Change Risk 不是 UI 标签，而是会影响 Preconditions、Confirmation、Checkpoint 与 Apply 规则的业务事实。

### 5.12 ChangeSet 与 Apply Attempt 分离

ChangeSet 是变更提案，Apply Attempt 是执行事实。

一次执行失败只形成 Failed Apply Attempt；只要 ChangeSet 未被 Cancelled 或成功 Applied，就可以在问题解决后重新尝试。

### 5.13 External side effects happen after commit

不可回滚外部副作用不能被当作事务内业务正确性的组成部分。

### 5.14 Reliable delivery intent must survive commit

需要可靠执行的异步行为，其耐久处理意图必须与业务状态变化原子一致。

### 5.15 Audit 必须回答真实操作责任

对关键管理行为至少应能回答：

“谁，以什么权限，在什么时间，对哪个对象，执行了什么，结果如何。”

---

## 6. 业务生命周期基线

### 6.1 ChangeSet

ChangeSet 表达 Proposal 的生命周期：

```text
Draft
-> Ready
-> Applying
-> Applied
```

取消分支：

```text
Draft / Ready
-> Cancelled
```

`Applying` 是执行中的暂态。

如果某次 Apply Attempt 失败：

```text
Applying
-> Ready
```

并保留失败的 Apply Attempt 事实与错误原因。ChangeSet 本身不进入永久 `Failed` 终态。

“需要确认”是 Apply Gate，不是 ChangeSet 的独立长期状态。

### 6.2 Apply Attempt

每次正式尝试 Apply 一个 ChangeSet，都形成独立 Apply Attempt：

```text
Pending
-> Running
-> Succeeded
```

失败分支：

```text
Running
-> Failed
```

Retry 必须创建新的 Apply Attempt，从而保留每次执行的 Principal、时间、Precondition、确认、结果与错误历史。

成功的 Apply Attempt 推动 ChangeSet 进入 Applied。

### 6.3 Migration

```text
Pending
-> Running
-> Applied
```

失败分支：

```text
Running
-> Failed
```

已经成功 Applied 的 Project Migration 不允许原地修改。

### 6.4 Session

```text
Active
-> Expired
```

或：

```text
Active
-> Revoked
```

### 6.5 Reliable Delivery

```text
Pending
-> Delivering
-> Delivered
```

失败可进入：

```text
Delivering
-> Retry
-> Delivering
```

达到最大尝试后：

```text
-> Failed
```

---

## 7. Admin 产品任务与信息架构

V0.1 一级入口固定为 7 个，并继续采用 `Collections`，不改为 `Data`，不设置独立一级 `API`。

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

### 7.1 Overview

回答：

> 我的 Backend 现在是否健康，有什么需要关注？

聚焦 Runtime Status、Database/Storage 状态、Migration/Drift、Recent Activity 与明显错误。

### 7.2 Collections

回答：

> 我的应用当前管理哪些数据和业务身份，这些数据现在实际是什么样，Application 如何使用它们？

Collection 列表用于选择业务对象。

单个 Collection 内任务层级：

```text
Records       <- 默认、首要
Schema
Relations
Indexes
Policy
Auth          <- Auth Collection 时显示
API
```

Records 还应能够感知会影响当前 Collection 的待处理 Change、Risk 与 Drift。

API 工作面保持 Collection context，聚焦当前 Collection 的 Data API、OpenAPI Contract、Realtime，以及 Auth Collection 的 Auth API。

这里不是削弱 Schema，而是明确：Schema 是为了让 Data 与 API 正确工作。

### 7.3 Changes

回答：

> Backend 准备发生什么变化、风险是什么、每次 Apply 实际发生了什么？

聚焦 ChangeSet、Diff、Risk、Human Confirmation Gate、Apply Attempt、Migration 与 Apply History。

失败展示为 Failed Apply Attempt，不展示 terminal Failed ChangeSet。

### 7.4 Hooks & Events

回答：

> 数据发生变化之后还会发生什么？

聚焦 Lifecycle Hook、Event Hook、Cron、Webhook 与 Delivery。

### 7.5 Access & Audit

回答：

> 谁能够管理这个 Backend、它能做什么，以及关键管理访问是否可追溯？

聚焦：

- Admin Principal；
- Agent / Service Principal；
- Credential / API Key；
- Capability Scope；
- 与管理访问、权限变化、关键 Control Plane 操作直接相关的 Audit Fact。

业务 Auth Collection User 不进入此页面。

### 7.6 Project Settings

回答：

> 这个 Project 依赖哪些运行配置与外部 Provider？

聚焦 Secret、Storage、OAuth、Email 与 Runtime Config。

### 7.7 Activity

回答：

> Project 最近发生过什么，运行或异步执行失败在哪里？

聚焦跨模块 Operations 时间线，例如 Runtime 状态、Migration / Apply 结果、Hook Error、Delivery / Webhook 状态等。

Activity 可以深链到对应 Audit Fact，但不复制 Access 管理模型。

---

## 8. Reference Application

V0.1 使用一个真实小型应用验证 Modelry 完整业务闭环。

Reference Application 固定为 **Blog**。

至少包含：

```text
users       (Auth Collection)
posts
comments
categories
```

并在 `posts` 或等价业务对象中覆盖 File Field。

Reference Application 应验证：

- Auth Collection；
- Record CRUD；
- Relation；
- File；
- Policy；
- Realtime；
- Lifecycle Hook；
- Collection API / OpenAPI Usage；
- Agent Inspect；
- Agent / Human Backend Model Change；
- ChangeSet / Diff / Risk；
- Apply Attempt；
- Migration；
- Drift / Doctor；
- Audit。

Admin Prototype 可以使用不同业务 Fixture 验证 UI 密度和交互，不因此改变正式 E2E Reference Application。

成功标准不是“每个功能页面都存在”，而是 Developer + Coding Agent 能利用 Modelry 完成一个真实应用后端的建立、使用、变更与诊断闭环。

---

## 9. V0.1 业务基线结论

V0.1 产品业务层正式固定以下原则：

1. `Collection` 是 Data、API Usage 与 Model 的共同一级业务对象，Admin 保持 `Collections` 一级入口；
2. 单个 Collection 默认从 `Records` 开始；`API` 与 Schema / Relations / Indexes / Policy / Auth 一样通过 Collection 二级入口进入，其中 Records / API 是高频使用面；
3. Admin 不设置独立顶层 `Data` 或 `API`；Project-wide OpenAPI / machine contract 仍可存在，但不推导出 Project-wide API Admin 页面；
4. Backend Model Change 统一进入 ChangeSet；普通 Record CRUD 不进入 ChangeSet；
5. 高影响 Administrative Data Mutation 使用 Impact Preview + Human Confirmation + Execute + Result Summary + Audit；
6. Agent 只有在显式拥有 Apply 能力时才能执行 Apply，且只有 SAFE、无需 access-impact confirmation 的 ChangeSet 允许无需 Human Confirmation 自动执行；
7. DATA_REWRITE、DESTRUCTIVE、IRREVERSIBLE 以及 `expandsAccess=true` 默认必须 Human Confirmation；
8. ChangeSet 与 Apply Attempt 分离，一次执行失败不把 ChangeSet 变成永久 Failed；
9. `Access & Audit` 聚焦管理身份、能力与关键管理审计，`Activity` 聚焦跨模块 Operations 时间线；
10. Records、API、Changes 不能成为相互割裂的信息岛，用户需要在真实数据、接口使用和模型变化之间保持上下文；
11. Blog 作为 V0.1 Reference Application，负责验证完整业务闭环。

后续 Specification 可以继续细化数量限制、确认交互、错误码、Apply Attempt 字段、Collection API Explorer 结构等实现级行为，但不得改变以上业务语义；需要改变时应先修改本业务基线或新增明确的产品决策记录。
