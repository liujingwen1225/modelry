# SPEC-0003 — V0.1 Browser Acceptance

- **状态：** Accepted — V0.1 Browser Acceptance Baseline
- **范围：** Modelry Community V0.1 核心产品流程的浏览器验收
- **依据：** `CONTEXT.md`、`AGENTS.md`、V0.1 当前权威文档、SPEC-0001、SPEC-0002、ADR-0001、GitHub Issues #2 / #6
- **依赖：** ADR-0001 Runtime / Storage、SPEC-0002 Domain Foundation、Core HTTP Contract / OpenAPI
- **不定义：** HTTP 路径或 DTO、SQLite 表结构、React 组件 API、测试框架或产品实现

本 Spec 定义十条 V0.1 产品能力端到端验收流程。每条流程在其对应产品能力实现并纳入候选版本后，必须通过真实 Admin + Chromium 验收；API 和 Runtime 诊断用于第二观察面验证，不可代替浏览器产品验收。

## 1. 验收环境与执行规则

### 1.1 必需环境

每次发布验收必须同时使用：

- **Real Runtime：** 当前候选版本的真实 Go Runtime，按 ADR-0001 的正常启动、就绪、停止流程运行。
- **Real SQLite：** Runtime 管理的 Project SQLite 文件；禁止内存数据库、Mock Repository 或替代实现。
- **Real HTTP：** 浏览器和辅助客户端访问真实 Runtime HTTP 服务；核心 API 不得被 Stub、拦截器或录制响应替代。
- **Real Admin：** 当前候选版本构建的 Admin，通过 HTTP 加载并连接上述 Runtime。
- **Real Chromium：** 使用 Chromium 打开 Admin 并完成用户操作；API-only、组件测试或截图不能替代。

使用新建的隔离临时 Project Root；FLOW-001 从合法空目录开始。其余流程可按下述前置条件顺序共享同一测试 Project。辅助核验可使用受支持的 Product API、OpenAPI、Runtime / Storage 诊断及真实 SQLite 文件状态；不得把 SQLite 表或列设计冻结为验收契约。

每个流程记录浏览器操作结果、关键 Durable Result、相关 HTTP 结果 / requestId 及失败信息。流程中标记为预期的业务拒绝（例如无权访问、唯一性冲突）须呈现为结构化、可恢复的产品结果，不能用隐藏浏览器错误或非预期 5xx 表达。

### 1.2 全局 Browser Health Gate

任一 Mandatory Flow 出现以下情况，该流程及本次发布验收立即失败：

- 非预期 Console Error；
- Page Exception；
- 非预期 HTTP 5xx；
- Loading 超过该步骤的验收等待期限，且没有完成、失败或恢复状态；
- Broken Navigation（预期导航、返回、Deep Link 或页面切换损坏）；
- 未处理的 Network Failure；
- Reload 或 Restart 后，UI、真实 HTTP 与已承诺的 Durable Result 不一致。

除明确预期的业务错误外，所有流程都必须满足此 Gate。停 Runtime 的 Restart 步骤须先关闭浏览器页面；重启后再打开浏览器，以免将计划中的停机误报为浏览器网络错误。

### 1.3 产品能力发布判定

十条流程分别是对应产品能力完成后的端到端发布门禁。候选版本声明支持某条流程所覆盖的能力时，该流程必须通过；声明完整 V0.1 核心产品能力时，FLOW-001 至 FLOW-010 均须通过。流程定义描述目标产品行为，不代表该能力已实现，也不授权提前实现后续功能。

某项能力尚未进入候选版本时，不得把该流程记为通过，也不得把它伪装成已交付功能。该能力进入候选版本后，其流程必须按本 Spec 使用真实 Runtime、真实 SQLite、真实 HTTP、真实 Admin 和真实 Chromium；不得使用 Mock Backend、Stub、网络拦截或录制响应通过发布门禁。API 请求成功、Go 单元 / 集成测试通过或静态 OpenAPI 校验均不能单独替代浏览器流程结果。任何适用流程失败须先修复或阻断相应发布；不得把失败项标作通过。

### 1.4 V0.1 Product Closure 发布门禁

GitHub Issue #11 将 FLOW-001 至 FLOW-010 纳入同一 V0.1 Product Closure。候选版本必须从空 Project Root 开始，按顺序完成全部产品流程，并在同一 Root 上执行重启验证：

