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

V0.1 Header 保持克制，不为了“开发者工具感”提前堆 Global Search / Command Palette。

左侧：

- Modelry 标识；
- 当前 Project / Instance Identity。

右侧：

- Runtime Status；
- 当前 Admin Menu。

Admin Menu 内包含：

- Theme；
- Session information；
- Logout。

只有当 V0.1 后续真正提供跨 Collection / Endpoint / Change / Setting 的统一搜索能力时，才增加 Global Search / Command Palette。没有完整搜索语义时不占 Header 位置。

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

## 默认 Community 本机流程

当 Runtime 使用默认本机绑定（例如 127.0.0.1 / localhost）且尚未创建 Admin 时，用户打开 Admin 应直接进入首次 Setup。

普通用户**不需要复制或输入 Setup Token**。

## 线框

~~~text
┌───────────────────────────────────────────────┐
│                  Modelry                      │
│                                               │
│            Create your Admin                  │
│                                               │
│  Instance       local-modelry                 │
│                                               │
│  Email          [________________________]     │
│  Password       [________________________]     │
│                                               │
│  首次创建 Admin 后，此 Setup 页面自动关闭    │
│                                               │
│                     [ Complete Setup ]        │
└───────────────────────────────────────────────┘
~~~

Primary Action：

- Complete Setup

成功：

~~~text
Admin created
-> session established
-> bootstrap closed
-> redirect Overview
~~~

## Remote Bootstrap

只有在 Runtime 被显式暴露为远程可访问，或首次 Admin 创建不是从本机可信上下文发起时，才启用额外 Bootstrap Security Mechanism。

可以采用：

- 一次性 Bootstrap Secret；
- CLI bootstrap；
- 启动时生成的短期 Pairing / Claim Code；

具体机制由后续 Security ADR / Contract 决定。

关键产品规则：

- Remote Bootstrap Secret 不进入默认 Community 本机 UX；
- 不要求普通用户从 Terminal 复制长 Token 到 Browser；
- Bootstrap Secret 只用于证明首次管理权，不作为后续 Login Credential；
- Admin 创建成功后 Bootstrap Capability 必须自动关闭；
- Runtime 已完成 Bootstrap 后再次访问 Setup 必须明确显示 already configured。

必须覆盖：

- already bootstrapped；
- remote bootstrap secret invalid / expired（仅远程模式）；
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
~~~

规则：

- Needs Attention 只有异常时展示；
- 正常 Health 信息保持紧凑；
- 读取失败显示 Unknown / Unavailable，不能显示 Ready；
- Recent Work 只保留 1–3 项；
- 不再额外放置 Collections / Changes / Activity 的 Quick Navigation，Sidebar 已承担导航职责；
- 不复制 Collections Inventory；
- 不复制 Activity Timeline；
- 不放大号 Record / Request KPI。

Overview 在正常已有 Collection 时没有固定 Create 按钮。

但**首次空项目是明确例外**。当 Backend 尚无任何 Collection 时，Overview 应直接成为 onboarding continuation：

~~~text
Your backend is ready

Create your first Collection to define application data and API.

[ Create Collection ]

Runtime    Ready
Database   Ready
Storage    Ready
~~~

不要让新用户在刚完成 Bootstrap 后先研究 Sidebar，再猜下一步去哪里。

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

Create Collection 必须完成一个 Collection 的**初始模型定义**，不采用“先创建空 Collection，再跳到 Schema 补字段”的割裂流程。

由于创建阶段可能连续定义多个 Field / Relation，Create Collection 使用**宽幅 Focused Creation Workspace**，而不是窄侧边 Sheet，也不拆成多步 Wizard。

它仍然是一次操作、一次提交，只是给连续建模足够空间。

用户心智是：

> 我要创建一个 posts 数据模型。

而不是：

> 我要先创建一个空容器，再去另一个页面继续配置。

### 线框

~~~text
Create Collection
────────────────────────────────────────

Basic information

Type

[ Normal Collection ]   [ Auth Collection ]

Name
[ posts ]

Description
[ Blog posts ]

────────────────────────────────────────
Initial fields

