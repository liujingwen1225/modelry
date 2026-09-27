# Spec 0001 — Modelry Admin 产品 UX 与页面规格

- **Status:** Accepted — V0.1.x Admin Product UX Authority
- **Scope:** Modelry self-hosted Project Admin for independent developers and coding-agent workflows
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

# 2. V0.1.x Current Information Architecture

Modelry Admin 面向独立应用开发者，提供自托管后端工作区。Owner 可直接操作，也可通过受支持的 MCP / Service Account 路径连接编码智能体。当前 Shell 按用户任务组织已交付页面；下列 V0.1.x 能力均为真实产品表面，不是路线图占位项。

## Sidebar

~~~text
Overview                         <- ungrouped

Build
  Collections
  API
  Automation

Manage
  Changes
  Access

System
  Settings
~~~

当前 contextual navigation 在对应产品区域的页面内容上方出现；它让已交付的相关页面可见，而不把每个实现模块都提升成 Sidebar 一级入口：

~~~text
Automation
  Webhooks
  Event Hooks
  Jobs
  Deliveries
  Extensions
  Secrets

Access
  Service Accounts / API Keys
  Administrators
  Audit

Settings
  General
  Runtime
  Files & Storage
  Mail
  Backup & Restore
  Diagnostics
    Activity
    Drift
~~~

产品区域入口分别是 `/automations`、`/access` 与 `/settings`；contextual links 使用已实现的子页面和 query context。Activity、Drift、Extensions、Secrets、Administrators 与 Storage / Mail / Portability 等具体路由归入相应区域。Settings 的 General 页面集中展示 Runtime、Database 与 Storage 诊断；Runtime settings 页面可编辑已支持的运行时配置。

不设独立一级入口：

- Extensions
- Secrets
- Activity
- Administrators
- Data
- Schema
- Auth
- Requests

Requests 属于 Global API；Audit 属于 Access；Activity 与 Drift 属于 Settings 的 Diagnostics；Extensions 与 Secrets 属于 Automation；Administrators 属于 Access。

Command Palette、English / Simplified Chinese 与 Light / Dark Theme 是当前全局产品操作，不是未来占位项。

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
App Users
Sessions
~~~

# 3. App Shell

Desktop：

~~~text
┌──────────────────────────────────────────────────────────────────────────┐
│ Project / Context | Command Palette | Runtime | Language | Theme | Owner │
├───────────────────┬──────────────────────────────────────────────────────┤
│ Overview          │ Contextual product navigation (when applicable)      │
│ Build             ├──────────────────────────────────────────────────────┤
│ Collections       │                                                      │
│ API               │ Page content                                         │
│ Automation        │                                                      │
│ Manage            │                                                      │
│ Changes           │                                                      │
│ Access            │                                                      │
│ System            │                                                      │
│ Settings          │                                                      │
└───────────────────┴──────────────────────────────────────────────────────┘
~~~

Global Topbar：

- Project / Context；
- Command Palette；
- Runtime Status；
- Language selector (`en` / `zh-CN`)；
- Theme toggle；
- authenticated Owner / Administrator menu and Sign out。

Command Palette 搜索可见命令和导航，不是后台数据的 Global Search。当前用户、权限、路由及资源上下文决定哪些命令可见；服务端仍是权限校验权威。

Product-area contextual navigation 的选项、路由映射与 query preservation 见第 2 节。无关一级区域切换不继承另一工作面的查询状态。

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

Overview 还提供面向开发者与编码智能体的 MCP 连接说明及 Service Account 管理入口。Agent access 使用 Control Plane Service Account / API Key；不把 Application User Credential 当作 Admin 身份，也不提供绕过 Runtime 授权的 Agent 通道。

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
[ Access Rules ] [ Authentication ] [ App Users ] [ Sessions ]
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

Policy Simulation 已作为 Access Rules 的辅助预览交付。它不应用规则、不创建授权旁路，也不替代真实 Application HTTP 请求验证；Runtime 对真实请求的授权结果仍是权威事实。

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

Access 是 Control Plane 身份、Permission 与 Audit 工作区。当前 contextual navigation 包含：

~~~text
[ Service Accounts / API Keys ] [ Administrators ] [ Audit ]
~~~

Collection 的 Application Access Rules 仍位于 Collection → Security；它与控制平面 Access 分开。

## 19.1 Service Accounts / API Keys

当前 Access 页面管理 Owner 可委派的 Service Accounts、其 Permission 及 API Keys。已交付 Administrators 管理；Owner 可为其他管理员配置受支持的控制平面访问范围。Application Service Account Permission 与 Admin Administrator Permission 是不同的身份 / 授权路径。

~~~text
Access                                      [ + Create service account ]

Service accounts / API Keys
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

## 19.2 Administrators

Administrators 是 Access 的 contextual destination。它管理已交付的 Admin administrator accounts 与其控制平面 Permission；它不改变 Application Auth、Application User 或 Collection Access Rules 的领域语义。

## 19.3 Audit

~~~text
Audit

Search...   Actor ▼   Action ▼   Resource ▼   Time ▼

Time        Actor          Action        Resource       Result
...
~~~

Audit 是 Control Plane Security / Governance Durable Fact。

不复制 Application Request Log。

# 20. Settings

Settings 是系统状态、运行配置与运维能力的 contextual 工作区，当前页面层级为：

~~~text
Settings
  General / Diagnostics
  Runtime
  Files & Storage
  Mail
  Backup & Restore
  Diagnostics
    Activity
    Drift
~~~

General 页面展示 Runtime、Database 与 Storage 健康状态和必要的诊断；Runtime settings 已支持编辑实际暴露的配置并说明其来源及是否需要重启。Files & Storage、Mail、Backup & Restore、Activity、Drift 都是已实现目的地，不是占位页面。