```text
empty Project Root
→ Owner Bootstrap and first Collection / Record
→ Collections, Records, Schema Pending Changes, and Apply
→ Application User, Session, and Access Rules
→ API Runner, Request Detail, Service Account, and API Key
→ failed Schema Apply recovery
→ close the browser page and stop Runtime
→ restart against the same Project Root
→ durable product state, revoked credentials, Requests, and Audit remain valid
```

此发布门禁执行全部十条流程，不得用旧的 Runtime / Storage foundation smoke 替代。Runtime / Storage 诊断和结构化错误仍是各流程的辅助核验；它们不能代替真实的产品操作、耐久状态检查或 Chromium 流程。候选版本声明完整支持 V0.1 Community 时，任何适用流程失败都阻断发布，不得将尚未实现的功能标为通过。

## 2. FLOW-001 — First Run

### Preconditions

- 隔离 Project Root 合法、可访问且为空；没有 `.modelry/`、Owner 或 Collection。
- Runtime 与 Admin 候选版本可启动；Chromium 可访问本机 Admin。

### User Actions

1. 按标准方式从空 Root 启动 Runtime，并等待 Admin 提示就绪。
2. 在 Admin 完成首次 Owner 创建。
3. 按首次 Setup 后的默认路径创建 `authors` Normal Collection，初始增加必填 `name` Text Field。
4. 在 Records 中创建第一条 Author Record。

### Visible Result

- 本机首次 Bootstrap 不要求复制长 Setup Token；成功后建立 Owner Session 并关闭 Bootstrap。
- 无 Collection 时直接进入 Create Collection，而非停在无行动的 Overview。
- Collection 创建完成后就地显示 Records 空状态及 Create Record；成功创建后显示可验证的 Record 值。
- `id`、`createdAt`、`updatedAt` 始终可见且锁定；不允许编辑、删除或改名。
- Runtime 与 Storage 未就绪时不得显示 Ready。

### Durable Result

- Project ID、Owner、Collection 初始 Applied Model、第一条 Record 与必要管理面状态写入该 Root 的真实持久状态。
- Bootstrap 完成后重新打开 Admin 或刷新，不能回到可重复创建 Owner 的状态。

### Secondary Verification

- 在 Admin Settings / 受支持的 Runtime 诊断中核对 Runtime、SQLite Database、Local Storage 的真实健康状态与当前 Project。
- 通过真实 HTTP 的受支持管理 / Application 面确认 Collection 和 Record 可见；页面数据与返回内容一致。

### Failure Conditions

- 空目录启动要求用户手工建立数据库 / 配置文件，或本机流程要求复制 Setup Token。
- Bootstrap 未关闭、Owner 未建立、首个 Collection 未能直接创建、系统字段缺失 / 可编辑，或 Record 值在刷新后丢失。
- 任何全局 Browser Health Gate 失败。

## 3. FLOW-002 — Create Normal Collection

### Preconditions

- FLOW-001 已建立 Owner、`authors` Collection 与第一条 Record；Runtime 为 Ready。

### User Actions

1. 从 Collections 创建新的 Normal Collection `posts`。
2. 在同一次创建中加入 `title`（Required Text）与 `category`（Text）等初始 Fields。
3. 提交并进入新 Collection 的 Records Workspace。

### Visible Result

- Create Collection 是一个连续工作面，可在创建时定义初始 Fields，不先建立空 Collection 再跳 Schema。
- 成功后显示 `posts` 与其 Fields；无既有数据的新 Collection 不要求常规 Migration Review。
- Records 显示 Ready / Empty 状态和明确的 Create first record 行动；系统字段仍可见且锁定。

### Durable Result

- `posts` Collection、初始字段、系统字段及 Applied Model 状态耐久保存；重新导航后仍存在。

### Secondary Verification

- Reload Admin 后重新打开 `posts`，核对字段与 Collection Type。
- 通过真实 HTTP / OpenAPI 的受支持模型观察面核对 Collection 与 Fields；确认与 Admin 展示一致。

### Failure Conditions

- 提交后只创建 Collection 却丢掉初始 Fields，或把初始建模强制变成独立 Schema Apply 流程。
- Collection 身份、类型或系统字段与 Admin 展示不符；刷新后未保存。
- 任何全局 Browser Health Gate 失败。

## 4. FLOW-003 — Record CRUD

### Preconditions

- FLOW-002 的 `posts` 含 `title`、`category` 字段且没有 Records。
- `authors` 中有一条可用于关系值的 Record。

### User Actions