Field          Type              Required        Features
id             System ID         Yes             System · Locked
createdAt      Datetime          No              System-managed
updatedAt      Datetime          No              System-managed

title          Text              Yes
slug           Text              Yes
author         Relation          No              -> users

Quick add field
[ field name ] [ Type ▼ ] [ Required ] [ + Add ]

[ Advanced field settings ]

────────────────────────────────────────
                         Cancel   Create Collection
~~~

### Collection Type 选择

V0.1 只有 Normal / Auth 两种 Collection Type，因此不使用 Dropdown。

使用并列可选择项，让用户在创建时直接理解两者差异：

~~~text
[ Normal Collection ]
Application data

[ Auth Collection ]
Application users + authentication
~~~

选择 Type 后，当前创建 Surface 原地更新对应默认配置，不跳下一步。

### Auth Collection 默认可用

选择 Auth Collection 时，创建页面必须同时展示 Authentication Defaults，使 Collection 创建完成后即可直接 Register / Login，不要求用户创建后再进入 Auth 页面完成第二轮基础配置。

推荐默认：

~~~text
Authentication

Login
Email + password                 Enabled

Registration
Self registration               Enabled

Session
Duration                         7 days
~~~

同时 Initial Fields 中明确出现 Auth Identifier：

~~~text
id             System ID         System · Locked
email          Auth identifier   Required · Unique
createdAt      Datetime          System-managed
updatedAt      Datetime          System-managed
~~~

规则：

- email 作为默认登录标识时必须在 Schema 中可见；
- 当 Email Login 仍启用时，email 不能被删除；
- Password **不是普通 Collection Field**，不出现在 Schema / Records 表格，也不能通过普通 Record API 读取；
- Password 属于 Application Credential，由 Auth Runtime 管理；
- 用户仍可在同一次 Create Collection 中添加 name、avatar、role 等 Profile Field；
- 高级 Auth 参数不阻断首次创建，创建后可在 Auth / Configuration 中调整。

因此 Auth Collection 的首次路径是：

~~~text
Create Auth Collection
-> choose Auth
-> keep sensible defaults
-> add optional profile fields
-> Create Collection
-> immediately usable for register / login
~~~

而不是：

~~~text
Create Auth Collection
-> open Auth page
-> configure login
-> apply again
-> finally usable
~~~

### 默认字段

创建界面必须直接展示：

- id；
- createdAt；
- updatedAt。

其中：

- id 固定存在且不可修改；
- createdAt / updatedAt 可以在创建阶段删除；
- 默认字段必须明确标记系统语义，避免用户重复创建同名字段。

### Add Field

创建阶段优先支持 **Quick Add**，让普通字段无需反复打开 / 关闭 Editor：

~~~text
[ name ] [ Type ▼ ] [ Required ] [ + Add ]
~~~

适合快速创建：

- Text；
- Number；
- Boolean；
- Datetime；
- 其他无需复杂配置的基础 Field。

需要 Validation、Default、Relation、File 或 Type-specific Option 时，点击 Advanced 或已添加 Field，打开与 Schema 共用的 Canonical Field Editor。

因此常见建模路径是：

~~~text
title   Text      Required   + Add
slug    Text      Required   + Add
views   Number               + Add
author  Relation             -> Advanced
~~~

Quick Add 与 Advanced Editor 最终都只修改同一个 Create Collection Draft，不立即写入 Runtime。

Quick Add 还必须优化连续录入：

- Enter 可以提交当前简单 Field；
- Add 成功后焦点回到下一个 Field Name；
- Type 默认继承最常用 Text，但每行仍明确显示；
- Field Name 冲突立即在当前行提示，不等到最终 Apply；
- 不因为新增一行而滚动到页面顶部或关闭当前工作区。

用户可以连续添加、编辑、删除初始字段。

### Relation

Relation 仍然是 Field Type。

因此创建阶段可以直接：

~~~text
author
-> Relation
-> target users
-> many-to-one
~~~

不需要先创建 Collection 再跳 Schema / Relations。

### Index

V0.1 默认 Create Collection Surface 不要求用户立即创建 Index。

原因：

