# Modelry 文档

本目录是 Modelry 当前唯一有效的产品与架构权威文档体系。

## 当前产品方向

Modelry 当前定位：

> 面向个人开发者、独立开发者和编码智能体的本地优先后端工作台。

当前路线：

~~~text
自托管 Modelry
→ 首次公开发布 / 开发者启用
→ V0.2 开发者与编码智能体体验
→ 基于真实反馈持续演进
→ 条件成熟时进入 Modelry 云服务
~~~

旧的“社区版 → 商业 / 企业版 → 云服务”路线已经废止。

部分文件名继续保留 community / editions，是为了保持历史链接稳定，不代表旧版本策略仍然有效。

## 阅读顺序

1. **00-product-vision.md** — Modelry 是什么、为谁服务、解决什么问题、遵循什么产品原则
2. **01-product-roadmap.md** — 已完成阶段、当前发布工作、V0.2 和后续路线
3. **02-technical-roadmap.md** — SQLite、单运行时 / 单项目、MCP 和云服务的技术方向
4. **03-editions-and-cloud.md** — 自托管 / 云服务边界；旧文件名继续保留
5. **04-v0.1-community-scope.md** — 已完成的 V0.1 / V0.1.x 交付边界；旧文件名继续保留
6. **05-product-experience-and-acceptance.md** — 跨页面体验、设计系统和验收原则
7. **06-product-architecture.md** — 领域、接口、运行时、编码智能体和云服务边界
8. **specs/0001-admin-product-ux-spec.md** — Admin 精确信息架构、页面和交互
9. 与当前任务直接相关的已接受 Product Model / ADR / Spec / Contract

## 当前交付状态

V0.1 核心闭环和 V0.1.x 产品成熟化已经完成。

当前 main 已交付：

- 核心建模 / 数据 / 认证 / API / 变更；
- 实时订阅；
- 扩展 / 生命周期钩子；
- 密钥配置；
- Webhook / 定时任务；
- 多文件 / S3 兼容存储；
- 多管理员 / 账号恢复；
- 策略模拟 / 活动记录 / 漂移 / 运行时设置；
- 备份 / 恢复 / 导入 / 导出；
- 类型化 API / SDK 生成；
- 国际化 / 命令面板 / 明暗主题；
- 浏览器 / 升级 / 重启 / 恢复闭环。

应用 OAuth / OIDC 尚未交付，作为 V0.2 高优先级能力。

## 文档职责

~~~text
00 产品愿景
→ 目标用户 / 问题 / 产品原则

01 产品路线
→ 当前阶段 / 下一阶段 / 长期方向

02 技术路线
→ 技术方向 / 架构升级条件

03 自托管 / 云服务策略
→ 产品形态 / 托管边界

04 V0.1 交付范围
→ 已交付基线 / 历史范围

05 产品体验
→ 跨页面 UX / 设计 / 验收规则

06 产品架构
→ 领域 / 接口 / 运行时 / 智能体 / 云边界

0001 Admin UX
→ 精确侧栏 / 工作区 / 页面 / 交互

已接受 Product Model / ADR / Spec
→ 已交付领域决策与语义

HTTP Contract / OpenAPI
→ 规范传输边界

Browser Acceptance
→ 真实技术栈产品验证
~~~

其中 Product Model、ADR、Spec、Contract、Browser Acceptance 等名称继续保留，是为了与仓库现有文件和工程流程一致。

## 权威规则

- 产品愿景和未来路线以 00–06 当前版本为准。
- 已接受 ADR / Spec / Contract 继续冻结已经交付的领域、运行时和 HTTP 语义。
- 产品从企业优先假设转向个人开发者优先，不意味着重写已经验证的底层语义。
- 如果旧 ADR / Spec 提到未来 Enterprise / PostgreSQL，但不是已经交付的语义，则不能覆盖当前产品路线。
- 新增 PostgreSQL、组织治理、HA、Kubernetes 等能力必须有新的明确产品决策，不能引用历史备注自动进入路线。

## Admin 精确信息架构

Admin 精确信息架构只由：

- docs/specs/0001-admin-product-ux-spec.md

定义。

其它文档引用它，不复制 Sidebar 作为第二份权威来源。

## 历史资料

重构前和 Legacy 文档已从当前活动文档树移除。

需要追溯历史行为时，可以查看 Git 历史或旧仓库 modelry-bf。

历史材料只能作为证据来源，不能覆盖当前决策。