1. 在 Admin 创建两条 `posts` Records，设置不同 Title 且相同 Category，供后续唯一性冲突流程使用。
2. 打开一条 Record 的 Detail，直接 Edit 并保存新 Title。
3. 通过列表 Search 找到该 Record、检查分页 / 返回上下文，然后从行操作删除另一条指定 Record。
4. 离开 Collection 后重新打开并 Reload。

### Visible Result

- 创建成功后同一 Sheet 留下可见的 Durable Result、稳定 ID 和更新后的列表。
- 可从 Row Action 直接 Edit，不必先打开 Detail；编辑结果原地可见。
- Search / Filter / Sort / Pagination 等已使用的列表上下文在 Detail / Edit 返回后尽可能恢复。
- Record CRUD 不显示 Schema Pending Change；无 Bulk Runtime 时不显示 Row Selection / Bulk Action。

### Durable Result

- 创建与更新的 Record 值跨导航和 Reload 保持；删除的 Record 不再显示。
- 两条相同 Category 的有效 Records 保留，作为 FLOW-009 的冲突前置数据。

### Secondary Verification

- 通过真实 Application HTTP 读取 Record，确认创建 / 更新值与 Admin 一致；确认已删除 Record 不再可读 / 列出。
- 再次打开 Record Deep Link，确认目标身份与列表上下文正确。

### Failure Conditions

- Record CRUD 被错误纳入 Schema Change / Migration；成功提示出现但数据未持久化；删除后仍能读取该 Record。
- Field Validation 被绕过，系统字段可编辑，或列表上下文损坏且无法恢复。
- 任何全局 Browser Health Gate 失败。

## 5. FLOW-004 — Schema Pending Changes + Apply

### Preconditions

- `posts` 有至少两条 Records；`authors` 存在且有目标 Record。
- Runtime 为 Ready，当前 Schema 没有其他待处理或失败变更。

### User Actions

1. 在 `posts` Schema / Fields 增加可空 `summary` Text Field 并保存。
2. 增加 `author` Relation Field，目标为 `authors`；保存。
3. 在 Indexes 增加引用 `title` 与 `category` 的 Composite Index；保存。
4. 依次切换 Fields / Relations / Indexes、离开 Collection、Reload 后返回。
5. 在当前 Collection 工作面 Apply 全部 Schema Pending Changes；若 Runtime 评估为 Needs review，则在同一 Context Review 后确认。

### Visible Result

- 三种操作都进入同一 Collection 的 Schema Pending Change；页面显示 Pending count，而非 Unsaved count。
- Refresh、导航及切换 Schema View 后 Pending 仍在；本地未保存表单与已保存 Pending Operation 区分清楚。
- Runtime 计算 Structured Diff、Risk、Preconditions、Impact；SAFE 变更直接 Apply，不增加无意义确认；Needs review 时展示影响并可就地确认。
- 成功后当前 Schema 更新、Pending 清空，并显示 Applied 状态。

### Durable Result

- Apply 前 Pending Change 在 Reload 后仍可恢复；Apply 成功后 Fields / Relation / Index 已进入 Applied Model，Pending 清空且 Applied History 有不可变成功事实。
- Apply 未改变原有 Records；Restart 后 Applied Model 与对应 History 仍存在（Restart 的完整验证见 FLOW-010）。

### Secondary Verification

- 在 Changes / History 中核对同一 Collection 的 Applied Fact 与 Technical Details。
- 使用真实 HTTP 请求核对新增 Field 的 Application Model 行为、Relation 目标及原 Records；核对真实 Runtime 返回状态与 Admin 一致。

### Failure Conditions

- Fields / Relations / Indexes 产生互相独立的 Schema 草稿；保存后的 Pending 在导航 / Reload 后消失。
- SAFE 变更被强制要求 Review，或 Needs review 缺少影响 / 确认；Apply 成功但 Applied Model、Pending Count、History 或 Record 不一致。
- 任何全局 Browser Health Gate 失败。

## 6. FLOW-005 — Auth Collection + App User Credential

### Preconditions

- Runtime 为 Ready；Owner 可管理 Collections。
- 没有与本流程测试 Email 冲突的 App User。

### User Actions

1. 创建 Auth Collection `users`；确认 Email + Password 已启用，Email Required + Unique，Self Registration 默认关闭。
2. 在 Admin 的 Create User 表单填写 Email、Profile 值、Password 与确认密码，一次创建 App User。
3. 通过真实 Application HTTP（可从 Admin 的 Runner 发出）使用 Email + Password 登录，保存本次签发 Session 的安全测试凭据。
4. 在 Admin 查看 User Profile 与 Sessions；再通过真实 HTTP 访问受保护的应用资源。

