# Modelry 领域上下文

本文档是 Modelry 的统一领域上下文，只记录已经确认的领域术语、概念关系与长期产品不变量。

**本文档不记录框架、数据库、目录路径、文件格式、HTTP 路径、CLI 命令或其他实现细节。** 这些内容属于 Product Scope、ADR 或后续 Specification。

## 产品定义

**Modelry 是一个为 AI Coding 重新设计的自托管应用后端。**

Modelry 不是某个现有 Backend 的兼容克隆，也不是在传统 Backend 上增加一个 AI Chat。它重新设计 Backend Model、变更机制、机器接口和运行边界，使人类开发者与 Coding Agent 都能理解、修改和审计应用后端。

## 产品不变量

1. **Human and Agent share one Backend semantics** —— 人类开发者与 Coding Agent 操作同一套 Backend Model，不维护两套隐藏语义。
2. **AI Native, Not AI Dependent** —— 核心 Backend 不依赖 AI Provider 才能工作。
3. **Explicit over Magic** —— Schema、Policy、Migration、Hook 和 Agent 变更必须可检查、可解释、可审计。
4. **One Instance, One Project** —— 当前产品模型中，一个运行中的 Instance 对应一个 Project。
5. **Data Plane 与 Control Plane 分离** —— 应用数据访问与 Backend 管理变更使用不同权限域。
6. **Principal 与 Credential 分离** —— 身份主体与证明身份的凭证是不同概念。
7. **Auth 是 Collection Capability** —— 业务认证能力声明在 Auth Collection 上，而不是退化为一个固定 User 表。
8. **File is a Field** —— File 属于 Record 数据模型的一部分，不在首版引入独立复杂 Asset 权限体系。
9. **Trusted does not mean failure-free** —— Project Hook 是可信代码，但仍需要明确故障边界。
10. **External side effects happen after commit** —— 不可回滚的外部副作用不能成为事务内业务正确性的组成部分。
11. **Reliable delivery intent is durable with the mutation** —— 需要可靠执行的异步副作用，其耐久处理意图必须与触发它的业务状态变化保持原子一致。
12. **Domain Event is the shared event fact** —— Realtime、Event Hook、Webhook 与 Audit 不各自重新解释业务状态产生互相冲突的事件语义。
13. **Backend Model changes are reproducible** —— Backend 结构变化必须形成可复现、可审计的 Migration History，不能只存在于某个运行状态中。
14. **Project Migration 与 System Migration 分离** —— 用户 Backend Model 演化与 Runtime 内部升级具有不同生命周期。
15. **Administrative Data Access 与 Application Data Access 分离** —— 管理员/Agent 的管理型数据检查不能伪装成业务用户访问。
16. **ChangeSet 与 Apply Attempt 分离** —— ChangeSet 表达变更提案，Apply Attempt 表达一次执行尝试；单次执行失败不能抹掉或重定义原始提案。

## 核心用户

### 第一核心用户

- AI Coding 开发者
- 独立开发者

### 自然覆盖用户

- 需要轻量自托管 Backend 的应用开发者

### 后续用户

- 需要协作、治理、企业身份或高可用能力的团队

# 统一领域语言

## Project

一个完整的应用后端产品单元，包含其 Backend Model、Project Migration History、项目扩展逻辑与运行数据。

## Instance

一个正在运行的 Modelry Runtime。当前产品模型中，一个 Instance 只服务一个 Project。

## Project Source

能够被版本管理、审查和复现的 Project 定义集合。

Project Source 与 Runtime Data 是不同生命周期：前者描述项目结构和项目代码，后者承载运行产生的数据与敏感状态。

## Runtime Data

Instance 运行过程中产生并维护的数据状态，包括业务 Record、运行元数据、凭证状态、文件内容、审计与交付状态等。

Runtime Data 不等同于 Project Source。

## Backend Model

Modelry 面向人类和 Agent 的声明式后端语义模型。

Backend Model 描述 Collection、Field、Relation、Index、Policy、Auth Capability 等产品语义，而不等同于某个物理数据库 Schema。

Backend Model 是所有管理入口共同操作的产品语义层。

## Runtime Config

Project 的运行级配置概念，用于描述 Provider、运行策略等非 Backend Model 内容。

