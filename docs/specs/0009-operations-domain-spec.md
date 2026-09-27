# Operations Domain Spec (Community V0.1.x)

- **Status:** Accepted
- **Date:** 2026-09-25
- **Issue:** [#27](https://github.com/liujingwen1225/modelry/issues/27)
- **Depends on:** [ADR-0007](../adr/0007-policy-activity-drift-and-settings.md), [Policy, Activity, Drift, and Runtime Settings](../product-model/0004-operations-and-governance.md), [V0.1 Foundation Spec](./0002-v0.1-foundation-spec.md), [Identity and Recovery Domain Spec](./0008-identity-and-recovery-domain-spec.md)
- **Contract:** [OpenAPI](../contracts/openapi.yaml)

本 Spec 定义 Policy Simulation、Activity、Drift Detection 与 Runtime Settings。Transport 细节以 OpenAPI 为准。

## 1. Scope

- Policy Simulation：对已应用 Access Rules 的非权威预演。
- Activity：来自产品事实的通用时间线。
- Drift Detection：Applied Model / Physical Projection / Runtime-Managed State 的一致性产品。
- Runtime Settings：带 source、validation、restart requirement 的 durable 配置。
- 上述能力的 Control Plane Permission、Audit 边界与 Deep Link。

## 2. Non-goals

- Hypothetical 规则改写、批量模拟、cascade 影响分析。
- 任意 debug log、日志文件读取、服务器端自由文本摘要。
- 自动 Apply、自动修改 Applied Model、破坏性修复、丢弃 Record 数据。
- Cloud / Enterprise 舰队配置、远程 Settings 推送、跨 Runtime 协调。
- OAuth / OIDC、PostgreSQL、分布式队列、微服务。

## 3. Domain model

### 3.1 Policy Simulation

- 输入：`collectionId`、`operation`（`list` / `view` / `create` / `update` / `delete`）、`principal`（`kind`：`anonymous` / `owner` / `applicationUser` / `serviceAccount`，可选 `id`）、`record`（`recordId` 或 `payload` 之一，`create` 可省略）。
- 评估：调用 `accesscontrol.Service.EvaluateInTransaction`，与 Application API 使用同一 evaluator。
- 输出：`allowed`、`code`、`message`、`reason`、`decidingRule`（`operation` + `mode`）、`authoritative: false`、`notice`。
- 非权威性必须出现在响应体本身，而不只在 UI。
- 未知 Collection / operation / principal kind / recordId 返回 400 校验错误，不当作 Deny。
- Simulation 不写 RequestRecord、不写 Audit、不出现在 Activity。权限不足仍由 fail-closed 中间件拒绝并记录 denied 事实。

### 3.2 Activity

- Fact 字段：`id`（`af_` + 稳定标识）、`kind`、`status`、`occurredAt`、`resource`（`kind` + `id`）、可选 `collectionId`、可选 `title`、`deepLink`。
- `kind` 取值：`change.applied`、`change.pending`、`change.failed`、`webhook.delivery`、`job.run`、`extension.run`、`mail.delivery`、`storage.migration`、`auth.recovery`。
- Activity 明确排除 Request Log 与 Audit：实现不得查询 `modelry_request_records` 或 `modelry_audit_records`。
- 敏感材料一律不出现：payload、message body、token、凭据、Secret 值、App User email。`auth.recovery` 只引用 App User Record id。
- 每个 owning module 通过 `Facts(ctx, query, limit)` 暴露自己的事实查询；Activity 不直接读其它模块的表。
- 排序：`occurredAt` 倒序，`id` 倒序作为 tie-breaker；Cursor 编码上一页最后一个 fact 的 `(occurredAt, id)`。
- Activity 为只读，无后台 Worker。

### 3.3 Drift

- Finding 字段：`id`、`class`（`appliedModel` / `physicalProjection` / `runtimeState`）、`severity`（`info` / `warning` / `error`）、`code`、`collectionId`（可选）、`expected`、`actual`、`expectedPendingChange: bool`、`remedy`（`reconcile` / `manual` / `none`）、`deepLink`、`detectedAt`。
- Applied Model vs Physical Projection：对每个 Applied Collection 比较期望的 Record table、column、index 与 SQLite 实际状态。缺失表、缺失列、列类型不匹配、缺失索引、以及 Applied Model 未声明的多余投影表都是 finding。
- Runtime-Managed State：interrupted apply attempt、failed change、以及未被任何 Applied Collection 支撑的投影表。
- Expected Pending Change：存在 Pending Change 时输出 `expectedPendingChange: true` 的 info 级 finding，`severity=info`，`remedy=manual`，Deep Link 指向 Changes / Schema。
- Reconcile：只重建 Applied Model 的物理投影（表、列、索引），幂等，不 Apply Pending Change，不修改 Applied Model，不删除 Record，不删除列或表。每次调用只处理一个 Collection。
- Reconcile 追加 Audit fact `drift.reconciled`，与修复处于同一事务。无法自动修复的 finding 返回 `remedy: manual`。

### 3.4 Runtime Settings

- 单例、revision guarded、durable。字段：`listenAddress`、`requestRetentionDays`、`revision`、`updatedAt`。
- 每项返回：`value`、`source`、`restartRequired`、`bounds`（或 validation 说明）。
- `source` 取值：`flag`（显式 runtime flag）、`project`（Project 存储值）、`default`（内建默认）。
- 优先级：`flag` > `project` > `default`。`flag` 生效时不因保存而被静默覆盖。
- `listenAddress`：`host:port`，端口为有效 TCP 端口；`restartRequired: true`；保存只持久化并报告，不改变正在运行的 listener。
- `requestRetentionDays`：1–3650；`restartRequired: false`；由 Request log 模块的 bounded、cancellable、restart-aware pruner 生效。
- 保存校验失败返回 422 `VALIDATION_FAILED`，不得夹紧或纠正取值。
- 版本冲突返回 409 `CONFLICT`。

### 3.5 Permission 与 Audit

- 新增 Control Plane operation：`activity.read`、`drift.read`、`drift.reconcile`、`policy.simulate`、`settings.read`、`settings.write`。
- `readOnly` preset 包含：`activity.read`、`drift.read`、`policy.simulate`、`settings.read`。
- Owner-only 资源：`settings.write`、`drift.reconcile`（即使 Administrator 持有 `fullAccess` 也被拒绝）。
- 未映射的 Control Plane 路由仍然只有 Owner 可用。
- Audit facts：`runtimeSettings.updated`、`drift.reconciled`。Simulation 与 Activity 读取不产生 Audit fact。

## 4. HTTP surface

| Method | Path | Permission |
| --- | --- | --- |
| `POST` | `/admin/api/v1/collections/{collectionId}/access-rules/simulate` | `policy.simulate` |
| `GET` | `/admin/api/v1/activity` | `activity.read` |
| `GET` | `/admin/api/v1/drift` | `drift.read` |
| `POST` | `/admin/api/v1/drift/reconcile` | `drift.reconcile`（Owner-only） |
| `GET` | `/admin/api/v1/settings` | `settings.read` |
| `PUT` | `/admin/api/v1/settings` | `settings.write`（Owner-only） |

## 5. Bounds

- Simulation：请求体 ≤ 256 KiB；inline payload ≤ 64 个字段。
- Activity：`limit` ≤ 50；每个来源每页最多读取 500 条候选事实。
- Drift：最多 512 个 Collection、2,048 条 finding；Reconcile 每次一个 Collection。
- Settings：2 个 setting；retention prune 每次 ≤ 5,000 条 Request record，每分钟 ≤ 1 次。

## 6. Errors

- `INVALID_ARGUMENT` / `VALIDATION_FAILED`：输入不合法（未知 operation、未知 principal kind、非法 listen address、越界 retention）。
- `NOT_FOUND`：Collection 或 Record 不存在。
- `CONFLICT`：Settings revision 冲突。
- `FORBIDDEN`：Permission 不足，或命中 Owner-only 资源。
- `INTERNAL_ERROR`：存储或投影读取失败；不泄漏 SQL 细节。

## 7. Acceptance

- Simulation 对同一输入与真实请求给出相同 Allow / Deny 结论，且响应标注非权威。
- Activity 覆盖所有已实现来源的 fact，且不出现 Request Log、Audit、payload、token、凭据或 App User email。
- Drift 在健康项目返回空 finding；人为破坏投影后出现 `physicalProjection` finding 并能通过 Reconcile 修复；Pending Change 只以 `expectedPendingChange` 呈现。
- Runtime Settings 保存 `listenAddress` 后报告 `restartRequired: true` 且运行中的 listener 不变；重启后使用新值；`requestRetentionDays` 无需重启即生效。
- 全部能力具备 Deep Link，且由 Chromium 验收覆盖真实 Runtime、真实 SQLite、真实 HTTP。