### Visible Result

- Auth Collection 创建后可立即使用认证；Password 不作为 Field 出现在 Schema、Profile、普通 Record Detail 或 Record API response。
- 一次 Create User 操作同时显示成功 Profile Record 与 Credential 已建立；无需跳另一页创建 Password。
- 登录成功返回可用 Session；Session Detail 可识别用户与状态，不显示可读回的 Password 或 Session Token。

### Durable Result

- Profile Record 与 Password Credential 作为一次产品操作成功或失败，不能只创建其中一方；合法 Credential 可在创建完成后通过真实 HTTP 验证。
- User、Credential、Session 在刷新后仍有对应的持久状态；Session 是否仍 Active 以其未过期 / 未撤销状态为准。

### Secondary Verification

- 真实 HTTP 登录后，用签发 Session 调用受保护资源成功；错误密码不能取得有效 Session。
- 通过 Admin Schema 与受支持的真实 API response 确认 Password 不作为 Field 或普通 Record 值返回。

### Failure Conditions

- Create User 部分成功、密码保存为普通 Field / 明文可读回、默认开启 Self Registration、错误密码仍认证成功，或签发的 Session 不能服务端识别。
- 产品提示创建成功但 Profile、Credential 或 Session 状态缺失 / 不一致。
- 任何全局 Browser Health Gate 失败。

## 7. FLOW-006 — Access Rules

### Preconditions

- FLOW-005 已创建并登录 App User；`posts` 至少有一条 Record。
- 当前 Collection 的 Access Rule 可由 Owner 管理，且无未完成 Access Rule 变更。

### User Actions

1. 打开 `posts` Security / Access Rules。
2. 将 List 设置为 Signed-in users，将 View 设置为 No access；保存并独立 Apply Access Rule Change。
3. 使用匿名真实 HTTP 请求列出 Posts；用 App User Session 列出 Posts；分别请求单条 View。
4. Reload Admin 并再次检查规则状态。

### Visible Result

- Admin 使用 No access、Signed-in users 等 Preset-first 规则表达。
- Access Rule Pending / Apply 不增加 Schema Pending Count、不出现在 Schema ChangeSet 中；Apply 结果在当前 Security Context 可见。
- 匿名 List 被拒绝；已登录 List 允许；View 按单独 No access 规则拒绝。拒绝原因可行动。

### Durable Result

- 已 Apply 的 Access Rules 跨页面和 Reload 保持；拒绝 / 放行结果与当前规则一致。
- 应用请求遵守 Fail Closed；规则保存或 Apply 失败时，原已生效规则仍有效。

### Secondary Verification

- 使用真实 HTTP 对匿名与 App User 分别执行 List / View，核对 Allow / Deny 与 Admin 配置一致。
- 从 Requests / Audit（适用的受支持事实）检查结果，不使用模拟 Policy Simulation。

### Failure Conditions

- Access Rule 进入 Schema Draft；Unauthorized List / View 返回数据；没有规则的路径默认放行；Admin 显示与真实 HTTP 不一致。
- 使用假的 Policy Simulation 结果替代真实请求验证。
- 任何全局 Browser Health Gate 失败。

## 8. FLOW-007 — API Runner + Request Detail

### Preconditions

- FLOW-006 的访问规则已 Apply；`posts` 的真实 HTTP Endpoint 可从 API Workspace / OpenAPI 发现。
- Chromium 正在真实 Admin 中，Runner 未自动携带 Admin Credential。

### User Actions

1. 在 Collection 或 Global API Workspace 选择一个 `posts` Endpoint。
2. 使用 API Runner 发出一次预期成功请求，再发出一次依据 FLOW-006 预期被拒绝的请求。
3. 对拒绝结果点击 View request details 一次。
4. 在 Request Detail 检查请求标识、状态、时间、时长、Endpoint、认证 / 授权结果与错误信息；离开后从 Requests 列表再打开同一请求。

### Visible Result

- Runner 显示 HTTP Status、Duration、canonical Request ID 和结构化结果。
- 失败提供 View request details；一次点击直接打开同一 RequestRecord，不要求复制 ID、到 Requests 搜索再打开。
- Request Detail 能返回 API Endpoint / Collection Context；不展示 Raw Credential、Raw Authorization Header 或完整敏感 Body。

### Durable Result

- 成功与拒绝请求均生成可检索的 RequestRecord；至少在本次验收期间跨导航与 Reload 保持。
- Runner 中的 Request ID 与 Detail / Requests 列表记录完全相同；结构化错误中的 ID 与之关联。

