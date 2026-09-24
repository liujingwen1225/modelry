# Spec 0001 — Modelry Admin 产品 UX 与页面规格

- **Status:** Accepted — V0.1 Community Admin Product UX Baseline
- **Scope:** Modelry V0.1 Community Project Admin
- **Depends on:** docs/00-product-vision.md、docs/04-v0.1-community-scope.md、docs/05-product-experience-and-acceptance.md、docs/06-product-architecture.md
- **Supersedes:** Pre-Reboot Admin UI / IA / Wireframe 文档中的页面结论
- **Does not define:** HTTP DTO、Database Schema、Go Package、React Component API、最终视觉稿

本 Spec 是 V0.1 Admin Exact IA、页面、交互、Primary Action 与 Durable Result 的唯一权威来源。

# 1. 设计目标

Modelry Admin 是 Developer Backend Workspace，不是传统企业后台，也不是数据库管理器。

必须满足：

1. 一个页面解决一个主要用户问题；
2. 一个工作面只有一个明显 Primary Action；
3. 普通用户不需要先理解内部 Domain Object；
4. 能少一步就不增加中转页；
5. Durable Result 原地可见；
6. Schema Pending Changes 与 Runtime/Data Operation 明确分离；
7. Search / Filter / Sort / Pagination / Deep Link Context 尽可能保留；
8. Empty / Loading / Error / Permission / Partial / Recovery State 都是一等状态；
9. 不展示没有真实 Runtime 能力的 Placeholder Action；
10. UI 默认围绕 Model → Data → Secure → API → Observe → Evolve。

# 2. V0.1 Exact Information Architecture

## Sidebar

~~~text
Overview

Build
  Collections
  API

Operate
  Changes
  Access

System
  Settings
~~~

V0.1 不建立独立一级：

- Hooks
- Activity
- Secrets
- Data
- Schema
- Auth
- Requests

Requests 属于 Global API。

Audit 属于 Access。

Secrets 随 Extension Runtime 在 V0.1.x 增加。

## Collection Workspace

~~~text
Records        <- default
Schema
Security
API
~~~

### Schema

~~~text
Fields         <- default
Relations
Indexes
~~~

### Security — Normal Collection

~~~text
Access Rules
~~~

### Security — Auth Collection

~~~text
Access Rules
Authentication
Sessions
~~~

# 3. App Shell

Desktop：

~~~text
┌──────────────────────────────────────────────────────────────────┐
│ Modelry / Project                         Runtime Status   User ▼ │
├───────────────┬──────────────────────────────────────────────────┤
│ Overview      │                                                  │
│               │                                                  │
│ Build         │                 Page Content                     │
│ Collections   │                                                  │
│ API           │                                                  │
│               │                                                  │
│ Operate       │                                                  │
│ Changes       │                                                  │
│ Access        │                                                  │
│               │                                                  │
│ System        │                                                  │
│ Settings      │                                                  │
└───────────────┴──────────────────────────────────────────────────┘
~~~

Header：

- Project / Instance Identity；
- Runtime Status；
- Admin Menu：Theme、Session、Logout。

V0.1 不提前增加没有统一搜索语义的 Global Search / Command Palette。

Runtime Status 异常时直接导航到可处理页面：

~~~text
Pending / Failed Change -> Changes
Storage problem         -> Settings
Runtime health problem  -> Overview / Settings
~~~

# 4. First Run / Bootstrap

## 目的

> 新 Runtime 如何安全、快速开始？

默认本机流程不要求复制 Setup Token。

~~~text
Create your Modelry owner

Email
[____________________________]

Password
[____________________________]

                         [ Complete setup ]
~~~

成功：

~~~text
Owner created
→ session established
→ bootstrap closed
→ no collections?
     yes -> Create Collection
     no  -> Overview
~~~

首次空项目减少 Overview 中转。

Create Collection Surface 必须提供 Back / Skip to Overview，不形成死路。

Remote Bootstrap 只有在显式远程首次初始化时才采用额外 Claim / Secret Mechanism，由 Security ADR 定义。

必须覆盖：

- already configured
- invalid / expired remote claim
- runtime unavailable
- password validation
- submitting
- durable success

# 5. Login

~~~text
Sign in

Email
[____________________________]

Password
[____________________________]

                              [ Sign in ]
~~~

不得出现 Application User 登录。

登录成功优先返回原 Deep Link。

# 6. Overview

