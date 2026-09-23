# Spec 0001 — Modelry Admin 产品 UX 与页面线框

- **Status:** Accepted — V0.1 Community Admin Product UX Baseline
- **Scope:** Modelry V0.1 Community Project Admin
- **Depends on:** docs/00-product-vision.md、docs/04-v0.1-community-scope.md、docs/05-product-experience-and-acceptance.md、docs/06-product-architecture.md
- **Supersedes:** Pre-Reboot Admin UI / IA / Wireframe 文档中的页面布局结论
- **Does not define:** HTTP DTO、Database Schema、Go Package、React Component API、最终视觉稿

> 本 Spec 明确 V0.1 Community Admin 的页面结构、信息层级、主要内容、按钮位置、Sheet / Drawer / Dialog 使用方式，以及用户操作后的结果状态。
>
> 它的职责是回答：**页面具体应该怎么组织，用户在哪里看到什么、点击什么、操作后发生什么。**

---

# 1. 设计目标

Modelry Admin 是开发者管理应用 Backend 的工作台，不是传统企业后台，也不是数据库管理器。

页面设计必须满足：

1. 一个页面只解决一个主要用户问题；
2. 一个工作面只有一个明显 Primary Action；
3. 用户先看到影响下一步判断的信息；
4. Durable Result 必须留在当前上下文可见；
5. Backend Model Change 与 Runtime/Data Operation 明确分离；
6. 列表负责选择对象，Sheet / Drawer 负责查看编辑单对象，Dialog 负责高风险确认；
7. 页面结构必须支持 Deep Link 与 Browser Acceptance；
8. Empty / Loading / Error / Permission / Partial State 都是一等页面状态；
9. 不使用无真实产品价值的 Dashboard Metric Card；
10. 不展示尚无 Runtime 能力支撑的 Placeholder Action。

---

# 2. 全局信息架构

V0.1 Project Admin 一级导航固定为：

~~~text
Core
  Overview
  Collections
  API

Control
  Changes
  Hooks
  Access

System
  Settings
  Activity
~~~

进入 Collection 后，Workspace 固定为：

~~~text
Records        <- default
Schema
Policy
Auth           <- Auth Collection only
API
~~~

Schema 内部固定为：

~~~text
Fields         <- default
Relations
Indexes
~~~

不建立独立顶层：

- Data
- Schema
- Relations
- Indexes
- Auth
- Secrets

Global API 是明确例外，它承担整个 Backend 的 Application API Workspace。

---

# 3. App Shell

## 3.1 Desktop 基础结构

~~~text
┌─────────────────────────────────────────────────────────────────────┐
│ Modelry / Project Identity      Runtime Status     Search   User ▼  │
├───────────────┬─────────────────────────────────────────────────────┤
│               │                                                     │
│ Core          │                                                     │
│  Overview     │                  Page Content                       │
│  Collections  │                                                     │
│  API          │                                                     │
│               │                                                     │
│ Control       │                                                     │
│  Changes      │                                                     │
│  Hooks        │                                                     │
│  Access       │                                                     │
│               │                                                     │
│ System        │                                                     │
│  Settings     │                                                     │
│  Activity     │                                                     │
│               │                                                     │
└───────────────┴─────────────────────────────────────────────────────┘
~~~

## 3.2 Header

左侧：

- Modelry 标识；
- 当前 Project / Instance Identity。

右侧：

- Runtime Status；
- Global Command / Search；
- Theme；
- 当前 Admin；
- Session / Logout。

Runtime Status 出现异常时必须可点击，并跳转到真正处理问题的页面。

例如：

~~~text
Pending Migration  -> Changes
Drift              -> Changes
Recovery Required  -> Changes / Settings
Runtime Error      -> Activity
~~~

## 3.3 Sidebar

Sidebar 只承担导航，不放：

- KPI；
- Collection CRUD；
- ChangeSet 操作；
- Runtime Log；
- Billing / Organization 等未来 Cloud Control Plane 内容。

---

# 4. Bootstrap

## 页面目的

回答：