### Secondary Verification

- 使用独立真实 HTTP 客户端复现同一成功 / 拒绝结果，并与 Runner Status / Request ID 对照。
- 通过 Request Detail 和受支持 Request API / 诊断确认无凭证泄露；HTTP-only 成功不能替代浏览器路径。

### Failure Conditions

- Runner 结果伪造、没有真实 HTTP 往返、未生成 RequestRecord、Request ID 不一致、Detail 打开错误请求或必须手工搜索才能到达。
- Raw Credential / Authorization Header / 敏感完整内容出现在 Runner、RequestRecord 或错误详情。
- 任何全局 Browser Health Gate 失败。

## 9. FLOW-008 — Service Account + API Key

### Preconditions

- Owner Session 有效，Runtime 为 Ready；Control Plane Access 页面可访问。
- 没有同名测试 Service Account。

### User Actions

1. 创建 `ci-readonly` Service Account，选择 Read only Permission，并保持默认 Create API Key now。
2. 在一次性 Reveal 中复制新 Key 到隔离的测试客户端；完成后离开 Reveal / Detail。
3. 用真实 HTTP 携带该 Key 执行允许的只读管理操作，再尝试一个应被 Read only 拒绝的变更操作。
4. 在 Admin Revoke API Key，并使用同一测试客户端再次请求。

### Visible Result

- 成功后 Service Account 与 Key 一并创建；明文 Key 仅在创建时显示一次，有 Copy / Copied 状态。
- 离开 Reveal 后列表 / Detail 不再显示明文；Permission 为 Read only，未授权变更被明确拒绝。
- Revoke 后 Key 显示为 Revoked；此前有效的 Key 立即不能认证或授权后续操作。

### Durable Result

- Service Account、Permission Grant、Key 身份与状态、Revoke 事实耐久保存；重新打开 Admin 不会重新暴露明文。
- 真实 HTTP 的撤销结果与 UI 状态一致，管理动作产生适用的 AuditRecord。

### Secondary Verification

- Reload Admin；核对 Service Account 仍存在、Permission 未改变、Key 为 Revoked。
- 通过真实 HTTP 对比 Revoke 前允许 / 拒绝的 Permission 行为及 Revoke 后认证失败；检查 Audit 不含 Key 明文。

### Failure Conditions

- Key 被重复 Reveal、持久化明文、没有服务端撤销效果，或 Read only 可执行未授权变更。
- Service Account、Key、Permission 或必需 Audit 只部分保存，或 API Key 被当作 ApplicationUser Credential 使用。
- 任何全局 Browser Health Gate 失败。

## 10. FLOW-009 — Failed Change Recovery

### Preconditions

- `posts.category` 为普通 Text Field，当前 Applied Model 不唯一。
- FLOW-003 留下至少两条 `category` 相同而其他必填值有效的 Records。
- 没有其他 Pending / Failed Schema Change。

### User Actions

1. 在 Schema 中将 `category` 设为 Unique（或建立等效单 Field Unique Index）并保存。
2. Apply 该 Schema Pending Change。
3. 查看当前页面的失败与恢复说明；在 Records 中修改冲突值，使所有现存值唯一。
4. 返回原 Change，按页面指导 Retry / Apply。

### Visible Result

- Runtime 因真实重复值拒绝首次 Apply，说明冲突及可修复方向；不得返回未经解释的物理 SQL 错误。
- 当前 Applied Model 仍为非唯一；Pending Change 保留、状态为 Failed / 需恢复，Changes Detail 展示最新 ApplyAttempt 与恢复建议。
- 修复数据后 Retry 创建新的 ApplyAttempt；成功后 Unique 生效、Pending 清空，History 可查看成功事实。

### Durable Result

- 首次失败不修改现存数据或 Applied Model；失败 ApplyAttempt 与所需 RecoveryState 可恢复，失败 Pending 不丢失且不产生虚假的 AppliedMigration。
- 修改冲突记录与成功 Retry 后，记录及唯一约束均持久化；重载后失败与成功历史都可区分。

### Secondary Verification

- 通过真实 HTTP 验证首次应用前相同值可读、错误状态不改变数据；修复后重新尝试重复值被拒绝、不同值被接受。
- 在 Changes / History 核对两次不同的 ApplyAttemptID、最终 AppliedMigration 以及实际 Applied Model。

### Failure Conditions