- 初次创建 Collection 的主要任务是定义数据结构；
- Index 属于更高级的查询 / 唯一性设计；
- 可以在 Collection 创建完成后从 Schema / Indexes 添加。

如果后续确认 Unique Constraint 需要成为常见建模入口，可以通过 Field Feature 表达并由 Runtime 生成对应 Index，但不在本 Spec 提前冻结。

### 提交语义

整个 Create Collection Surface 只产生一个 Draft。

~~~text
Collection definition
+
Initial Fields
+
Initial Relations
+
Field Validation / Defaults
        ↓
one modeling draft
        ↓
Create Collection
        ↓
one ChangeSet
        ↓
Runtime canonical Risk / Preconditions / Impact
        ↓
SAFE -> apply immediately
Risk -> review in current Create Collection flow
        ↓
durable Collection
~~~

用户只需要点击一次 **Create Collection**。

不要求：

~~~text
Create empty Collection
-> enter Collection
-> open Schema
-> add fields
-> Apply again
~~~

### Apply 结果

创建成功后直接进入：

~~~text
Collection Workspace
-> Records
~~~

如果 Collection 尚无 Record：

~~~text
posts

No records yet.
Your collection is ready with 6 fields.

[ Create first record ]

Secondary:
Edit Schema
~~~

此时用户可以立即创建第一条业务数据。

如果 Runtime 返回需要确认的风险，Review / Confirm 仍在当前 Create Collection Flow 原地完成，不强制跳转 Changes。

如果用户只有 propose 权限没有 apply 权限：

- Create Collection Draft 可以 Save for Later；
- 后续从 Changes 页面继续；
- 未 Apply 前不得把 Collection 显示为已经创建。


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

Records 页面必须保留用户当前工作上下文：

- Search；
- Filter；
- Sort；
- Pagination / Cursor；
- Column Visibility（适合 URL 的部分进入 URL State，其余可作为本地偏好）；
- 当前打开的 Record Deep Link。

打开 Record Detail、编辑后返回、刷新页面时，不应把用户重置回默认列表。

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

## 9.3 Create / Edit Record

普通 Collection 使用 Detail / Edit Sheet，保持 Records 列表上下文。

但不能规定所有 Record Form 永远使用窄 Sheet。

根据可见字段数量和复杂度自适应：

- 少量简单字段：标准侧边 Sheet；
- 字段较多、包含大文本 / File / Relation / JSON-like complex input：Wide Sheet；
- 极复杂表单如果后续确有需要，可以使用 Focused Record Editor，但 V0.1 不默认跳完整独立页面。

目标是：**保留列表上下文，但不牺牲表单可用宽度。**

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

Create 成功后的 View 状态可以提供 Secondary Action：

- Create another

用于连续录入多条数据，但不自动清空并进入下一条，避免意外丢失刚创建结果。

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

### 默认系统字段

创建 Collection 后，Schema / Fields 必须立即显示系统默认字段，禁止存在“Runtime 实际有字段，但 UI 默认不展示”的隐式字段。

V0.1 默认字段：

~~~text
id           System ID        required   locked
createdAt    Created Time     optional   system-managed
updatedAt    Updated Time     optional   system-managed
~~~

规则：

- **id 必须显示**；
- id 是 Collection 的系统主键，用户不能删除、重命名、修改类型或改变其系统语义；
- id 使用明显的 System / Locked 标识，避免用户误以为需要再次创建 ID 字段；
- createdAt / updatedAt 默认创建并显示；
- createdAt / updatedAt 的值由 Runtime 自动维护，不允许用户手工写入或修改；
- createdAt / updatedAt 可以从 Schema 中删除；删除属于普通 Backend Model Change，并进入当前 Collection Shared Draft；
- createdAt / updatedAt 一旦保留，其 Name、Type 与系统维护语义固定，不作为普通自定义 Field 编辑；
- 删除后如需恢复，应通过 Add System Field / Restore Default Field 等明确入口恢复，而不是让用户手工创建一个同名普通字段；
- 新建普通 Field 时，id / createdAt / updatedAt 等保留名称必须做冲突校验；
- Record Form 默认不显示 id / createdAt / updatedAt 为可编辑输入；
- Record Detail 可以在 Metadata 区域展示这些系统字段。