> 这是一个新的 Modelry Runtime，我如何创建第一个 Admin？

## 线框

~~~text
┌───────────────────────────────────────────────┐
│                  Modelry                      │
│                                               │
│            Create your Admin                  │
│                                               │
│  Instance       local-modelry                 │
│                                               │
│  Setup Token    [________________________]     │
│  Email          [________________________]     │
│  Password       [________________________]     │
│                                               │
│  安全说明                                     │
│                                               │
│                     [ Complete Bootstrap ]    │
└───────────────────────────────────────────────┘
~~~

Primary Action：

- Complete Bootstrap

成功：

~~~text
Admin created
-> session established
-> redirect Overview
~~~

必须覆盖：

- invalid token；
- already bootstrapped；
- runtime unavailable；
- submitting；
- password validation。

---

# 5. Login

## 线框

~~~text
┌───────────────────────────────────────────────┐
│                  Modelry                      │
│                                               │
│                 Sign in                       │
│                                               │
│  Email          [________________________]     │
│  Password       [________________________]     │
│                                               │
│                         [ Sign in ]            │
└───────────────────────────────────────────────┘
~~~

不得出现 Application Auth Collection User 登录。

登录成功后优先返回原 Deep Link。

---

# 6. Overview

## 页面目的

回答：

> Backend 当前是否健康？我现在最需要处理什么？

Overview 是 Action Center，不是统计 Dashboard。

## 线框

~~~text
Overview

┌──────────────────────────────────────────────────────────────┐
│ Needs attention                              only if needed  │
│ ! Pending destructive change                     View Change │
│ ! Storage unavailable                            Open Settings│
└──────────────────────────────────────────────────────────────┘

Backend health
───────────────────────────────────────────────────────────────
Runtime           Ready
Database          Ready
Storage           Ready
Schema            Up to date
Project source    Writable

Continue recent work
───────────────────────────────────────────────────────────────
posts             Continue editing
Change #12        Review
users             Open Records

Quick navigation
[ Collections ]   [ Changes ]   [ Activity ]
~~~

规则：

- Needs Attention 只有异常时展示；
- 正常 Health 信息保持紧凑；
- 读取失败显示 Unknown / Unavailable，不能显示 Ready；
- Recent Work 只保留 1–3 项；
- 不复制 Collections Inventory；
- 不复制 Activity Timeline；
- 不放大号 Record / Request KPI。

Overview 没有固定 Create 按钮。

---

# 7. Collections

## 页面目的

回答：

> Backend 里有哪些 Collection？我要进入或创建哪一个？

## 页面顶部

~~~text
Collections                                      [ + Create Collection ]

[ Card ] [ List ]       Search...   Type: All ▼   Sort ▼
~~~

Create Collection 位于页面右上角，是唯一 Primary Action。

## 7.1 Card View — 默认

~~~text
┌──────────────────────┐  ┌──────────────────────┐
│ posts          Normal│  │ users            Auth│
│ Blog posts           │  │ Application users    │
│                      │  │                      │
│ Records        128   │  │ Records          36 │
│ Fields          12   │  │ Fields           10 │
│                      │  │                      │
│ ! Pending change     │  │ Updated 2h ago       │
└──────────────────────┘  └──────────────────────┘
~~~

Card：

- 整卡可点击；
- Name 为最强识别；
- Type 使用轻量 Badge；
- Description 最多两行；
- Records / Fields 为小型 Metadata；
- Pending / Drift / Risk 仅异常时强调；
- 右上 Overflow 只放真实可用 Secondary Action。

## 7.2 List View

~~~text
Name          Type       Records     Fields     Status         Updated
posts         Normal     128         12         Pending        2h
users         Auth       36          10         —              1d
~~~

Card / List 共用 Search / Filter / Sort State。

点击 Card / Row：

~~~text
Collection Workspace
-> Records
~~~

## 7.3 Create Collection

点击后使用 Sheet，而不是跳到独立 Wizard 页面。

~~~text
Create Collection

Type
(•) Normal
( ) Auth

Name
[________________]