Runtime Config 与 Secret 分离；敏感值不能因为属于配置就退化为普通明文配置。

## Collection

用户和 Agent 面向的核心数据模型单元。Collection 不等同于物理数据库表。

当前包含两类 Collection：

- **Normal Collection** —— 普通应用记录；
- **Auth Collection** —— 在普通数据模型之上具备认证能力的 Collection。

## Auth Collection

具备业务认证能力的 Collection。

一个 Project 可以存在多个 Auth Collection，对应不同业务身份域。

Auth Collection 可以声明允许的 Login Identifier、Credential 类型、身份验证要求和其他 Auth Capability。

## Record

Collection 中的一条业务数据实例。

## Field

Collection 的声明式属性。

Relation 和 File 都属于 Field Type，而不是默认演变成独立的顶层业务模型。

## Relation

一个 Record 对另一个 Collection Record 的声明式引用关系。

Relation 可以具有不同基数，但物理存储方式不属于领域定义。

## File Field

在 Record 上声明文件数据能力的 Field。

File Field 可以约束数量、大小和内容类型，并默认继承所属 Record 的读取授权语义。

## Upload Session

文件从“已上传但尚未绑定业务 Record”到“已成为 Record 正式数据”的临时生命周期。

未完成绑定的文件属于临时状态，可以按照明确保留策略清理。

## Index

Backend Model 中声明的数据查询或唯一性约束能力。

Index 是否能安全创建不仅取决于声明，还取决于当前数据是否满足前置条件。

## Validation

Backend Model 对 Record 或 Field 输入施加的声明式有效性约束。

Validation 与 Authorization 不应混为一体。

## Default

创建 Record 时，在调用者未显式提供值的情况下可以应用的声明式初始值语义。

## Policy

Data Plane 中面向业务 Record 的声明式授权规则。

Policy 是 Application Data Access 的主要授权原语，不与 Control Plane Capability Scope 混用。

## Policy Operation

Record Policy 所约束的具体数据操作。

当前至少区分：

- list
- view
- create
- update
- delete

不同操作可以具有不同 Policy。

## Policy Evaluation Context

Policy 在求值时能够明确访问的领域上下文。

至少包括当前认证 Principal、相关 Record，以及创建/更新场景下需要区分的变更前状态与候选变更后状态。

Policy 不允许依赖未声明的隐式 Runtime 状态。

## Relation Authorization

读取父 Record 并不自动赋予读取关联 Record 的权限。

Relation Expand 或等价关联读取必须再次服从目标 Collection 的读取 Policy。

## Expression Engine

Filter、Policy 与 Realtime Subscription Filter 共享的声明式条件语义。

Expression Engine 的目标是让同一个业务条件拥有一致的解析、类型和错误语义，而不是在不同功能中维护互不兼容的条件语言。

## Filter

调用者对已获授权数据集合进一步声明的查询条件。

Filter 不能扩大 Policy 允许的数据范围。

## Backend Model Change

对 Backend Model 的结构或声明式行为进行的变更。

Backend Model Change 不允许通过某个入口直接形成不可追踪的运行状态。

## ChangeSet

对 Backend Model 或受管运行配置的一组显式变更提案，是人类与 Agent 共用的变更载体。

ChangeSet 至少表达：

- 来源 Principal；
- 拟议变更；
- Before/After Diff；
- 风险；
- 可逆性；
- 变更原因；
- 最终结果。

标准领域链路：

`Inspect -> Propose -> ChangeSet -> Diff + Risk -> Confirm/Auto Apply -> Durable Change -> Audit`

ChangeSet 表达的是 Proposal 本身，不等同于某一次实际执行。一个尚未 Applied 或 Cancelled 的 ChangeSet 可以在执行问题被修复后重新尝试 Apply。

## Diff

ChangeSet 所表达的变更前状态与候选变更后状态之间的结构化差异。

Diff 必须适合人类审查，也必须可被 Agent 机器读取。

## Risk Classification

对 ChangeSet / Migration 数据影响与恢复难度的明确分类。

当前至少区分：

- **SAFE** —— 不预期破坏已有数据；
- **DATA_REWRITE** —— 需要转换或重写已有数据；
- **DESTRUCTIVE** —— 可能删除或不可访问已有数据；
- **IRREVERSIBLE** —— 无法依赖自动反向操作恢复原状态。

