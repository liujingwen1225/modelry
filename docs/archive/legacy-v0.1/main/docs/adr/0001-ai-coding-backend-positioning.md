# ADR-0001：将 Modelry 定位为为 AI Coding 重新设计的 Backend

- **状态：** Accepted
- **日期：** 2026-09-02

## 背景

PocketBase 证明了极简、自托管应用后端的产品价值，但如果只是复制其 API，或者在传统 Backend 上增加一个 AI Chat，底层的后端控制模型并没有真正发生变化。

Modelry 需要一个稳定、长期有效的产品身份，用来约束 API 设计、Schema 建模、机器接口、部署方式和未来功能优先级。

## 决策

Modelry 定位为：**一个为 AI Coding 重新设计的自托管应用后端。**

Modelry 不是 PocketBase Compatibility Project。

正式采用以下产品不变量：

1. Single Binary First。
2. Human-friendly Admin + Agent-friendly Backend。
3. AI Native, Not AI Dependent。
4. Explicit over Magic。
5. 当前产品模型坚持 One Instance, One Project。

第一核心用户是 AI Coding 开发者与独立开发者；前端开发者属于自然覆盖用户；更重的企业和团队能力后置。

## 影响

### 正面影响

- 产品可以同时为人类开发者和 Coding Agent 优化，而无需背负 PocketBase 兼容包袱。
- Machine-readable Schema、MCP、可 Diff 变更和 Audit 成为核心能力，而不是后置集成。
- V0.1 可以主动保持轻量，而不是提前演变成通用企业应用平台。

### 负面影响

- PocketBase 现有客户端不能假设可直接迁移或兼容。
- Modelry 需要建立自己的 SDK、工具与生态。
- AI-first 定位提高了错误模型、Metadata、变更安全和可检查性的质量门槛。