Description
[____________________________]

                         [ Cancel ] [ Review Change ]
~~~

因为创建 Collection 属于 Backend Model Change：

~~~text
Draft
-> Review Change
-> ChangeSet
-> Runtime canonical Risk / Preconditions
-> Apply
-> Collection durable
-> enter Collection / Records
~~~

---

# 8. Collection Workspace Header

所有 Collection 页面共享 Header：

~~~text
Collections / posts

posts                                                Normal
Blog posts

[ Records ] [ Schema ] [ Policy ] [ API ]
                           Auth Collection additionally: [ Auth ]

Secondary:  ... 
~~~

不得在每个 Tab 重复 Collection Identity。

异常状态，例如 Pending Change / Drift，可以在 Header 下方出现 Context Banner。

---

# 9. Records

## 页面目的

回答：

> 当前 Collection 有哪些真实数据？我要如何查看、创建、编辑和删除？

## 线框

~~~text
Records · 128                                     [ + Create Record ]

[ Model Change Impact — only when relevant ]

Search...   Filter   Sort   Columns                         More
────────────────────────────────────────────────────────────────
Title              Author          Status       Updated
Hello Modelry      Alice           Published    10 min
...
────────────────────────────────────────────────────────────────
                                                   < 1 2 3 >
~~~

Create Record 是唯一 Primary Action。

没有真实 Import / Export Runtime 时，不显示 Import / Export。

## 9.1 Data Table

必须支持：

- Search；
- Filter；
- Sort；
- Pagination；
- Column Visibility；
- Stable Field-driven Columns；
- Row Selection；
- Long ID 不换行 + Copy；
- Loading / Empty / Error；
- Record Deep Link。

Bulk Action 只有真正 Runtime 支持时才显示。

## 9.2 Record Detail Sheet

点击 Row：

~~~text
┌──────────────────────────────────────┐
│ Record                         [ × ] │
│                                      │
│ title       Hello Modelry            │
│ author      Alice                    │
│ status      Published                │
│                                      │
│ Metadata ▼                           │
│                                      │
│                 [ Delete ] [ Edit ]  │
└──────────────────────────────────────┘
~~~

Edit 是 Primary Action。

Delete 是 Destructive Secondary Action。

## 9.3 Create / Edit Sheet

~~~text
┌──────────────────────────────────────┐
│ Create Record                  [ × ] │
│                                      │
│ Title                                │
│ [_______________________________]    │
│                                      │
│ Author                               │
│ [ Select...                    ▼ ]   │
│                                      │
│ Status                               │
│ [ Draft                         ▼ ]  │
│                                      │
├──────────────────────────────────────┤
│             Cancel        Create     │
└──────────────────────────────────────┘
~~~

Footer Sticky。

成功后 Sheet 不立即消失：

~~~text
Create
-> persist
-> Sheet switches to View
-> durable ID/value visible
-> Table refetches
~~~

Edit 同理。

Delete：

~~~text
Delete
-> Confirm Dialog
-> persist
-> Sheet closes
-> Row disappears / soft-delete reflected
~~~

---

# 10. Schema

## 页面目的

回答：

> Collection 的结构是什么？如何安全修改 Fields、Relations 和 Indexes？

页面顶部：

~~~text
Schema

[ Fields ] [ Relations ] [ Indexes ]
~~~

三个 Local View 共用一个 Collection Modeling Draft。

---

## 10.1 Fields

~~~text
Schema · 12 fields                                [ + Add Field ]

[ Fields ] [ Relations ] [ Indexes ]