创建 Collection 成功后，空 Collection 的 Schema 初始状态应该类似：

~~~text
Schema · 3 fields                                [ + Add Field ]

[ Fields ] [ Relations ] [ Indexes ]

Field          Type          Required       Features
id             system id     Yes            System · Locked
createdAt      datetime      No             System-managed
updatedAt      datetime      No             System-managed
~~~

这样用户能明确知道：

- Collection 已经有主键；
- 哪些字段由系统维护；
- 哪些默认字段可以移除；
- 不需要重复创建 id。



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

## 10.4 Shared Draft Scope

同一个 Collection 内的模型修改默认进入同一个 Shared Draft。

可以连续积累：

- Field add / update / remove；
- Relation add / update / remove；
- Index add / update / remove；
- 与上述结构变更直接相关的 Validation / Default / Constraint 调整。

用户不需要每修改一个 Field 就立即 Apply。

推荐工作方式：

~~~text
Add Field
-> Edit Field
-> Add Relation
-> Add Index
-> continue modeling
-> one Apply Changes
~~~

Runtime 对这一组变更统一计算：

- Structured Diff；
- Risk；
- Preconditions；
- Impact；
- Migration Plan。

因此一次 Apply 对应一次完整的 Collection Modeling Task，而不是一次单字段操作。

V0.1 的 Draft Scope 固定为 **单 Collection**。

明确不做：

~~~text
posts + users + comments
-> one cross-collection modeling draft
~~~

跨 Collection 联合 Draft 会显著增加依赖排序、失败恢复、权限和 UX 复杂度，留待后续版本单独设计。

## 10.5 Shared Draft Action Bar

只要 Fields / Relations / Indexes 有任何 Draft：

~~~text
┌─────────────────────────────────────────────────────────────┐
│ 3 unsaved model changes            Discard   Apply 3 changes│
└─────────────────────────────────────────────────────────────┘
~~~

固定在 Workspace 底部。

默认主操作应带上当前变更数量，例如 **Apply 3 changes**，不使用含糊的通用 Apply Changes，也不要求用户先跳转 Changes 页面。

点击 Apply Changes 后：

- Runtime 生成 / 更新对应 ChangeSet；
- Runtime 计算 canonical Risk / Preconditions / Impact；
- SAFE Change 可以直接完成 Apply；
- 需要确认的 Risk Change 在当前 Workspace 原地展开 Review Surface；
- 用户确认后仍在当前 Workspace 内完成 Apply；
- Apply 成功后 Draft 清理并刷新当前页面。

切换 Fields / Relations / Indexes 不丢 Draft。

如果用户离开 Collection Workspace，Draft 不得静默丢失。离开时可以：

- Continue Editing；
- Save for Later；
- Discard。

选择 Save for Later 后，Draft 转为可继续处理的 ChangeSet，之后可从 Changes 页面继续 Review / Apply。

---

# 11. Review / Apply Changes

Review Surface 是 **当前工作区内的风险确认层**，不是独立页面跳转要求。

普通 SAFE Change 默认不展开完整 Review，用户点击 Apply Changes 后即可完成。

只有 Runtime 返回需要确认的 Risk / Impact 时，当前页面原地展开 Review Surface，例如 Sheet、Drawer 或 In-place Review Panel：

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

[ Save for Later ]                  [ Confirm & Apply ]
~~~

规则：

- 不强制导航到 Changes 页面；
- Frontend 可以在 Apply 前给即时 Preview；
- Runtime 返回 canonical Risk / Preconditions / Impact 后，以 Runtime 结果为准；
- Risk 不是用户输入；
- 需要确认的 Risk Change 在当前业务上下文内完成 Human Confirmation；
- Confirm & Apply 成功后，保持在当前 Collection / Schema 页面；
- 成功结果在当前页面可见，并清理 Draft；
- 用户暂不应用时可以选择 Save for Later；
- Save for Later 后，该 ChangeSet 出现在 Changes 页面，供后续继续；
- 用户已经离开原页面后，也可以从 Changes 页面恢复 Review / Apply；
- 没有 Apply Capability 时，只允许 Save for Later / Open in Changes，不显示可执行 Apply。

