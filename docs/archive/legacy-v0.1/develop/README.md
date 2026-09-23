# Modelry

**为 AI Coding 重新设计的应用后端。**

Modelry 是一个面向 AI Coding 的自托管应用后端。

> 单一可执行文件。TypeScript First。对人友好。对 Agent 友好。

## 当前阶段

Modelry 已完成：

- `grill-with-docs`
- Design Gap Closure
- Bun Runtime Spike Gate
- Frontend V0.1 Closure
- API Contract Freeze
- Backend / Control Plane Core
- V0.1.0 Data Plane Core
- Data Plane Core post-merge CI Gate / Closure Bookkeeping

Bun Runtime Spike 最终结论：**GO**。

Bun + TypeScript 已通过 Linux x64 / Windows x64 standalone、SQLite、Embedded Admin、REST、SSE、MCP -> ChangeSet、Dynamic TypeScript Hook、Hook Fault Recovery、Hook Reload/Concurrency 与 Transactional Outbox 等关键验证。

Runtime Completion 已完成 Closure，当前正式阶段是：**`V0.1.0 Release Readiness / Hardening`**。

当前固定流程：

`to-spec -> to-tickets -> feature branch -> implement -> PR -> develop -> code-review`

`docs/specs/0005-v0.1.0-runtime-completion.md` 保留为 Runtime Completion 的范围与架构依据；当前收口重点是 Blog Reference Application、可重复 Release Gate、安全扫描、Migration/Drift/Doctor 和独立 code-review。

`frontend/admin` 的 Mock/fixture 只能作为单元测试边界；Release Readiness 的 mandatory path 必须通过真实 Runtime、真实 SQLite 和真实 HTTP/MCP/CLI seam。

## Standalone quick start

将 standalone executable 放入 Project Root 后，直接运行即可自动完成首次初始化并启动 Runtime：

```sh
chmod +x modelry
./modelry
```

首次启动会创建 `modelry.config.json`、`.modelry/` 和 `.gitignore`，然后输出 Admin URL 与 Setup Token。需要只初始化而不启动服务时，仍可使用 `modelry init`；`modelry serve` 保持严格模式，要求 Project 已经初始化。

## Local development

本地开发使用 `bun run dev` 同时启动两个进程，不需要每次执行 `frontend build -> embed assets -> bun compile` 才能跑通完整 Modelry：

```sh
npm ci --prefix frontend/admin
bun run dev
```

```text
Vite Admin Dev Server (HMR)  --(/_modelry/api/*)-->  Bun Backend Dev Runtime  -->  SQLite / Runtime
```

- Admin UI 由 Vite dev server 提供（支持 HMR），入口是 `http://localhost:5173/admin`；
- Backend 直接运行 TypeScript/Bun Runtime，与生产使用同一个 `runCli -> serve` 入口，使用真实 SQLite / Runtime Lock / Control Plane，不使用 Mock Backend；
- 开发用 Project 默认初始化在 `build/dev/project`（已被 gitignore），可用 `MODELRY_DEV_PROJECT` 指向其他目录；
- 端口默认沿用 Runtime Config 的 `8090` 与 Vite 的 `5173`。端口被占用时会明显失败，不会静默切换到随机端口；
- 也可以分开运行：`bun run dev:backend` / `bun run dev:admin`。

开发闭环 smoke：

```sh
bun run smoke:dev
```

Development Fast Loop 与 Production Single Binary 是两条运行路径：`bun run dev` 不嵌入 Admin assets、不编译 standalone executable，但复用同一份 Backend Runtime 与同一份前端业务代码。

## Production validation

根目录使用 Bun 统一执行 Backend 与 Frontend 的质量入口：

```sh
bun install
npm ci --prefix frontend/admin
bun run check
bun run smoke:standalone
bun run e2e:blog
```

`bun run build:standalone` 会先构建 `frontend/admin`，再把 production assets 嵌入 Bun standalone executable。GitHub Actions 不作为发布门禁；Linux x64 / Windows x64 的 native build/smoke 在需要跨平台复核时于对应环境手工执行。

`bun run check` 已包含 `e2e:blog`：它在临时 Project 中通过真实 ChangeSet/Apply 建立 `users`、`posts`、`comments`、`categories`，并串行验证 Application Auth、Record Policy、Relation、File、Hook、Realtime、Secret、OpenAPI/API Runner、MCP、CLI、Migration、Drift 与 Doctor。脚本结束时 Project 会清理，不会写入仓库 fixture 或生产数据。

Frontend quality gates:

- TypeScript strict mode
- ESLint
- Vitest
- Component journey tests
- Production build
- Real-backend browser smoke

## 产品定位

Modelry 不是“给 PocketBase 加上 AI”，也不是 PocketBase API 兼容项目。

它借鉴 PocketBase 类产品“轻量、自托管、开箱即用”的体验，但从一开始围绕 AI Coding 重新设计 Backend Model、变更机制、机器接口和运行边界。

核心原则：

- **Single Binary First** —— 默认部署保持单一可执行文件和尽可能少的外部依赖。
- **Human-friendly Admin + Agent-friendly Backend** —— 人类开发者和 Coding Agent 都是一等公民。
- **AI Native, Not AI Dependent** —— 不配置任何 AI 服务时，核心 Backend 仍然完整可用。
- **Explicit over Magic** —— Schema、Policy、Migration、Hook 和 Agent 变更都必须可检查、可解释、可审计。
- **Backend Model is the Source of Truth** —— Agent 和工具修改声明式 Backend Model，而不是直接操作物理数据库。
- **One Instance, One Project** —— 一个运行中的 Modelry Instance 对应一个应用后端 Project。

## 当前设计基线

- Backend Model 变更统一经过 `ChangeSet -> Diff + Risk -> Apply -> Migration -> Audit`。
- Application Data Access 使用 Record Policy；Administrative Data Access 使用 Capability Scope。
- 可靠 Event/Outbox/Audit Fact 与业务 Mutation 原子持久化，外部副作用在 Commit 后执行。
- Project Migration History 是可复现历史来源，Runtime Backend Model 是运行时 Materialized Truth，Schema Snapshot 是 Generated Projection。
- Custom API 必须提供机器可读 Route Contract，不能成为任意 Router 黑盒。
- V0.1 分为 `V0.1.0 Core Closure` 与 `V0.1.x Completion`，后置能力不再无条件阻塞首个端到端版本。

## 当前技术基线

- Runtime / Core：**Bun + TypeScript**，Runtime Spike 已 `GO`。
- Storage：**SQLite First**。
- Admin UI：TypeScript + React 类 Web UI，并入单一可执行文件。
- Realtime：SSE First。
- Extension：Trusted Project Code 形式的 TypeScript Hooks / Custom APIs。
- Hook Isolation：Worker First，self-spawned same executable 作为可行 fallback。
- Reliable Async：SQLite Transactional Outbox。
- Agent 接口：MCP 作为 V0.1 核心能力，并通过 Backend Model / ChangeSet Core 工作。

已确认的领域术语和架构决策见 [`CONTEXT.md`](./CONTEXT.md)、[`docs/01-v0.1-scope.md`](./docs/01-v0.1-scope.md)、[`docs/adr/`](./docs/adr/) 与 [`docs/spikes/0001-bun-runtime-validation-result.md`](./docs/spikes/0001-bun-runtime-validation-result.md)。
