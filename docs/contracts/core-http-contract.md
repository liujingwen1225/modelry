# Core HTTP Contract — Modelry V0.1

- **状态：** Accepted — V0.1 Core HTTP Contract Baseline
- **范围：** Modelry Community V0.1 HTTP boundary
- **Canonical OpenAPI:** [openapi.yaml](./openapi.yaml)
- **依据：** Accepted ADR-0001、SPEC-0002、SPEC-0001、Issues #2 和 #5

本文件冻结 HTTP 的平面边界、最小资源与操作、错误与关联语义。它定义未来契约，不表示这些端点都已实现。具体响应形状以同目录 OpenAPI 为机器可读来源；Domain 语义遵循 SPEC-0002，路径与 DTO 不反向改变领域对象。

## 1. API 平面边界

| 边界 | Canonical prefix | 身份与授权 | 资源范围 |
| --- | --- | --- | --- |
| Modelry Control Plane | `/admin/api/v1` | 受保护的管理操作使用 Owner Session 或有对应 Permission 的 Service Account API Key；Bootstrap / 登录遵守各自公开流程，Runtime / Storage 状态可匿名读取安全快照 | Bootstrap、Owner 登录、Runtime / Storage 诊断、Collections / Schema / Access / Auth 管理、Service Accounts / API Keys、Requests、Audit |
| Application Data Plane | `/api/v1` | 可选 Application Session；每项 Collection 操作仍由对应 Access Rule 决定 | Collection Records、Application Auth / Session |

V0.1 是单 Runtime / 单隐式 Project；路径不含 organization、tenant、environment、project 或 region 层。Admin HTTP 和 Application HTTP 共用 Runtime 与领域服务，但各自认证、Principal、Permission / AccessRule 和观测边界分离。Control Plane 管理端点不能被当作 Application API；Admin 身份也不能用于 App User 登录。

`GET /admin/api/v1/runtime/status` 与 `GET /admin/api/v1/storage/status` 是额外的只读诊断例外，可匿名读取有限健康快照。Bootstrap 状态、首次 Owner 设置和 Owner 登录仍遵守各自公开流程。匿名诊断响应不包含 Project Root 的绝对路径或秘密；只有经 Owner Session 或具备相应 Permission 的 Service Account API Key 授权的诊断请求才可返回 Local Storage 路径。其余受保护的 Control Plane 读取和所有写操作仍按各自认证 / Permission 要求执行。

所有 ID 都是稳定不透明字符串；路径使用 ID 的资源不因显示名变化而换身份。Application Record 路径的 `{collectionName}` 是当前 Applied Model 中的 API 名称。集合详情 / 管理路径使用 `collectionId`。Collection Type 在创建时为 `Normal` 或 `Auth`，类型转换与 Collection 删除不由本契约开放。

## 2. 认证与安全边界

- 管理面浏览器登录由 `POST /admin/api/v1/auth/login` 建立 HttpOnly、SameSite 的 Owner Session Cookie；`logout` 撤销服务端 Session，`session` 返回当前 Owner 身份。部署在 HTTPS 时 Cookie 必须带 Secure。管理面写请求必须执行同源 / CSRF 防护。
- 管理面 CLI / Agent 使用 `Authorization: Bearer <API key>`。API Key 认证后的每项调用仍按关联 Service Account 的 Permission 授权。Owner 和 Service Account 不互换。
- Runtime / Storage 状态端点允许匿名读取健康快照；匿名响应及其诊断消息不包含 Project Root 绝对路径或凭证、令牌等秘密。携带凭证时先验证身份和相应 Permission；无效凭证或权限不足必须返回标准结构化错误，不得降级为匿名响应。Storage 路径只在授权的诊断响应中返回。
- Application 登录返回服务端可撤销的 opaque Session Token；后续 Application API 使用 `Authorization: Bearer <session token>`。它不是 Owner Session，也不是 API Key。
- Application Record 操作在没有 Session 时仍可到达 Runtime，以便规则为 `Anyone` 的操作执行；Runtime 必须 fail closed 地评估 Collection Access Rule。匿名访问不代表默认公开。
- `POST /admin/api/v1/bootstrap/owner` 仅在当前 Project 尚无 Owner 且本机首次 Bootstrap 能力开放时可用。它只覆盖本机默认首次设置；远程首次 Bootstrap 需要另行定义并验证 Claim / Secret 机制，不能把此匿名路径直接暴露为远程授权方式。
- 不定义 OAuth、Additional Administrator、Cloud Control Plane、通用 RBAC / Capability Graph 或未冻结的认证方式。