Risk 不是展示标签，而会影响 Preconditions、确认和恢复要求。

## Migration

Backend Model Change 被正式 Apply 后形成的持久化、可复现演化记录。

Migration History 描述 Project 如何从较早 Backend Model 演化到当前 Backend Model。

## Project Migration

描述用户 Project Backend Model 演化的 Migration。

Project Migration 已经成功 Apply 后不可原地重写；修正通过新的 Migration 表达。

## System Migration

描述 Modelry Runtime 自身内部状态结构升级的 Migration。

System Migration 与 Project Migration 完全分离，不进入用户 Project 的 Backend Model 演化历史。

## Migration History

Project Migration 按确定顺序形成的 Durable Historical Source。

它负责描述 Backend Model 如何演化到当前状态。

## Runtime Backend Model

当前 Instance 已成功 Apply 后实际生效的 Backend Model，是运行时的 Materialized Truth。

Runtime Backend Model 应当能够与 Migration History 对账。

## Schema Snapshot

当前 Backend Model 的机器可读 Generated Projection。

Snapshot 用于快速 Inspect 当前模型，不是人工维护的独立 Source of Truth；它可以由受信的 Backend Model 状态重新生成。

## Migration Ledger

Runtime 对已经成功 Apply 的 Project Migration 进行记录的对账事实。

Migration Ledger 用于判断 Runtime Backend Model 当前对应 Migration History 的哪个位置，并协助检测 Drift。

## Drift

Project Migration History、Runtime Backend Model、Migration Ledger 与 Schema Snapshot 之间出现不一致的状态。

Drift 必须被显式发现和报告，不能静默继续当作正常状态。

## Migration Precondition

Migration Apply 前必须满足的当前模型或数据条件。

Precondition 的目的，是在任何结构变化发生之前发现不安全或不适用的 Migration。

## Migration Checkpoint

执行高风险 Migration 前用于支持恢复的安全状态点。

Checkpoint 不等同于自动 down migration；Modelry 不承诺所有结构变化都可以无损自动逆转。

## Principal

能够代表某个身份访问或操作 Modelry 的主体。

当前统一三类 Principal：

- **Admin Principal** —— Modelry Control Plane 管理身份；
- **Auth Principal** —— Auth Collection Record 完成认证后形成的业务身份；
- **Agent / Service Principal** —— Coding Agent、自动化程序和服务集成使用的机器身份。

Principal 与 Credential 分离。

## Credential

用于证明某个 Principal 身份的凭证。

一个 Principal 可以拥有多个 Credential；Credential 可以轮换、撤销或替换，而不改变 Principal 本身。

Credential 可以包括 Password、OAuth、OTP、Session、API Key 等不同类型。

## Identity

外部身份提供方与 Auth Principal 之间的身份绑定。

一个 Auth Principal 可以绑定多个外部 Identity，并可同时拥有其他 Credential。

## Admin Principal

Modelry 管理控制面的管理员身份，与业务 Auth Collection 分离。

Admin Principal 的生命周期不依赖某个业务 Collection 的 Schema。

## Auth Principal

由 Auth Collection 中某条 Record 完成认证后形成的业务身份。

Auth Principal 主要用于 Application Data Access，并受 Record Policy 约束。

## Anonymous Principal

Auth Collection 可选支持的临时业务身份。

Anonymous Principal 可以拥有受限 Session，并在后续绑定正式 Credential/Identity 时升级为已注册身份，尽量保持同一业务身份连续性。

## Agent / Service Principal

供 Coding Agent、MCP Client、自动化程序或后端服务使用的机器身份。

Agent / Service Principal 不拥有隐式超级管理员权限，其能力由 Capability Scope 明确授予。

## API Key

通常用于机器身份认证的一种 Credential。

API Key 不是 Principal，也不应因为持有 Key 自动获得超级权限。

## Session

可由服务端撤销的认证会话 Credential。

Session 允许身份在一段时间内持续被识别，同时支持显式撤销和强制失效。

## Password Credential

绑定 Auth Principal 的密码凭证。

Password 不作为普通业务 Field 暴露，其安全状态属于认证子系统。

## Email Verification

