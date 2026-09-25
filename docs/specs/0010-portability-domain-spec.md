# Portability and Developer Interfaces Domain Spec (Community V0.1.x)

- **Status:** Accepted
- **Date:** 2026-09-25
- **Issue:** [#28](https://github.com/liujingwen1225/modelry/issues/28)
- **Depends on:** [ADR-0008](../adr/0008-backup-restore-import-export-and-generated-artifacts.md), [Project Portability and Developer Interfaces](../product-model/0005-portability-and-developer-interfaces.md), [V0.1 Foundation Spec](./0002-v0.1-foundation-spec.md), [Operations Domain Spec](./0009-operations-domain-spec.md)
- **Contract:** [OpenAPI](../contracts/openapi.yaml)

本 Spec 定义 Backup Bundle、Restore、Collection Export/Import、Typed Application API Contract 与 Generated Artifacts。Transport 细节以 OpenAPI 为准。

## 1. Scope

- Backup Bundle 的内容、格式、完整性元数据与版本识别。
- Restore 的 preflight 与 apply 语义。
- Collection Export / Import 与其 schema 处理。
- Typed Application API Contract 与可复现生成物。
- CLI 与 Admin Surface、Permission 与 Audit。

## 2. Non-goals

- Cloud / Enterprise 舰队备份、远程对象存储目标、保留策略引擎、定时备份服务。
- Merge / partial restore、对运行中项目的 restore、对更新格式的静默覆盖。
- 导入 File 字节、SQL dump、表级导入导出、直接写数据库。
- 发布 SDK 到包仓库、把生成物当作权威来源。
- OAuth / OIDC、PostgreSQL、分布式队列。

## 3. Domain model

### 3.1 Backup Bundle

- 归档格式：`tar`。条目顺序固定：`manifest.json`、`database/project.sqlite`、`objects/<key>`（按 key 升序）。
- `manifest.json` 字段：`format`（`modelry.community.backup`）、`formatVersion`（1）、`projectId`、`runtimeVersion`、`createdAt`、`appliedModelHash`、`database`（`path`、`bytes`、`sha256`、`sqliteVersion`）、`objects[]`（`key`、`bytes`、`sha256`）、`counts`（`collections`、`records`、`objects`）。
- 数据库载荷使用 SQLite `VACUUM INTO` 从运行中的数据库产生一致快照，包含已提交的 WAL 内容；禁止直接复制 `project.sqlite`。
- File object 只包含 Applied Model 当前引用的对象；`objects[]` 与归档条目必须一一对应。
- 归档以流式方式产生与写出，不在内存中缓存整个项目。

### 3.2 Restore

- Preflight（只读）校验：
  - `format` 与 `formatVersion` 受支持；
  - manifest 列出的每个条目存在且 SHA-256 匹配；
  - 归档中不存在未列出的条目；
  - 数据库载荷可打开并包含 Modelry 内部 migration 表；
  - 数据库格式版本不高于当前 Runtime。
- Preflight 输出结构化 finding：`code`、`severity`（`info`/`warning`/`error`）、`message`，以及 `compatible` 布尔值、`projectId`、`runtimeVersion`、`createdAt`、`counts`。
- Apply：
  - 若项目 Runtime lock 被其它进程持有，直接拒绝；
  - 若项目目录已有项目且未提供 `--force`，拒绝并报告将替换的内容；
  - 先解压到 managed directory 内的 staging 目录，重新校验 staged 数据库，然后才替换数据库与 object store；
  - 失败时不改变原项目状态。
- Admin Surface 只提供 preflight；in-place apply 只能通过 CLI 在已停止的项目上执行。
- Runtime 内执行的 preflight 写入 Audit fact `restore.preflight`。

### 3.3 Export / Import

- 格式：NDJSON。
  - 首行 `{"kind":"collection","collectionId":…,"name":…,"type":…,"appliedModelHash":…,"fields":[…]}`；
  - 其后每行 `{"kind":"record","values":{…}}`（导出附带 `"id"`）。
- Export 通过 Records Service 读取已提交 Record，`appliedModelHash` 由 Applied Model 计算；File 字段导出 object key，绝不导出字节；Password Credential、Session、Secret 永不导出。
- Import 通过 `records.Service.Create` 创建每条 Record，因此 Field Validation、Required、Unique、Relation、File 引用规则与 Application API 完全一致。
- Import 在 header 的 `appliedModelHash` 与当前 Applied Model 不一致时整体拒绝（409 `MODEL_MISMATCH`），不做字段猜测。
- Import 结果逐条返回：`index`、`status`（`created`/`failed`）、`recordId?`、`code?`。单条失败不影响后续 Record（除非请求本身不合法）。
- 每条 Record 保持自己的事务与副作用边界；整个导入不包在单个 SQLite 事务里。

### 3.4 Typed Application API Contract

- 内容来自 Applied Model：Collection 列表（id、name、type）、Field（id、name、type、required、unique、relation、file rules）、Applied Access Rule 摘要、以及既有 Application API endpoint 模板。
- 响应包含 `version`（Runtime version）与 `contentHash`（规范 JSON 的 SHA-256）。
- 生成物：`application-api.json` 与 `modelry-client.ts`。两者按确定性顺序输出，不含时间戳与环境路径；同一 Applied Model 重复生成必须字节一致。
- 生成客户端只调用既有 `/api/v1/...` 路由，不引入新的服务端语义。

### 3.5 Permission 与 Audit

- 新增 Control Plane operation：`backup.create`、`restore.preflight`、`records.export`、`records.import`、`developer.read`。
- Owner-only 资源：`backup.create`、`restore.preflight`、`records.import`、`developer.read`。
- `readOnly` preset 包含：`records.export`。
- Audit facts：`backup.created`、`restore.preflight`。
- 未映射的 Control Plane 路由仍然只有 Owner 可用。

## 4. HTTP surface

| Method | Path | Permission |
| --- | --- | --- |
| `POST` | `/admin/api/v1/backup` | `backup.create`（Owner-only） |
| `POST` | `/admin/api/v1/restore/preflight` | `restore.preflight`（Owner-only） |
| `GET` | `/admin/api/v1/collections/{collectionId}/export` | `records.export` |
| `POST` | `/admin/api/v1/collections/{collectionId}/import` | `records.import`（Owner-only） |
| `GET` | `/admin/api/v1/developer/contract` | `developer.read`（Owner-only） |

## 5. Bounds

- Backup：最多 100,000 个 File object；快照写入 managed directory；归档 32 KiB 缓冲流式写出。
- Restore：最多 100,000 个归档条目、manifest 最大 64 MiB。
- Export：单次最多 100,000 条 Record；Import：单次最多 1,000 条 Record 且请求体最大 8 MiB。
- Contract：最多 512 个 Collection、每 Collection 最多 4,096 个 Field。

## 6. Errors

- `INVALID_ARGUMENT`：bundle 缺少 manifest、NDJSON 行不合法、header 缺失。
- `VALIDATION_FAILED`：preflight 发现不兼容（格式版本、digest 不匹配、额外条目、数据库不兼容）。
- `CONFLICT`：`MODEL_MISMATCH`（import header 与 Applied Model 不一致）、`PROJECT_IN_USE`（restore 时项目被占用）、`PROJECT_NOT_EMPTY`（未提供 --force）。
- `PAYLOAD_TOO_LARGE`：请求体超过 8 MiB。
- `FORBIDDEN`：Permission 不足或命中 Owner-only 资源。
- `INTERNAL_ERROR`：快照、归档或数据库读取失败；不泄漏 SQL 细节。

## 7. Acceptance

- 运行中的项目可以产生一致 backup，manifest 记录版本、身份与每个载荷的 digest。
- 篡改任一载荷或 manifest 后 preflight 必须失败，并且不写任何文件。
- restore 在项目被占用或未提供 `--force` 时拒绝；成功路径后项目可再次启动并保留 Record。
- Export → Import 往返后 Record 数量与值保持一致；违反 Validation/Relation/File 的 Record 在 Import 中逐条失败并给出稳定错误码。
- `modelry generate` 在同一 Applied Model 上重复执行产生字节一致的产物。
- 全部能力具备真实 Runtime、真实 SQLite、真实 HTTP 与 CLI 验收。