## 3. Canonical Request ID 与 RequestRecord

1. 每个到达 HTTP Runtime 的请求由入口生成一个全新的 canonical Request ID，格式为 `req_<opaque>`。不信任调用方传入的 `X-Request-Id` 作为权威值；如实现保留上游追踪值，必须与本 ID 分开存放。
2. Runtime 在**所有** HTTP 响应（含成功、错误和 204）设置 `X-Request-Id` 响应头；结构化错误的 `error.requestId` 必须与该头完全一致。每次重试是新 HTTP 请求，获得新 ID。
3. 每次 Application HTTP 请求（成功或失败）在可持久化时形成一个 RequestRecord。至少保存 RequestID、时间、Endpoint、Method、Status、Duration，以及安全范围内的 Authentication / Authorization outcome 和 Error Code。RequestRecord 不记录 Raw Credential、Authorization Header、完整敏感 Body 或无限制 Raw Header / Query。
4. API Runner 从响应读取 `X-Request-Id`，显示给用户，并以该值直接打开 Control Plane 的 `GET /admin/api/v1/requests/{requestId}`。错误详情、列表与 Request Detail 使用同一 ID，不要求复制后搜索。
5. Control Plane 请求也有 canonical `X-Request-Id` 和同形错误关联；只有 Domain 认定适用时，其 AuditRecord 才关联该 ID。RequestRecord 是 Application HTTP 操作遥测，AuditRecord 是 Control Plane 安全 / 治理事实，二者不可合并。
6. 如果存储故障导致 RequestRecord 无法持久化，HTTP 错误仍携带同一 Request ID；Runtime 不伪称该请求已有可打开的耐久 Request Detail，也不泄露请求秘密。

## 4. Structured Error Envelope

