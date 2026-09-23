# ADR-0011：采用 Git 友好的项目结构、声明式 Migration 与显式备份升级模型

- **Status:** Accepted
- **Date:** 2026-09-02

## 背景

Modelry 的核心用户包含 AI Coding 开发者，因此后端结构变更不能只存在于运行中的数据库，也不能只通过 Admin/MCP 留下不可提交到 Git 的内部状态。

项目需要同时满足：

- Backend Model 变更可审计、可复现、可提交 Git；
- Coding Agent 可以不启动服务就理解当前后端结构；
- Admin、CLI、MCP 产生的结构变更都能形成正式 Migration Artifact；
- Runtime State 与 Project Migration History 不一致时能够明确发现 Drift；
- 破坏性 Schema 变更具有明确风险、前置条件与恢复策略；
- 备份、恢复和 Runtime 升级保持 Single Binary First，不引入额外基础设施。

## 决策

### 1. Project Source 与 Runtime Data 分离

V0.1 采用可版本管理的 Project Source 与不可版本管理的 Runtime Data 分离模型。

具体目录名属于实现约定，由 Spec 固定；领域上必须保证：

- Runtime Binary 不属于 Project Source；
- Project Migration History、Hook Source、声明式 Runtime Config 与 Generated Schema Snapshot 可进入 Git；
- Runtime Database、Local Storage Data、Secret Material 与 Backup Artifact 不进入 Git。

### 2. Runtime Config 与 Backend Model 分离

Runtime Config 只承载 Runtime/Provider 级声明式配置，不承载完整 Backend Model，也不允许任意可执行代码成为配置语义。

Secret 只通过名称引用，不把明文 Secret 写入 Git 配置。

### 3. Project Migration 使用声明式、不可变 Artifact

Backend Model 结构变更必须形成声明式 Migration Artifact。

Migration 描述领域操作，例如：

- `collection.create`；
- `collection.drop`；
- `field.add`；
- `field.rename`；
- `field.drop`；
- `field.type_change`；
- `index.create`；
- `policy.update`。

默认 Migration 不是原始 SQL，也不是任意 TypeScript `up()` 代码。

已经 Apply 的 Project Migration 视为 Immutable。需要修正时必须创建新的 Migration。

复杂 Data Migration 另行设计，不能借此破坏 Schema Migration 的声明式边界。

### 4. Backend Model 的真相层级

“Backend Model is the Source of Truth”描述的是产品语义层，不要求存在第四份独立 Backend Model Source 文件。

V0.1 的持久化关系固定为：

```text
Project Migration History
        ↓ replay / validate
Runtime Backend Model
        ↓ generate
Schema Snapshot
```

三者职责：

- **Project Migration History** —— Durable Historical Source，描述项目如何演化到当前 Backend Model；
- **Runtime Backend Model** —— Materialized Runtime Truth，表示当前 Instance 已成功 Apply 的实际 Backend Model；
- **Schema Snapshot** —— Generated Projection，表示当前 Backend Model 的稳定机器可读视图，不允许手工作为真相源编辑。

因此：

- Git 中的完整 Migration History 是可复现 Backend Model 的历史来源；
- Runtime Migration Ledger 证明 Runtime 已 Apply 到哪个历史位置；
- Snapshot 便于 Agent/CI 快速读取，但可以由受信 Backend Model 状态重新生成；
- 正常设计中不存在需要人工维护的第四份 Backend Model Source 文件。

### 5. Migration Ledger 是 Runtime 对账依据

Runtime 记录已经成功 Apply 的 Project Migration 及必要执行元数据，用于判断：

- 当前 Runtime Backend Model 对应哪个 Migration History；
- 是否存在缺失、重复、被修改或顺序不一致的 Migration；
- 是否需要拒绝启动、进入只读诊断模式或要求显式修复。

### 6. Drift Detection 是正式能力

Modelry 必须比较 Project Migration History、Runtime Migration Ledger、Runtime Backend Model 与 Schema Snapshot，并明确报告 Drift。

Drift 至少区分：

- Workspace ahead of Runtime；
- Runtime ahead of Workspace；
- Applied Migration content changed；
- Missing Migration；
- Snapshot stale / inconsistent；
- Runtime Model inconsistent with Ledger。

Drift 不允许被静默忽略。

### 7. Admin、CLI、MCP 共享 Migration 产物

任何 Backend Model 结构变更均通过：

`ChangeSet -> Diff + Risk -> Apply -> Migration Artifact -> Runtime Migration Ledger -> Snapshot`

不能存在“Schema 已改但没有对应 Project Migration”的正常路径。

Project Workspace 可写时，可以直接写出 Migration Artifact 与更新后的 Snapshot；只读生产 Workspace 中，Runtime 仍必须保存等价的完整 Artifact 并提供导出/同步流程。

### 8. Migration Risk Classification 是执行语义

V0.1 的**主风险级别**至少包括：

- **SAFE** —— 不预期破坏已有数据；
- **DATA_REWRITE** —— 需要扫描、转换或重写已有 Record；
- **DESTRUCTIVE** —— 可能删除数据、让旧数据不可访问，或改变数据含义；
- **IRREVERSIBLE** —— 无法依赖自动反向操作恢复原状态，必须依靠 Backup/Checkpoint 或新的补偿 Migration。

主风险级别按严重程度递增：

`SAFE < DATA_REWRITE < DESTRUCTIVE < IRREVERSIBLE`

