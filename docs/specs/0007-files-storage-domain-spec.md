# Files and Storage Domain Spec (Community V0.1.x)

- **Status:** Accepted
- **Date:** 2026-09-25
- **Issue:** [#25](https://github.com/liujingwen1225/modelry/issues/25)
- **Depends on:** [ADR-0005](../adr/0005-file-values-and-storage-providers.md), [Local File Values and Storage Providers](../product-model/0002-files-and-storage.md), [Admin Product UX Spec](./0001-admin-product-ux-spec.md), [Extension Runtime Domain Spec](./0005-extension-runtime-domain-spec.md)
- **Contract:** [OpenAPI](../contracts/openapi.yaml)

本 Spec 定义 Multiple File values、Local 与 S3-compatible Storage Provider、Provider migration、Diagnostics 与 Admin 行为。Transport 细节以 OpenAPI 为准；本 Spec 定义领域语义。

## 1. Scope

- `file` Field 保存单个 File value；`files` Field 保存有序 File value 列表。
- File constraint：`maxBytes`、`allowedMimeTypes`、`maxFiles`。
- Storage Provider：`local` 与 `s3`（S3-compatible，AWS Signature V4）。
- 上传、绑定、替换、删除、reconcile 生命周期对两个 Provider 语义一致。
- Provider 配置、连接测试、Provider migration、健康诊断。
- Admin 与 Application 读取路径，不暴露路径、桶名、对象 URL 或凭据。

## 2. Non-goals

- 独立 DAM、File Collection、File 级权限。
- 图片处理、病毒扫描、CDN、多区域复制、客户端直传、presigned URL。
- 分布式队列、外部 broker、跨 Project migration。
- Provider marketplace 或任意第三方插件。
- 删除源 Provider 数据（migration 只复制，不清理源）。

## 3. Domain model

### 3.1 File value

- `file` 值：单个 opaque 对象引用，格式 `obj_` + 32 位小写十六进制。
- `files` 值：opaque 对象引用的 JSON 数组，保持顺序，长度 `1..maxFiles`；`null` 或空数组表示未设置。
- 写入时允许临时引用 `tmp_` + 32 位小写十六进制；临时引用只能绑定到它上传时所属的 Collection 与 Field。
- Record 值不包含文件名、路径、桶名、Provider 名、endpoint、大小或凭据。
- `files` Field 不支持 `unique`；`file` Field 保持现有语义。
- `files` Field 不支持 filter 与 sort；请求返回 `INVALID_ARGUMENT`。

### 3.2 File constraint

| 字段 | 类型 | 范围 | 默认 | 适用范围 |
| --- | --- | --- | --- | --- |
| `maxBytes` | integer | 1..134217728 (128 MiB) | 10485760 (10 MiB) | `file`、`files` |
| `allowedMimeTypes` | string[] | 1..16 项，合法 MIME 或 `type/*` | `application/pdf`、`image/gif`、`image/jpeg`、`image/png`、`image/webp`、`text/csv`、`text/plain` | `file`、`files` |
| `maxFiles` | integer | 1..32 | 8 | 仅 `files` |

- 上传时的调用方策略只能收紧 Field constraint，不能放宽。
- `file` Field 声明 `maxFiles` 时 Pending change 校验失败（`INVALID_ARGUMENT`）。
- `maxFiles` 超出上限或 `allowedMimeTypes` 为空/重复/非法时校验失败。
- 已有 Record 的 Re-validate 在 Apply 前执行；不兼容时 Precondition `FIELD_VALUE_INCOMPATIBLE` 失败。

### 3.3 Staged upload

- 上传始终先进入 Runtime 管理的本地暂存目录（`.modelry/files/tmp`），与 Provider 无关。
- 暂存响应返回 `temporaryId`、`contentType`、`size`；`contentType` 由前 512 字节嗅探得到，不使用调用方文件名或请求头声明。
- 暂存文件与内存记录在 15 分钟宽限期后由 reconcile 回收；未绑定的暂存不会进入 migration。
- 同一 Runtime 最多同时保留 64 个暂存上传。

### 3.4 Storage Provider 配置

- 每个 Project 恰好一份配置，默认 `provider=local`、`revision=1`。
- `PUT` 必须携带 `expectedRevision`；版本不匹配返回 `CONFLICT`。
- S3 配置项：`endpoint`、`region`、`bucket`、`keyPrefix`、`pathStyle`、`accessKeySecretId`、`secretKeySecretId`、`sessionTokenSecretId`（可选）。
- `endpoint` 必须为 HTTPS；loopback、private、link-local 主机允许 HTTP，便于自托管 MinIO。不允许 user information、query、fragment、非 http(s) scheme。
- `bucket` 1..63 字符（`[a-z0-9.-]`）；`keyPrefix` 0..128 字符，仅 `[A-Za-z0-9._/-]`，不以 `/` 开头，不以 `..` 段出现；`region` 1..64 字符。
- 凭据必须是已存在且已配置的 Project Secret；Secret 缺失、被删除或不可解密时 Provider 不可用（fail closed），不回落匿名请求。
- 凭据在每次 Provider 操作（或一次 migration 运行）内解密到内存，仅用于该次签名，结束后不再持有；不写入 SQLite、RequestRecord、Audit、日志或响应。

### 3.5 Provider 切换规则

- 当 Project 仍被 Durable Record 引用的 File object 数量为 0 时，允许直接 `PUT` 切换 Provider。
- 引用数量大于 0 时：
  - 切换 Provider 返回 `409 MIGRATION_REQUIRED`。
  - 在 `provider=s3` 时修改 `endpoint`、`bucket`、`keyPrefix`、`pathStyle` 返回 `409 MIGRATION_REQUIRED`。
  - 修改 `region`、凭据引用、或 `provider=local` 时的无关字段允许直接保存。
- Provider 切换为 Control Plane 写入，不修改任何 Record 行。

### 3.6 Migration

状态机：

```text
pending -> running -> completed
                   -> failed
                   -> cancelled
pending -> cancelled
running|pending -> interrupted   (Runtime restart)
```

- 触发：`POST /admin/api/v1/storage/files/migrations`，body 携带目标 Provider 配置快照。
- 前置：目标 Provider 与当前不同；目标配置可校验；不存在 `pending`/`running` migration（否则 `409 MIGRATION_ACTIVE`）。
- 过程：枚举 Durable Record 引用的对象引用（去重、排序，稳定顺序）；对每个引用：目标已存在且大小一致则跳过；否则从当前 Provider 读取并写入目标 Provider，然后校验大小。
- 单次最多一个对象在传输；每对象 30 秒 deadline；`totalObjects` 上限 100000；每次运行复制上限 100000 个对象。
- 进度耐久保存：`totalObjects`、`copiedObjects`（含跳过）、状态、时间戳、安全错误码。
- 完成：在单个 SQLite 事务中校验 `copiedObjects == totalObjects`，写入新 Provider 配置并递增 revision，写 Audit `storage.migrationCompleted`，migration 置 `completed`。
- 失败：写入安全错误码（`providerUnavailable`、`credentialUnavailable`、`objectWriteFailed`、`verificationFailed`），当前 Provider 不变，migration 置 `failed`。
- 取消：`POST .../{id}/cancel` 在 `pending`/`running` 时生效；取消后当前 Provider 不变。
- 重启：启动时把 `running`、`pending` migration 置为 `interrupted`，不自动继续。Owner 可重新触发；已存在的目标对象被跳过，因此重试幂等。
- Migration 不删除源对象，不迁移暂存与未引用对象。

## 4. Read path

- Admin 单文件：`GET /admin/api/v1/collections/{collectionId}/records/{recordId}/files/{fieldName}`（仅 `file` Field）。
- Admin 多文件：`GET /admin/api/v1/collections/{collectionId}/records/{recordId}/files/{fieldName}/{fileIndex}`（仅 `files` Field，0-based）。
- Application 对应：`GET /api/v1/{collectionName}/{recordId}/files/{fieldName}` 与 `.../{fileIndex}`，继续执行 Collection view Access Rule。
- 响应头：`Content-Type`、`Content-Length`、`Content-Disposition: attachment`、`X-Content-Type-Options: nosniff`、`Cache-Control: private, no-store`。
- 索引越界、引用不存在、对象不可读均返回 `404 NOT_FOUND`，不返回空体。
- 路由不匹配（例如对 `file` Field 使用索引路由）返回 `400 INVALID_ARGUMENT`。

## 5. Diagnostics

`GET /admin/api/v1/storage/status` 增加 `fileStorage`：

```json
{
  "state": "ready",
  "provider": "Local",
  "activeProvider": "local",
  "message": "Local Storage is responding.",
  "hint": ""
}
```

`GET /admin/api/v1/storage/files`（Owner session）返回：

- `activeProvider`、`revision`、`providerState`（`ready`/`degraded`/`unavailable`）、`providerMessage`、`providerHint`。
- `configuration.provider`、`configuration.local.path`（Owner-only）、`configuration.s3`（endpoint、region、bucket、keyPrefix、pathStyle、凭据 Secret 元数据，绝不含明文）。
- `health`：`state`、`message`、`hint`、`observedAt`、`referencedObjects`。
- `migration`：`active` 与最近一次 migration 摘要。

Provider health 探测有界且非破坏：Local 校验暂存与对象目录可写；S3 执行一次带 prefix 的 list（`max-keys=1`）并在配置了对象时 `HEAD` 一个引用。5 秒 deadline。

Request History 与 Request Detail 必须保留 Deep Link Context：多文件读取请求既记录安全路由模板（/api/v1/{collectionName}/{recordId}/files/{fieldName}/{fileIndex}），也能从模板解析回对应端点深链接。

## 6. Errors

| Code | HTTP | 触发 |
| --- | --- | --- |
| `INVALID_ARGUMENT` | 400 | 约束非法、索引路由用于单文件、`files` Field 使用 filter/sort |
| `NOT_FOUND` | 404 | Record、Field、对象或 migration 不存在 |
| `STORAGE_PROVIDER_NOT_CONFIGURED` | 409 | 目标 Provider 配置缺失或不完整 |
| `STORAGE_CREDENTIAL_UNAVAILABLE` | 409 | 引用的 Secret 缺失或无法解密 |
| `STORAGE_PROVIDER_UNAVAILABLE` | 503 | Provider 不可达、超时或返回非 2xx |
| `MIGRATION_REQUIRED` | 409 | 有引用对象时直接切换 Provider 或移动对象位置 |
| `MIGRATION_ACTIVE` | 409 | 已有 `pending`/`running` migration |
| `MIGRATION_NOT_ACTIVE` | 409 | 取消已终止的 migration |
| `CONFLICT` | 409 | `expectedRevision` 不匹配 |
| `UNAUTHENTICATED` | 401 | 非 Owner session |

错误响应遵循既有 envelope：`{ "error": { "code", "message", "details", "hint" } }`，且不包含凭据、签名、对象 URL 或绝对路径（Local path 仅出现在 Owner-only 的 storage/files 成功响应中）。

## 7. Audit

Audit action：`storage.providerConfigured`、`storage.providerTested`、`storage.migrationStarted`、`storage.migrationCancelled`、`storage.migrationCompleted`、`storage.migrationFailed`。

- 每条 AuditRecord 包含 Owner 身份、Provider 类型、migration ID（如适用）与结果。
- 不包含 endpoint 全量、bucket 之外的凭据信息、Secret 值、对象引用清单。`bucket` 与 `endpointHost` 为安全元数据，可进入 Audit。
- 配置写入与 Audit 在同一 SQLite 事务提交；migration 完成时的配置切换与 Audit 同事务。

## 8. Bounds

| 项目 | 上限 |
| --- | --- |
| 单文件 | 128 MiB |
| Field 默认单文件 | 10 MiB |
| `files` 每 Field 数量 | 32 |
| 并发暂存上传 | 64 |
| 暂存宽限期 | 15 分钟 |
| 孤儿对象宽限期 | 1 小时 |
| 单次 reconcile 扫描 | 1000 个对象 |
| S3 list 分页 | 1000 |
| 单对象 S3 deadline | 2 秒 |
| Provider health deadline | 5 秒 |
| migration 并发 | 1 |
| migration 单对象 deadline | 30 秒 |
| migration 对象总数 | 100000 |
| migration 历史保留 | 50 |

## 9. Acceptance

1. `files` Field 可绑定、替换、重排、读取与清空；`file` Field 行为不变。
2. Local 与 S3-compatible 在相同 API 下语义一致（上传、绑定、读取、替换、reconcile、migration 后读取）。
3. 约束违规在暂存阶段拒绝，且不产生 Durable 副作用。
4. 失败事务留下可回收孤儿对象，reconcile 不删除被引用对象。
5. 有引用对象时直接切换 Provider 返回 `MIGRATION_REQUIRED`；migration 完成后读取路径不变。
6. Runtime 重启后 migration 状态为 `interrupted`，重试幂等，Provider 不变。
7. Provider 不可达时 Runtime 仍启动，非文件 Record 变更成功，文件操作 fail closed，diagnostics 显示 degraded。
8. 响应、Diagnostics、Audit 与 RequestRecord 不泄漏凭据、签名、对象 URL 或绝对路径。