所有非 2xx JSON 响应使用同一 envelope：

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request could not be applied.",
    "details": {
      "violations": [
        {
          "path": "/name",
          "code": "REQUIRED",
          "message": "Name is required."
        }
      ]
    },
    "hint": "Add a name and retry.",
    "requestId": "req_7b19..."
  }
}
```

- `code` 是稳定、机器可读的大写标识；客户端按 code 分支，不解析 message。
- `message` 面向人类，可本地化；不包含堆栈、SQL、凭证或敏感 Body。匿名诊断请求的错误消息也不得包含 Project Root 绝对路径。
- `details` 始终为结构化 JSON object；通用字段可扩展，`violations` 用于可定位的输入问题。匿名诊断错误的 `details` 不得暴露 Project Root 绝对路径或秘密；未定义语义的细节不得成为兼容性依赖。
- `hint` 仅在 Runtime 能给出安全、可行动的修复步骤时提供；匿名诊断错误的 hint 不得包含 Project Root 绝对路径或秘密。
- `requestId` 是入口生成的 canonical ID，与响应头相同，不接受调用方伪造。

### HTTP 状态映射

| HTTP | 典型稳定 Code | 含义 |
| --- | --- | --- |
| 400 | `INVALID_ARGUMENT` | 参数格式、JSON 或受支持的查询语法无效 |
| 401 | `UNAUTHENTICATED` | 缺少、无效、过期或已撤销的 Session / API Key |
| 403 | `FORBIDDEN`、`REGISTRATION_DISABLED` | 身份有效但无 Permission / Access；注册未启用 |
| 404 | `NOT_FOUND` | 资源不存在或当前 Principal 不可见 |
| 409 | `CONFLICT`、`BOOTSTRAP_CLOSED`、`CHANGE_CONFIRMATION_REQUIRED` | 当前状态或版本冲突；需确认 Risk；Bootstrap 已关闭 |
| 413 | `PAYLOAD_TOO_LARGE` | 上传或请求超出受支持大小 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Content-Type 不受支持 |
| 422 | `VALIDATION_FAILED` | 请求结构可解析但违反领域 / 字段 Validation |
| 429 | `RATE_LIMITED` | Runtime 对请求施加限流（仅在该机制启用时） |
| 500 | `INTERNAL_ERROR` | 未预期内部错误；不给客户端内部实现细节 |
| 503 | `STORAGE_UNAVAILABLE`、`STORAGE_BUSY`、`RUNTIME_NOT_READY` | 必要存储 / Runtime 当前不能安全处理请求 |

成功的删除 / 撤销可返回 204 空 Body；它仍必须返回 `X-Request-Id`。404 不泄露用户无权访问资源是否存在。

## 5. 最小资源与操作

请求 / 响应 DTO 的完整字段及错误 refs 以 OpenAPI 为准。

### Bootstrap、Owner 与 Runtime

- `GET /admin/api/v1/bootstrap/status`：只读返回 `required` / `closed` 状态。
- `POST /admin/api/v1/bootstrap/owner`：原子创建唯一 Owner；成功关闭 Bootstrap Capability 并建立管理 Session。不得要求本机用户复制 Setup Token。
- `POST /admin/api/v1/auth/login`、`POST /auth/logout`、`GET /auth/session`：登录、撤销当前管理 Session、读取当前 Owner Session。
- `GET /admin/api/v1/runtime/status`、`GET /admin/api/v1/storage/status`：无需凭证即可返回 ADR-0001 定义的有限派生健康快照；Unknown / Unavailable 不得显示为 Ready。匿名响应不返回 Project Root 绝对路径或秘密；Local Storage 路径仅对经授权的诊断请求返回。不提供 Runtime Settings mutation。

### Collections、Records 与 Schema

- Control Plane `GET/POST /collections` 和 `GET /collections/{collectionId}` 列出、创建和读取 Collection。创建在一次操作中持久化 Normal / Auth 类型与初始 Model；初始结构不是原始 SQL 端点。
- 管理面 Records 端点用于 Admin 在 Collection Workspace 读取 / 管理数据；Application Records 端点是 Collection 的稳定 REST CRUD 边界。两者权限检查分开。
- Application `GET/POST /api/v1/{collectionName}` 与 `GET/PATCH/DELETE /api/v1/{collectionName}/{recordId}` 对应 List / Create / View / Update / Delete。所有操作使用 Applied Model、Validation、Default 与 Access Rule；系统字段由 Runtime 管理。Record CRUD 不进入 Schema Change。
- Schema 先保存 Pending Operation，再 inspect、preview / apply / discard，最后读取 Applied History：`pending-change`、`pending-operations`、`preview`、`apply`、`discard`、`history` 端点见 OpenAPI。Schema Change 的作用域恰为一个 Collection；Field / Relation / Index 共用持久 Pending Change。
- `GET /changes` 与 `GET /changes/{changeSetId}` 提供全局 Changes Surface 和指定 Change 的恢复详情；列表分别表达 Pending Change 与不可变 AppliedMigration，不把失败 ApplyAttempt 改写成成功历史。
- Apply 请求不能携带原始 SQL，也不能由调用方指定 authoritative Risk / Diff / Preconditions。Runtime 每次 Preview / Apply 重新计算 Diff、Risk、Preconditions、Impact。SAFE 可直接应用；需 Review 时，未确认返回 409 和可解释详情，用户在当前业务上下文确认后重试。失败保留 Pending Change，并将新的 ApplyAttempt 与恢复结果关联；成功历史对应不可变 AppliedMigration。
- Access Rule 与 Auth Configuration 各有自己的保存、Apply、Discard 生命周期，不加入 Schema Pending Change。

### Auth Users、Credentials 与 Sessions

- Admin 通过 Control Plane `GET/POST /collections/{collectionId}/users` 浏览或创建 Auth Collection 用户。创建一次提交 Profile Record + Password Credential；不得让调用方分别写入后得到半个用户。
- Application Auth 在 `/api/v1/auth/{collectionName}` 下提供注册（仅当已 Apply 且启用）、登录、当前 Session、登出、密码更改与 Session 查看 / 撤销边界。密码是 Credential，不是 Field；不得读回或进入普通 Record response。
- Control Plane 可按权限为 Auth Collection 创建 App User、改密码、查看 / 撤销 App User Sessions。Session 必须可服务端撤销，撤销后的 Session 后续访问失败；密码修改时按 ADR-0001 原子处理所需 Session 失效。
- Auth Collection 的 Email Identifier、注册开关和 Session Duration 属于 Auth Configuration，不属于 Schema Change。Self Registration 默认关闭。

### Service Accounts、API Keys、Requests 与 Audit

- `GET/POST /service-accounts` 与 `GET/PATCH /service-accounts/{id}` 管理 Service Account；V0.1 Permission 仅有受控 Full Access、Read Only、Custom 表达，不开放额外管理员。
- 创建 API Key 通过 `POST /service-accounts/{id}/api-keys`。明文只在成功响应中展示一次；明文不得出现在列表、后续读取、Record、RequestRecord、AuditRecord 或 Error 中。列表只返回非秘密摘要，`POST /api-keys/{id}/revoke` 撤销为不可逆事实；禁用 Service Account 也立即使其 Key 不可认证。
- `GET /requests`、`GET /requests/{requestId}` 只暴露已脱敏 Application RequestRecord 元数据。不得暴露原始凭证、无限制 Header / Query 或完整敏感 Body。
- `GET /audit`、`GET /audit/{auditRecordId}` 只读访问耐久、追加式 AuditRecord，并按 Owner / Permission 授权。Audit 不等于所有 Application Request。

## 6. Schema 兼容性约束

- OpenAPI 是唯一 canonical HTTP DTO 描述；本文件说明契约语义，不复制 Schema 字段定义。
- `operationId` 全文唯一且稳定。移除、重命名路径或字段必须按兼容变更评估。
- 错误 envelope、requestId、平面前缀和安全边界适用于 V0.1 的后续实现；列出操作不代表本次已实现所有产品能力。
- 查询分页采用 opaque cursor；分页大小有界。Search / Filter / Sort 语法以本契约中的稳定字段为限，不能接受任意 SQL。后续扩展不得让 Application API 穿过 AccessRule。
- 所有日期时间采用 RFC 3339 UTC；JSON ID 不暴露 SQLite RowID。空缺 / Unknown 与空集合严格区分。
- 本契约不定义 HTTP API 的未来 major-version 生命周期或请求记录保留年限；RequestRecord Retention 必须在运维边界明确前，不得宣传未约定时长。

## 7. 规范依据

- [Issue #2 — V0.1 Foundation Closure](https://github.com/liujingwen1225/modelry/issues/2)
- [Issue #5 — Core HTTP Contract & OpenAPI](https://github.com/liujingwen1225/modelry/issues/5)
- [ADR-0001 Runtime / Storage](../adr/0001-runtime-storage-architecture.md)
- [SPEC-0002 V0.1 Domain Foundation](../specs/0002-v0.1-foundation-spec.md)
- [SPEC-0001 Admin Product UX](../specs/0001-admin-product-ux-spec.md)
- [OpenAPI Specification 3.1.1](https://spec.openapis.org/oas/v3.1.1.html)
