# ADR-0005：将 Hook 定义为 Trusted Project Code，并保留运行时故障隔离

- **状态：** Accepted
- **日期：** 2026-09-02

## 背景

Modelry 需要生命周期 Hook、Custom API 和定时项目逻辑，让真实应用能够超越自动生成的 CRUD。由于 Modelry 面向 AI Coding，这些 Extension 很可能经常由 Coding Agent 生成或修改。

这里存在两个不同问题：

1. 面向任意恶意第三方代码的安全隔离；
2. 面向可信项目代码 Bug 的故障隔离。

如果 V0.1 就构建完整不可信代码 Sandbox，会把产品范围大幅扩展到 Serverless / Runtime Infrastructure。

## 决策

V0.1 的 TypeScript Hook 与 Custom Application Logic 定义为 **Trusted Project Code**。

Modelry V0.1 不承诺安全执行任意恶意第三方代码。

但可信代码仍应在可行范围内具备运行时故障边界。Runtime 设计必须验证：

- 普通异常不会终止 Backend；
- Hook Timeout 可以被检测并恢复；
- runaway / failed execution 在可行范围内可以隔离或重启，并避免破坏 Core Runtime State；
- Hook 错误与 Hook 变更进入日志和 Audit；
- 如果所选 Runtime 设计能够可靠支持，Hook Code 可以在不重新编译主 Modelry executable 的情况下更新。

Worker 是首选验证路径。如果 Worker 无法提供可接受的故障边界，则允许采用 self-spawned Hook Runner 子进程，同时继续保持只分发一个 executable。

针对不可信 Plugin、Marketplace Code、多租户用户上传函数的强 Capability Isolation 延后到未来独立决策，可使用专门 Sandbox / Runtime。

## 影响

### 正面影响

- V0.1 不会演变成通用 Serverless Sandbox Platform。
- TypeScript Hook 保持简单，并对 AI Coding 友好。
- 严肃处理故障隔离，但不把它与恶意代码安全问题混为一谈。

### 负面影响

- V0.1 Operator 必须信任 Project Hook Code。
- 未来如果引入 Plugin Marketplace 或任意用户代码，需要新增真正的安全边界。
- Worker / Process 的实际行为必须通过 Runtime Spike 验证，不能只凭假设接受。
