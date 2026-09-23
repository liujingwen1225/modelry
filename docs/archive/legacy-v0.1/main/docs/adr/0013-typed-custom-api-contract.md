# ADR-0013：Custom API 必须使用可生成 OpenAPI 的显式类型契约

- **Status:** Accepted
- **Date:** 2026-09-02

## 背景

Modelry V0.1 同时把 Custom API、OpenAPI 3.1、TypeScript SDK 和 Agent-friendly Backend 作为正式能力。

如果 Custom API 只允许项目代码直接注册任意 HTTP Handler，例如只写 method/path/handler，那么 Modelry 无法可靠知道该 API 的：

- path/query/header 参数；
- request body；
- response shape；
- auth requirement；
- error contract。

这会导致 Custom API 成为 Backend Model 之外的一块黑盒：OpenAPI 不完整，Agent 无法 Inspect，SDK 不能生成稳定类型，Runtime Validation 也只能依赖 Handler 自行实现，与 `Explicit over Magic` 原则冲突。

## 决策

### 1. Custom API 是显式 Route Contract + Handler

Custom API 必须通过 Modelry 提供的声明式/类型化 Route Definition 注册，而不是直接向底层 HTTP Server 注入任意路由。

概念模型：

```ts
defineRoute({
  method: "POST",
  path: "/checkout",
  auth: ...,
  input: ...,
  output: ...,
  errors: ...,
  handler: ...
})
```

上述代码只表达契约形状；具体 TypeScript API、Schema Library 或类型实现由 Spec 与 Spike 验证决定。

### 2. Contract 是机器可读的

每个 Custom API 至少能够被 Modelry 解析出：

- method；
- path；
- operation identifier；
- authentication requirement；
- path/query/header 参数；
- request body schema；
- success response schema；
- declared error responses。

这些信息必须能被 Runtime、Admin、OpenAPI Generator、Agent Inspect 和 SDK Generation 共享，而不是各自从 Handler 代码猜测。

### 3. Runtime Validation 与文档契约使用同一 Schema

Request/Response Validation、OpenAPI Schema 与 Agent Inspect 不允许维护三份彼此独立的结构定义。

Route Contract 中的 Schema 是统一来源，至少用于：

- 输入验证；
- OpenAPI 3.1 生成；
- Admin API 文档；
- MCP/Agent Inspect；
- TypeScript Client 类型生成。

### 4. Custom API 不绕过 Principal/Policy/Capability 体系

Custom API 必须显式声明认证要求。

Custom API Handler 访问业务 Record 时仍使用受控 Data API/Runtime Context，并遵循当前 Principal 与 Record Policy；不得通过暴露底层数据库句柄形成授权旁路。

如果某个 Custom API 明确执行管理型能力，则必须位于 Control Plane 扩展边界并经过 Capability Scope，不允许以 Data Plane Custom API 伪装管理接口。

### 5. Custom API 与系统路由命名空间不能冲突

Custom API 只能注册在为应用扩展预留的路径规则内，不能覆盖：

- Modelry Data API 系统路由；
- Control Plane 路由；
- Auth/File/Realtime 等保留端点。

冲突必须在 Hook/Route 加载阶段返回确定性错误，而不是按注册顺序覆盖。

### 6. Handler 仍属于 Trusted Project Code

Route Contract 机器可读并不意味着 Handler 是沙箱代码。

V0.1 Custom API Handler 与 Hook 一样属于 Trusted Project Code，继续遵循 ADR-0005 的故障隔离边界。

## V0.1 不做

- 自动从任意 TypeScript Handler 源码推断完整 OpenAPI；
- 任意底层 Router escape hatch 作为正式公共 API；
- GraphQL resolver framework；
- 自动生成复杂业务 SDK implementation；
- 允许 Custom API 覆盖系统路由。

## 后果

### 正向

- Custom API 不再成为 OpenAPI 与 Agent Inspect 的黑盒；
- 一个 Route Contract 同时驱动 Runtime Validation、OpenAPI、Admin 和 SDK 类型；
- Agent 可以理解项目自定义业务 API，而不仅仅理解 CRUD；
- Custom API 保持 `Explicit over Magic`；
- 不会因为 Hook 扩展能力破坏 Data/Control Plane 的授权边界。

### 代价

- 开发者不能直接使用任意 HTTP Router API；
- Modelry 必须提供足够好用的 Route Contract API；
- Schema 表达能力需要在易用性和 OpenAPI 兼容性之间取舍；
- streaming、文件流、非 JSON response 等高级场景需要后续显式扩展。

## Spec Gate

`to-spec` 必须明确：

- Route Definition TypeScript API；
- Schema 表达方式；
- request/response runtime validation；
- auth declaration；
- error response；
- route conflict；
- OpenAPI mapping；
- Agent Inspect representation；
- Custom API 调用内部 Record API 时的 Principal/Policy 传递规则。