Auth Collection 可以声明的身份验证能力，用于表达 Email 是否需要被验证以及验证状态如何影响认证生命周期。

## Password Reset

用于安全替换 Password Credential 的受控认证生命周期。

Password Reset 的安全语义由 Modelry 统一定义，不要求每个项目重复构建。

## OTP

一次性验证码类型的 Credential。

## OAuth Provider

外部身份认证能力的 Provider 抽象。

不同 Provider 的 Identity 可以绑定到同一个 Auth Principal；不得因为 Provider 不同就默认制造重复业务身份。

## Capability Scope

Control Plane 的显式能力授权原语。

Capability Scope 决定 Admin / Agent / Service Principal 可以执行哪些 Backend 管理能力，不与 Record Policy 混用。

## Administrative Data Access

Control Plane 为诊断、运营、迁移或开发管理目的，对业务 Record 进行的管理型访问。

Administrative Data Access：

- 不伪装成某个业务 Auth Principal；
- 不使用 Record Policy 作为主要授权原语；
- 必须经过明确 Capability Scope；
- 必须记录真实操作 Principal 并可审计。

普通单条 Record CRUD 属于 Administrative Data Access，不进入 ChangeSet。高影响批量数据修改可以要求影响预览与显式 Human Confirmation，但仍不因此变成 Backend Model Change。

## Policy Simulation

在不进行真实业务访问的情况下，评估“某个业务 Principal 在给定 Policy 下将获得什么结果”的诊断能力概念。

Policy Simulation 与 Administrative Data Access 是不同能力，不能互相替代。

## Agent

通过机器接口理解和操作 Backend 的 Coding Agent。

Agent 是 Agent / Service Principal 的操作者，不是默认数据库管理员，而是受控的 Backend Collaborator。

## Inspect

人类或 Agent 读取当前 Backend Model、状态、ChangeSet、Migration 或诊断信息而不产生变更的控制面行为。

## Propose

人类或 Agent 提交候选变更并形成 ChangeSet 的行为。

Propose 不等同于 Apply。

## Apply

在授权、风险与必要确认满足后，将 ChangeSet 正式变为 Durable Change 的行为。

SAFE ChangeSet 在 Agent 显式拥有 Apply 能力时可以无需 Human Confirmation 执行；DATA_REWRITE、DESTRUCTIVE 与 IRREVERSIBLE 默认必须经过 Human Confirmation。

## Apply Attempt

对某个 ChangeSet 发起的一次实际 Apply 执行尝试。

Apply Attempt 与 ChangeSet 是不同生命周期：

- 一个 ChangeSet 可以存在多个 Apply Attempt；
- Apply Attempt 记录该次执行的 Principal、时间、确认上下文、Precondition 结果、执行结果与错误；
- 某次 Apply Attempt 失败不会把 ChangeSet 永久定义为 Failed；
- Retry 创建新的 Apply Attempt；
- 成功的 Apply Attempt 才推动 ChangeSet 进入 Applied，并形成对应的 Durable Change / Migration 事实。

## Hook

用于扩展应用业务逻辑的 Project Code Extension。

V0.1 将 Hook 定义为 **Trusted Project Code**，但可信不意味着无需故障隔离。

## Lifecycle Hook

在业务状态提交前同步执行的 Hook。

Lifecycle Hook 用于本地、确定性的验证、字段补全和阻止操作，不应用于必须执行的不可回滚外部副作用。

## Event Hook

消费已提交 Domain Event 的异步 Hook。

Event Hook 适合执行外部副作用。需要可靠执行的 Event Hook 采用耐久处理意图和 at-least-once 语义，因此 Handler 必须考虑幂等。

## Domain Event

业务状态成功变化后，对该变化进行统一表达的领域事件事实。

Domain Event 是 Realtime、Event Hook、Webhook 与 Audit 共享的事件语义来源。

Modelry 不因此自动成为永久保存所有领域事件的 Event Store。

## Durable Event Fact

为可靠异步处理保留的耐久事件事实。

Durable Event Fact 必须与触发它的业务 Mutation 保持原子一致，并可以在相关可靠处理完成后按照保留策略清理。

## Realtime

面向在线客户端的实时状态变化通知能力。

Realtime 是 best-effort 体验能力，不作为可靠业务消息队列；Realtime Filter 也不能绕过 Record Policy。