## 目的

> Backend 当前是否健康？现在有什么需要处理？

Overview 是 Action Center，不是统计 Dashboard。

~~~text
Overview

Needs attention                         only when needed
! 2 schema changes failed                      View
! Storage unavailable                          Open settings

Backend health
Runtime          Ready
Database         Ready
Storage          Ready
Schema           Up to date

Continue recent work
posts            Open records
users            Edit security
~~~

规则：

- Needs attention 只在需要操作时展示；
- 正常状态紧凑；
- Unknown / Unavailable 不得伪装为 Ready；
- 不复制 Collections Inventory；
- 不复制 Request Log；
- 不复制 Audit；
- 不放大 KPI。

空项目：

~~~text
Your backend is ready

Create your first Collection to define application data and API.

[ Create Collection ]
~~~

# 7. Collections

## 目的

> 有哪些业务模型？我要进入或创建哪一个？

~~~text
Collections                                  [ + Create Collection ]

[ Card ] [ List ]      Search...   Type ▼   Sort ▼
~~~

默认 Card View。

Card：

- Name 最强；
- Type 使用轻量 Badge；
- Description 最多两行；
- Records / Fields 为 Secondary Metadata；
- Pending / Failed Change 仅异常时强调；
- 整卡可进入 Collection Workspace。

Card / List 共用 Search / Filter / Sort State。

# 8. Create Collection

Create Collection 一次完成初始模型，不先创建空 Collection 再跳 Schema。

使用 Focused Workspace，不拆多步 Wizard。

~~~text
Create Collection

Type
[ Normal Collection ]   [ Auth Collection ]

Name
[ posts ]

Description
[ Blog posts ]

System fields
id           System ID       Locked
createdAt    Created Time    System · Locked
updatedAt    Updated Time    System · Locked

Initial fields

Name        Type        Required   Unique   Configuration
title       Text        Yes        No
slug        Text        Yes        Yes
author      Relation    No         No       users · many-to-one

Quick add
[ name ] [ Type ▼ ] [ Required ] [ Unique ] [ + Add ]

                                       Cancel   Create Collection
~~~

## 8.1 System Fields

V0.1 固定：

- id
- createdAt
- updatedAt

全部：

- always present；
- visible；
- system-managed；
- locked；
- not removable；
- not renameable；
- not editable in Record Form。

这样避免删除 / 恢复默认字段、reserved-name 与不同 timestamp 状态带来的首版复杂度。

## 8.2 Quick Add

基础 Field 应连续录入：

- Enter 添加；
- 成功后焦点回到 Name；
- 默认 Type = Text；
- duplicate name 当前行报错；
- 不滚回顶部；
- 不关闭当前 Workspace。

## 8.3 Relation Inline

选择 Relation 后原行展开必要配置：

~~~text
author
Relation
Target      [ users ▼ ]
Cardinality [ many-to-one ▼ ]
~~~

复杂 Delete Behavior 再进入 Advanced Field Editor。

Relation 仍然是 Field Type，Relations View 只是 Projection。

## 8.4 Unique

普通单字段 Unique 是 Field Feature：

~~~text
Unique [x]
~~~

Runtime 内部可以生成对应 Index。

Composite / Advanced Index 再进入 Schema / Indexes。

## 8.5 Auth Collection

选择 Auth 后原地出现：

~~~text
Authentication

Email + password                 Enabled
Email                            Required · Unique
Allow users to sign up           [ ]
Session duration                  7 days
~~~

规则：

- Email + Password 默认启用；
- Self Registration 默认 Disabled；
- 用户可在创建时直接开启；
- email 是 Auth Identifier Field；
- password 是 Credential，不是普通 Field；
- 可以在同一次创建中增加 name / avatar / role 等 Profile Field。

## 8.6 提交

新 Collection 没有既有数据，不向普通用户展示 Migration Review。

~~~text
Create Collection
→ validate
→ internally create/apply canonical change
→ durable Collection
→ Records
~~~

如果 Validation / Precondition 失败，在当前 Create Surface 原地解释并修复。

成功后：

~~~text
No records yet
Your collection is ready.

[ Create first record ]

Secondary: Edit schema
~~~

# 9. Collection Workspace

Header 共用 Collection Identity：

~~~text
Collections / posts

posts                                          Normal
Blog posts

[ Records ] [ Schema ] [ Security ] [ API ]
~~~

