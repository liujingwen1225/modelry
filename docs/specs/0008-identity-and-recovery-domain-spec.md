# Identity and Recovery Domain Spec (Community V0.1.x)

- **Status:** Accepted
- **Date:** 2026-09-25
- **Issue:** [#26](https://github.com/liujingwen1225/modelry/issues/26)
- **Depends on:** [ADR-0006](../adr/0006-administrators-and-account-recovery.md), [Administrators, Mail Delivery, and Account Recovery](../product-model/0003-identity-and-recovery.md), [Extension Runtime Domain Spec](./0005-extension-runtime-domain-spec.md), [Webhooks and Jobs Domain Spec](./0006-webhooks-jobs-domain-spec.md)
- **Contract:** [OpenAPI](../contracts/openapi.yaml)

本 Spec 定义 Additional Administrators、Control Plane Permission、Control Plane Session、Mail Provider、Mail Delivery，以及 App User 的 Email Verification 与 Password Reset。Transport 细节以 OpenAPI 为准。

## 1. Scope

- Administrator CRUD、Permission、启用/停用、密码重置与 Session 管理。
- Owner bootstrap 语义不变，且 Owner 唯一。
- Project Mail Provider 配置、连接测试与 durable Mail Delivery。
- App User Email Verification（off / optional / required）。
- App User Password Reset（申请、确认、撤销全部 Session）。
- Audit：管理员、邮件、恢复流程的 Control Plane 事实。

## 2. Non-goals

- OAuth / OIDC（含 GitHub、Google、微信、企业微信、钉钉、飞书）。
- SAML、Enterprise SSO、SCIM、Organization / Team / Directory / Group Provisioning。
- 多 Runtime、分布式队列、外部 Broker、跨 Project 邮件发送。
- App User 自定义邮件模板编辑、附件、富文本邮件、批量营销邮件。

## 3. Domain model

### 3.1 Administrator

- 字段：id（`adm_` + 32 hex）、email、状态（`active` / `disabled`）、Permission（preset + custom version + operations）、createdAt、updatedAt、lastLoginAt。
- email 唯一（大小写不敏感）、去除首尾空白、最长 254 字符；密码为 write-only credential，最小 12 字节、最大 1024 字节。
- Permission 复用 Control Plane operation 词表：preset `fullAccess` / `readOnly` / `custom`。Custom 必须声明至少一个受支持 operation。
- 上限 32 个 Administrator。Owner 不计入该上限。
- Owner 不能创建第二个 Owner，也不能把 Administrator 提升为 Owner。
- 删除或停用 Administrator 时，其全部 Control Plane Session 在同一事务内撤销。

### 3.2 Control Plane Session

- 登录端点：`POST /admin/api/v1/auth/login`。Owner 与 active Administrator 都可登录。
- 会话响应包含 `role`（`owner` / `administrator`）与 `permission`（preset + operations，Owner 为 fullAccess）。
- Administrator session 时长 30 天；Owner session 维持现有语义。
- Session 记录：id（`ses_` + 32 hex）、administrator id（Owner 为空）、token hash、createdAt、expiresAt、revokedAt、lastUsedAt。
- 撤销：停用/删除 Administrator、Administrator 自己登出、Owner 通过 `POST /admin/api/v1/administrators/{id}/sessions/revoke-all` 撤销。
- 过期或已撤销的 session 一律 `401 UNAUTHENTICATED`；停用 Administrator 的 session 立即失效。
- 保留上限 1,024 条 Administrator session。

### 3.3 Permission enforcement

- Control Plane 请求按 Method + Path 映射到 operation（与 Service Account 相同的映射表）。
- Owner 通过所有 operation。Administrator 通过当且仅当 Permission 覆盖该 operation。
- 未映射的 Control Plane 路由只允许 Owner（fail closed）。
- 拒绝返回 `403 FORBIDDEN`，details 包含 `requiredOperation`；拒绝事实写入 Audit（result `denied`）。

### 3.4 Mail Provider

- 单例配置：enabled、host、port、security（`startTLS` / `tls`）、from address、from name、username secret id、password secret id、revision、updatedAt。
- 仅 Owner 可读可写；写入必须携带 expectedRevision。
- 默认 `enabled=false`。启用需要 host、port、from address 与已配置的 username / password Secret；否则 `409 MAIL_NOT_CONFIGURED`。
- `POST /admin/api/v1/mail/test` 同步发送一封测试邮件（bounded，最长 20 秒），不写入 delivery 历史以外的状态；失败返回安全错误码，不泄漏 SMTP 响应正文。
- 凭据只在单次投递尝试内解密到内存，投递结束后不再持有；不写入 SQLite、RequestRecord、Audit、日志或响应。

### 3.5 Mail Delivery

- 字段：id（`mail_` + 32 hex）、kind（`test` / `verification` / `passwordReset`）、recipient、status（`pending` / `running` / `succeeded` / `failed` / `cancelled` / `interrupted`）、attempts、nextAttemptAt、errorCode、createdAt、completedAt。
- 目标内容不持久化：message 正文与 token 只存在于创建 intent 的一次调用中；intent 保存 token hash 与 purpose。
- Worker：单并发、bounded attempts（最多 8）、backoff、可取消、restart-aware（启动把 `running` 标记 `interrupted` 并归还 pending 当且仅当预算尚存且 Provider 仍启用）。
- Provider 未启用或凭据不可用时，intent 保持 pending 并记录安全 errorCode；不静默丢弃。
- 上限：pending 1,000、retained 5,000、单条重试 ≤8、每分钟 ≤2 次尝试、单封 ≤512 KiB。

### 3.6 Email Verification

- Auth Collection 配置新增 `emailVerification`：`off`（默认，保持 V0.1 行为）/ `optional` / `required`。
- `POST /api/v1/auth/{collectionName}/email-verification/request`：body `{email}`；始终 `202 accepted`；仅在 App User 存在、flow 未关闭、mail 可用时创建 intent 与 token。
- `POST /api/v1/auth/{collectionName}/email-verification/confirm`：body `{token}`；成功标记 verified 并消费 token。
- `required` 时未验证 App User 登录返回 `403 EMAIL_NOT_VERIFIED`，details 包含 collection 与 recovery 提示。

### 3.7 Password Reset

- `POST /api/v1/auth/{collectionName}/password-reset/request`：body `{email}`；始终 `202 accepted`（不枚举账号）。
- `POST /api/v1/auth/{collectionName}/password-reset/confirm`：body `{token, password}`；成功设置新密码、消费 token、撤销该 App User 的全部 Application Session，并在同一事务写入 Audit。

### 3.8 Recovery token

- token 形态：`vfy_` / `rst_` + 32 hex；服务端只保存 SHA-256 hash + purpose + App User + expiresAt + usedAt。
- TTL 30 分钟；单次使用；同一 App User 每小时最多 16 次申请；保留上限 1,024。
- 未知、过期、已使用、purpose 不匹配一律 `400 INVALID_ARGUMENT`（同一安全文案），不泄漏内部状态。

## 4. Control Plane API

| Method | Path | Operation | 说明 |
| --- | --- | --- | --- |
| GET | /admin/api/v1/administrators | administrators.read | 列表（cursor 分页） |
| POST | /admin/api/v1/administrators | administrators.manage | 创建（Owner） |
| GET | /admin/api/v1/administrators/{id} | administrators.read | 详情 |
| PATCH | /admin/api/v1/administrators/{id} | administrators.manage | 修改 email / permission |
| DELETE | /admin/api/v1/administrators/{id} | administrators.manage | 删除并撤销 session |
| POST | /admin/api/v1/administrators/{id}/enable | administrators.manage | 启用 |
| POST | /admin/api/v1/administrators/{id}/disable | administrators.manage | 停用并撤销 session |
| POST | /admin/api/v1/administrators/{id}/password | administrators.manage | Owner 设置新密码并撤销 session |
| GET | /admin/api/v1/administrators/{id}/sessions | sessions.read | 该 Administrator 的 session 列表 |
| POST | /admin/api/v1/administrators/{id}/sessions/revoke-all | sessions.revoke | 撤销全部 session |
| GET | /admin/api/v1/mail | mail.read | Mail Provider 配置与投递统计 |
| PUT | /admin/api/v1/mail | mail.manage | 保存配置（expectedRevision） |
| POST | /admin/api/v1/mail/test | mail.manage | 发送测试邮件 |
| GET | /admin/api/v1/mail/deliveries | mail.read | 投递历史 |
| POST | /admin/api/v1/mail/deliveries/{id}/retry | mail.manage | 重试失败投递 |

创建/修改/删除 Administrator 与 Mail Provider 变更仅允许 Owner（`administrators.manage` / `mail.manage` 也属于 Owner 与 Full access Administrator 的 operation，但产品上 Administrator 不能创建 Administrator）：Administrator 的 `administrators.manage` 与 `mail.manage` operation 在权限评估中显式拒绝，只有 Owner 通过。

## 5. Errors

| Code | HTTP | 触发 |
| --- | --- | --- |
| UNAUTHENTICATED | 401 | 无 session、session 过期或已撤销 |
| FORBIDDEN | 403 | Permission 不足；details.requiredOperation |
| EMAIL_NOT_VERIFIED | 403 | `required` 模式下未验证 App User 登录 |
| NOT_FOUND | 404 | Administrator / delivery 不存在 |
| CONFLICT | 409 | expectedRevision 过期、email 重复、Owner 保护操作 |
| MAIL_NOT_CONFIGURED | 409 | Mail Provider 未启用或凭据缺失 |
| MAIL_UNAVAILABLE | 503 | SMTP 连接失败或超时 |
| TOO_MANY_REQUESTS | 429 | 恢复申请或管理员重置超出速率上限 |
| VALIDATION_FAILED | 422 | 字段级校验失败（email、password、permission） |

错误响应沿用既有 envelope，且不含 SMTP 响应正文、凭据、token、密码。

## 6. Audit

- `administrator.created|updated|enabled|disabled|deleted|passwordSet|sessionsRevoked`
- `mail.providerConfigured|testSent|deliveryRetried`
- `auth.passwordResetRequested|passwordResetCompleted|emailVerificationRequested|emailVerificationCompleted`（Control Plane 侧记录事实，不含 token）
- `controlPlane.denied`：Permission 拒绝事实，包含 actor、operation、method 与安全路由模板。
- 每条 AuditRecord 只包含演员、动作、资源与结果；不包含密码、token、邮件正文、SMTP 凭据。

## 7. Bounds

| 项目 | 上限 |
| --- | --- |
| Administrators | 32 |
| Administrator sessions | 1024 |
| Administrator session 时长 | 30 天 |
| Mail intents pending | 1000 |
| Mail intents retained | 5000 |
| 单条投递尝试 | 8 |
| 每分钟投递尝试 | 2 |
| 单封邮件 | 512 KiB |
| 单次 SMTP connect / attempt | 10s / 20s |
| 恢复申请速率 | 16 / App User / 小时 |
| 恢复 token TTL | 30 分钟 |
| 恢复 token retained | 1024 |

## 8. Acceptance

1. Owner 可以创建 Administrator 并指定 Permission；Administrator 能登录并只看到、只执行被允许的操作。
2. Permission 不足返回 403 + requiredOperation，并写入 Audit。
3. 停用或删除 Administrator 后其 session 立即失效（401）。
4. Owner 不可被停用、删除或降权；也不能由 Administrator 创建。
5. Mail Provider 未配置时，验证与重置申请 fail closed（MAIL_NOT_CONFIGURED），且不产生链接日志。
6. 配置 Mail Provider 并测试成功后，密码重置申请对存在与不存在的 email 返回相同响应。
7. 重置链接单次有效、30 分钟过期；成功后该 App User 的所有 Application session 失效。
8. `required` 验证模式下未验证 App User 登录被拒（EMAIL_NOT_VERIFIED），验证后登录成功。
9. Mail 投递是 durable outbox：重启后未完成投递恢复为 interrupted/pending，凭据与 token 不落库。
10. 现有 V0.1 Auth 行为（off 验证 + 现有登录/会话）保持不变。
