# Spike 0001：Bun Runtime 验证

## 状态

**Completed — GO**

验证结果见：[`0001-bun-runtime-validation-result.md`](./0001-bun-runtime-validation-result.md)。

本 Spike 是一次性架构验证，不是生产实现。原型代码没有生产继承权。

## 核心问题

Bun + TypeScript 是否能够满足 Modelry V0.1 的运行时要求，同时不破坏 Single Binary First，也不迫使项目采用不可接受的 Extension / Runtime 设计？

结论已经通过实际 CI 与 standalone executable 证据回答：**可以，进入 `to-spec`，不触发 Go fallback。**

## Gate 定义

### 1. Standalone Executable

必须证明：

- 可构建单一可执行文件；
- 目标环境不需要额外安装 Bun / Node Runtime；
- Linux x64 与 Windows x64 至少都有真实运行证据。

### 2. SQLite Persistence / minimal Migration

必须证明：

- Schema / Record 可持久化；
- executable 重启后状态保留；
- 最小 Migration 可以幂等 Apply；
- SQLite 事务与异常退出恢复路径可接受。

### 3. Embedded Admin UI

必须证明 React 类 Admin 资源可以并入同一 executable，由同一 Runtime 提供，而不需要独立 Node Server。

完整平台静态资源矩阵属于 Release Engineering，不作为 Bun Runtime Go/No-Go blocker。

### 4. REST API

必须证明 Bun Runtime 能稳定承载最小 CRUD、JSON Request/Response 与结构化错误。

### 5. SSE Realtime

必须证明最小 create/update/delete 实时事件与断线重连可行。

V0.1 Realtime 明确为 best-effort；Spike 不要求跨 Runtime 重启的永久事件重放能力。

### 6. MCP 必须穿过真实 ChangeSet 语义

不能只验证 direct mutation Tool。

最小路径必须是：

```text
schema_get
    ↓
collection_change_propose
    ↓
ChangeSet + Diff
    ↓
changeset_apply
    ↓
Backend Model Changed
    ↓
Migration Artifact / Ledger
```

目标是证明 MCP 能复用同一 Backend Model / ChangeSet Core。

### 7. 外部 Project TypeScript Hook 动态加载

必须证明：

- executable 外部 `.ts` Hook 可加载；
- 不重新编译主 executable 即可更新 Hook；
- Module Reload 行为能够形成明确工程约束。

完整 Project dependency/package resolution 在 Hook Runtime Spec 中固定。

### 8. Hook Fault Recovery

必须验证 Trusted Project Code 常见故障不会无条件拖垮 Core Runtime，包括：

- `throw`；
- Promise rejection；
- timeout / infinite loop；
- Worker terminate / recover；
- `process.exit()` 类行为。

Worker 是首选候选；如果 Worker 边界不足，可以使用 self-spawned same executable 作为 fallback，同时保持 Single Binary First。

本 Gate 不验证恶意第三方代码 Sandbox。

### 9. Hook Reload / Concurrency Boundary

必须证明可以形成可预测状态机：

- 在途 invocation 绑定明确版本；
- reload 只影响明确范围内的新 invocation；
- reload 失败保留 last-known-good；
- 连续快速修改不导致 Core Runtime 状态失控。

### 10. Minimal Transactional Outbox

必须证明：

- 业务 Mutation 与可靠 Outbox intent 可以在同一 SQLite Transaction 中持久化；
- Commit 后、实际 Delivery 前即使 Runtime 崩溃，重启后可靠任务仍可恢复；
- 不允许形成业务状态成功但可靠 delivery intent 永久丢失的正常窗口。

## 结果分级

- `PASS` —— 已通过可复现证据证明；
- `RISK` —— 技术路线可行，但存在进入 Spec / Release Engineering 的非阻塞限制；
- `FAIL` —— 存在阻塞 Bun 技术路线的问题。

最终建议：

- `GO`；
- `CONDITIONAL GO`；
- `NO-GO`。

## 最终结论

原始 Spike 与 Design Gap Closure 后的 Supplemental Spike 已共同关闭本 Gate。

最终结论：**GO**。

后续固定流程：

`to-spec -> to-tickets -> implement -> code-review`
