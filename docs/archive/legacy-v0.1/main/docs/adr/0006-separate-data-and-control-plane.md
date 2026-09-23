# ADR-0006：分离 Data Plane 与 Control Plane

- **状态：** Accepted
- **日期：** 2026-09-02

## 背景

Modelry 同时服务两类完全不同的操作：

1. 应用运行时对业务数据的访问，例如 Record CRUD、Auth、File、Realtime；
2. 对 Backend 本身的管理和变更，例如修改 Schema、Policy、Migration、ChangeSet、Secret 和运行配置。

如果两类操作共用同一路由命名空间和默认权限域，会模糊业务数据访问与平台管理权限的边界，也会让 MCP 或 Admin 身份意外获得过大的数据/配置权限。

此外，Data API 会被 SDK、用户代码和 Agent 长期依赖，其兼容性要求明显高于内部管理接口，因此必须从第一版建立清晰边界。

## 决策

Modelry 明确分离 **Data Plane** 与 **Control Plane**。

### Data Plane

Data API 使用版本化路径：

`/api/v1/...`

Collection Record 的标准路径为：

`/api/v1/collections/:collection/records`

Data Plane 主要承载：

- Collection / Record CRUD；
- Auth；
- File；
- Realtime；
- Custom API。

Data API 面向业务应用、SDK、终端用户以及业务 Auth Principal。

Data Plane 的 Record 访问以 **Record Policy** 为主要授权原语。

### Control Plane

HTTP 管理接口使用独立命名空间：

`/_modelry/api/...`

Control Plane 主要承载：

- Backend Model；
- Schema；
- Policy；
- Migration；
- ChangeSet；
- Audit；
- Secret；
- Runtime Status；
- Administrative Data Access。

Admin UI、CLI 和 MCP 都属于 Control Plane 的主要客户端。

Control Plane 的授权以 **Capability Scope** 为主要授权原语。

MCP 不因为属于控制面就天然绕过 Principal / Capability Scope / Risk / Confirmation 机制。Agent 仍然是受控 Principal。

### Administrative Data Access

Control Plane 需要读取或修改业务 Record 时，这是显式的管理型数据访问，不是普通 Data Plane 请求，也不模拟业务 Auth Principal。

这类操作：

- 使用 `data:inspect` / `data:mutate` 等 Capability Scope；
- 默认不经过业务 Record Policy；
- 必须记录真实 Admin / Agent Principal 并进入 Audit；
- 不得因为具有管理数据权限就自动获得 Secret、Credential 或内部认证状态的明文访问能力。

未来如果需要验证“某个业务身份经过 Policy 会看到什么”，应提供独立 Policy Simulation，而不是把管理访问伪装成 impersonation。

## V0.1 API 约束

- 不提供 `/api/posts` 之类自动生成的顶层简写路由，避免和系统路由、Custom API 冲突；
- Record 更新以 `PATCH` 为主；
- Data API 从第一版采用 `/api/v1/` 版本前缀；
- OpenAPI 3.1 从 Backend Model 与显式 Route Contract 生成，并作为 Data API 的正式机器可读契约；
- 列表响应使用分页 envelope，单条 Record 直接返回 Record 对象；
- 公共 API 使用稳定错误码、结构化 details/hint 和 requestId；
- V0.1 提供有限 Batch API，但允许按 Scope 分层到 V0.1.x；
- 不提供跨 HTTP 请求保持状态的通用 Transaction Session API。

## 后果

### 正面

- 业务数据权限和 Backend 管理权限边界明确；
- SDK / Data API 可以保持更强的兼容性承诺，而 Control Plane 可以独立演进；
- MCP、Admin UI、CLI 可以围绕统一 Backend Model / ChangeSet 语义开发；
- Agent 管理型数据访问不再与业务 `auth.id` / Record Policy 发生语义冲突；
- 降低 Agent 因控制面身份而无意获得原始数据库超级权限的风险。

### 负面

- 产品需要维护两套清晰的接口面和认证授权边界；
- Administrative Data Access 需要独立 API/Tool 语义与审计；
- 某些同时涉及业务数据和管理配置的操作需要显式跨越两个能力层，而不能依赖一个万能 API；
- API 路由和权限测试需要同时覆盖 Data Plane 与 Control Plane。
