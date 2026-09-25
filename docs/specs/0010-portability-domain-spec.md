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
- 数据库载荷、引用对象集合、`counts` 与 `appliedModelHash` 必须来自同一个逻辑快照：它们从该快照读取，而不是从仍在变化的 Runtime 读取。
- File object 只包含 Applied Model 当前引用的对象；`objects[]` 与归档条目必须一一对应。
- 归档以流式方式产生与写出，不在内存中缓存整个项目。

### 3.2 Restore

- Preflight（只读）校验：
  - `format` 与 `formatVersion` 受支持；
  - manifest 列出的每个条目存在、字节长度与声明的 `bytes` 一致且 SHA-256 匹配；
  - 归档中不存在未列出的条目，也不存在重复条目；
  - 数据库载荷可打开并包含 Modelry 内部 migration 表；
  - 数据库格式版本不高于当前 Runtime。
- Bundle 的 manifest 是权威元数据；Preflight 验证 manifest 所描述的 payload 完整性与结构一致性。当前格式没有外层可信 digest 或签名，因此不承诺识别对 `counts`、`createdAt`、`runtimeVersion` 等 manifest 元数据的恶意重写，也不提供 Bundle 来源真实性证明。
- Preflight 输出结构化 finding：`code`、`severity`（`info`/`warning`/`error`）、`message`，以及 `compatible` 布尔值、`projectId`、`runtimeVersion`、`createdAt`、`counts`。
- Apply：
  - 若项目 Runtime lock 被其它进程持有，直接拒绝；
  - 若项目目录已有项目且未提供 `--force`，拒绝并报告将替换的内容；
  - 先解压到 managed directory 内的 staging 目录，重新校验 staged 数据库，然后才替换数据库与 object store；
  - 替换分三个阶段：先把全部新内容准备到目标所在目录，再统一把原内容移到备份位置，最后统一激活；每个状态变更前先将 journal intent 写入并同步；
  - POSIX 平台对每个受影响的 parent directory 执行真实目录 `fsync` 并传播错误。独立 commit marker 先写入、flush、同步，再原子 rename 并同步 managed directory；marker rename 后的 managed-directory `fsync` 成功是唯一 commit point。此前的失败回滚原状态，此后的崩溃恢复只清理备份，不回滚新状态；
  - Windows 当前无法通过 Go 标准库提供 POSIX directory `fsync`；使用文件 `Sync` 与同卷原子 rename，并明确依赖 Windows 文件系统的目录项耐久性保证，不宣称 POSIX 等价保证；
  - 只有「移开原件」这一步真正发生（备份文件存在）时，回滚才会删除目标位置的内容；否则目标是原件，必须原样保留；
  - 替换数据库时同时移除旧的 `project.sqlite-wal` / `-shm`，避免旧日志被回放到新数据库上；
  - 失败时不改变原项目状态：原数据库与原 object store 保持字节级不变；
  - 项目存在未完成的 journal 时，Runtime 拒绝启动，直到操作者用 CLI 再次执行 restore 把它收敛。
- 旧版仅以 `journalDone` 表示提交的 journal 无法证明当时的 `Sync` 是否成功；新 Runtime 与普通 restore 都 fail closed，不从该行推断提交。操作者检查并保留项目目录副本后，可在下一次显式 restore 时传入 `--force --resolve-legacy-restore=accept-current`，明确接受当前激活的目标并清理旧备份，再应用指定 Bundle；若要恢复旧状态，必须从保留的目录副本中手动恢复。新格式的 journal 不使用此兼容路径。
- Restore 恢复 bundle 描述的逻辑项目状态及其引用的 File object，不保证将目标 Provider 物理存储镜像成 bundle。目标中 bundle 未引用的旧对象可能暂时保留；它们仍按既有 File Storage orphan reconcile 与 grace period 策略回收，不扩大本次 Restore 的替换集合。
- Admin Surface 只提供 preflight；in-place apply 只能通过 CLI 在已停止的项目上执行。
- Runtime 内执行的 preflight 写入 Audit fact `restore.preflight`。

### 3.3 Export / Import

- 格式：NDJSON。
  - 首行 `{"kind":"collection","collectionId":…,"name":…,"type":…,"appliedModelHash":…,"fields":[…]}`；
  - 其后每行 `{"kind":"record","values":{…}}`（导出附带 `"id"`）。
