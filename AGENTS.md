# AGENTS.md — Modelry

## 开始任何任务前先读

1. CONTEXT.md
2. docs/00-product-vision.md
3. docs/01-product-roadmap.md
4. docs/02-technical-roadmap.md
5. docs/03-editions-and-cloud.md
6. docs/04-v0.1-community-scope.md
7. docs/05-product-experience-and-acceptance.md
8. docs/06-product-architecture.md
9. 与当前任务直接相关的 Accepted ADR / Spec / Contract

## 产品原则

不要把 Modelry 优化成内部工程系统。

每个用户可见功能都必须按产品能力评审：

- 用户能否快速理解？
- 是否有明确的下一步？
- 默认值是否合理、安全？
- Durable Result 是否可见？
- 出错后是否知道原因和修复方式？
- 能否完成真实业务闭环？
- 是否符合统一视觉与交互体系？

## V0.1 Community 基线

- Go
- SQLite
- React + TypeScript + Vite
- Modular Monolith
- Contract First
- Zero-config-first
- 简单 Self-hosted Delivery

Single Binary 与 One Instance / One Project 只是 V0.1 Community 的交付和拓扑策略，禁止把它们扩大成永久全局产品假设。

## 架构规则

- Modelry Product Semantics 不得等同于 SQLite-specific Semantics。
- V0.1 不实现 PostgreSQL，但不得让未来 PostgreSQL 需要重写 Domain Model。
- 当存在 Modelry Product Concept 时，不直接向用户暴露 Raw Database Concept。
- Data Plane 与 Control Plane 必须分离。
- Admin Auth 与 Application Auth 必须分离。
- Schema Evolution 统一经过 ChangeSet / Diff / Risk / Apply / History。
- Hooks / Extensions 保持 JavaScript / TypeScript-facing Runtime Boundary。
- MCP 只是同一 Product Semantics 的另一个 Interface，不拥有隐藏旁路。
- Contract 在 Transport Implementation 之前定义。

## 质量规则

Definition of Done 不是“代码能编译”或“API 测试通过”。

核心产品功能必须满足：

~~~text
Functional Closure
+
UX Closure
+
Visual Closure
+
Error Closure
+
Business Flow Closure
~~~

Mandatory Acceptance 使用：

- Real Runtime
- Real SQLite
- Real HTTP
- Real Admin Browser
- Durable State Verification
- Cross-Surface Verification
