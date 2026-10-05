# Modelry

Modelry 是一个面向个人开发者、独立开发者和 AI 辅助开发场景的**本地优先后端工作台**。

它把数据模型、数据管理、认证授权、API、文件、实时订阅、自动化、可观测性和安全变更组织成一个统一产品，让一个人也能从本地开始完成应用后端，而不必先搭建一整套基础设施。

> 让开发者与编码智能体基于同一套后端模型，共同创建并安全演进应用后端。

## 产品定位

Modelry 优先服务：

- 个人开发者；
- 独立开发者和小型应用开发者；
- 使用 Codex、Claude Code、Cursor 等工具进行 AI 辅助开发的开发者。

Modelry 不以企业后端平台为当前目标。企业开发者当然可以使用 Modelry，但组织体系、复杂 RBAC、企业单点登录、HA、集群、Kubernetes、合规治理等能力，不会因为“未来可能需要”而提前进入产品路线。

当前产品路线：

~~~text
开源 / 自托管 Modelry
        ↓
开发者体验 + 编码智能体体验
        ↓
Modelry 云服务
~~~

未来云服务首先解决免部署、HTTPS、存储、备份、监控、邮件和运行维护，而不是把开源版做成残缺版本。

## 核心体验

开发者：

~~~text
启动
→ 建模
→ 管理数据
→ 配置安全
→ 使用 API / SDK
→ 观察运行状态
→ 安全演进
~~~

编码智能体：

~~~text
检查现状
→ 理解模型
→ 提出变更
→ 查看差异与风险
→ 应用
→ 验证
→ 审计
~~~

Admin、HTTP API、SDK、CLI 和 MCP 必须操作同一套后端语义。编码智能体不能绕过变更生命周期、权限校验或审计直接修改底层状态。

## 当前能力

当前 main 已完成 V0.1 核心闭环和 V0.1.x 产品成熟化，主要能力包括：

- 集合、字段、关系、索引和记录；
- 耐久待应用变更、差异、风险、应用、恢复和历史；
- REST API、OpenAPI、API 调试工作区和请求日志；
- 认证集合、邮箱密码登录、会话和账号恢复；
- 访问规则和策略模拟；
- 单文件 / 多文件、本地存储和 S3 兼容存储；
- SSE 实时订阅；
- JavaScript / TypeScript 扩展；
- 生命周期钩子、事件钩子、Webhook；
- 密钥配置；
- 定时任务 / Cron；
- 活动记录、漂移检测和运行时设置；
- 管理员、服务账号和 API Key；
- 审计；
- 导入 / 导出；
- 备份 / 恢复；
- 类型化应用 API 和 SDK 生成；
- CLI；
- MCP；
- 中英文 Admin；
- 全局命令面板和明暗主题。

尚未交付的主要应用开发能力是 OAuth / OIDC 登录。按新路线，GitHub / Google 应用登录将作为 V0.2 的高优先级能力。

## 技术基线

- 后端运行时：**Go**
- 数据库：**SQLite**
- Admin：**React + TypeScript + Vite**
- 架构：**模块化单体**
- 研发原则：**契约优先**
- 交付方式：**自托管、零配置优先**
- 运行拓扑：**单运行时 / 单项目**

SQLite 和单运行时 / 单项目不再被视为等待 PostgreSQL 或企业版替换的临时限制，而是当前自托管 Modelry 有意选择的简单架构。

只有在真实用户、真实云端负载或真实规模数据证明现有边界成为明确瓶颈时，才重新评估数据库、运行拓扑或分布式架构。

## 快速开始

从源码构建并启动 Modelry（需要 Go 1.25 或更新版本）：

~~~bash
mkdir my-modelry-project
go build -o modelry ./cmd/modelry
./modelry start --project-root ./my-modelry-project
~~~

Windows：

~~~powershell
mkdir my-modelry-project
modelry.exe start --project-root .\my-modelry-project
~~~

项目目录必须是已存在的空目录。首次启动会创建 .modelry/ 状态目录。打开终端输出的本地地址，在 Admin 中创建所有者、集合和第一条记录。

查看项目状态：

~~~bash
./modelry status --project-root ./my-modelry-project
~~~

## 当前阶段

V0.1.x 产品成熟化已经完成。下一阶段优先解决：

1. 首次公开发布、打包和安装文档；
2. 5 分钟完成首个可用后端；
3. GitHub / Google 应用 OAuth；
4. SDK 接入体验；
5. MCP / 编码智能体接入与安全变更体验；
6. 示例应用、模板和部署指引；
7. 邮件配置和自托管生产环境体验。

## 文档

当前权威入口：

- [docs/README.md](docs/README.md)

历史重构前文档和旧仓库内容仅用于追溯，不能覆盖当前产品决策。

## Agent 与模型

顶栏 Agent 与 MCP 共用业务工具、权限和审核流程。Owner 可在「设置 → Agent 与模型」修改兼容模型服务、模型和加密密钥，并授权普通操作自动执行；高风险操作仍需确认。本次更新改变 MCP 的默认自动写入行为，见 [接入与兼容性说明](docs/mcp-agent-connection.md)。
