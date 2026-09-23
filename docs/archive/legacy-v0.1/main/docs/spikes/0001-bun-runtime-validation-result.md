# Spike 0001：Bun Runtime 验证结果

## 状态

**Completed — GO**

Bun + TypeScript 已通过 Modelry V0.1 Runtime Spike Gate，不触发 Go fallback。

本结果由两组隔离原型证据组成：

1. 原始 Bun Runtime Spike：验证基础 8 项 Runtime 能力；
2. Design Gap Closure 后 Supplemental Spike：补充 MCP -> ChangeSet、Transactional Outbox、Hook Reload/Concurrency 与 Windows x64 Standalone。

所有 Spike 原型均属于一次性验证代码，**没有生产继承权**。生产实现必须从后续 `to-spec -> to-tickets -> implement` 重新建立模块边界。

## 验证基线

### 原始 Spike

- Bun：`1.4.0+34cbb9a40`
- 平台：Ubuntu 24.04 / Linux x64
- React / React DOM：`19.2.8`
- MCP TypeScript SDK：`1.30.0`
- CI Run：`33588016663`
- Evidence Artifact：`bun-runtime-spike-evidence` / `9830753814`
- Prototype Head：`2e3e04f5966255e9e8915fc4e4d5821e5910fc15`
- 结果：基础 8 项 **8/8 PASS**，`GO`

### Supplemental Spike

- Bun：`1.4.0+34cbb9a40`
- Linux Runner：Ubuntu 24.04 / Linux x64
- Windows Runner：Windows Server 2022 / win32-x64
- CI Run：`33595767496`
- Linux Evidence Artifact：`bun-runtime-supplemental-linux` / `9833327373`
- Windows Evidence Artifact：`bun-runtime-supplemental-windows` / `9833330223`
- Supplemental Head：`ad682e0dc8f7a350286e23daf4d3cc7735b07c26`
- 结果：补充 4 项 **4/4 PASS**，Workflow 整体 `success`

## Gate 结果

| # | 验证项 | 结果 | 结论 |
|---|---|---|---|
| 1 | Standalone Executable | **PASS** | Linux standalone 已独立运行；Windows 2022 runner 上原生 `win32-x64` executable 编译并启动成功。Windows supplemental binary 为 `89,357,312` bytes，子进程环境移除 `PATH/BUN_INSTALL/NODE_PATH` 后健康检查仍成功。 |
| 2 | SQLite Persistence / minimal Migration | **PASS** | `bun:sqlite` 持久化、重复启动 Migration 幂等与进程重启均已通过；Supplemental Outbox 还验证了事务 Commit 后异常退出与重启恢复。 |
| 3 | Embedded Admin UI | **PASS / accepted boundary** | Linux standalone 中 React HTML/JS/CSS 内嵌并由同一 executable 服务已通过。Windows 已验证 standalone 发布模型；Windows 专门的 Admin asset fetch 不作为 Runtime 技术路线阻塞项，进入发布矩阵。 |
| 4 | REST API | **PASS** | 最小 Record CRUD、JSON request/response 与结构化错误均通过。 |
| 5 | SSE | **PASS / accepted boundary** | create/update/delete 与 `Last-Event-ID` 进程内重连通过。跨 Runtime 重启不承诺持久事件重放，符合 V0.1 Realtime best-effort 定位。 |
| 6 | MCP through ChangeSet Core | **PASS** | Supplemental MCP 只暴露 `schema_get`、`collection_change_propose`、`changeset_apply`；Propose 不修改 Backend Model，Apply 后 Backend Model 改变并产生可追溯 Migration Artifact；没有 direct `create_collection` bypass。 |
| 7 | Dynamic TypeScript Hook | **PASS / accepted boundary** | standalone executable 可动态加载外部 `.ts` Hook 且无需重新编译；修改后可加载新版本。完整 Project dependency/package resolution 进入 Spec/实现验证，不构成 Bun Runtime blocker。 |
| 8 | Hook Fault Recovery | **PASS / accepted boundary** | Worker 与 self-spawned executable 对 throw、rejection、infinite loop、`process.exit()` 均形成可恢复证据，Core 保持可用。该结论只针对 Trusted Project Code，不等价于恶意代码 Sandbox。 |
| 9 | Hook Reload / Concurrency Boundary | **PASS** | 在途 generation 1 调用使用 immutable v1 snapshot 完成，同时 reload 安装 generation 2；新调用使用 v2；语法错误版本被拒绝并保留 last-known-good；连续 v3 -> v4 -> v5 reload 后状态可预测且 Core 健康。 |
| 10 | Minimal Transactional Outbox | **PASS** | 同一 SQLite Transaction 写业务 row + Outbox intent；Commit 后、Delivery 前主动 `exit(91)`；重启后业务 row 与 pending Outbox 均存在，并可继续 drain 到 delivered。Rollback probe 同时证明失败事务不会留下半条业务状态。 |

