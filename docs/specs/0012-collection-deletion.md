# 集合删除规格

- 状态：已实现（#43 画板 6「数据 · 删除集合确认」）
- 适用范围：`DELETE /admin/api/v1/collections/{collectionId}`
- 实现：`internal/backendapi/deletion.go`、`internal/runtime/collection_deletion.go`

## 1. 为什么需要单独规格

Figma 定义了「删除集合」的确认流程，但后端没有任何集合删除能力。这不是补一个 DELETE 语句：
一个集合在 SQLite 里横跨 11 张表、一张动态投影表和外部文件对象，任一步遗漏都会留下孤儿数据。

`internal/storage/sqlite.go` 显式开启 `foreign_keys(1)`，因此**不能依赖数据库级联**，
必须按依赖顺序显式删除。

## 2. 受影响的数据（已核对建表语句）

| 表 | 关联列 | 所属模块 |
| --- | --- | --- |
| `modelry_backend_collections` | `id` | backendmodel |
| `<RecordTableName(collectionID)>` | 动态表 | storage |
| `modelry_backend_apply_attempts` | `change_set_id` → changes | backendmodel |
| `modelry_backend_changes` | `collection_id` | backendmodel |
| `modelry_backend_applied_migrations` | `collection_id` | backendmodel |
| `modelry_access_rules` | `collection_id` | accesscontrol |
| `modelry_auth_configurations` | `collection_id` | appauth |
| `modelry_app_password_credentials` | `collection_id` | appauth |
| `modelry_app_sessions` | `collection_id` | appauth |
| `modelry_app_recovery_tokens` | `collection_id` | appauth |
| `modelry_record_events` | `collection_id` | recordevents |
| `modelry_record_event_sequences` | `collection_id` | recordevents |
| `modelry_record_event_watermarks` | `collection_id` | recordevents |

外部副作用：该集合引用过的 File Field 对象（本地目录或 S3 兼容存储）。

## 3. 删除顺序

```text
1. applied_migrations    （它外键引用 apply_attempts，必须先删）
2. apply_attempts        （先于 changes）
3. changes
4. record_events / sequences / watermarks
5. access_rules
6. auth_configurations / password_credentials / sessions / recovery_tokens
7. extension_bindings    （外键引用 collections，显式清理而非依赖级联）
8. DROP TABLE <记录投影表>
9. DELETE FROM modelry_backend_collections
```

实现时核对建表语句发现：`modelry_backend_applied_migrations.apply_attempt_id`
外键引用 `modelry_backend_apply_attempts(id)`，且没有 `ON DELETE CASCADE`。
因此第 1、2 步的顺序必须与原规格草稿相反，否则 `foreign_keys(1)` 会拒绝删除。
这里以真实约束为准。

前 7 步、第 8 步与第 9 步在同一事务内（SQLite 支持 DDL 事务）。
文件对象清理在事务提交之后执行，且只清理删除后已不被任何集合引用的对象；
失败不回滚集合删除，只在响应的 `pendingFileObjects` 里回报待处理数量。

`modelry_request_records`、`modelry_extension_intents/runs`、`modelry_automation_event_hooks`
中的 `collection_id` 是历史事实与业务逻辑配置，不属于集合自身的数据，按 Figma 画板 6
「notes API 与欢迎笔记逻辑将无法正常使用」的语义保留，不随集合删除。
`modelry_audit_records` 中的 `collection.deleted` 事实同样保留。

## 4. 语义与安全

- 权限：仅 Owner，或具备集合管理权限的身份。
- 审计：提交后写一条 `collection.deleted` 事实，包含集合 ID、名称、删除的记录数与会话数。
  被删除集合自身的审计历史保留，不随集合删除。
- 不可恢复：响应里明确 `irreversible: true`；前端必须要求输入集合名称确认。
- 记录数与会话数在事务内先统计，用于审计与响应，避免删除后无法回报影响范围。
- 进行中的变更：存在 `ready` / `needsReview` 的待应用变更时，删除前先做一次预检，
  默认一并删除并在响应中返回 `discardedChanges`；不静默忽略。

## 5. 接口

```http
DELETE /admin/api/v1/collections/{collectionId}
```

```json
{
  "data": {
    "collectionId": "col_...",
    "name": "notes",
    "deletedRecords": 8,
    "discardedChanges": 1,
    "revokedSessions": 2,
    "irreversible": true
  }
}
```

错误：

- `404 NOT_FOUND`：集合不存在
- `409 CONFLICT`：存在正在应用的变更（`applying`），稍后重试
- `403 FORBIDDEN`：权限不足

## 6. 验收

1. 有记录、有待应用变更、有应用用户与会话的集合，删除后 13 处数据全部消失；
2. 记录投影表被 DROP，`modelry_backend_collections` 中不再有该行；
3. 审计留下 `collection.deleted`，且其它集合的审计不受影响；
4. 删除后刷新页面、重启 Runtime，集合仍不存在；
5. 未知 collectionId 返回 404，不产生任何写入；
6. 事务中途失败时，集合与全部子数据保持原样（用注入失败验证）。
