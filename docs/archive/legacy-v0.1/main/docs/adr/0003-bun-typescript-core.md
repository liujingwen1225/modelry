# ADR-0003：采用 Bun + TypeScript 作为 Backend Core 技术栈

- **状态：** Accepted
- **日期：** 2026-09-02
- **Runtime Spike：** GO

## 背景

Modelry 需要同时满足：轻量自托管 Runtime、单一可执行文件发布、动态 TypeScript 项目扩展、MCP / SDK 集成以及 Web Admin UI。

Go 能提供成熟稳定的 Single Binary 平台，但会在 Core 与 TypeScript Hook / SDK 之间引入额外语言和 Runtime 边界。

Bun 提供 TypeScript-first Runtime、npm 生态兼容、原生 HTTP / SQLite 能力、Executable Compilation，并允许 Core、MCP、SDK、CLI、Hook 与 Admin UI 共享更多类型和实现语言。

因此 Bun + TypeScript 是否可用，不能只依据文档判断，必须经过 Standalone、SQLite、MCP、动态 Hook、故障恢复和可靠事件路径等真实 Spike。

## 决策

采用 **Bun + TypeScript** 作为 Modelry V0.x Backend Core 的正式实现技术基线。

在合理范围内，以下产品面优先统一使用 TypeScript：

- Backend Core
- Backend Model Types
- ChangeSet Types
- MCP Server / Tools
- CLI
- Extension / Hook API
- Generated TypeScript SDK
- Admin UI Shared Contracts

继续把 **Single Binary First** 作为产品不变量。

Go 不再是当前并行实现路线，只保留为未来出现新的阻塞级 Runtime 证据时的技术 fallback，而不是 V0.x 需要同时维护的第二套 Backend Core。

## Spike 结果

`docs/spikes/0001-bun-runtime-validation.md` 已于 2026-09-02 完成，最终结论为 **GO**。

关键证据包括：

- Linux x64 standalone executable：PASS；
- Windows x64 native standalone executable：PASS；
- SQLite persistence / minimal migration：PASS；
- Embedded Admin UI：PASS；
- REST API：PASS；
- SSE：PASS；
- MCP 通过 `Propose -> ChangeSet -> Apply -> Migration`：PASS；
- External Dynamic TypeScript Hook：PASS；
- Hook Fault Recovery：PASS；
- Hook Reload / Concurrency Boundary：PASS；
- Transactional Outbox crash recovery：PASS。

因此 Bun Runtime Gate 已关闭，不触发 Go fallback。

Spike 原型代码没有生产继承权；后续实现必须依据 Specification 重新确定模块边界。

## Hook Runtime 方向

Spike 同时证明两条可行故障边界：

1. Bun Worker；
2. self-spawned same executable Hook Runner。

生产设计优先使用最简单且满足故障边界的方案；如果 Worker 在后续实现中无法满足某个明确约束，可以退化到 self-spawned executable，而不增加第二个需要分发的 Runtime。

不得把 `node:vm` 视为恶意代码安全 Sandbox。

## 影响

### 正面影响

- 大部分产品面统一为一种主要语言；
- Core / MCP / CLI / Hook / SDK / Admin 可以共享更多 TypeScript 类型与工具链；
- Single Binary First 已有 Linux + Windows 实际证据；
- Dynamic Project Hook 不要求用户额外安装 Node/Bun Runtime；
- SQLite Transactional Outbox 与 MCP ChangeSet 路线已有可行性证据；
- 不需要为了技术不确定性同时维护 Go 与 TypeScript 两套实现。

### 负面影响

- Bun 的生产历史仍短于 Go / Node.js；
- 某些 npm package compatibility、Hook dependency resolution 与平台边界仍需要持续 CI；
- standalone executable 当前体积约 84–89 MB，需要后续优化分发体验；
- macOS 尚未进入当前实际发布矩阵；
- Spike 只证明架构可行，不替代生产级测试、性能验证与 Release Engineering。
