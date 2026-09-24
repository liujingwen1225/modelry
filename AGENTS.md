# AGENTS.md — Modelry

## 开始任务前先读

1. CONTEXT.md
2. docs/00-product-vision.md
3. docs/01-product-roadmap.md
4. docs/02-technical-roadmap.md
5. docs/03-editions-and-cloud.md
6. docs/04-v0.1-community-scope.md
7. docs/05-product-experience-and-acceptance.md
8. docs/06-product-architecture.md
9. docs/specs/0001-admin-product-ux-spec.md
10. 与当前任务直接相关的 Accepted ADR / Spec / Contract

## 产品原则

不要把 Modelry 优化成内部工程系统。

每个用户可见功能都必须先问：

- 能不能少理解一个概念？
- 能不能少跳一次页面？
- 能不能少点一次按钮？
- 能不能使用安全合理的默认值？
- Durable Result 是否原地可见？
- Error 是否给出明确恢复路径？
- Search / Filter / Sort / Pagination / Deep Link Context 是否保留？
- 是否形成真实业务闭环？

## V0.1 Community 基线

- Go
- SQLite Only
- React + TypeScript + Vite
- Modular Monolith
- Contract First
- Zero-config-first
- 简单 Self-hosted Delivery
- One Runtime / One Project in V0.1

## V0.1 产品 Gate

优先证明：

~~~text
First Run
→ Model
→ Data
→ Secure
→ API
→ Observe
→ Evolve
~~~

不要因为长期 Community 需要某个能力，就默认它必须进入 V0.1。

Realtime、Lifecycle Hooks、Secrets UI、Standalone Activity、Policy Simulation、Additional Administrator Management 等默认属于 V0.1.x，除非权威 Scope 明确重新纳入。

## 架构规则

- Modelry Product Semantics 不得等同于 SQLite-specific Semantics。
- V0.1 不实现 PostgreSQL，但不得让未来 PostgreSQL 需要重写 Domain Model。
- 当存在 Product Concept 时，不直接向普通用户暴露 Raw Database Concept。
- Data Plane 与 Control Plane 分离。
- Admin Auth 与 Application Auth 分离。
- Backend Model Evolution 统一经过 ChangeSet / Diff / Risk / Apply / History。
- Schema Pending Changes 必须耐久保存。
- Schema、Policy、Auth Configuration 不共享一个隐形 Collection-wide UX Draft。
- MCP 只是同一 Product Semantics 的另一个 Interface，不拥有隐藏旁路。
- Contract 在 Transport Implementation 之前定义。

## UI Vocabulary

Domain 可以保留内部术语，但 Product UI 优先使用：

~~~text
ChangeSet       -> Pending change
Migration       -> Applied change / Technical details
Principal       -> Administrator / Service account / App user
Capability      -> Permission
Credential      -> Password / API key / Session
Policy          -> Access rule
~~~

## 质量规则

Definition of Done 必须同时覆盖：

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
