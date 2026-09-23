# ADR-0002：采用声明式 Backend Model 与可审计 ChangeSet

- **状态：** Accepted
- **日期：** 2026-09-02

## 背景

Modelry 既会被人类通过 Admin UI / CLI 操作，也会被 Coding Agent 通过 MCP 操作。如果每个入口都直接修改物理数据库或内部 Metadata，会导致行为不一致、审计能力薄弱，并增加未来存储演进的成本。

尤其是 AI 驱动的变更，需要一个在 Apply 前可检查、Apply 后可追踪的统一控制面。

## 决策

**Backend Model 是产品层 Source of Truth。**

物理数据库是实现与存储目标，不是管理 API。

Schema 和受管配置变更统一通过 **ChangeSet** 流转：

`Inspect -> Propose -> ChangeSet -> Diff + Risk -> Confirm/Auto Apply -> Migration/Config Change -> Audit`

ChangeSet 至少记录：来源 Principal、拟议变更、Before/After Diff、风险分级、可逆性、可用时的变更原因，以及最终 Apply 结果。

MCP 明确拆分 Read / Propose / Apply 能力。通用且无限制的 `execute_sql` 不作为 Agent 的主要控制入口。

授权语义遵循后续 ADR 的平面分离：

- Application Data Access 由 Record Policy 约束；
- Control Plane 管理能力由 Capability Scope 约束；
- Agent 是一种 Principal，而不是隐式数据库管理员；
- Administrative Data Access 必须使用显式管理能力并进入 Audit。

## 影响

### 正面影响

- Admin UI、CLI、MCP 和未来工具统一到同一套 Backend Model / ChangeSet 语义；
- Agent 变更具备可解释、可 Diff、可风险分级、可审计能力；
- Storage 可以演进，而无需重定义产品模型；
- Migration 自然成为 Backend Model 变更的结果，而不是零散 SQL 历史；
- Data Plane 与 Control Plane 可以分别采用明确的授权原语。

### 负面影响

- Modelry 需要自行实现 Schema / Change Engine，而不是直接暴露数据库管理能力；
- 某些高级数据库原生特性必须先被 Backend Model 明确表达，才能作为产品能力开放；
- ChangeSet 与风险语义会增加前期设计工作，但这是进入实现前必须承担的复杂度。