---

# 12. Policy

## 页面目的

回答：

> Application User 对当前 Collection 的各类操作分别有什么访问规则？

Policy 不默认让用户在五个 Operation Tab 之间来回切换，而是先给出**五类操作的整体摘要**，再编辑单项规则。

## 首屏

~~~text
Policy

Operation        Current rule                         Status
List             ownerId = @request.auth.id          Custom
View             ownerId = @request.auth.id          Custom
Create           authenticated                       Custom
Update           ownerId = @request.auth.id          Custom
Delete           denied                              Default deny
~~~

点击某一 Operation 后，在同页 Detail / Editor Pane 中编辑：

~~~text
Update policy

Rule
┌──────────────────────────────────────────────────────────────┐
│ ownerId = @request.auth.id                                   │
└──────────────────────────────────────────────────────────────┘

Readable explanation
Only records owned by the current user can be updated.

Secondary:
[ Copy from View ]   [ Simulate ]

───────────────────────────────────────────────────────────────
                         Cancel   Save Draft
~~~

这样用户始终能看到 List / View / Create / Update / Delete 的整体状态，不需要逐个 Tab 才知道当前配置。

### 减少重复配置

Policy Editor 支持把已有 Operation Rule 复制到当前 Operation Draft，例如：

- Copy from List；
- Copy from View；
- Copy from Update。

复制只修改 Draft，不直接写 Runtime。

### Apply

Policy Mutation 属于 Backend Model Change，进入当前 Collection Shared Draft。

有 Draft 时使用统一 Bottom Sticky Action Bar：

~~~text
2 unsaved changes                         Discard   Apply 2 changes
~~~

Simulation 是 Secondary Tool。

Simulation Result 与编辑区分离，不能自动改变 Rule。


# 13. Auth — Auth Collection Only

Auth Collection 创建时已经带有可工作的 Authentication Default，因此 Auth 页面不是“完成初始化”的必经页，而是后续管理与调整入口。

固定两个 Local View：

~~~text
[ Configuration ] [ Sessions ]
~~~

## 13.1 Configuration

默认先展示当前配置摘要，而不是一进入页面就把所有字段变成 Form。

~~~text
Authentication                                      [ Edit ]

Login
Email + password                         Enabled

Registration
Self registration                        Enabled

Password
Minimum length                            8

Session
Duration                                  7 days
~~~

点击 Edit 后进入本页编辑状态。

修改只进入当前 Collection Draft；底部统一显示：

~~~text
1 unsaved change                         Discard   Apply 1 change
~~~

不再使用额外的 Review Changes 按钮制造第二层确认。

需要风险确认时，Apply 后在当前页面原地展开 Review / Confirm。

### Auth Identifier 与 Credential

必须明确：

~~~text
email
-> Collection Field / Auth Identifier

password
-> Application Credential
-> not a normal Collection Field
~~~

因此：

- email 在 Schema / Records 中按其产品语义展示；
- password 不出现在 Schema Field List；
- password 不进入普通 Record Detail；
- password 不允许普通 Record API read-back。

## 13.2 Sessions

~~~text
Sessions

Search user...

User                 Created       Last used       Status
alice@example.com    2h            10m             Active
bob@example.com      1d            2h              Revoked
~~~

优先显示可识别的 Application User，而不是 usr_... / Principal 等内部标识；无法安全解析显示名称时才退回稳定 ID。

点击 Session / User -> Detail Sheet。

Revoke Session 是 Runtime Operation，不走 ChangeSet。

Revoke 成功后行保留并更新为 Revoked，让 Durable Result 原地可见。

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

> 我之前保存但尚未处理的变更在哪里？有哪些失败、待确认或已应用的历史？

Changes 是 **异步承接、恢复和历史页面**，不是每次模型编辑的强制中转页。

## 首屏

~~~text
Changes

[ Open ] [ History ]

Search...     Scope: All ▼     Risk: All ▼     Status: All ▼

