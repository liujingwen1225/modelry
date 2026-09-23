# AGENTS.md

本仓库使用 Matt Skills Curated 工程工作流。已经确认的产品与领域决策视为长期约束；不得由 Agent 自行脑补未确认能力并直接进入实现。

## Agent skills

### Issue Tracker

GitHub Issues 是实现级工作的唯一正式任务跟踪器。尚未完成规格化的设计内容不能直接创建为实现 Ticket。详见 `docs/agents/issue-tracker.md`。

### GitFlow

本仓库正式采用 GitFlow 分支模型。`main` 为发布稳定线，`develop` 为唯一长期集成线；正常工作必须从 `develop` 创建 `feature/*`，发布稳定化使用 `release/*`，线上紧急修复使用 `hotfix/*`。完整规则见 `docs/agents/gitflow.md`。

不得继续创建新的 `frontend/*`、`contract/*`、`spec/*` 或 `prototype/*` 作为正式开发分支。历史同名前缀分支只作为阶段遗留，确认无独有内容后删除。

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

以下阶段均已结束：

- `grill-with-docs`
- Design Gap Closure
- Bun Runtime Spike Gate
- Frontend First / Mock First / Frontend Closure
- API Contract Freeze
- Backend / Control Plane Core
- V0.1.0 Data Plane Core
- Data Plane Core post-merge CI Gate / Closure Bookkeeping

Bun Runtime Spike 最终结论为 **GO**，结果见：

- `docs/spikes/0001-bun-runtime-validation.md`
- `docs/spikes/0001-bun-runtime-validation-result.md`

ADR-0003 的 **Bun + TypeScript** 已通过 Runtime Gate，不触发 Go fallback。

Frontend V0.1 Closure 已完成并通过最终审查，正式冻结基线为：

`5e140d6aa3ea33dbd40dfd3f56bf43949d64b550`

V0.1.0 API Contract Freeze 已通过 Issue #39 / PR #40 合并到 `develop`。正式机器契约为：

- `docs/contracts/0001-v0.1.0-api-contract-freeze.md`
- `contracts/openapi/v0.1.0.json`
- `contracts/frontend-repository-mapping.json`
- `contracts/v0.1.0-contract-manifest.json`

当前正式阶段是：**V0.1.0 Release Readiness / Hardening**。

唯一阶段规格：`docs/specs/0005-v0.1.0-runtime-completion.md`。

Runtime Completion 已完成 Closure，当前集成基线为 `develop@793e0406d832aaa28668d4428a42b9cbebfc6eac`（已合并 PR #129 Secret at-rest 安全修复）。当前 Release Readiness vertical slice 为 Issue `#100 Blog Reference Application / Release Readiness E2E`。

### Runtime Completion 规则（已完成阶段基线）

Runtime 实现必须以 Frozen Contract 为 transport 与机器语义边界，不得从页面、Mock、Spike 或 prototype 重新猜测 API。

每个 feature 只完成对应 Issue 的纵向范围，并通过测试、code-review、PR 合并回 `develop`。发现 Frozen Contract Gap 时必须停止局部 workaround：创建独立 Contract Gap Issue，完成 Contract Review 并合并回 `develop` 后再继续实现。

当前 Runtime Completion 的固定边界：

- Application Auth 必须复用现有 Application Data Plane / Record Policy，不创建第二套 Record Store 或授权引擎；
- Password 是独立 Credential，不是普通 Auth Collection Field；
- Control Plane Principal/Credential 与 Application Auth Record/Credential/Session 分离；
- Secret 是一级 Control Plane 资源，Admin、Hook、MCP 复用同一 Secret Runtime；
- Realtime、Hook、Audit、Auth/Record mutation 共享统一 Domain Event 语义，不各自监听内部表生成竞争事实；
- Lifecycle Hook 只处理事务内、本地、确定性的验证/字段补全，不执行不可回滚外部副作用；
- CLI、Admin、HTTP、MCP 都是已有领域能力的入口，不复制 ChangeSet、Migration、Record、Auth、Secret 等业务逻辑；
- V0.1.0 的 MCP 不提供任意 SQL、shell 或 unrestricted filesystem capability；
- V0.1.x 的 OAuth、OTP、Password Reset、S3、Event Hook、Webhook、Cron、Backup/Restore、Batch 不得被顺带带入 V0.1.0 Runtime Completion。

Runtime Completion 已按 Spec 0005 DAG 完成；上述顺序仍是已交付能力的依赖记录，当前工作只收口 Blog E2E、Hardening 与 Release Gate，不重新扩大 Runtime Completion 范围。

实现继续遵循：

1. Issue 已规格化且依赖满足；
2. 从当时最新 `develop` 创建 `feature/<issue-number>-<short-name>`；
3. 在 feature 分支实现、测试、审查；
4. PR 合并回 `develop`；
5. Runtime Completion Closure 后，仍必须通过 Blog E2E / Release Readiness 全部门禁，才能从 `develop` 创建 `release/v0.1.0`；
6. Release 完成后合并 `main` 与 `develop`，并在 `main` 创建 `v0.1.0` Tag。

### Release Readiness / Hardening 规则

- #100 必须通过真实 standalone Runtime、真实 SQLite、真实 HTTP/MCP/CLI 和 Blog 四集合闭环；Mock/fixture 不能替代 mandatory path。
- Release gate 必须覆盖真实 Browser journey、完整后端/前端测试、契约检查、构建、安全扫描、Migration/Upgrade、Drift/Doctor；Linux/Windows 跨平台 smoke 可按需在对应环境手工执行，不作为自动门禁。
- 发现新的 P0/P1 时立即停止 Release Readiness，创建独立 blocker Issue 并修复；在修复、Review、验证完成前不得创建 `release/v0.1.0`。
- GitHub Actions 不作为 V0.1.0 Release Gate；本地/人工可重复验证结果、Frozen Contract diff、Blog E2E 与独立 code-review 是发布判断依据。

Spike prototype 不具有生产继承权；生产实现不得因为 Spike 中存在某个临时 SQLite Schema、HTTP Route、Worker 文件或状态结构，就把它自动视为生产设计。

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