- 为制造失败修改物理数据库或绕过用户流程；错误首次 Apply 却清空 Pending、改变 Applied Model、丢记录或写入成功 History。
- Retry 覆写失败 Attempt，或修复重复数据后变更仍无法恢复 / 没有可行动说明。
- 任何全局 Browser Health Gate 失败。

## 11. FLOW-010 — Restart Persistence

### Preconditions

- FLOW-001 至 FLOW-009 的最终状态已稳定；Project Root 与 Project ID 已记录。
- 至少存在 Owner、Normal / Auth Collection、Record、Applied Schema History、App User Credential、一个有效 Session、已 Apply Access Rule、Service Account、已撤销 API Key、RequestRecord 与 AuditRecord。
- 确认没有运行中的 Apply、上传或未完成本地表单；Admin 浏览器页面可关闭。

### User Actions

1. 在 Admin 完成一个 Deep Link（例如 Record 或 Request Detail）Reload，确认目标与 Context 正确。
2. 关闭浏览器页签；用 ADR-0001 所要求的有界 Graceful Shutdown 停止 Runtime。
3. 使用同一 Project Root 和相同启动配置重启 Runtime，等待 Ready；不删除或重建 `.modelry/`。
4. 重新用 Chromium 打开 Admin，登录原 Owner，重新访问原 Deep Link。
5. 通过真实 HTTP 验证原 Record / Applied Model、App User 认证与 Session、Access Rule、Service Account / 撤销状态、RequestRecord / AuditRecord。

### Visible Result

- Runtime 在全部真实就绪条件满足前不报告 Ready；Ready 后 Admin 显示相同 Project 身份与正常 Runtime / SQLite / Local Storage Health。
- Owner 登录后可看到原 Collections、Records、Applied History、Security 状态与受支持的观察事实；Deep Link 正确恢复上下文。
- 已撤销 API Key 不会因重启复活；有效且未过期 Session 按其领域状态工作。

### Durable Result

- 同一 Root 保留同一 Project ID；应用过的 Schema / AppliedMigration、Records、Owner、Credential、Sessions、Access Rules、Service Account / API Key 状态、RequestRecord 与 AuditRecord 均满足各自 Durable Contract。
- SQLite 数据库和 ADR-0001 管理的 File Storage 内容 / 引用保持一致；Reload / Restart 不依赖浏览器缓存补出不存在的服务端事实。

### Secondary Verification

- 使用真实 HTTP 和 Admin 分别观察关键状态；比较身份、数据、权限、Request ID 与审计事实，不要求相同 UI 编排。
- 通过 Runtime / Storage 诊断确认同一 Project Root、SQLite 与 Local Storage 健康；确认 Runtime 管理的真实 `.modelry/project.sqlite` 存在且重启前后引用同一 Project 身份。
- 对已撤销 API Key 做认证失败检查；对仍有效 App Session 与 Credential 做真实应用请求检查。

### Failure Conditions

- Runtime 在 Storage / SQLite 尚未就绪时报告 Ready；重启生成新 Project、丢失或重复数据、Model / Ledger 不一致、Session / 撤销状态错误、文件引用不一致。
- 仅浏览器缓存显示旧状态而真实 HTTP 不一致；Deep Link / 导航损坏；Ready 后服务请求仍不可用。
- 任何全局 Browser Health Gate 失败。

## 12. Flow Coverage 与完成条件

- [x] FLOW-001 First Run
- [x] FLOW-002 Create Normal Collection
- [x] FLOW-003 Record CRUD
- [x] FLOW-004 Schema Pending Changes + Apply
- [x] FLOW-005 Auth Collection + App User Credential
- [x] FLOW-006 Access Rules
- [x] FLOW-007 API Runner + Request Detail
- [x] FLOW-008 Service Account + API Key
- [x] FLOW-009 Failed Change Recovery
- [x] FLOW-010 Restart Persistence
- [x] 每条流程都具备 Preconditions、User Actions、Visible Result、Durable Result、Secondary Verification、Failure Conditions。
- [x] Mandatory 环境要求 Real Runtime、Real SQLite、Real HTTP、Real Admin、Real Chromium。
- [x] Reload / Restart 与全局 Browser Health Gate 已定义。
- [x] GitHub Issue #11 要求的十条产品能力流程均属于 V0.1 Product Closure 发布门禁；foundation smoke 不能替代产品流程。
- [x] 主 Agent 已复核 Accepted HTTP Contract / OpenAPI、十条流程结构与 V0.1 Product Closure 发布门禁，并接受本 Spec。

## 13. 明确排除