- Export 通过 Records Service 读取已提交 Record，`appliedModelHash` 由 Applied Model 计算；File 字段导出 object key，绝不导出字节；Password Credential、Session、Secret 永不导出。
- Export 无损搬移每个产品字段的值（包括名字像秘密的普通字段，以及 JSON 字段里的高精度数字）；凭据不进入导出是因为它们不属于 Record，而不是因为字段名被过滤。
- Import 通过 `records.Service.Create` 创建每条 Record，因此 Field Validation、Required、Unique、Relation、File 引用规则与 Application API 完全一致。
- Import 要求 header 携带非空 `appliedModelHash`：缺失或空值整体拒绝（400 `INVALID_ARGUMENT`），与当前 Applied Model 不一致时整体拒绝（409 `MODEL_MISMATCH`）。省略 hash 不能绕过 model compatibility gate，也不做字段猜测。
- Import 结果逐条返回：`index`、`status`（`created`/`failed`）、`recordId?`、`code?`。单条失败不影响后续 Record（除非请求本身不合法）。
- 请求级失败（header 不合法、model 不匹配、请求体超过 8 MiB、Record 数超过 1,000、读取中断）返回结构化错误，绝不被一个看起来成功的部分摘要掩盖。因为每条 Record 有自己的事务，失败前的前缀可能已经提交，所以这类响应在 `details` 里报告 `created`/`failed` 计数。
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

这些上限各自约束自己描述的对象，任何一条都不能被当作整个 bundle 的上限：

- Backup：最多 100,000 个 File object；快照写入 managed directory；归档 32 KiB 缓冲流式写出。
- Restore：最多 100,002 个归档条目（含 manifest、数据库载荷与上限数量的 File object）；manifest 最大 64 MiB；单个 File object 载荷最大 128 MiB（与产品单文件上限一致，零字节对象合法）；单个数据库载荷最大 4 GiB；一个 bundle 声明的载荷总量最大 4 GiB。Preflight 按 manifest 自己声明的长度收紧读取预算，因此合法的大对象不会被整体上限误伤。Backup 使用同一组边界，因此它绝不会产出一份自己无法恢复的 bundle。
- Export：单次最多 100,000 条 Record；Import：单次最多 1,000 条 Record 且请求体最大 8 MiB。
- Contract：最多 512 个 Collection、每 Collection 最多 4,096 个 Field。这个上限只约束 Contract 的生成与读取：超过它时 Contract 明确失败，而 Backup、Export、Import 仍然读取完整的 Applied Model 并计算覆盖全部 Collection 的 `appliedModelHash`。

## 6. Errors

- `INVALID_ARGUMENT`：bundle 缺少 manifest、NDJSON 行不合法、header 缺失。
- `VALIDATION_FAILED`：preflight 发现不兼容（格式版本、digest 不匹配、额外条目、数据库不兼容）。
- `CONFLICT`：`MODEL_MISMATCH`（import header 与 Applied Model 不一致）、`PROJECT_IN_USE`（restore 时项目被占用）、`PROJECT_NOT_EMPTY`（未提供 --force）。
- `PAYLOAD_TOO_LARGE`：请求体超过 8 MiB。
- `FORBIDDEN`：Permission 不足或命中 Owner-only 资源。
- `INTERNAL_ERROR`：快照、归档或数据库读取失败；不泄漏 SQL 细节。

## 7. Acceptance

- 运行中的项目可以产生一致 backup，manifest 记录版本、身份与每个载荷的 digest。
- 篡改 payload、或使 manifest 与 payload 的长度/digest/归档结构不一致后，preflight 必须失败且不写任何文件；对仍然结构有效的 manifest 元数据重写不作防篡改承诺。
- restore 在项目被占用或未提供 `--force` 时拒绝；成功路径后项目可再次启动并保留 Record。
- Export → Import 往返后 Record 数量与值保持一致；违反 Validation/Relation/File 的 Record 在 Import 中逐条失败并给出稳定错误码。
- `modelry generate` 在同一 Applied Model 上重复执行产生字节一致的产物。
- 全部能力具备真实 Runtime、真实 SQLite、真实 HTTP 与 CLI 验收。