## Webhook

将 Domain Event 可靠投递给外部 Endpoint 的能力。

Webhook 使用 at-least-once 语义，因此消费方需要能够识别重复 Delivery 并保持幂等。

## Delivery

某个可靠异步副作用任务的一次实际执行尝试。

Delivery 可以成功、重试或进入最终失败状态；Delivery 与 Domain Event 本身是不同生命周期。

## Audit

对关键操作和状态变化保留的可追踪事实。

Audit 的目的，是能够回答“谁在什么时候以什么权限对什么对象做了什么以及结果如何”。

需要可靠审计的操作，其最小 Audit Fact 不允许存在业务状态已成功而审计事实永久丢失的正常窗口。

## Secret

应用运行需要的敏感配置资源。

Secret 的名称、存在状态与明文值具有不同暴露等级；普通 Inspect 不应因为具备查看名称的权限就可以重新读取明文。

## Data Plane

面向应用运行时的数据访问面。

主要服务业务应用、SDK、终端用户和业务 Auth Principal，并以 Record Policy 作为 Record 级授权核心。

## Control Plane

面向 Backend 管理、诊断与变更的控制面。

主要服务 Admin、CLI、Agent 与自动化管理程序，并以 Capability Scope、ChangeSet、Risk 和 Audit 作为核心治理语义。

## Data Query

对 Collection Record 的查询行为。

Query Filter 只缩小当前 Principal 已获授权的数据集合，不能扩大 Policy 授权范围。

## Batch

在一次受控请求中执行有限多个数据操作的能力。

Batch 需要明确原子性、数量与资源限制，不能演变成跨多个请求维持开放事务的通用数据库会话。

## Custom API

Project 定义的应用业务 API 扩展。

Custom API 仍属于 Modelry Backend 的显式产品表面，不能成为绕开 Principal、Policy 或 Control Plane 权限的黑盒。

## Route Contract

Custom API 的机器可读接口契约。

Route Contract 描述请求、响应、认证和错误等 API 语义，使 Runtime Validation、API Documentation、Agent Inspect 与 Client Types 能共享同一契约来源。

## Backup

用于在未来恢复 Project Runtime State 的一致性快照能力。

Backup 与 Project Source 不同：它保护运行数据和敏感状态，而不是替代 Project Migration History。

## Restore

从 Backup 恢复 Runtime State 的显式高风险操作。

Restore 必须验证兼容性和恢复目标，并进入 Audit。

## Runtime Upgrade

Modelry Runtime 版本发生变化并可能触发 System Migration 的生命周期。

Runtime Upgrade 与 Project Backend Model Migration 是不同问题。

## Doctor

对 Project/Instance 的配置、Migration、数据完整性、扩展加载和其他运行状态进行系统诊断的产品能力。

Doctor 的结果应当既适合人类阅读，也适合 Agent 机器判断。

# 术语关系摘要

```text
Project
├─ Project Source
│  ├─ Migration History
│  ├─ Schema Snapshot (generated)
│  └─ Project Code Extension
└─ Runtime Data
   ├─ Runtime Backend Model
   ├─ Records
   ├─ Credentials / Sessions
   ├─ Files
   ├─ Delivery State
   └─ Audit

Principal
├─ Admin Principal
├─ Auth Principal
└─ Agent / Service Principal
     ↓
Credential

Application Data Access
Auth Principal -> Record Policy -> Records

Administrative Data Access
Admin/Agent Principal -> Capability Scope -> Records

Backend Change
Inspect -> Propose -> ChangeSet -> Diff + Risk -> Apply Attempt -> Migration -> Audit
                                  └-> retry creates another Apply Attempt

Reliable Side Effect
Mutation + Durable Event Fact (atomic)
        -> Commit
        -> Event Hook / Webhook Delivery
```

# 文档边界

以下内容明确不属于 `CONTEXT.md`：

- Runtime / framework / language 选择；
- 数据库或存储产品选择；
- 项目目录和文件名；
- Migration 文件格式；
- HTTP 路径；
- CLI 命令；
- 具体 UI 页面；
- 具体 SDK API；
- Bun Spike 结果；
- 尚未决定的备选方案。

这些内容分别进入 Product Scope、ADR、Spike 或后续 Specification。
