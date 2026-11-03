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
9. `docs/specs/0011-figma-frontend-rebuild.md`（涉及新前端实现时必须读取）
10. 与当前任务直接相关的已接受 Product Model / ADR / Spec / Contract

涉及新前端时，必须同时查看 Figma 设计文件：
https://www.figma.com/design/WDn5msOTqcN4j6eEWBNjwM/modelry?node-id=0-1

新前端页面、信息架构、视觉、组件和交互只依据 Figma 与 `docs/specs/0011-figma-frontend-rebuild.md`。不得恢复任何已废止的旧 UI 设计。

## 当前产品定位

Modelry 是面向个人开发者、独立开发者和编码智能体的本地优先后端工作台。

不要默认把 Modelry 优化成企业后端平台，也不要因为“未来可能需要”提前设计：

- PostgreSQL；
- 组织 / 团队治理；
- 企业 SSO / SAML / SCIM；
- 复杂企业 RBAC；
- HA / 集群；
- 批量实例管理；
- Kubernetes 优先部署；
- 合规平台；
- 多项目运行时。

这些能力只有在真实需求和证据证明当前架构形成明确瓶颈后，才通过新的产品决策和 ADR 进入路线。

## 产品原则

每个用户可见功能都必须先问：

- 一个人能不能理解？
- 一个人能不能部署和维护？
- 能不能减少完成应用的时间？
- 能不能少理解一个概念？
- 能不能少跳一次页面？
- 能不能少点一次按钮？
- 默认值是否安全合理？
- 成功结果是否耐久并原地可见？
- 错误是否给出明确恢复路径？
- 编码智能体能不能安全可靠地操作？
- 是否形成真实业务闭环？

## 当前技术基线

- Go
- SQLite
- React + TypeScript + Vite
- Ant Design（新前端唯一 UI 组件库）
- 模块化单体
- 契约优先
- 零配置优先
- 自托管优先
- 单运行时 / 单项目

SQLite 与单运行时 / 单项目是当前有意的产品架构，不是等待企业版或 PostgreSQL 替换的临时实现。

同时必须保持后端模型与 SQLite 物理结构分离，不能让数据库内部语义泄漏成产品语义。

## 当前产品门槛

开发者：

~~~text
首次运行
→ 建模
→ 数据
→ 安全
→ API / SDK
→ 观察
→ 演进
~~~

编码智能体：

~~~text
检查
→ 理解
→ 提出变更
→ 差异 / 风险
→ 应用
→ 验证
→ 审计
~~~

V0.1.x 后端成熟化能力已经交付。后端已有能力不代表必须在新前端增加对应菜单或页面；新前端只实现 Figma 已定义的产品范围。

## 架构规则

- Modelry 产品语义不能等同于 SQLite 特有语义。
- 应用数据面与管理面分离。
- Admin 认证与应用认证分离。
- 后端模型演进统一经过变更集、差异、风险、应用和历史。
- 结构待应用变更必须耐久保存。
- 结构、策略、认证配置不共享一个隐形的集合级草稿。
- Admin、HTTP、SDK、CLI、MCP 操作同一套产品语义。
- MCP 不拥有隐藏旁路，不得直接改 SQLite 绕过变更生命周期。
- 先定义契约，再实现传输层。
- 外部副作用不得被描述为可回滚数据库事务。

## 新前端强制规则

新前端唯一实施基线是 `docs/specs/0011-figma-frontend-rebuild.md` 和对应 Figma 文件。

- 新前端必须按 Figma 从头实现；旧 React 页面、组件、布局、路由、状态管理、CSS 和 Design Tokens 不得复制、迁移或作为实现模板。
- React + TypeScript + Vite；Ant Design（`antd`）是唯一 UI 组件库。
- 不得引入 shadcn/ui、Base UI、Mantine、Ant Design X 或其它 UI 组件库。
- 基础交互控件必须使用 Ant Design；通过统一 `src/ui/` 出口、ESLint 和静态检查约束，禁止业务页面自行实现原生 Button / Input / Select / Textarea 等基础控件。
- 允许实现 Figma 特有的业务组件，但不能用自定义组件替代 Ant Design 已有的基础组件。
- Ant Design 默认主题不是 Modelry 的视觉基线；所有视觉以 Figma 为准，使用主题 Token 和 CSS 变量实现。
- 不增加 Figma 没有的页面、菜单或功能；后端现有功能不自动成为新前端范围。
- 不建设要求用户编写或调试代码的 Hook / Lifecycle Hook / Extension 编辑器或工作台。Figma 中的可视化「业务逻辑」页面仍属于当前范围。
- AI 页面使用 Ant Design 基础组件与业务组件实现，不引入 Ant Design X。
- 新 API Client 根据后端 HTTP Contracts / OpenAPI 重新实现；只在 Figma 中的实际操作无法由现有 API 支持时，才增加最小必要后端接口。
- 保留 Go 单二进制嵌入方式和 `internal/webui/dist` 输出接缝；`admin/` 目录名可保留，但不代表复用旧前端源码。

## 界面术语

领域模型可以保留内部术语，但产品界面优先使用：

~~~text
ChangeSet       → 待应用变更
Migration       → 已应用变更 / 技术详情
Principal       → 管理员 / 服务账号 / 应用用户
Capability      → 权限
Credential      → 密码 / API Key / 会话
Policy          → 访问规则
~~~

## 近期优先级

当前优先完成 Figma 定义的新前端实现与真实体验验收。不要把旧 UI Closure、旧导航或旧组件库作为继续开发的前置任务。

不要自行把企业版、PostgreSQL 或云端控制面基础设施插到当前前端重建任务之前。

## 质量规则

每个用户可见能力必须同时满足：

~~~text
功能闭环
+
体验闭环
+
视觉闭环
+
错误闭环
+
业务流程闭环
~~~

强制验收使用：

- 真实运行时；
- 真实 SQLite；
- 真实 HTTP；
- 真实浏览器；
- 耐久状态验证；
- 跨界面验证；
- Figma 截图对照。
