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

## 快速开始

从源码构建并启动 Modelry（需要 Go 1.25 或更新版本）：

```bash
mkdir my-modelry-project
go build -o modelry ./cmd/modelry
./modelry start --project-root ./my-modelry-project
```

Windows 可先运行 `mkdir my-modelry-project`，再将输出文件名改为 `modelry.exe`，并运行 `modelry.exe start --project-root .\my-modelry-project`。Project Root 必须是已存在的空目录；首次启动会在其中创建 `.modelry/` 状态目录。打开终端输出的本地地址，在 Admin 中创建 Owner、Collection 和第一条 Record。默认监听地址是 `127.0.0.1:8080`，可用 `--listen` 覆盖。按 `Ctrl+C` 优雅停止 Runtime。

查看项目持久状态：

```bash
./modelry status --project-root ./my-modelry-project
```

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

**V0.1 Community Product Closure 已实现完整候选产品路径**：空 Project Root 首次启动、Owner 管理、Collections / Schema / Records、认证与 Access Rules、Application API、API Runner、Requests、Service Accounts / API Keys、Audit、CLI 与 Core MCP 均使用同一 Runtime 与产品语义。

候选版本以真实 Go Runtime、SQLite、HTTP、嵌入式 Admin 和 Chromium 完成 FLOW-001 至 FLOW-010 验收，覆盖待处理变更、Apply / Recovery / History、凭据撤销、文件与同一 Project Root 重启持久性。Realtime、Lifecycle Hooks、Secrets UI、Standalone Activity 与 Policy Simulation 仍属于 V0.1.x 范围。

产品、架构、Domain、HTTP Contract 和 Browser Acceptance 的权威入口见 [docs/README.md](docs/README.md)。