Field           Type         Required        Features        ...
title           text         Yes             searchable
author          relation     Yes             -> users
cover           file         No              image/*
~~~

Add Field 是 Primary Action。

点击 Field 或 Add Field -> Field Editor Sheet。

### Field Editor

~~~text
Field

Name
[________________]

Type
[ Text ▼ ]

Required        [ ]
Default
[________________]

Validation
[...]

Type-specific options
[...]

                         [ Cancel ] [ Save Draft ]
~~~

Relation / File 都是 Field Type，其配置进入同一 Canonical Field Editor。

---

## 10.2 Relations

Relations 是 Relation-oriented Projection，不是第二套 Schema Editor。

~~~text
Schema                                           [ + Add Relation ]

[ Fields ] [ Relations ] [ Indexes ]

Field          Target       Cardinality       Delete behavior
author         users        many-to-one       restrict
~~~

Add / Edit Relation 复用 Relation Field Editor。

禁止：

- 第二套 Relation Draft；
- 第二套 Submit Path；
- 与 Fields 中不同的 Relation Validation。

---

## 10.3 Indexes

~~~text
Schema                                              [ + Add Index ]

[ Fields ] [ Relations ] [ Indexes ]

Name                 Type       Fields          Status
idx_posts_slug       Unique     slug            Applied
~~~

点击 Add / Edit -> Index Editor Sheet。

Index Review 重点展示：

- Fields Validity；
- Uniqueness Preconditions；
- Duplicate Conflict；
- Affected Data；
- Runtime Risk。

---

## 10.4 Shared Draft Action Bar

只要 Fields / Relations / Indexes 有任何 Draft：

~~~text
┌─────────────────────────────────────────────────────────────┐
│ 3 unsaved model changes              Discard  Review Changes│
└─────────────────────────────────────────────────────────────┘
~~~

固定在 Workspace 底部。

Review Changes 是 Draft 状态唯一 Primary Action。

切 Tab 不丢 Draft。

离开 Workspace 时必须有 Unsaved Changes Protection。

---

# 11. Review Changes

Review Surface 统一用于 Collection Model Change。

~~~text
Review Changes

Summary
3 changes

Structured Diff
────────────────────────────────────────
+ field subtitle: text
~ relation author: users -> members
+ unique index idx_slug

Risk
────────────────────────────────────────
DATA_REWRITE

Impact
────────────────────────────────────────
Affected records: 128
Preconditions: 1 warning

[ Save as ChangeSet ]                 [ Confirm & Apply ]
~~~

规则：

- Frontend 可以在 POST 前给 Preview；
- ChangeSet 创建后必须使用 Runtime Canonical Risk / Preconditions / Impact；
- Risk 不是用户输入；
- 高风险必须 Human Confirmation；
- 没有 Apply Capability 时，不显示 Apply，只能 Save/Open in Changes；
- Apply 成功后 Draft 清理并刷新当前 Schema；
- Save as ChangeSet 后提供 Open in Changes。

---

# 12. Policy

## 页面目的

回答：

> Application User 对当前 Collection 可以做什么？

## 线框

~~~text
Policy                                             [ Review Changes ]

Operation
[ List ] [ View ] [ Create ] [ Update ] [ Delete ]

Rule
┌──────────────────────────────────────────────────────────────┐
│ ownerId = @request.auth.id                                   │
└──────────────────────────────────────────────────────────────┘

Readable explanation
Only records owned by the current user are accessible.

Secondary:
[ Simulate ]
~~~

Policy Mutation 属于 Backend Model Change，不能直接 Save 到 Runtime。

Primary Action：

- 无 Draft：Edit / Add Rule
- 有 Draft：Review Changes

Simulation 是 Secondary Tool。

Simulation Result 应与编辑区分开，不能自动改变 Rule。

---

# 13. Auth — Auth Collection Only

Auth 页面固定两个 Local View：

~~~text
[ Configuration ] [ Sessions ]
~~~

## 13.1 Configuration

~~~text
Authentication

Login identifiers
[x] Email
[ ] Username

Password
Minimum length      8

Session
Duration            7 days

                                      [ Review Changes ]
~~~

Configuration Change 属于 Backend Model Change。

## 13.2 Sessions

~~~text
Sessions

Search principal...

Principal        Created       Last used       Status
usr_...          2h            10m             Active
usr_...          1d            2h              Revoked
~~~

点击 Session / Principal -> Detail Sheet。

Revoke Session 是 Runtime Operation，不走 ChangeSet。

---

# 14. Collection API

## 页面目的

回答：

> 当前 Collection 的 Application API 怎么用？

## 线框

~~~text
API

Endpoints
────────────────────────────────────────────────────────
GET      /api/v1/posts
POST     /api/v1/posts
GET      /api/v1/posts/:id
PATCH    /api/v1/posts/:id
DELETE   /api/v1/posts/:id

Selected Endpoint
GET /api/v1/posts/:id

Parameters
Headers
Body
Responses

                                      [ Run Request ]
~~~

Endpoint Detail 与 Runner 必须与 Global API 共用实现。

Secondary Action：

- Copy Path
- Copy curl
- View OpenAPI
- View Request Logs

Runner 不自动使用 Admin Credential。

---

# 15. Global API

Global API 固定：

~~~text
[ Endpoints ] [ Requests ]
~~~

---

## 15.1 Endpoints

~~~text
API
[ Endpoints ] [ Requests ]

Search endpoints...

Collection: All ▼   Kind: All ▼   Method: All ▼   Auth: All ▼

──────────────────────────────────────────────────────────────
Collection    Method    Endpoint                   Kind
posts         GET       /api/v1/posts              Data
posts         POST      /api/v1/posts              Data
users         POST      /api/v1/auth/login         Auth
~~~

点击 Endpoint 后使用页面内 Detail Pane，不弹 Modal。

~~~text
GET /api/v1/posts/:id

Collection        posts
Kind              Data
Authentication    Auth / Anonymous

Parameters
Headers
Body
Responses

[ Open in Collection ]                      [ Run Request ]
~~~

Secondary：

- Copy Path
- Copy curl
- View OpenAPI
- View Requests for Endpoint

---

## 15.2 Requests

~~~text
API
[ Endpoints ] [ Requests ]

Search request ID...

Collection: All ▼   Endpoint: All ▼   Method: All ▼
Status: All ▼       Error: All ▼      Time: Last 1 hour ▼

──────────────────────────────────────────────────────────────
Time       Collection   Method   Endpoint          Status   Duration
14:32:01   posts        GET      /posts/:id        200      18 ms
14:31:55   comments     GET      /comments         500      137 ms
~~~

默认时间倒序。

使用 Cursor Pagination。

### Request Detail Sheet

~~~text
Request

Request ID
Started At
Duration
Method
Route
Collection
Status

Authentication
Anonymous / Authenticated / Failed

Authorization
Allowed / Denied / Not Evaluated

Result
Error Code
Response Size

Navigation
[ Open Endpoint ] [ Open Collection ]
~~~

V0.1 Request Detail 不展示：

- Request Body
- Response Body
- Raw Headers
- Credential
- Raw Query Values

---

# 16. Changes

## 页面目的

回答：

> Backend 有哪些待处理、已应用或失败的变更？风险是什么？

## 首屏

~~~text
Changes

[ Open ] [ History ]

Search...     Scope: All ▼     Risk: All ▼     Status: All ▼

──────────────────────────────────────────────────────────────
Change        Scope        Risk          Status        Updated
#12           posts        DESTRUCTIVE   Needs review  5m
#11           users        SAFE          Ready         1h
~~~

禁止提供 Generic New ChangeSet。

ChangeSet 应从真实业务编辑器产生。

## Change Detail

~~~text
Change #12

Summary
Scope
Created by
Status

Structured Diff
[...]

Risk / Impact
[...]

Preconditions
[...]

Apply Attempts
[...]

Secondary: Save / Close / Open Scope

                          [ Apply ]
or
                          [ Confirm & Apply ]
~~~

Apply Attempt 失败后：

- ChangeSet 本身仍可继续；
- Retry 创建新的 Apply Attempt；
- Error 与 Recovery Guidance 留在 Detail 可见。

History 展示 Durable Applied Migration / Change Facts，不只是 Activity Timeline。

---

# 17. Hooks

## 页面目的

回答：

> 当前有哪些 Lifecycle Hook？它们是否健康？

V0.1 只展示已正式支持的 Hook 类型。

## 线框

~~~text
Hooks                                               [ + Add Hook ]

Search...

Name                    Event                  Status       Updated
normalize-post          posts.beforeCreate     Healthy      1d
validate-title          posts.beforeUpdate     Error        2h
~~~

Add Hook 是 Primary Action。

点击 Hook -> Detail / Editor Sheet：

~~~text
Hook

Name
Event / Target
Enabled

Code
┌──────────────────────────────────────────────┐
│ TypeScript                                   │
└──────────────────────────────────────────────┘

Secrets used
Runtime status
Last error

                        [ Disable ] [ Save ]
~~~

不要在 V0.1 UI 提前展示 Event Hook / Cron / Webhook Placeholder。

---

# 18. Access / Audit

Access 页面内部固定：

~~~text
[ Access ] [ Audit ]
~~~

## 18.1 Access

~~~text
Access                                           [ + Add Principal ]

Search...

Principal             Type          Status        Last used
admin@example.com     Admin         Active        now
agent_local           Service       Active        1h
~~~

点击 -> Principal Detail Sheet。

内容分区：

- Identity
- Capabilities / Roles
- Status
- Credentials
- Sessions

危险操作使用 Dialog：

- Disable Principal
- Revoke Credential
- Revoke Session

Application User 不出现在这里。

## 18.2 Audit

~~~text
Audit

Search...   Actor ▼   Action ▼   Resource ▼   Time ▼

Time        Actor          Action          Resource          Result
...
~~~

Audit 是 Control Plane Security / Governance Fact。

不复制每一条 Application API Request。

---

# 19. System Settings

System Settings 使用 Local Navigation：

~~~text
[ Runtime ] [ Secrets ] [ Storage ]
~~~

## 19.1 Runtime

~~~text
Runtime

Host / Port
Project Source
Operational configuration
Read-only runtime information

                                    [ Review / Save ]
~~~

Runtime Config 是否进入 ChangeSet，由后续 Runtime Config Contract 决定；UI 不提前假设直接写文件。

## 19.2 Secrets

~~~text
Secrets                                             [ + Add Secret ]

Name                  Updated          Used by
STRIPE_KEY            2d               checkout-hook
MAIL_API_KEY          7d               mail-hook
~~~

Secret Detail 不展示现有 Plaintext。

允许：

- Create
- Replace
- Delete
- Inspect metadata

## 19.3 Storage

~~~text
Storage

Provider          Local
Path              ...
Health            Ready
Usage             ...

Future provider configuration only when supported
~~~

Community V0.1 默认 Local Storage。

不展示尚未支持的 S3 配置表单占位。

---

# 20. Activity

## 页面目的

回答：

> Runtime 最近发生了什么值得关注的运行事件？

~~~text
Activity

Search...     Type ▼     Severity ▼     Time ▼

Time        Type          Summary                         Severity
14:32       Migration     Change #12 applied              Info
14:20       Hook          validate-title failed           Error
13:58       Runtime       Request log cleanup failed      Warning
~~~

点击 Event -> Detail Sheet。

Activity 不复制：

- 每条 API Request；
- 每条 Audit；
- 完整 Change History。

它只表达跨模块 Operational Event。

---

# 21. Sheet / Drawer / Dialog 统一规则

## Sheet / Drawer

用于：

- Record Detail / Edit
- Field Editor
- Index Editor
- Hook Editor
- Principal Detail
- Request Detail

特点：

- 保持原列表 Context；
- 支持 Deep Link；
- 可以在 View / Edit 状态间切换；
- Durable Result 可以留在 Sheet 中。

## Dialog

只用于：

- Delete
- Revoke
- Disable
- Destructive / Irreversible Confirm
- Unsaved Draft Leave Protection

禁止用 Modal 承载复杂长期编辑器。

---

# 22. Primary Action 位置规则

默认：

~~~text
Page Title                                      [ Primary Action ]
~~~

例如：

~~~text
Collections                                     [ + Create Collection ]
Records                                         [ + Create Record ]
Fields                                          [ + Add Field ]
Hooks                                           [ + Add Hook ]
Access                                          [ + Add Principal ]
~~~

当页面存在 Draft 时，Primary Action 从页面右上切换为 Bottom Sticky Action Bar：

~~~text
3 unsaved changes                       Discard   Review Changes
~~~

Detail Sheet 的 Primary Action 默认位于右下。

Destructive Action 不与 Primary Action 使用相同视觉权重。

---

# 23. 页面状态

每个核心页面必须至少设计：

- Loading
- Empty
- Error
- Permission Denied
- Partial Data
- Ready
- Mutation In Progress
- Durable Success
- Recovery Required

## Empty State

格式：

~~~text
Title
一句解释
[ Primary Action ]
~~~

例如：

~~~text
No collections yet
Create your first Collection to define application data.

[ Create Collection ]
~~~

## Partial Data

当一个页面的部分资源失败时：

- 成功部分继续展示；
- 失败部分明确标记 Unavailable；
- 不把失败误表示为 0；
- 给出 Retry 或目标恢复入口。

---

# 24. Responsive 与 Density

V0.1 Admin 优先 Desktop Developer Tool。

基线：

- 1280px：必须完整可用；
- 1440px：主要设计基准；
- 1920px：合理利用空间但不无限拉宽 Form；
- Tablet：允许 Sidebar 收起；
- Mobile：不作为 V0.1 核心生产编辑场景，但基础导航和只读查看不得完全崩坏。

Dense Table 只在真正需要高密度扫描时使用。

Form 最大宽度应限制，避免 1920px 下字段横跨整屏。

---

# 25. Design System 与技术边界

固定技术基线：

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

业务状态：

- TanStack Query
- TanStack Table
- React Hook Form
- Zod
- URL State
- React Local State

页面不能直接把 shadcn/ui Demo 当成产品设计。

Modelry Design System 决定：

- Typography
- Color Tokens
- Spacing
- Radius
- Elevation
- Button Hierarchy
- Form Pattern
- Table Pattern
- Sheet / Dialog Pattern
- Status
- Empty / Error State
- Interaction Feedback

---

# 26. Browser Acceptance 对齐

本 Spec 中每个核心页面都必须能被 Playwright 以稳定语义识别。

测试应围绕用户任务和 Durable Result，而不是 CSS Selector。

至少覆盖：

~~~text
First Run
-> Bootstrap
-> Login
-> Overview

Collection
-> Create
-> Schema
-> Review / Apply
-> Records
-> Reload

Auth
-> Configure
-> Register / Login
-> Session
-> Revoke

Policy
-> Configure
-> Simulate
-> Real API Verification

API
-> Endpoint
-> Runner
-> requestId
-> Request Log

Change
-> Diff
-> Risk
-> Apply Attempt
-> History
-> Restart

Hook
-> Create
-> Execute
-> Error
-> Recovery
~~~

---

# 27. Definition of Done

Admin V0.1 不能仅以“页面完成”验收。

必须同时满足：

- 页面目的明确；
- Wireframe 与 Primary Action 层级符合本 Spec；
- Empty / Loading / Error / Permission / Partial State 齐全；
- Durable Result 可见；
- Backend Model Change 不绕过 ChangeSet；
- Global / Collection API 共用 Endpoint Detail 与 Runner；
- Records CRUD 不错误进入 ChangeSet；
- Application Auth 与 Admin Access 不混淆；
- Request / Audit / Activity 不混淆；
- 所有核心页面使用 Modelry Design System；
- Mandatory Playwright Browser Acceptance 完成真实业务闭环。

---

# 28. 后续文档关系

本 Spec 固定页面产品结构，但不冻结具体 HTTP DTO。

后续顺序：

~~~text
Product Vision / Roadmap
        ↓
Product Architecture
        ↓
本 Admin Product UX Spec
        ↓
Runtime / Domain ADR
        ↓
Foundation Spec
        ↓
HTTP Contract / OpenAPI
        ↓
Implementation
        ↓
Browser Acceptance
~~~

当后续 Contract 发现某个页面所需 Capability 缺失时，应先修改 Domain / Contract，而不是让前端通过隐藏逻辑模拟不存在的能力。