Auth Collection 的 Security 内增加 Authentication / Sessions。

异常状态，例如 failed pending apply，可以在 Header 下显示 Context Banner。

# 10. Records

## 目的

> 当前 Collection 有哪些真实数据？如何连续管理？

~~~text
Records · 128                                  [ + Create Record ]

Search...   Filter   Sort   Columns                 More
────────────────────────────────────────────────────────
Title              Author          Updated
Hello Modelry      Alice           10 min
────────────────────────────────────────────────────────
                                           < Previous Next >
~~~

必须支持：

- Search
- Filter
- Sort
- Pagination / Cursor
- Column Visibility
- Field-driven Columns
- Loading / Empty / Error
- Record Deep Link
- Context Preservation

无 Bulk Runtime 时：

- 不显示 Row Selection；
- 不显示 Bulk Action。

## 10.1 Record Detail

Row click → Detail Sheet。

~~~text
Record

title        Hello Modelry
author       Alice

Metadata ▼

                              [ Delete ] [ Edit ]
~~~

Edit 是 Primary。

Row Overflow 同时提供 **Edit**，允许：

~~~text
Row action Edit
→ Edit Sheet
→ Save
~~~

不用先打开 Detail。

## 10.2 Create / Edit

- 简单 Record → Standard Sheet；
- 多字段 / File / Relation / long text → Wide Sheet；
- V0.1 不默认跳独立页面。

Create 成功：

~~~text
persist
→ same Sheet switches to View
→ durable ID/value visible
→ table refreshes
~~~

View 状态提供 Secondary：

- Create another

不自动清空刚创建结果。

## 10.3 Auth User Record

Auth Collection 的 Create Record 是增强型 User Editor：

~~~text
Create user

Profile
Email
[________________]
Name
[________________]

Authentication
Password
[________________]
Confirm password
[________________]

                                  [ Create user ]
~~~

产品上一次完成：

~~~text
Profile Record
+
Password Credential
~~~

底层仍保持两类资源。

User Detail：

~~~text
Profile
...

Authentication
Password          Set
Sessions          3 active

[ Change password ]
[ Revoke all sessions ]
~~~

Password：

- 不进入 Schema；
- 不显示 read-back；
- 不出现在普通 Record API response。

# 11. Schema

## 目的

> Collection 结构是什么？如何连续修改并安全 Apply？

~~~text
Schema

[ Fields ] [ Relations ] [ Indexes ]
~~~

三者共用一个 **Schema Pending Draft**。

Policy / Auth 不加入这个 Draft。

## 11.1 Fields

~~~text
Schema · 8 fields                               [ + Add Field ]

Field          Type          Required     Features
id             System ID     Yes          System · Locked
createdAt      Datetime      —            System · Locked
updatedAt      Datetime      —            System · Locked
title          Text          Yes
slug           Text          Yes          Unique
author         Relation      No           -> users
~~~

Add / Edit → Canonical Field Editor。

保存 Editor 时，不立即修改 Applied Model，而是耐久保存一个 Pending Operation。

~~~text
Save field
→ pending operation persisted
→ return to Schema
→ pending count visible
~~~

## 11.2 Relations

Relations 是 Relation-oriented Projection。

~~~text
Field          Target       Cardinality
author         users        many-to-one
~~~

Add / Edit 复用 Relation Field Editor。

不建立第二 Draft / 第二 Validation / 第二 Submit Path。

## 11.3 Indexes

~~~text
Name                 Type       Fields
idx_posts_slug       Unique     slug
idx_posts_status     Index      status, updatedAt
~~~

普通单字段 Unique 优先从 Field Editor 操作。

这里主要负责：

- composite index；
- advanced index；
- conflict / precondition diagnostics。

## 11.4 Durable Pending Changes

同一 Collection 内：

- Field add / update / remove；
- Relation add / update / remove；
- Index add / update / remove；
- structural validation / default change；

进入同一 Schema Pending Draft。

一旦 Field / Relation / Index Editor 保存：

- Pending Operation 已耐久；
- refresh 不丢；
- 切换 Schema View 不丢；
- 离开 Collection 不丢；
- 不弹 Save for Later。

只有编辑器本地表单尚未保存时，离开才触发 Unsaved Form Protection。

Bottom Bar：

~~~text
3 pending changes                     Discard   Apply 3 changes
~~~

不是 “3 unsaved changes”。

## 11.5 Apply

