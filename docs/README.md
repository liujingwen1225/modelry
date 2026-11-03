# Modelry 文档

本目录是 Modelry 当前产品与架构权威文档体系。

## 当前产品方向

Modelry 当前定位：

> 面向个人开发者、独立开发者和编码智能体的本地优先后端工作台。

当前路线：

~~~text
自托管 Modelry
→ 完成 Figma 定义的新前端
→ 项目所有者真实体验
→ 决定是否首次公开发布
→ 后续根据真实反馈持续演进
→ 条件成熟时进入 Modelry 云服务
~~~

旧的“社区版 → 商业 / 企业版 → 云服务”路线已经废止。

## 阅读顺序

1. **00-product-vision.md** — Modelry 是什么、为谁服务、解决什么问题、遵循什么产品原则
2. **01-product-roadmap.md** — 已完成阶段、当前发布工作和后续路线
3. **02-technical-roadmap.md** — SQLite、单运行时 / 单项目、MCP 和云服务的技术方向
4. **03-editions-and-cloud.md** — 自托管 / 云服务边界；旧文件名继续保留
5. **04-v0.1-community-scope.md** — 已完成的 V0.1 / V0.1.x 后端交付边界；旧文件名继续保留
6. **05-product-experience-and-acceptance.md** — 跨页面体验与质量验收原则
7. **06-product-architecture.md** — 领域、接口、运行时、编码智能体和云服务边界
8. **specs/0010-figma-frontend-rebuild.md** — 当前新前端唯一实施基线：Figma 页面、Ant Design 组件库、重建边界和验收标准
9. 与当前任务直接相关的已接受 Product Model / ADR / Contract

## 当前交付状态

V0.1 核心闭环和 V0.1.x 后端成熟化能力已经完成。新前端正在根据 Figma 重新实现。

后端能力继续以已接受的 Product Model、ADR、Spec、Contract 和实际代码为准。后端已经存在某项能力，不代表新前端必须展示该能力。

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
→ 已交付后端能力 / 历史范围

05 产品体验
→ 跨页面质量 / 体验与验收原则

06 产品架构
→ 领域 / 接口 / 运行时 / 智能体 / 云边界

0010 Figma Frontend Rebuild
→ 新前端页面 / 视觉 / 交互 / Ant Design / 实施与验收边界

已接受 Product Model / ADR / Spec
→ 已交付领域决策与语义

HTTP Contract / OpenAPI
→ 后端传输边界
~~~

## 前端设计权威规则

新前端的页面、信息架构、布局、视觉、组件组合和交互，以：

- [Figma — Modelry](https://www.figma.com/design/WDn5msOTqcN4j6eEWBNjwM/modelry?node-id=0-1)
- `specs/0010-figma-frontend-rebuild.md`

为唯一实施依据。

后端领域语义、权限、安全和 HTTP Contract 继续有效；旧前端设计文件已从当前活动文档体系中移除。
