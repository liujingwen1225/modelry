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
10. DESIGN.md（涉及 Admin / 前端 / UI / UX 实现时必须读取）
11. 与当前任务直接相关的已接受 Product Model / ADR / Spec / Contract

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

V0.1.x 产品成熟化已经完成。实时订阅、钩子、密钥配置、Webhook、任务、S3、多管理员、策略模拟、活动记录、漂移检测、运行时设置、SDK、导入 / 导出、备份 / 恢复均已交付，不得再次当作未完成未来项。

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
- Go 核心不要求用户编写 Go 插件；扩展面向 JavaScript / TypeScript。
- 外部副作用不得被描述为可回滚数据库事务。

## 前端设计规则

涉及 Admin / 前端 / UI / UX 的实现必须同时遵守：

- `docs/specs/0001-admin-product-ux-spec.md`：产品体验、信息架构、页面职责、用户旅程、状态与 URL；
- `DESIGN.md`：视觉语言、排版、密度、Surface、组件组合、响应式与交互反馈；
- `admin/src/components/ui/*`：shadcn/ui + Base UI 通用交互原语。

不得通过页面级手写样式绕过设计系统重新建立第二套 Button、Input、Table、Dialog、Sheet、Badge 或状态体系。产品页面优先使用连续画布、层级、留白和分隔线组织内容，避免 Card Everywhere。

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

1. 首次公开发布、打包和安装；
2. 5 分钟完成首个可用后端；
3. GitHub / Google 应用 OAuth / OIDC；
4. SDK 接入体验；
5. MCP / 编码智能体接入与安全演进；
6. 示例应用 / 模板 / 部署指引；
7. 邮件配置体验。

不要自行把企业版、PostgreSQL 或云端控制面基础设施插到这些优先级之前。

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
- 真实 Admin 浏览器；
- 耐久状态验证；
- 跨界面验证。