子页面按实际运行时能力展示可用设置与恢复路径。不得把尚未支持的配置伪装成可编辑，也不得把 settings mutations 与 Collection Schema Pending Draft 混合。

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
- 已实现的 Extensions / Secrets / Activity 等能力通过真实产品页面进入，不以未实现 Placeholder 代替；
- Search / Filter / Sort / Pagination / Deep Link Context 保持；
- 所有核心页面遵守 Modelry Design System；
- Mandatory Browser Acceptance 完成真实业务闭环。

# 30. V0.1.x 已交付的产品表面

以下能力已进入当前 Admin / Runtime 产品，不再按“未来能力”或 Placeholder 描述：

- Realtime subscriptions；
- Hooks / Extensions 与 Secrets；
- Automation：Webhooks、Event Hooks、Jobs、Deliveries；
- Activity 与 Drift；
- Access 中的多管理员、Service Accounts 与 API Keys；
- Collection Security 中的 Policy Simulation；
- 可编辑 Runtime Settings；
- Import / Export 与 Backup / Restore；
- Admin i18n（English / Simplified Chinese）、Theme 与 Command Palette。

高级运维能力按 Automation、Access、Settings contextual navigation 渐进式进入，不把内部模块数等同于一级导航数量。UI 文案和入口不得改写底层稳定 Domain / Contract 语义。此清单描述当前已交付产品面，不承诺 Enterprise、PostgreSQL 或其它 Issue 未定义路线。

# 31. V0.1.x Admin Shell 与全局产品操作

本节描述当前已实现的共享 Shell 和导航，不是尚待决定的演进方案；它与上文当前 Information Architecture 一致，且不改变底层 Project / Collection / Security 业务语义：

~~~text
Project / Context | Command Palette | Runtime | Language | Theme | Owner
~~~

## 31.1 Language

Admin 初始支持 `en`（English）和 `zh-CN`（简体中文）。所有用户可见的共享 Shell、导航、状态控件和 Command Palette 文案必须使用结构化、按产品域组织的 locale resources 与稳定 translation keys。后续 V0.1.x Surface 从首次实现开始使用同一 i18n API，不得自建页面翻译表。

- 首次选择：有有效 Modelry locale preference 时使用该值；否则仅在首次默认值中匹配明确支持的浏览器 locale（`en`、`zh-CN`，标签匹配不区分大小写）；`zh-TW` 等不支持的 locale 安全回退到 English，不按语言前缀推断区域变体。
- 用户选择持久化；切换即时生效，不重新加载页面，也不改变当前 pathname、query、hash 或局部工作上下文。
- 日期、时间、相对时间、数字和复数通过 `Intl` locale-aware formatter 提供共享入口。
- Collection/Field 名称、ID、用户数据、API/domain 标识符及稳定服务端错误码是数据或契约，不翻译。已支持的服务端错误码可以映射到本地化的说明文案。
- 单个 locale 缺少已知 key 时回退到 English。未知 key 在 development/test 显式失败；production 使用可见但安全的 key 标记回退。诊断不得包含插值值、credential 或 secret。

## 31.2 Theme

Light / Dark 是独立的全局 Theme action，位于 Topbar，与 Owner 身份、Session 和 Sign out 分开。沿用当前持久化 preference 行为；控件必须可键盘访问，具有可理解的可访问名称、可见 focus 与满足 Design System 的对比度。

## 31.3 Command Palette

Command Palette 是通过共享、可扩展的 Command Registry 注册的操作与导航表面。Command metadata 至少包括稳定 ID、产品域分类、显示文案、可选关键词、上下文/能力可见条件与执行动作。后续 V0.1.x Surface 可以从自己的模块注册和移除 commands，无需扩展一个集中巨型组件。

- `⌘K`（macOS）和 `Ctrl+K`（Windows/Linux）打开 palette；输入只对可见 command 的 label/keywords 做模糊匹配，不对后台数据做全文搜索。
- 支持键盘上下移动、Enter 执行、Escape 关闭、focus trap 与关闭后的 focus restoration。
- 只显示当前用户能力、项目、路由和资源上下文中真实可执行的命令。命令经正常导航和业务动作执行，不提供授权旁路。
- Command visibility 依据当前已认证 Admin session、角色 / Permission、route、resource 与 command context；只隐藏无权或不相关的入口，不替代服务端授权。
- Owner 与 Administrator 使用 Admin Control Plane session / Permission；Application Service Account / API Key 与 Application User Credential 均不是 Admin session，也不得复用于 Admin authorization。
- Command visibility 仅控制发现和调用入口；Runtime API 对 Admin session 与 Permission 的检查仍是授权权威，不能由客户端命令注册替代或绕过。
- 可用命令限于真实存在的导航页、近期 Collection、当前 Collection tabs 与 Create actions、Automation destinations、适用的 Pending / Failed Change、Access / Settings destinations，以及确有问题时的诊断目的地。无实现的能力不显示占位命令。
- 导航只在语义匹配时保留 URL/deep-link context；切换无关的一级工作区不继承另一页面的 query/hash。

## 31.4 Acceptance

使用 Admin tests/build 与真实 Chromium 验证 Shell 双语、locale 持久化与无重载切换、当前深链状态保留、数据标识不变、Theme 持久化、平台快捷键、keyboard/focus 行为、命令上下文可见性与实际导航，以及 Automation / Access / Settings contextual navigation 和多管理员 Permission 下的真实可见性。完整浏览器发布门禁及 Computer Use 职责见 SPEC-0003；此节不改变底层 Domain / Contract 或 V0.1 Core Flows。
