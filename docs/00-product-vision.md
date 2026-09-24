# Modelry 产品愿景

## 一句话定义

**Modelry 是一个产品化 Backend Platform，让开发者与 Coding Agent 通过统一产品创建、运行并安全演进应用后端。**

## 要解决的问题

应用后端通常需要组合：

- Database
- Schema / Migration
- API
- Auth
- Authorization
- Files
- Realtime
- Extension
- Secrets
- Observability
- Admin Tooling
- Deployment Convention

问题不只是缺少某项能力，而是这些能力经常形成多套配置、多套状态和割裂的运维体验。

Modelry 的目标，是把它们组织成一套一致的 Backend Product Semantics。

## V0.1 产品承诺

第一个版本不追求一次实现最终 Backend Platform 的全部能力。

它必须先让开发者顺畅完成：

~~~text
First Run
→ Create Backend Model
→ Manage Data
→ Secure
→ Use API
→ Observe
→ Evolve
~~~

这条主路径必须具备：

- 明确入口；
- 合理默认值；
- 最少无意义步骤；
- 原地 Durable Result；
- 可行动 Error；
- 安全变更；
- Reload / Restart 后仍可验证；
- Admin 与 API / MCP 结果一致。

## 产品原则

### 1. 产品化优先

架构服务产品，不为了内部模型漂亮而增加用户步骤。

### 2. 完整工作流优先于 Feature Checklist

一个 Endpoint 或页面存在，不代表能力完成。

完整能力至少包括：

~~~text
Configure
→ Execute
→ Result
→ Feedback
→ Error
→ Recover
→ Verify
~~~

### 3. Default Simple, Progressive Advanced

常用任务使用安全合理的默认值。

高级表达式、Risk Details、Migration Internals、Runtime Diagnostics 等只在用户需要时暴露。

### 4. Product Concept 优先

普通用户首先面对：

- Collection
- Field
- Relation
- Access Rule
- Pending Change
- API
- App User
- Service Account

而不是数据库和安全实现内部术语。

### 5. Explicit Change，不做不可解释的 Magic

Backend Model 的变化必须可理解、可审查、可恢复。

底层保持：

~~~text
Propose
→ ChangeSet
→ Structured Diff
→ Risk / Preconditions
→ Apply Attempt
→ Migration / History
~~~

但 UI 不要求用户先学习这些对象。

### 6. Human 与 Agent 操作同一 Backend Semantics

Admin、HTTP、CLI、MCP 不得形成互相绕开的业务规则。

### 7. AI Native, Not AI Dependent

Coding Agent 是一等客户端。

没有任何 AI Provider 时，Modelry 仍必须是完整可用的 Backend Platform。

### 8. Safe by Default

Auth、Access Rule、Secret、危险 Model Change 与 External Side Effect 默认采用安全边界。

安全默认不意味着强迫用户理解所有治理对象。

## 核心产品域

长期 Modelry 包括：

- Collections / Records
- Schema / Changes
- Application API / OpenAPI
- Application Auth
- Access Rules
- Files
- Realtime
- Extensions / Hooks
- Secrets
- Requests / Audit / Diagnostics
- CLI
- MCP

这些是长期产品域，不等于全部必须进入 V0.1。

## Modelry 不是什么

Modelry 不是：

- Visual SQL Client
- 通用数据库管理器
- Workflow / DAG Platform
- Kubernetes Management Product
- PocketBase Compatibility Layer
- 没有 AI 就不能运行的 AI Tool

## 北极星体验

Human：

~~~text
start
→ model
→ data
→ secure
→ API
→ observe
→ evolve
~~~

Optional expansion：

~~~text
extend
→ realtime
→ hooks
→ advanced operations
~~~

Coding Agent：

~~~text
inspect
→ understand
→ propose
→ diff
→ apply
→ verify
→ audit
~~~

两者操作同一 Backend Model 与 Runtime。
