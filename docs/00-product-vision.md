# Modelry 产品愿景

## 一句话定义

**Modelry 是一个产品化 Backend Platform，让开发者通过统一的可视化和可编程体验，创建、运行并安全演进应用后端。**

## 要解决的问题

一个完整应用后端通常需要同时组合：

- Database
- Schema / Migration
- API
- Auth
- Authorization
- Files
- Realtime
- Hooks / Events
- Secrets
- Observability
- Admin Tooling
- Deployment Convention

单独看，每个工具可能都很好用；但开发者仍需要自己设计它们之间的边界、状态和运维方式。

Modelry 的目标，是把这些能力收敛为一个完整产品。

## 产品承诺

新用户不需要先成为数据库或基础设施专家，就应该能够完成：

~~~text
启动 Modelry
→ 进入 Admin
→ 创建 Collection
→ 定义 Fields / Relations / Indexes
→ Review 并 Apply Changes
→ 创建真实 Records
→ 使用自动生成的 API
→ 配置 Auth / Policy
→ 使用 Files / Realtime / Hooks
→ 查看 Requests / Audit / Activity
→ 安全演进 Backend
~~~

当这一整条路径做到易用、好用、好看、功能完善且状态可恢复时，Modelry 才算真正成立。

## 产品原则

### 1. 产品化优先

技术架构服务于产品。

不能因为某种语言、数据库、部署方式或内部实现更“纯粹”，而牺牲用户体验和完整闭环。

### 2. 完整工作流优先于 Feature Checklist

一个 API Endpoint 存在，不代表功能完成。

完整能力至少包括：

~~~text
配置
→ 执行
→ 结果
→ 反馈
→ 错误
→ 恢复
→ 可观测
~~~

### 3. 默认简单，高级能力渐进暴露

常见任务应该拥有合理默认值。

数据库细节、高级 Policy、Runtime 参数、危险变更等高级能力，仅在真正需要时展示。

### 4. Modelry Concept 优先于 Database Concept

用户首先面对：

- Collection
- Field
- Relation
- Policy
- Change
- API

而不是数据库内部术语。

数据库是实现层，除非用户主动进入 Advanced Surface。

### 5. Explicit Change，不做不可解释的 Magic

Backend Model 的变化必须可 Inspect、可 Review、可解释。

核心链路：

~~~text
Inspect
→ Propose
→ ChangeSet
→ Structured Diff + Risk
→ Apply Attempt
→ Migration / History
→ Audit
~~~

### 6. Human 与 Agent 操作同一 Backend Semantics

Admin、HTTP API、CLI、MCP 不得形成多套相互绕开的业务规则。

Coding Agent 不是隐形 DBA。

### 7. AI Native, Not AI Dependent

Coding Agent 是一等客户端。

但即使完全没有 AI Provider，Modelry 仍然必须是完整可用的 Backend Platform。

### 8. Safe by Default

Auth、Policy、Secret、危险 Schema Change 与 External Side Effect 默认采用安全边界。

失败必须可诊断、可恢复。

## 核心产品域

- Collections / Records
- Schema：Fields / Relations / Indexes / Validation / Defaults
- Changes / Migration History
- Application API / OpenAPI
- Application Auth
- Record Policy
- Files
- Realtime
- Hooks / Events
- Secrets
- API Request Observability
- Audit / Activity
- CLI
- MCP

## Modelry 不是什么

Modelry 不是：

- Visual SQL Client
- 通用数据库管理器
- Workflow / DAG Platform
- Kubernetes Management Product
- 给 Headless CMS 补 Backend 能力
- PocketBase Compatibility Layer
- 没有 AI 就不能运行的 AI Tool

## 北极星体验

Human：

~~~text
start
→ model
→ data
→ API
→ secure
→ extend
→ observe
→ evolve
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

两者最终操作同一个 Backend Model 与 Runtime。
