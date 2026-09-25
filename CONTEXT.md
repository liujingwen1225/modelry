# Modelry 当前上下文

## 产品定位

Modelry 是一个面向人类开发者与 Coding Agent 的产品化 Backend Platform。

V0.1 的核心用户路径统一为：

~~~text
First Run
→ Create Backend Model
→ Manage Data
→ Secure
→ Use API
→ Observe
→ Evolve
~~~

扩展能力是重要方向，但不作为第一个 V0.1 Release Gate 的前置条件。

Modelry 不能演变成“数据库管理工具 + 一堆附加功能”。

## 产品化要求

所有产品和技术决策必须优先服务：

- **易用**：少理解一个内部概念、少一次跳转、少一次无意义确认。
- **好用**：真实工作流连续，默认值合理，结果原地可见。
- **好看**：视觉、信息层级与交互统一。
- **功能完整**：核心 Backend 工作流真正闭环，而不是拥有很多未闭环能力。

技术纯粹性、提前抽象和内部对象模型不得凌驾于产品体验。

## 产品体系

### Community

开源、自托管、SQLite Only、零配置优先。

Community 的长期产品可以持续拥有 Files、Realtime、Hooks、Secrets 等能力，但 V0.1 不要求一次完成所有长期 Community 能力。

### Commercial / Enterprise

面向正式生产、团队和组织的商业 Self-hosted 产品。

PostgreSQL、Organization / Team Governance、Enterprise Identity、Advanced RBAC、Backup / Restore、Production Observability、HA / Scale、Fleet Operations、Compliance 与 Support 属于这一阶段。

### Modelry Cloud

官方 Managed SaaS。

Cloud 使用独立 Cloud Control Plane 管理 Organization、Team、Project、Environment、Region、Usage、Billing、Backup 和托管运维。

Project Backend Plane 的核心产品语义继续与 Self-hosted Modelry 共用。

## V0.1 Community 固定基线

- Go Runtime
- SQLite Only
- React + TypeScript + Vite
- Modular Monolith
- Contract First
- Zero-config-first
- 简单 Self-hosted Delivery
- 一个 Runtime 服务一个 Project

## V0.1 产品范围原则

必须优先完成：

~~~text
Model
→ Data
→ Security
→ API
→ Observe
→ Evolve
~~~

V0.1 保留：

- Collections / Fields / Relations / Basic Index / Validation / Defaults
- Records
- Durable Pending Schema Changes / Apply / Recovery / Applied History
- REST API / OpenAPI / Runner / Request Logs
- Auth Collection / Email + Password / Sessions
- Access Rules
- Local Single-file Field
- Owner + Service Account / API Key
- Minimal Audit
- Runtime / Storage Diagnostics
- Minimal CLI
- Core MCP

V0.1.x 再进入：

- Realtime
- Lifecycle Hooks
- Secrets UI
- Event Hooks / Webhooks
- Policy Simulation
- Additional Administrator Management
- Full Activity Timeline
- Drift Product
- Editable Runtime Settings
- Multiple File Values
- S3-compatible Storage

## Policy, Activity, Drift, and Runtime Settings

**Policy Simulation**：针对已应用 Access Rules 的非权威预演，使用与真实请求相同的 evaluator。它不写 RequestRecord、不写 Audit、不改变规则。
_Avoid_：Dry Run、Policy Test、Rule Preview

**Activity**：由各子系统产品事实构成的有界运维时间线（Model 变更、Automation 投递、Extension Run、Mail Delivery、Storage Migration、App User 恢复）。
_Avoid_：Audit Log、Request Log、Event Stream、Debug Log

**Drift**：Applied Model、物理 SQLite 投影与 runtime-managed state 三者之间的不一致。
_Avoid_：Corruption、Migration Failure、Schema Mismatch

**Expected Pending Change**：已保存但尚未 Apply 的变更。它以信息项呈现，不是 Drift。
_Avoid_：Pending Drift、Unapplied Drift

