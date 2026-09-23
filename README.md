# Modelry

Modelry 是一个面向开发者的产品化 Backend Platform，用于通过可视化 Admin、稳定 API 和 Agent 友好的机器接口，完成应用后端的创建、运行与持续演进。

Modelry 的目标不是把数据库内部能力直接暴露给用户，而是把建模、数据、API、认证、权限、文件、实时、扩展、变更和可观测性整合成一个真正易用、好用、好看、功能完善的完整产品。

## 产品方向

Modelry 作为一个统一产品体系发展：

- **Modelry Community**：开源、自托管、SQLite Only、零配置优先。
- **Modelry Commercial / Enterprise**：面向正式生产和组织级场景的自托管商业版，采用 PostgreSQL，并提供企业治理与生产运维能力。
- **Modelry Cloud**：官方托管 SaaS，采用 PostgreSQL，并提供独立 Cloud Control Plane。

Community 必须是完整可用的 Backend Platform，而不是 Demo 或阉割版。Commercial / Enterprise 和 Cloud 的价值主要来自生产规模、组织治理、运维能力和托管服务。

## V0.1 Community 技术基线

- Backend Runtime：**Go**
- Database：**SQLite**
- Admin：**React + TypeScript + Vite**
- Architecture：**Modular Monolith**
- Product Discipline：**Contract First**
- Default Delivery：简单、自托管、零配置优先，Admin 随 Runtime 一起交付
- User Extension：保留 **JavaScript / TypeScript-facing Runtime Boundary**，不要求用户编写 Go Plugin

Single Binary 与 One Instance / One Project 是 V0.1 Community 的交付和运行拓扑选择，不是整个 Modelry 永久不变的产品约束。

## 文档

当前唯一权威文档入口：

- docs/README.md

历史 Pre-Reboot / Legacy 文档不再保留在当前活动文档树中，避免旧技术和旧产品假设继续造成混淆。

如需追溯历史行为，可通过 Git History 或旧仓库 modelry-bf 获取，但历史内容不能覆盖当前权威文档。

## 当前阶段

当前处于 **产品路线、技术路线与产品架构冻结阶段**。

在进入大规模生产实现前，需要基于当前权威文档重新建立：

- ADR
- Foundation Spec
- HTTP Contract / OpenAPI
- Admin Product UX Spec
- Browser Acceptance Spec