──────────────────────────────────────────────────────────────
Change summary                    Scope       Risk          Status        Updated
Remove legacy status field         posts       DESTRUCTIVE   Needs review  5m
Add profile fields                 users       SAFE          Ready         1h
~~~

Change ID 仍然存在，但作为 Secondary Metadata / Deep-link Identity，不作为列表中最主要的信息。

Change List 的第一列必须优先展示用户能理解的 Summary，例如：

- Add 3 fields to posts；
- Remove legacy status field；
- Update users policy；
- Add unique index on slug。

禁止提供 Generic New ChangeSet。

ChangeSet 应从真实业务编辑器产生。

用户在原业务页面仍然可以完成 Apply；只有以下情况才需要进入 Changes：

- 用户选择 Save for Later；
- 用户已经离开原业务页面；
- Apply 失败后需要恢复；
- 需要查看 Apply Attempts / Migration History；
- 需要统一处理多个 Pending Change。

## Change Detail

~~~text
Remove legacy status field

Change ID        chg_...
Scope            posts
Created by       jane@example.com
Status           Needs review

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

> 当前有哪些 Lifecycle Hook？它们什么时候执行、代码是什么、现在是否健康？

V0.1 只展示已正式支持的 Lifecycle Hook，不提前展示 Cron / Webhook / Event Delivery Placeholder。

## 首屏

~~~text
Hooks                                               [ + Add Hook ]

Search...

Name                    Trigger                Status       Updated
normalize-post          posts.beforeCreate     Healthy      1d
validate-title          posts.beforeUpdate     Error        2h
~~~

## Add Hook

Add Hook 使用一个完整 Editor Surface，一次定义即可保存，不再先创建空 Hook 再进入第二个页面补配置。

~~~text
Add Hook

Name
[ normalize-post ]

Collection
[ posts ▼ ]

Trigger
[ beforeCreate ▼ ]

Enabled
[x]

Code
┌──────────────────────────────────────────────────────────┐
│ TypeScript                                               │
│                                                          │
└──────────────────────────────────────────────────────────┘

Secrets
[ Select secret references... ]

Context / API help                            View reference

───────────────────────────────────────────────────────────
                                      Cancel   Save Hook
~~~

选择 Trigger 后，Editor 应提供对应的最小 TypeScript Signature / Context Hint，减少用户查文档再返回编辑器的往返。

Secrets 只按 Reference 选择，不把 Plaintext 注入编辑表单。

## Hook Detail

点击 Hook 后保持 Registry Context，打开 Detail / Editor。

优先展示：

- Trigger；
- Enabled / Disabled / Faulted；
- Runtime Status；
- Last Error（有真实来源时）；
- Code；
- Referenced Secrets。

Save 成功后留在 Detail 并展示 Durable Hook Definition。

如果 Hook Runtime 尚未提供安全的 Test Execution Contract，V0.1 **不展示假的 Test 按钮**。等真实 Test Runtime 存在后再增加原地 Test 能力。

---

# 18. Access / Audit

Access 页面内部固定：

~~~text
[ Access ] [ Audit ]
~~~

产品 UI 不要求普通用户先理解 Principal / Capability / Credential 等内部安全模型术语。

这些概念可以继续存在于 Domain / Contract，但界面优先使用：

- Administrator
- Service Account
- Permissions
- API Key
- Session

## 18.1 Access

~~~text
Access                                                [ + Add access ]

Search...

Name                    Kind               Status       Last used
jane@example.com        Administrator      Active       now
ci-deploy               Service account    Active       1h
~~~

点击 Add access：

~~~text
Add access

[ Add administrator ]
Human access to Modelry Admin

[ Create service account ]
Machine / Agent access through API key
~~~

不先弹一个要求用户选择 Principal Type 的工程化表单。

### Add administrator

一次完成：

- Name；
- Email；
- Initial password / bootstrap credential（按 Security Contract）；
- Permissions。

成功后直接进入新 Administrator Detail。

### Create service account

一次完成：

- Name；
- Description；
- Permissions；
- Create API key now：默认开启。

成功路径：

~~~text
Create service account
-> durable service account created
-> API key created
-> one-time reveal
-> copy
-> Done
-> stay on service account detail
~~~