**Reconcile**：只重建 Applied Model 的物理投影（表、列、索引）的修复动作。它不 Apply Pending Change、不删除 Record、不删除列或表。
_Avoid_：Repair Migration、Reapply、Reset Schema

**Runtime Setting**：带 value source、validation 与 restart requirement 的 durable Runtime 配置项。
_Avoid_：Env Var、Config File、Flag
## 架构不变量

- Backend Model 定义 Modelry 产品语义，SQLite 不能反过来定义产品。
- V0.1 只实现 SQLite，但未来 PostgreSQL 不应要求重写 Domain Model、Admin 或 Contract。
- Application Data Plane 与 Modelry Control Plane 分离。
- Admin Identity 与 Application User Identity 分离。
- Principal 与 Credential 在 Domain 中分离，但 UI 使用 Administrator、Service Account、App User、Password、API Key、Session 等自然术语。
- 受管 Backend Model Mutation 统一经过显式 Change Lifecycle。
- Admin、HTTP、CLI 与 MCP 操作同一套 Backend Semantics。
- Go 是 Runtime 实现语言，不是用户必须面对的扩展语言。
- Domain Language 不等于 UI Language。

## Record Events and Realtime

**Record Event**：一个已提交的 Collection Record 创建、更新或删除事实。它属于 Project 内该 Collection 的数据变更历史，与 API 请求遥测和管理审计分别建模。
_Avoid_：Audit Event、Request Event、Activity Event

**Event ID**：标识一个 Record Event，并确定它在所属 Collection 事件序列中的位置。ID 使用 `evt_<Collection ID 的 UTF-8 字节之无填充 Base64 URL-safe 编码>_<非零 20 位序号>`，因此在同一 Project 内唯一；它可作为从该 Event 之后恢复接收的游标值。零序号只表示首次订阅的 Event Cursor 边界，不代表 Event。
_Avoid_：SQLite Row ID、Request ID

**Event Cursor**：标识订阅者从一个 Collection 事件序列继续接收的位置。它通常取最近已接收 Event 的 Event ID；首次订阅时使用独立的 Collection-scoped cursor 表示建立订阅时的序列边界。不同 Collection 之间不承诺一个可观察的全序。
_Avoid_：Page Cursor、Request ID

## Extensions, Lifecycle Hooks, and Secrets

**Extension**：Project 中由 Owner 管理的一份可版本化脚本资源，可为 Collection Record 生命周期绑定受控处理函数。Extension 不是普通 Record、Go Plugin 或可访问 Runtime 内部状态的通道。
_Avoid_：Plugin（容易暗示任意进程能力）、Script File（未表达受控边界）

**Lifecycle Hook**：Extension 在一个 Collection 的 Record Create、Update 或 Delete 流程中收到的明确调用。Pre-commit Hook 可以验证或修改本次待提交 Record；Post-commit Hook 在耐久提交后运行，可执行外部副作用，但其失败不撤销该变更。
_Avoid_：SQLite Trigger、Database Hook（泄漏实现细节）、Transactional Hook（容易误示外部副作用可回滚）

**Secret**：Project 中供获准 Extension 使用的敏感配置值。它与 Record、RequestRecord、AuditRecord 分开管理；Owner 写入后不能再次读取原值。
_Avoid_：Secret Record、Credential（与身份认证凭证混淆）、Environment Variable（隐去归属与访问范围）

### Extension Product Semantics

Extension 是 Project 中的一份 JavaScript 或 TypeScript 程序。每次激活都会形成一个不可变 Revision；Collection 绑定指向明确的活动 Revision。Owner 可停用 Extension 或替换为新 Revision。V0.1.x 不支持从磁盘、npm 或网络导入代码。

Lifecycle Hook 分为 `beforeCreate`、`beforeUpdate`、`beforeDelete` 与 `afterCommitCreate`、`afterCommitUpdate`、`afterCommitDelete`。每个 Collection 操作的每个阶段至多有一个启用的绑定，因此执行顺序明确。Before Hook 只接收本次待变更 Record 和 Applied Model 上下文，可以拒绝或返回 Record 修改；它不访问 Secret 或网络。验证与 Hook 均成功后，Runtime 才提交 Record 与 Record Event。Hook 拒绝、执行失败、超时或修改后验证失败时，Record 与 Event 均不改变。