~~~text
Apply 3 changes
→ Runtime canonical Diff / Risk / Preconditions / Impact
~~~

SAFE：

~~~text
→ apply immediately
→ current Schema refreshes
→ pending draft clears
~~~

Need Review：

~~~text
Review changes

What will change
+ subtitle field
~ author relation target
+ composite index

Checks & impact
128 records affected
1 warning

[ Cancel ]                        [ Confirm & Apply ]
~~~

不强制跳 Changes。

Failed：

- 当前 Context 显示失败；
- Pending Change 保留；
- 提供 Recovery Guidance；
- 也可从 Changes 恢复。

# 12. Security

Security 是 Collection 的“谁能访问、如何认证”工作区。

Normal：

~~~text
[ Access Rules ]
~~~

Auth：

~~~text
[ Access Rules ] [ Authentication ] [ Sessions ]
~~~

# 13. Access Rules

## 目的

> Application Client / User 对当前 Collection 可以做什么？

首屏展示五种操作整体状态：

~~~text
Operation   Access
List        Record owner
View        Record owner
Create      Signed-in users
Update      Record owner
Delete      No access
~~~

点击一项后编辑：

~~~text
Update access

Who can update?
( ) No access
( ) Anyone
( ) Signed-in users
(x) Record owner
( ) Custom rule

Owner field
[ author ▼ ]

Secondary:
[ Copy from View ]
[ Advanced expression ]

                         Cancel   Save pending rule
~~~

Custom 才展示 Expression。

Copy from another operation 只改变当前 Draft。

Access Rule Draft 与 Schema Draft 分离。

有 Pending Rule 时：

~~~text
2 pending access rule changes       Discard   Apply 2 changes
~~~

Apply Risk 仍由 Runtime 计算。

V0.1 不提供假的 / 不完整 Hypothetical Simulation。

验证路径：

~~~text
Access Rule
→ Apply
→ API Runner
→ Request Detail
→ allowed / denied reason
~~~

# 14. Authentication — Auth Collection Only

创建 Auth Collection 时已经完成基础 Authentication Setup。

页面用于后续调整：

~~~text
Authentication

Email + password            Enabled
Self registration          Disabled
Session duration            7 days

                                      [ Edit ]
~~~

编辑形成独立 Auth Configuration Pending Change，不与 Schema Draft 合并。

页面明确：

~~~text
email
→ Auth identifier field

password
→ Application credential
→ not a normal field
~~~

# 15. Sessions — Auth Collection Only

~~~text
Sessions

Search user...

User                 Created       Last used       Status
alice@example.com    2h            10m             Active
bob@example.com      1d            2h              Revoked
~~~

优先显示可识别用户。

Row Action：

- Revoke

流程：

~~~text
Revoke
→ confirm
→ runtime operation
→ row stays visible
→ status becomes Revoked
~~~

不走 Schema Change。

# 16. Collection API

## 目的

> 当前 Collection 的 API 怎么用？

~~~text
API

Endpoints
GET      /api/v1/posts
POST     /api/v1/posts
GET      /api/v1/posts/:id
PATCH    /api/v1/posts/:id
DELETE   /api/v1/posts/:id

Selected endpoint
GET /api/v1/posts/:id

Parameters
Headers
Body
Responses

                                      [ Run request ]
~~~

Secondary：

- Copy path
- Copy curl
- View OpenAPI
- View requests for endpoint

Runner 不自动使用 Admin Credential。

Collection 与 Global API 必须复用 Endpoint Detail / Runner。

# 17. Global API

固定：

~~~text
[ Endpoints ] [ Requests ]
~~~

## 17.1 Endpoints

~~~text
Search endpoints...

Collection ▼   Kind ▼   Method ▼   Auth ▼

Collection    Method    Endpoint                 Kind
posts         GET       /api/v1/posts            Data
users         POST      /api/v1/auth/login       Auth
~~~

选择后使用 Detail Pane。

## 17.2 Runner Result

每次执行至少显示：

~~~text
Status        403
Duration      18 ms
Request ID    req_abc123

POLICY_DENIED
Current access rule denied this request.

[ View request details ]
~~~

View request details 一次点击打开对应 Request Detail。

禁止要求用户：

~~~text
copy requestId
→ Requests
→ search
→ open
~~~

## 17.3 Requests

~~~text
Search request ID...

Collection ▼   Endpoint ▼   Method ▼
Status ▼       Error ▼      Time ▼

