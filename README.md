# Modelry

Modelry 是一个面向开发者与 Coding Agent 的产品化 Backend Platform，用统一的可视化 Admin、稳定 Application API 和机器接口，完成应用后端的创建、运行与持续演进。

Modelry 不把数据库内部能力直接暴露成“管理工具”。它把建模、真实数据、认证授权、API、文件、变更和运行诊断组织成一个完整产品。

## 产品方向

Modelry 作为一个统一产品体系发展：

- **Modelry Community**：开源、自托管、SQLite Only、零配置优先。
- **Modelry Commercial / Enterprise**：面向正式生产与组织级场景的商业自托管版本，采用 PostgreSQL，并增加团队、治理、运维与规模能力。
- **Modelry Cloud**：官方托管 SaaS，采用 PostgreSQL，并拥有独立 Cloud Control Plane。

Community 必须完整可用，但“完整”不等于第一个版本一次实现所有长期能力。V0.1 优先把核心开发闭环做到真正好用，再通过 V0.1.x 持续扩展 Realtime、Hooks、Secrets 等能力。

## V0.1 Community 产品闭环

~~~text
First Run
→ Create Backend Model
→ Manage Data
→ Secure
→ Use API
→ Observe
→ Evolve
~~~

V0.1 的发布标准不是 Feature Checklist，而是这条路径是否易用、可恢复、可验证。

## V0.1 Community 技术基线

- Backend Runtime：**Go**
- Database：**SQLite**
- Admin：**React + TypeScript + Vite**
- Architecture：**Modular Monolith**
- Product Discipline：**Contract First**
- Delivery：简单、自托管、Zero-config-first
- Runtime Topology：V0.1 中一个 Runtime 服务一个 Project

Single Binary 与 One Instance / One Project 是 V0.1 Community 的交付与拓扑选择，不是 Modelry 永久产品约束。

## V0.1 重点能力

V0.1 聚焦：

- Collections / Schema / Records
- Pending Changes / Apply / Recovery / History
- REST API / OpenAPI / API Runner / Request Logs
- Auth Collection / Email + Password / Sessions
- Access Rules
- Local Single-file Field
- Service Account / API Key
- Minimal Audit
- Runtime / Storage Diagnostics
- Minimal CLI
- Core MCP

Realtime、Lifecycle Hooks、Secrets UI、独立 Activity、Policy Simulation 等进入 V0.1.x。

## 文档

当前唯一权威入口：

- docs/README.md

历史 Pre-Reboot / Legacy 文档不属于当前权威体系。需要追溯时可查看 Git History 或旧仓库 modelry-bf，但历史内容不能覆盖当前决策。

## 当前阶段

**V0.1 Foundation Closure 已完成实现与集成验收**：Runtime / Storage ADR、Foundation Domain Spec、Core HTTP Contract / OpenAPI 与 Browser Acceptance Spec 已建立并接受；Go Runtime、Admin Shell、真实 HTTP、SQLite 重启连续性与 Chromium smoke 均按这些基线完成验证。

Foundation Closure 只交付单 Project Runtime、SQLite 与本地文件存储基础、状态诊断、结构化 HTTP 错误和 Admin Shell。Collections、Records、Schema、认证授权与其他 V0.1 产品工作流仍按权威规格后续实现；当前导航不会把它们呈现为已交付能力。
