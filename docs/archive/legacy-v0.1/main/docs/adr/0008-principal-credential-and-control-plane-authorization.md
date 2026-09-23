# ADR-0008：分离 Principal 与 Credential，并区分 Data Plane 与 Control Plane 授权模型

- **状态：** Accepted
- **日期：** 2026-09-02

## 背景

Modelry 同时服务业务应用用户、后台管理员、Coding Agent、MCP Client 和自动化服务。如果把 User、Admin、API Key、Agent 等全部混成同一种“身份”概念，会导致认证、授权、凭证轮换和审计语义混乱。

另外，Data Plane 的业务数据访问和 Control Plane 的后端管理操作性质不同：前者需要细粒度 Record 级规则，后者更适合显式的能力授权。如果强行复用同一套 Policy，会让授权模型难以理解、实现和审计。

此前设计中的 `data:read` / `data:write` 还存在一个歧义：Agent 通过 MCP 查询业务 Record 时，究竟是模拟某个业务 Auth Principal 经过 Record Policy，还是执行管理员性质的数据检查。V0.1 必须从语义上消除这两条路径的混用。

## 决策

### 1. Principal 与 Credential 分离

Principal 表示“谁在操作”，Credential 表示“它如何证明自己的身份”。

V0.1 统一三类 Principal：

- **Admin Principal** —— Modelry Control Plane 管理身份；
- **Auth Principal** —— Auth Collection Record 认证后的业务身份；
- **Agent / Service Principal** —— Coding Agent、MCP Client、自动化和系统集成使用的机器身份。

Credential 包括 Password、OAuth、OTP、Session、API Key 等。API Key 不是 Principal。

一个 Principal 可以拥有多个 Credential；Credential 可以轮换、撤销或替换，而 Principal 身份保持不变。

### 2. Admin 与业务 Auth Collection 分离

Modelry Admin 不存放在业务 `users/customers/merchants` 等 Auth Collection 中。

首次启动且系统不存在 Admin 时，通过一次性 Bootstrap Setup Token 创建首个 Admin。首个 Admin 创建成功后，该 Token 立即失效。后续 Admin 创建必须由已有 Control Plane Admin 发起。

### 3. Session 采用可撤销模型

V0.1 采用短生命周期 Access Token + 服务端 Refresh Session 的方向，以支持：

- logout；
- revoke；
- 设备/session 管理；
- 强制失效。

不以长期完全无状态 JWT 作为唯一 Session 模型。

### 4. API Key 是机器 Credential

API Key 主要绑定 Agent / Service Principal：

- 创建时明文只显示一次；
- 持久化只保存安全 Hash；
- Key 本身不携带隐式超级管理员语义；
- 实际授权来自 Principal 的 Capability Scope。

### 5. Data Plane 与 Control Plane 使用不同授权原语

**Application Data Access：**

`Auth Principal -> Record Policy -> Records`

这条路径面向业务应用、SDK 和终端用户。Record Policy 决定业务 Principal 可以看到和修改哪些 Record。

**Control Plane Management：**

`Admin / Agent Principal -> Capability Scope -> Backend Model / ChangeSet / Secret / Audit / Administrative Data Access`

Control Plane 使用显式 Capability Scope，不把管理权限伪装成某个业务 Auth Principal 的 Record Policy。

Record Policy 与 Capability Scope 不混为同一套授权表达式。

### 6. Administrative Data Access 是独立的管理能力

Admin UI、CLI 或 MCP 可能需要为调试、迁移、诊断和运营目的读取或修改业务 Record。这是一条明确的 **Administrative Data Access** 路径，而不是普通 Data Plane 请求。

V0.1 使用概念性能力：

- `data:inspect` —— 允许通过受控管理工具读取业务 Record；
- `data:mutate` —— 允许通过受控管理工具创建、修改或删除业务 Record。

它们替代容易与 Data Plane Record Policy 混淆的 `data:read` / `data:write` 命名。

Administrative Data Access 的规则：

- 不使用虚构的 `auth.id` 去模拟业务用户；
- 默认不经过业务 Record Policy；
- 必须经过 Capability Scope；
- 必须进入 Audit，并记录真实 Principal、目标 Collection、Record、操作类型与结果；
- Secret、Credential Hash、内部认证状态等敏感系统字段仍受独立的不可读/脱敏规则约束；
- 高风险批量修改仍可要求额外确认或 ChangeSet，具体由 Spec 固定。

如果未来需要“以某个业务用户身份预览 Policy 结果”，应提供显式的 Policy Simulation 能力，而不是把真实管理访问与 impersonation 混成一个请求。

### 7. Agent 不拥有隐式超级权限

Coding Agent 使用 Agent / Service Principal 身份进入 Control Plane。即使拥有 `changeset:propose`，也不自动拥有 `changeset:apply`。

同样：

- `data:inspect` 不蕴含 `data:mutate`；
- `model:write` 不蕴含 `changeset:apply`；
- `secrets:manage` 不意味着可以重新读取 Secret 明文。

高风险 Apply 继续遵循 ChangeSet Risk + Confirmation 机制。

### 8. V0.1 Capability Scope 基线

V0.1 预期的底层 Scope 至少包括：

- `model:read`；
- `model:write`；
- `data:inspect`；
- `data:mutate`；
- `changeset:propose`；
- `changeset:apply`；
- `policy:write`；
- `secrets:manage`；
- `audit:read`；
- `runtime:read`。

具体角色模板可以后置；底层授权必须始终落到这些显式能力，而不是依赖“管理员”“Agent”名称自动放行。

## 后果

### 正向影响

- 身份、凭证、授权职责清晰；
- API Key 可以独立轮换而不改变机器身份；
- Admin 不受业务 Auth Collection Schema 变更影响；
- Data Plane 与 Control Plane 的业务数据访问不会再发生 `auth.id` 语义冲突；
- MCP/Agent 权限可做最小授权，不需要默认管理员模式；
- Audit 可以稳定记录真实 Principal，而不是记录易变化的 Credential；
- 后续可以独立增加 Policy Simulation / Impersonation，而不污染真实数据访问链路。

### 负向影响

- V0.1 需要同时实现 Record Policy 与 Capability Scope 两套授权原语；
- 管理型数据访问必须有独立 API/Tool 语义与审计；
- Session、API Key、Admin Bootstrap 需要独立的 Control Plane 元数据与生命周期管理；
- 未来引入团队、组织或复杂 RBAC 时，需要在 Capability Scope 之上增加高层角色抽象，而不是直接修改底层 Principal/Credential 模型。

## 安全不变量

1. Data Plane 的业务请求不能因为调用者是 Agent 而自动绕过 Record Policy。
2. Control Plane 的管理型数据访问不能伪装成业务 Auth Principal。
3. 所有 Administrative Data Access 必须可审计。
4. Capability Scope 必须遵循最小授权；任何 Scope 都不得隐式扩张成超级管理员。
