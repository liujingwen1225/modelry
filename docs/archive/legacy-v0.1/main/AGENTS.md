# AGENTS.md

本仓库使用 Matt Skills Curated 工程工作流。已经确认的产品与领域决策视为长期约束；不得由 Agent 自行脑补未确认能力并直接进入实现。

## Agent skills

### Issue Tracker

GitHub Issues 是实现级工作的唯一正式任务跟踪器。尚未完成规格化的设计内容不能直接创建为实现 Ticket。详见 `docs/agents/issue-tracker.md`。

### Domain Docs

当前仓库采用 **单一上下文（single-context）** 领域文档模型。规划或实现任何涉及 Collection、Policy、Migration、Principal、Auth、Hook、Event、Data Plane 或 Control Plane 的变更前，必须先阅读根目录 `CONTEXT.md`。详见 `docs/agents/domain.md`。

`CONTEXT.md` 必须保持 implementation-free；Runtime、数据库、路径、文件格式、HTTP、CLI 和 UI 细节进入 ADR / Scope / Spike / Specification。

### Architecture Decision Records

变更产品不变量、Runtime 技术路线、Backend Model、Agent 权限、Migration、安全模型、Extension 执行模型或 Instance/Project 模型前，必须阅读 `docs/adr/` 中相关 ADR。

新 ADR 原则上应同时满足：

1. 难以逆转或改变成本明显；
2. 如果缺少背景，决策结果并非显而易见；
3. 确实存在有意义的取舍或替代方案。

普通规格细化优先进入现有 ADR 或后续 Specification，不为每个小决定新增 ADR。

### V0.1 Scope

V0.1 的正式产品边界见 `docs/01-v0.1-scope.md`。

V0.1 已区分：

- **V0.1.0 Core Closure** —— 首个可用版本必须跑通的核心闭环；
- **V0.1.x Completion** —— 已确认领域边界但不阻塞 V0.1.0 的后续能力。

除非新增 Accepted ADR 明确修改范围，否则不得在 Spec、Ticket 或实现阶段擅自加入被明确排除的能力，也不得让 V0.1.x 能力重新无条件阻塞 V0.1.0。

## 当前工作阶段

以下设计阶段均已结束：

- `grill-with-docs`
- Design Gap Closure
- Bun Runtime Spike Gate

Bun Runtime Spike 最终结论为 **GO**，结果见：

- `docs/spikes/0001-bun-runtime-validation.md`
- `docs/spikes/0001-bun-runtime-validation-result.md`

ADR-0003 的 **Bun + TypeScript** 已通过 Runtime Gate，不触发 Go fallback。

当前正式阶段是：**`to-spec`**。

### to-spec 规则

`to-spec` 只负责把已经确认的 Scope、CONTEXT、ADR 与 Spike 结果综合为可实施、可验收的 V0.1.0 Specification。

不得在 `to-spec` 阶段重新开启产品发散或把 V0.1.x 能力重新塞回 V0.1.0。

Specification 至少必须独立覆盖：

1. Backend Model schema；
2. ChangeSet / Diff / Risk；
3. Migration Safety Model；
4. Record Policy Evaluation Model；
5. Principal / Credential / Session；
6. Administrative Data Access；
7. Durable Event / Outbox delivery；
8. Hook Runtime boundary 与 reload state；
9. Custom API Route Contract；
10. Drift / Doctor；
11. Structured API Error；
12. V0.1.0 Acceptance Demo。

Spike prototype 不具有生产继承权；Specification 不得因为 Spike 中存在某个临时 SQLite Schema、HTTP Route、Worker 文件或状态结构，就把它自动视为生产设计。

Specification 被接受后，固定生命周期为：

1. `to-tickets` —— 将已接受规格拆分为实现级任务；
2. `implement` —— 仅按已规格化和 Ticket 化的范围进入生产实现；
3. `code-review` —— 同时依据仓库工程规范和已接受规格审查实现。

不得从当前阶段直接进入生产实现。

## Design Gap Closure 后的强制设计基线

### Policy

- Policy 按 list/view/create/update/delete 分开求值；
- Update 必须有明确 before/after 语义；
- Relation Expand 与 Realtime 不得绕过目标 Record Policy。

### Authorization

- Application Data Access：Auth Principal -> Record Policy；
- Administrative Data Access：Admin/Agent Principal -> Capability Scope；
- 管理型数据访问使用 `data:inspect` / `data:mutate`，不能伪装为业务 `auth.id`。

### Event Reliability

- External side effects happen after commit；
- 可靠 Event/Outbox/Audit Fact 必须与触发它的业务 Mutation 原子持久化；
- Webhook 与 reliable Event Hook 按 at-least-once 设计；
- Realtime 是 best-effort，不是可靠消息队列。

### Backend Model / Migration

持久化真相层级：

`Project Migration History -> Runtime Backend Model -> Generated Schema Snapshot`

不得引入需要人工维护的第四份 Backend Model Source。

Migration Risk 使用单一可排序级别：SAFE < DATA_REWRITE < DESTRUCTIVE < IRREVERSIBLE；一个 ChangeSet/Migration 包含多种操作时取最高风险级别，并具备 Preconditions 与必要恢复点。

### Custom API

Custom API 必须有机器可读 Route Contract，不能成为绕过 Runtime Validation、OpenAPI、Agent Inspect 或授权体系的任意 Router 黑盒。

## 产品护栏

- Modelry 是为 AI Coding 重新设计的 Backend，不是 PocketBase 兼容项目；
- 除非有新的 Accepted ADR，否则必须保持 Single Binary First；
- AI 对核心 Backend 是增强能力，不得成为运行依赖；
- Backend Model 是产品语义 Source of Truth；不得把直接操作物理数据库作为产品控制面；
- Admin UI、CLI、MCP、Agent 应收敛到统一 Backend Model 和 ChangeSet 机制；
- 当前产品模型坚持 One Instance, One Project；
- Agent 驱动的变更必须保持显式、可 Diff、可风险分级、可审计；
- V0.1 Hook 属于 Trusted Project Code，但可信不等于可以忽略故障隔离；
- V0.x 只实现 SQLite Runtime，不提前引入 PostgreSQL、Cluster/HA、Multi-project 或外部基础设施依赖；
- V0.x 不为假设中的 PostgreSQL 提前制造只有 SQLite 一个实现的通用 DatabaseAdapter；
- V0.1 不以 Admin AI Chat 作为 AI Native 的证明；MCP、Backend Model、ChangeSet、Diff、Risk、Structured Error、Snapshot、Doctor 才是核心机器接口。

## 文档语言约定

- 产品、设计、ADR、Issue 规格、工程约定默认使用中文；
- 代码标识、CLI 命令、协议名、标准名以及稳定的领域术语可保留英文，例如 `Collection`、`Backend Model`、`ChangeSet`、`Policy`、`Hook`、`MCP`；
- 不为了“中文化”翻译会直接进入代码/API 的标识，从而造成文档术语与实现脱节。