Time       Collection   Method   Endpoint       Status   Duration
14:32:01   posts        GET      /posts/:id     200      18 ms
14:31:55   posts        POST     /posts         403      12 ms
~~~

Request Detail：

- Request ID
- time / duration
- method / route
- collection
- status
- authentication outcome
- authorization outcome
- error code
- response size
- Open Endpoint
- Open Collection

V0.1 不记录展示：

- Raw Credential
- Raw Authorization Header
- Full Request Body
- Full Response Body
- unrestricted Raw Header / Query values

# 18. Changes

## 目的

> 哪些 Model Changes 还没完成？哪些需要我处理？历史发生了什么？

Changes 是恢复 / 汇总 / History Surface，不是每次编辑的强制中转页。

固定：

~~~text
[ Pending ] [ History ]
~~~

Pending：

~~~text
Change summary                    Scope       Status          Updated
Add 3 fields to posts             posts       Ready           5m
Remove legacy status field        posts       Needs review    1h
Update users access rules         users       Failed          2h
~~~

用户主状态：

- Ready
- Needs review
- Failed
- Applied

不要求用户理解：

- ChangeSet
- Apply Attempt
- Migration

## 18.1 Change Detail

~~~text
Remove legacy status field

Status              Needs review
Scope               posts

What will change
[...]

Checks & impact
[...]

Recovery
[...]

Technical details ▼

                                  [ Confirm & Apply ]
~~~

Technical Details 可展示：

- Change ID
- ChangeSet ID
- canonical diff
- Apply Attempts
- Migration ID / Ledger fact

Retry 创建新的 Apply Attempt，但主 UI 只表达：

- previous attempt failed；
- current recovery action；
- latest state。

History 展示 Durable Applied Facts。

# 19. Access

V0.1 Access 固定：

~~~text
[ Access ] [ Audit ]
~~~

## 19.1 Access

V0.1 只有：

- Current Owner
- Service Accounts

不提供 Additional Administrator Management。

~~~text
Access                                      [ + Create service account ]

Owner
jane@example.com                            Full access

Service accounts
Name              Permission      Status      Last used
ci-deploy         Custom          Active      1h
~~~

### Create Service Account

一次完成：

- Name
- Description
- Permission preset
- Create API Key now：默认开启

Permission：

- Full access
- Read only
- Custom

成功：

~~~text
service account created
→ API key created
→ one-time reveal
→ copy
→ Done
→ stay on detail
~~~

API Key Plaintext 只 One-time Reveal。

危险操作：

- Disable service account
- Revoke API key

使用 Dialog。

## 19.2 Audit

~~~text
Audit

Search...   Actor ▼   Action ▼   Resource ▼   Time ▼

Time        Actor          Action        Resource       Result
...
~~~

Audit 是 Control Plane Security / Governance Durable Fact。

不复制 Application Request Log。

# 20. Settings

固定：

~~~text
[ Runtime ] [ Storage ]
~~~

V0.1 Settings 以 Read-only / Diagnostic 为主。

## Runtime

展示：

- version
- bind / address
- project source
- config source
- runtime health
- database health
- restart guidance when relevant

不为了首版 Settings Page 实现复杂 Runtime Config Mutation。

## Storage

展示：

- provider = Local
- path
- health
- usage where reliable

不展示未支持的 S3 Placeholder。

# 21. 列表 Context / URL State

进入 Detail / Edit 后返回，尽可能恢复：

- Search
- Filter
- Sort
- Pagination / Cursor
- local tab
- column visibility
- scroll / selection where stable

适合共享与 Back 恢复的状态进入 URL。

Record / Request / Change Detail 必须支持 Deep Link。

# 22. Surface 使用边界

## Standard Sheet

- short object detail
- short form

## Wide Sheet

- Record Editor
- Complex Field Editor

## Focused Workspace

- Create Collection
- future long-form editing

## Split Pane

- Endpoint list + detail
- other list + persistent inspector workflows

## Dialog

只用于：

- Delete
- Revoke
- Disable
- Destructive Confirm
- Unsaved local form leave protection

禁止复杂长期编辑器放进窄 Modal。

# 23. Primary Action

默认：

~~~text
Page Title                                  [ Primary Action ]
~~~

有 durable Pending Change 时：

~~~text
3 pending changes                 Discard   Apply 3 changes
~~~

Destructive Action 不与 Primary Action 同视觉权重。