After-commit Hook 消费事务中记录的不可变提交事实，只运行一次；它不能修改或撤销已提交 Record，失败也不改变 Record mutation 的成功结果。意图与 Record Event 同事务耐久写入，并固定当时的 Extension Revision、Binding、Secret 别名映射、Origin 授权和 Event ID；重启后未完成项标记为中断，不自动重试。停用、撤销或删除依赖项会取消尚未开始的对应意图；运行中取消尽力而为。仅此阶段可读取明确绑定给该 Extension 的 Secret 别名，并可使用 Owner 明确授予的 HTTPS Origin；请求有时限、并发数和字节上限，不能访问本机或私有网络地址。

Secret 的原值只在创建或替换时由 Owner 输入。管理列表、详情、Audit、RequestRecord、普通 Record、Hook Run 与运行时错误只显示元数据或配置状态。加密密钥缺失、无效或无法通过本机文件权限检查时，依赖 Secret 的 Hook 失败关闭；不得生成新密钥继续运行。

Hook Run 记录阶段、Extension Revision、绑定、开始/结束时间和安全错误类别，不记录源异常、Guest 自定义消息、脚本 stdout、HTTP 请求/响应内容或 Secret。Extension 配置的绑定槽位冲突会在启用时原子拒绝，Extension 保持停用。

**Realtime Subscription**：应用通过 Collection 订阅已授权的 Record Event，并在连接恢复后从 Event Cursor 继续接收。
_Avoid_：Record polling、Activity Timeline

## File Values and Storage Providers

**File value**：Collection Field 上的文件能力取值。`file` Field 保存单个 File value，`files` Field 保存有序列表；两者只保存 Runtime 生成的不透明对象引用，不保存文件名、路径或桶名。
_Avoid_：File path、Bucket key、Filename

**File object**：Runtime 写入 Storage Provider 的一份不可变字节内容。对象写入后永不覆盖；替换文件产生新对象，旧对象在宽限期后由 reconcile 回收。
_Avoid_：Mutable file、Blob row

**Storage provider**：实际存放 File object 的实现，当前为 `Local` 与 `S3-compatible`。Provider 是运行实现，不是 Backend Model 语义；切换 Provider 不修改任何 Record 值。
_Avoid_：Backend、Bucket（作为产品术语）

**Provider migration**：把所有 Durable Record 引用的 File object 复制到目标 Provider，并在全部校验通过后才切换 Provider 的耐久操作。它 bounded、可取消、restart-aware，且不删除源对象。
_Avoid_：Sync、Replication、Copy job
## Change UX 不变量

底层继续保留：

~~~text
ChangeSet
→ Structured Diff
→ Risk / Preconditions / Impact
→ Apply Attempt
→ Migration / Ledger
~~~

用户主界面优先使用：

~~~text
Pending
Needs review
Failed
Applied
~~~

Schema 的 Pending Changes 必须耐久保存。用户离开 Collection、刷新页面或切换 Fields / Relations / Indexes 时不应丢失。

Policy 与 Auth Configuration 不与 Schema 共用一个隐形 Collection-wide Draft。

## 权威文档阅读顺序

1. docs/00-product-vision.md
2. docs/01-product-roadmap.md
3. docs/02-technical-roadmap.md
4. docs/03-editions-and-cloud.md
5. docs/04-v0.1-community-scope.md
6. docs/05-product-experience-and-acceptance.md
7. docs/06-product-architecture.md
8. docs/specs/0001-admin-product-ux-spec.md
9. 后续 Accepted ADR
10. 后续 Accepted Spec
11. 后续 Accepted Contract

历史文档不具备当前权威性。

## 当前实施 Gate

Admin Product UX Spec 已完成本轮范围和 UX 收敛。

在大范围生产实现前仍需建立并接受：

- Runtime / Storage ADR
- Foundation Spec
- HTTP Contract / OpenAPI
- Browser Acceptance Spec