## Supplemental Spike 关键证据

### MCP -> ChangeSet

CI 实际输出：

- `tools=changeset_apply, collection_change_propose, schema_get`
- Propose 形成 Pending ChangeSet + Diff，Backend Model 未提前改变；
- Apply 后 Backend Model 改变；
- Migration Artifact 可追溯到对应 ChangeSet；
- 未暴露 direct `create_collection` bypass。

### Transactional Outbox

CI 实际执行：

`transaction commit -> intentional process exit(91) -> restart executable -> pending outbox recovered -> drain -> delivered`

因此 ADR-0010 所要求的“可靠 delivery intent 与业务 Mutation 原子持久化”在 Bun + SQLite 上具有可行的实现路径。

### Hook Reload / Concurrency

Supplemental 原型采用 immutable generation snapshot 验证最小可预测状态机：

- invocation 开始时绑定一个 generation；
- reload 成功后只影响后续 invocation；
- reload 验证失败时不替换 active generation；
- 快速连续 reload 不导致 Core Runtime 崩溃。

该状态机是进入 Spec 的证据，不代表生产实现必须复制原型代码结构。

### Windows x64

Windows Server 2022 GitHub runner 实际输出：

- Runtime：`Bun 1.4.0, win32-x64`
- native standalone compile：PASS
- executable run：PASS
- binary size：`89,357,312` bytes
- 移除 `PATH/BUN_INSTALL/NODE_PATH` 后 health：PASS

因此 Single Binary First 不再只有 Linux x64 证据。

## 已接受的非阻塞边界

以下问题不改变 `GO`，但必须在 Spec / Release Engineering 中保持明确：

1. macOS 尚未进入实测发布矩阵；
2. standalone 体积约 84–89 MB，后续需要处理压缩、下载与升级体验；
3. SSE 是 best-effort，不承诺跨 Runtime 重启的持久事件重放；
4. Hook 是 Trusted Project Code，不提供任意恶意代码安全 Sandbox；
5. Project Hook dependency/package resolution 需要在 Hook Runtime Spec 中固定；
6. Windows Admin 静态资源完整矩阵属于 release CI，而不是 Bun Runtime Go/No-Go blocker；
7. Spike prototype 的 SQLite Schema、HTTP Route、MCP Tool 实现和 Hook snapshot 机制均不得直接复制为生产架构。

## ADR-0003 Go / No-Go

### 结论：**GO**

当前证据足以关闭 Bun Runtime Spike Gate：

- **Bun + TypeScript 成为 V0.1 正式实现技术基线；**
- **不触发 Go fallback；**
- Worker 是首选 Hook 隔离候选，self-spawned same executable 保留为可行 fallback；
- SQLite Transactional Outbox 路线可继续规格化；
- MCP 必须通过 Backend Model / ChangeSet Core，而不是暴露 direct mutation bypass；
- 项目正式阶段从 `Bun Runtime Spike Gate` 前进到 **`to-spec`**。