# 24. 页面状态

核心页面至少覆盖：

- Loading
- Empty
- Error
- Permission Denied
- Partial Data
- Ready
- Mutation In Progress
- Durable Success
- Recovery Required

Empty State：

~~~text
No collections yet
Create your first Collection to define application data.

[ Create Collection ]
~~~

Partial Data：

- 成功部分继续展示；
- 失败部分标记 Unavailable；
- 不把失败显示为 0；
- 提供 Retry / Recovery。

# 25. Feedback

默认：

~~~text
local field edit
→ immediate local validation

durable mutation
→ pessimistic

success
→ durable result remains visible

toast
→ supplementary only

failure
→ inline actionable error
~~~

Schema Pending Operation 保存成功后，应直接出现在 Pending Count / Local Projection 中。

# 26. Responsive / Density

Admin 优先 Desktop Developer Tool。

- 1280px：完整可用；
- 1440px：主要设计基准；
- 1920px：合理利用空间；
- Tablet：Sidebar 可折叠；
- Mobile：只要求基础导航 / 只读不崩坏，不作为核心编辑场景。

Density：

- Standard
- Compact Table

Form 不无限横跨大屏。

# 27. Design System Contract

固定：

~~~text
React + TypeScript + Vite
        ↓
Modelry Design System
        ↓
shadcn/ui
        ↓
Base UI
        ↓
Tailwind CSS v4
~~~

Modelry Design System 必须覆盖：

- semantic tokens
- typography
- spacing
- radius / elevation
- light / dark
- button hierarchy
- form pattern
- table pattern
- sheet / workspace / dialog pattern
- status
- empty / error / partial state
- keyboard / focus
- interaction feedback
- structured viewer
- copy interaction

目标 Accessibility：WCAG 2.2 AA。

# 28. Browser Acceptance

至少覆盖：

## First Run

~~~text
Start
→ Bootstrap Owner
→ Create Collection
→ Create first Record
~~~

## Normal Collection

~~~text
Create Collection
→ Initial Fields
→ Record CRUD
→ Access Rule
→ API Runner
→ Request Detail
→ Schema Pending Changes
→ Apply
→ Restart
→ Verify
~~~

## Auth Collection

~~~text
Create Auth Collection
→ Create App User + Password
→ Login
→ Session
→ Revoke
→ access fails
→ Audit
~~~

## API Error

~~~text
Run
→ structured error
→ requestId
→ View request details
→ same Request
~~~

## Failed Model Change

~~~text
Apply
→ failure visible
→ Changes / Recovery
→ retry
→ applied history
~~~

Mandatory Browser Flow 使用：

- Real Runtime
- Real SQLite
- Real HTTP
- Real Admin
- Real Chromium

不以 Mock Backend 替代核心 Closure。

# 29. Definition of Done

Admin V0.1 必须满足：

- First Run 不要求本机复制 Setup Token；
- Bootstrap 后无 Collection 时直接进入 Create Collection；
- Create Collection 一次完成初始模型；
- id / createdAt / updatedAt 明确可见且锁定；
- Auth Collection 创建后 Authentication Ready；
- Admin 创建 Auth User 时一次完成 Record + Password Credential；
- Schema Pending Changes 耐久且不需要 Save for Later；
- Policy / Auth 不与 Schema 共用 Collection-wide Draft；
- SAFE Apply 不增加额外 Review；
- Risk Review 原地完成；
- Records CRUD 不进入 Schema Change；
- Access Rules Preset-first；
- Runner Error 一键进入对应 Request Detail；
- Changes 主 UI 不要求用户理解 ChangeSet / Apply Attempt / Migration；
- Access UI 不要求理解 Principal / Capability / Credential；
- Request 与 Audit 不混淆；
- No Hooks / Activity / Secrets Placeholder；
- Search / Filter / Sort / Pagination / Deep Link Context 保持；
- 所有核心页面遵守 Modelry Design System；
- Mandatory Browser Acceptance 完成真实业务闭环。

# 30. V0.1.x 后续 Surface

明确不是 V0.1 Placeholder：

- Realtime
- Hooks / Extensions
- Secrets
- Generic Activity
- Additional Administrators
- Policy Simulation
- Editable Runtime Settings

当 Runtime Capability 真正进入对应版本时，再通过新的 Spec 增加 Product Surface，而不是提前在 V0.1 Sidebar 留空入口。