一个 Migration 如果同时符合多个风险特征，必须按**最高适用风险级别**归类。实现可以附加 `requiresBackfill`、`dropsData`、`requiresCheckpoint` 等详细影响 Flag，但不能用多个并列主级别替代唯一可比较的 Risk Level。

Risk Classification 必须由实际 Migration Operation 与当前数据状态共同决定，不能只由操作名称静态决定。

例如新增唯一 Index：空表或数据满足唯一性时可能是 SAFE；存在重复数据时则前置条件失败，必须先处理数据，不能直接 Apply。

### 9. 非平凡 Migration 必须有 Preconditions

Migration Apply 前必须验证适用前置条件，例如：

- Field 是否存在/不存在；
- 目标类型是否允许转换；
- 唯一约束是否已有冲突；
- Required Field 是否能为历史 Record 提供 Default/Backfill；
- Relation 基数变化是否与现有数据兼容；
- Drop/Rename 目标是否仍被 Policy、Index、Hook 或其他 Schema 引用。

Precondition 失败时必须在任何结构变化发生前终止，并返回机器可读错误。

### 10. 破坏性 Migration 需要确认与恢复点

对 DESTRUCTIVE / IRREVERSIBLE 变更：

- ChangeSet 必须明确展示潜在数据影响；
- 默认要求显式确认；
- 在可行时生成安全 Backup/Checkpoint；
- 不允许静默丢弃不可转换数据；
- 失败必须保持数据库处于一致状态；
- 不承诺所有 Migration 都有自动 down migration。

Modelry 的恢复模型优先是：

`Backup/Checkpoint + forward fix Migration`

而不是承诺每个结构操作都能无损逆向执行。

### 11. 类型变更必须有明确转换策略

`field.type_change` 等 Data Rewrite 操作不能只修改 Metadata。

Spec 必须为每种支持的类型转换定义：

- 是否允许自动转换；
- 是否需要显式 conversion strategy；
- 无法转换的 Record 如何处理；
- 是否允许 dry-run 统计影响范围；
- 失败是否整体回滚。

未定义转换语义的类型组合必须拒绝执行。

### 12. Rename 与 Drop 必须保持语义可追踪

Rename 应尽量作为显式 `rename` operation 表达，而不是 `drop + add`，以便 Diff 可理解、Agent 能判断实体连续性，并避免数据因实现细节意外丢失。

Drop 必须被视为潜在破坏性操作，并检查引用关系与数据影响。

### 13. Backup 采用 Full Snapshot First

V0.1 不做增量备份体系。

Backup 至少覆盖：

- 数据库一致性 Snapshot；
- Local Storage；
- System Metadata；
- Migration Ledger；
- 加密 Secret Material；
- Backup Manifest。

运行中的 SQLite 必须使用正确的一致性 Snapshot/Backup 机制，不能简单复制活动 WAL 数据库文件。

S3 Compatible Storage 默认记录必要 Provider/Manifest 状态；远程 Object 全量归档应作为显式选项。

### 14. Restore 是显式高风险操作

Restore 必须经过：

`validate -> version compatibility check -> safe target restore -> verify -> activate`

默认不直接覆盖当前正在运行的数据目录。

Restore 属于高风险 Control Plane 操作，应进入 Audit，并服从明确确认机制。

### 15. System Migration 与 Project Migration 分离

Project Migration 描述用户 Backend Model 演化。

System Migration 描述 Modelry Runtime 自身内部 Schema/Metadata 升级，例如 Session Store、Migration Ledger、System Metadata 变化。

二者具有不同生命周期，不能混入同一个用户 Migration 序列。

### 16. Runtime Upgrade 以替换 Binary 为主

V0.1 不要求实现 `self-update`。

升级流程应包含：

`new binary -> compatibility check -> system migration plan -> safe backup/checkpoint -> system migration -> start`

不承诺任意版本无损 Downgrade。Downgrade 兼容性必须按版本明确声明。

### 17. Doctor 是正式诊断入口

Doctor 应检查至少：Config、Migration Drift、Database Integrity、Storage、Secret References、Hook Loading、Runtime Version、Schema Snapshot。

诊断结果应尽量使用稳定、机器可读的状态码，便于 Coding Agent 处理。

## 结果

### 正面影响

- Backend 结构天然进入 Git/PR 审查流程；
- Coding Agent 可以读取 Repository 理解当前 Backend；
- 不再存在“Backend Model Source 到底是哪一份文件”的第四真相源歧义；
- Admin、CLI、MCP 变更不会形成不可追踪的运行时孤儿状态；
- Risk Level 可以稳定排序并驱动自动化确认/恢复策略；
- 破坏性变更有明确风险、前置条件与恢复路径；
- Backup/Restore/Upgrade 仍保持 SQLite First 与 Single Binary First 的产品边界。

### 负面影响

- Runtime 必须维护 Migration Ledger、Snapshot 和 Project Artifact 的一致性；
- Migration Planner 需要理解当前数据状态和依赖引用，而不仅仅生成 DDL；
- 类型转换、唯一约束、Drop/Rename 等场景需要大量边界测试；
- 只读生产环境需要额外 Migration Export 工作流；
- 声明式 Migration 会限制直接使用任意数据库原生 DDL，需要持续扩展 Backend Model Operation 集合。

## Spec Gate

`to-spec` 必须把 **Migration Safety Model** 作为独立章节，至少覆盖：

- Risk Level 与 impact flags；
- precondition；
- dry-run/impact preview；
- confirmation；
- checkpoint/backup；
- atomicity；
- failure recovery；
- rename/drop/type change/unique index/relation cardinality change。
