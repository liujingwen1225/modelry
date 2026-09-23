# ADR-0009：Auth Collection、Credential 与 Session 模型

- **状态：** Accepted
- **日期：** 2026-09-02

## 背景

Modelry 需要为业务应用提供开箱即用的认证能力，但又不能把认证简化成一个固定 `users` 表或若干特殊字段。

前置 ADR 已经明确：Principal 与 Credential 分离，Admin Principal 与业务 Auth Principal 分离，Data Plane 使用 Record Policy，Control Plane 使用 Capability Scope。

因此 Auth Collection 必须既保持 PocketBase 类产品的低门槛体验，又具备可扩展、可审计、可被 Agent 理解的声明式模型。

## 决策

### 1. Auth 是 Collection Capability

V0.1 保留 Normal Collection 与 Auth Collection 两类 Collection。Auth Collection 在普通 Collection 数据模型之上声明认证能力，而不是单独存在一个硬编码 User 服务。

一个 Project 可以存在多个 Auth Collection，例如 `customers`、`merchants`、`members`。

Auth 配置属于 Backend Model，并可被 Admin、CLI、MCP 和 OpenAPI/元数据读取。

### 2. Login Identifier 可配置

Auth Collection 不强制同时存在固定 `email` 与 `username` 字段。

V0.1 允许按 Collection 配置登录标识，例如：

- email
- username

手机号等 Identifier 可在后续扩展。

### 3. Password 不是普通 Field

Password 是绑定 Auth Principal 的 Credential，不作为 Collection 普通 `text` Field 暴露。

Password Hash、Hash 算法、算法迁移、重置 Token、轮换等都属于认证子系统内部状态。

### 4. Email Verification 是声明式 Capability

Email Verification 支持：

- `off`
- `optional`
- `required`

是否允许未验证身份建立受限 Session，应由明确 Auth 策略决定，而不是通过普通 Field Validation 隐式表达。

### 5. Password Reset 由 Modelry 内置

V0.1 内置密码重置流程，包括 Token 生成、有效期、单次使用和 Credential 更新。

邮件模板和发送 Provider 可以配置，但密码重置的安全生命周期由 Modelry 统一实现，不要求每个项目自行 Hook。

### 6. V0.1 支持 Email OTP，SMS OTP 后置

Email OTP 进入 V0.1 核心认证能力。

SMS OTP 因供应商、费用、地区、模板审核等额外复杂性后置。

### 7. OAuth 使用可扩展 Provider Interface

V0.1 首选内置 GitHub 与 Google Provider。

核心身份模型不依赖具体 Provider，后续可增加 Microsoft、Apple、WeChat、Feishu、DingTalk 等。

外部 OAuth Account 通过 Identity 绑定到 Auth Principal。一个 Auth Principal 可以绑定多个 Identity，并可同时拥有 Password Credential。

不同 Provider 登录不能默认制造多条业务用户记录；账号绑定/合并必须遵循明确安全规则。

### 8. MFA 预留，不进入 V0.1 完整范围

Principal / Credential / Session 模型必须允许未来增加：

- TOTP
- WebAuthn / Passkey
- Recovery Code

但 V0.1 不实现完整 MFA 产品能力，避免首版认证系统膨胀成通用 IAM 平台。

### 9. Anonymous Auth 可选启用

Auth Collection 可选择启用 Anonymous Auth，默认关闭。

Anonymous Principal 拥有受限 Session，并可受 Record Policy 约束。

后续绑定 Email、Password、OTP 或 OAuth Identity 时，应支持匿名身份升级为注册身份，并尽量保持同一业务 Record / Principal 连续性。

### 10. Session 是服务端可撤销 Credential

V0.1 采用：

`短生命周期 Access Token + 服务端 Refresh Session`

而不是仅使用长期无状态 JWT。

Session 至少记录：

- `sessionId`
- `principalId`
- `createdAt`
- `lastUsedAt`
- `expiresAt`
- `revokedAt`

可按隐私策略记录 User Agent、IP 等辅助上下文。

V0.1 支持：

- 撤销当前/指定 Session
- 撤销其他 Session
- 全部登出
- 管理员强制失效

### 11. Auth Event 进入统一 Event System

V0.1 至少定义：

- `auth.registered`
- `auth.login.succeeded`
- `auth.login.failed`
- `auth.email.verified`
- `auth.password.changed`
- `auth.session.revoked`

这些领域事件可以驱动 Audit、Hook 和 Webhook。业务扩展应消费领域事件，而不是依赖认证内部存储表。

## 产品体验约束

底层模型可以正规，但默认产品体验必须保持简单。

典型路径应保持为：

`创建 users Auth Collection -> 启用 email/password -> 自动获得注册、登录、Session、邮箱验证/重置密码等能力`

AI Agent 也应能通过 Backend Model 直接 Inspect 出某个 Auth Collection 当前允许的登录方式、验证要求和 Provider，而不需要阅读运行时内部表。

## 后果

### 正向

- Auth 不再绑定唯一 User 表，可自然支持多业务身份域。
- Password、OAuth、OTP、Session 都能在统一 Principal/Credential 模型下演进。
- 后续增加 MFA、Passkey、新 OAuth Provider 时不需要推翻核心身份模型。
- Backend Model 对 Admin、MCP、Agent 和 OpenAPI 都保持机器可读。
- Auth Event 与统一 Event System 对齐，减少业务扩展侵入认证内部实现。

### 代价

- 认证子系统比“在 users 表加 password 字段”复杂，需要独立 Credential、Identity、Session 存储模型。
- OAuth 账号绑定、Identifier 唯一性、匿名升级等边界必须在后续规格阶段进一步精确定义。
- Email Provider、Token 生命周期、速率限制和滥用防护仍需要专门安全规格。

## V0.1 明确不做

- 完整 TOTP MFA 产品
- Passkey / WebAuthn
- Recovery Code
- SMS OTP
- 企业 SAML / OIDC Federation
- 通用 IAM / IdP 平台
