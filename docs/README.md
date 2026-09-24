# Modelry 文档

本目录是 Modelry 当前唯一有效的产品与架构权威文档体系。

## 阅读顺序

1. **00-product-vision.md** — Modelry 是什么、解决什么问题、产品原则
2. **01-product-roadmap.md** — Community、Commercial / Enterprise 与 Cloud 的演进路线
3. **02-technical-roadmap.md** — 支撑产品路线的技术路线
4. **03-editions-and-cloud.md** — Edition 与 Cloud 的产品边界
5. **04-v0.1-community-scope.md** — V0.1 Community 做什么、不做什么
6. **05-product-experience-and-acceptance.md** — 跨页面 UX、Design System 与验收原则
7. **06-product-architecture.md** — Domain、Plane、Boundary 与共享产品语义
8. **specs/0001-admin-product-ux-spec.md** — Admin Exact IA、页面、交互与 Durable Result
9. **adr/0001-runtime-storage-architecture.md** — V0.1 Runtime、Project Root、SQLite 与 Local Storage 决策
10. **specs/0002-v0.1-foundation-spec.md** — Domain 对象、身份、生命周期与安全边界
11. **contracts/core-http-contract.md**、**contracts/openapi.yaml** — HTTP 平面、资源、错误与 DTO
12. **specs/0003-browser-acceptance-spec.md** — 十条 V0.1 产品流程及 Product Closure 验收门禁

后续正式设计统一进入：

- docs/adr/
- docs/specs/
- docs/contracts/

## 文档职责

避免多份文档重复冻结同一结论：

~~~text
00 Product Vision
→ why / product principles

01 Product Roadmap
→ when

02 Technical Roadmap
→ technical direction

03 Editions
→ product / commercial boundary

04 V0.1 Scope
→ keep / simplify / defer

05 Product Experience
→ cross-page UX / design / acceptance rules

06 Product Architecture
→ domain / plane / architecture boundary

0001 Admin UX
→ exact sidebar / workspace / page / interaction

ADR-0001 Runtime / Storage
→ runtime / project / persistence architecture decisions

SPEC-0002 Domain Foundation
→ domain identity / lifecycle / ownership / security semantics

Core HTTP Contract / OpenAPI
→ canonical API boundary / operations / DTO / errors

SPEC-0003 Browser Acceptance
→ ten real-stack V0.1 product flows / browser health gate / Product Closure release gate
~~~

Exact Admin IA 只由 Admin UX Spec 定义。其它文档引用它，不复制 Sidebar 作为第二份权威来源。

## 历史资料

Pre-Reboot / Legacy 文档已从当前活动文档树移除。

需要追溯历史行为时，可以查看 Git History 或旧仓库 modelry-bf。

历史材料只能作为证据来源，不能覆盖当前权威文档。
