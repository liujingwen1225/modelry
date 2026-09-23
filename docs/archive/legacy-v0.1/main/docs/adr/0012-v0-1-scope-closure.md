# ADR-0012：收口 V0.1 产品范围并以 Bun Runtime Spike 作为进入规格阶段的技术 Gate

- **Status:** Accepted
- **Date:** 2026-09-02

## 背景

Modelry 已经完成多轮 `grill-with-docs`，核心产品定位、Backend Model、ChangeSet、Auth、Data/Control Plane、Event/Hook、Migration、Git 工作流等关键边界已经稳定。

后续设计审查又发现几个必须在进入 Spec 前关闭的结构性缺口：

- 可靠 Domain Event / Webhook / Event Hook / Audit 在 Commit 后单独持久化会产生 crash window；
- Agent 管理型数据访问与业务 Record Policy 存在授权语义冲突；
- Migration 的持久化真相层级和破坏性变更安全模型需要明确；
- Record Policy 需要按操作、before/after、Relation Expand、Realtime 固定语义；
- Custom API 必须具备可生成 OpenAPI 的机器可读契约；
- 原 V0.1 功能总量虽然方向正确，但全部同时阻塞首版会削弱可交付性。

这些问题均属于设计闭环缺口，而不是重新定义产品方向。

## 决策

### 1. V0.1 核心定位不变

Modelry V0.1 的核心成功标准仍然是完成：

`init -> serve -> Admin 建模 -> Data API -> MCP Inspect/Propose -> ChangeSet/Diff -> Apply -> Migration -> Git Diff`

Backend Model、ChangeSet、Diff、Migration、MCP、Admin、CLI、Policy、Auth 仍然是核心语义。

### 2. 接受 Design Gap Closure 修复

以下设计作为进入 `to-spec` 前的正式基线：

- ADR-0007：Policy 按 list/view/create/update/delete 求值，并明确 before/after、Relation Expand 与 Realtime 授权语义；
- ADR-0008：Administrative Data Access 与业务 Data Plane 分离，使用 `data:inspect` / `data:mutate`；
- ADR-0010：可靠 Event/Outbox/Audit Fact 与业务 Mutation 同事务持久化，外部副作用在 Commit 后执行；
- ADR-0011：Project Migration History -> Runtime Backend Model -> Generated Schema Snapshot 的真相层级，以及 Migration Safety Model；
- ADR-0013：Custom API 使用显式 Route Contract 驱动 Runtime Validation / OpenAPI / Agent Inspect / SDK Types。

### 3. V0.1 采用 V0.1.0 + V0.1.x 两层交付

V0.1 的领域模型与兼容边界统一设计，但不再要求全部已确认能力同时阻塞首个可用版本。

#### V0.1.0 Core Closure

必须优先交付：

- Collection / Field / Relation / Index；
- Record CRUD / Filter / Policy；
- Email/Password 与 Username/Password Auth；
- Revocable Session；
- Local File；
- SSE；
- Lifecycle Hook；
- Secret；
- Backend Model / ChangeSet / Diff / Risk；
- Declarative Migration / Drift；
- Audit；
- Admin；
- MCP；
- CLI Core；
- OpenAPI 3.1。

#### V0.1.x Completion

允许在 V0.1.0 之后补齐：

- Email Verification / Email OTP；
- GitHub / Google OAuth；
- Anonymous Auth；
- S3 Compatible Storage；
- Event Hook；
- Webhook；
- Custom API 完整产品化；
- Simple Cron；
- Backup / Restore 完整体验；
- Batch。

后置不代表删除：这些能力的领域边界与兼容方向仍由当前 ADR 固定。

### 4. V0.x 非目标不变

除非新的 Accepted ADR 明确改变方向，V0.x 不实现：

- PostgreSQL Runtime；
- GraphQL；
- MFA / Passkey；
- Enterprise SSO；
- Multi-project / Workspace；
- Cluster / HA；
- Plugin Marketplace；
- Untrusted Sandbox；
- Workflow Engine；
- Admin AI Chat；
- Cloud Platform；
- 多套官方 SDK。

继续坚持：

- SQLite Only for V0.x；
- One Instance, One Project；
- Single Node；
- Single Binary First。

### 5. Bun Runtime Spike 仍是正式 Gate

正式进入 `to-spec` 前，必须执行 `docs/spikes/0001-bun-runtime-validation.md` 并产出 `PASS / RISK / FAIL` 结果与针对 ADR-0003 的 Go / No-Go 结论。

Spike 必须验证的不是“Bun 能启动 HTTP Server”这种表面能力，而是决定产品形态是否成立的关键路径：

- standalone executable；
- embedded Admin；
- SQLite；
- SSE；
- MCP；
- 外部 Project TypeScript Hook 动态加载；
- Hook infinite loop / crash / timeout 恢复；
- MCP 通过 `Propose -> ChangeSet -> Apply` 进入同一 Backend Model 语义。

如果出现阻塞性 `FAIL`，允许切换到 Go fallback；不得为了维护既有偏好而绕过实测结果。

## 进入 to-spec 的强制章节

Bun Spike 通过后，`to-spec` 至少必须单独覆盖：

1. Backend Model schema；
2. ChangeSet / Diff / Risk；
3. Migration Safety Model；
4. Record Policy Evaluation Model；
5. Principal / Credential / Session；
6. Administrative Data Access；
7. Durable Event / Outbox / Event Hook delivery；
8. Hook Runtime boundary；
9. Custom API Route Contract；
10. Drift / Doctor；
11. Structured API Error；
12. V0.1.0 Acceptance Demo。

这些章节属于已决设计的规格化，不重新打开产品范围讨论。

## 结果

### 正向影响

- 两个会影响正确性的 P0 缺口在 Spec 前关闭；
- V0.1 仍保留完整产品方向，但 V0.1.0 的交付面显著收窄；
- Migration、Policy、Custom API 和 Agent Data Access 不再依赖实现者自行猜测；
- Bun Spike 更接近真实产品风险，而不是 API Demo；
- 设计阶段可以正式结束。

### 代价

- V0.1.x 会承担一部分原计划首发能力；
- Specification 需要对安全与生命周期语义写得更精确；
- Event/Outbox、Migration Safety 和 Policy Evaluation 会带来额外测试成本，但这些成本属于正确性成本，不能通过省略设计规避。

## 后续流程

`grill-with-docs` 与 Design Gap Closure 均正式结束。

后续固定顺序：

`Bun Runtime Spike -> to-spec -> to-tickets -> implement -> code-review`