这样不会出现“创建了 Service Account，但用户还不知道下一步要再去创建 Credential”的断裂流程。

API Key Plaintext 仍然只能 One-time Reveal，不允许后续 Read-back。

### Access Detail

内容按用户任务排序：

1. Identity；
2. Permissions；
3. API Keys（Service Account）；
4. Sessions（Administrator）；
5. Status / Disable。

UI 使用 Permissions 作为用户术语；底层仍可映射到 Capability。

危险操作使用 Dialog：

- Disable access；
- Revoke API Key；
- Revoke Session。

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

每一个可编辑 Setting 必须明确标记生效方式：

- Applies immediately；
- Requires Runtime restart；
- Read-only / derived。

保存需要 Restart 的配置后，当前页面必须持续显示 Pending Restart，并提供明确 Restart Guidance，不能只 Toast 成功。

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

# 21. 操作效率与上下文保留

## 21.1 列表上下文不丢失

从 List / Table 进入 Detail、Edit、Sheet 后返回时，必须尽可能恢复：

- Search；
- Filter；
- Sort；
- Pagination / Cursor；
- Selected local view；
- Scroll / selection（在稳定实现可行时）。

适合 Deep Link 的状态进入 URL State；纯展示偏好保留为 Local Preference。

禁止用户每查看或编辑一个对象就被送回列表第一页。

## 21.2 高频简单操作就地完成

当一个操作只需要 1–3 个常用字段时，优先使用 Quick Add / Inline Draft，而不是强制打开大型 Editor。

复杂配置再 Progressive Disclosure 到 Sheet / Detail Pane。

适用：

- Add simple Field；
- Initial Collection Fields；
- 简单 Filter；
- Policy Rule copy。

不适用：

- Destructive Confirmation；
- Complex Relation / File configuration；
- Long-form Hook Code。

# 22. Sheet / Drawer / Dialog 统一规则

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
- Durable Result 可以留在 Sheet 中；
- 宽度必须由任务复杂度决定，不使用一个固定窄宽度承载所有表单；
- 简单 Detail 使用标准宽度，复杂 Record / Field / Hook Editor 可以升级为 Wide Sheet；
- 内容需要大量横向比较时优先使用页面内 Detail Pane，而不是无限加宽 Sheet。

## Dialog

只用于：

- Delete
- Revoke
- Disable
- Destructive / Irreversible Confirm
- Unsaved Draft Leave Protection

禁止用 Modal 承载复杂长期编辑器。

---

# 23. Primary Action 位置规则

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
Access                                             [ + Add access ]
~~~

当页面存在 Draft 时，Primary Action 从页面右上切换为 Bottom Sticky Action Bar：

~~~text
3 unsaved changes                     Discard   Apply 3 changes
~~~

Detail Sheet 的 Primary Action 默认位于右下。

Destructive Action 不与 Primary Action 使用相同视觉权重。

---

# 24. 页面状态

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

# 25. Responsive 与 Density

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

# 26. Design System 与技术边界

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

# 27. Browser Acceptance 对齐

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

# 28. Definition of Done

Admin V0.1 不能仅以“页面完成”验收。

必须同时满足：

- 页面目的明确；
- Wireframe 与 Primary Action 层级符合本 Spec；
- 首次空项目能从 Overview 一步进入 Create Collection；
- Empty / Loading / Error / Permission / Partial State 齐全；
- Durable Result 可见；
- Backend Model Change 不绕过 ChangeSet；
- Global / Collection API 共用 Endpoint Detail 与 Runner；
- Records CRUD 不错误进入 ChangeSet；
- Application Auth 与 Admin Access 不混淆；
- Auth Collection 创建完成后具备默认可用的 Email + Password Auth；
- Password 不被建模为普通 Collection Field；
- Access UI 不强迫用户理解 Principal / Capability / Credential 内部术语；
- Request / Audit / Activity 不混淆；
- 所有核心页面使用 Modelry Design System；
- Mandatory Playwright Browser Acceptance 完成真实业务闭环。

---

# 29. 后续文档关系

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
