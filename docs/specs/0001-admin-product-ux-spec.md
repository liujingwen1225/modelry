# Spec 0001 — Modelry Admin 全新体验与界面规格

- **状态：** 新版设计提案（2026-09-29）
- **范围：** 自托管 Modelry 项目 Admin 的信息架构、内容、操作旅程与视觉系统
- **替代：** 本文件重建 Admin 的导航、页面组织、首页、内容表达和交互方式；实现阶段从本稿重新对照，不沿用旧版页面结论
- **依赖：** `docs/00-product-vision.md`、`docs/04-v0.1-community-scope.md`、`docs/05-product-experience-and-acceptance.md`、`docs/06-product-architecture.md` 及已接受的相关 ADR / Spec / HTTP Contract
- **不定义：** HTTP DTO、数据库结构、Go 包、业务能力或组件 API

本文件提供一套可评审、可实施的新版 Admin 设计。用户界面的精确信息架构与体验以本文件为准；产品能力和业务语义以对应已接受的产品文档与契约为准。

# 1. 产品体验目标

Modelry Admin 是开发者构建和运营一个应用后端的工作台。界面沿着实际任务组织，让用户在同一工作区里完成建模、数据管理、应用接入、安全配置、运行观察与模型演进。

默认服务一个开发者、一个项目、一个运行时。界面不引入组织、环境晋级、多项目切换或企业治理心智。

新版体验必须：

1. 让首次使用者知道下一步能完成什么；
2. 把常用操作放在产生结果的上下文中；
3. 将运行状态、模型状态和记录数据状态分开表达；
4. 让成功结果留在页面中，刷新后仍能继续查看；
5. 把错误写成可理解、可处理的下一步；
6. 让开发者和编码智能体经过同一授权、校验、变更与审计路径；
7. 用稳定的深链接恢复集合、记录、请求和变更上下文；
8. 在键盘、屏幕阅读器、窄屏和明暗主题下保持可操作。

首页承担任务入口与注意事项，不承担统计大屏职责。产品不展示没有真实运行能力的入口或示意指标。

# 2. 两条核心任务旅程

## 2.1 开发者旅程

~~~text
启动 Runtime
→ 创建 Owner
→ 建立第一个 Collection
→ 创建一条 Record
→ 配置应用访问规则
→ 发出第一条 API 请求
→ 按需要添加 Hook / Webhook / Schedule
→ 查看请求和运行状态
→ 审核、应用并验证后续模型变化
~~~

每一步都在完成上一步后就地提供下一条有意义的路。用户可以跳过非必需步骤，已有项目直接恢复到最近工作。

## 2.2 编码智能体旅程

~~~text
连接 MCP
→ 检查当前项目和权限
→ 理解 Collection / API / Access Rules
→ 提出受控变更
→ 展示差异、影响和运行时风险
→ 必要时由开发者复核
→ 应用
→ 用 API 或运行状态验证
→ 查看审计记录
~~~

Admin 展示 MCP 连接方式、服务账号权限和验证结果。编码智能体没有绕过权限、模型变更生命周期或审计的路径。Service Account、Admin Account 与 Application User 分别表达不同身份。

# 3. 新版信息架构

## 3.1 全局导航

全局导航依开发者完成后端的工作顺序排列。它不使用传统企业后台的模块分组，也不把内部实现模块直接作为一级页面。

~~~text
Home

BUILD
  Collections

CONNECT
  API & SDK

AUTOMATE
  Automations

OBSERVE
  Requests
  Activity & Audit

EVOLVE
  Changes
  Model health

PROJECT
  Access & keys
  Settings
~~~

导航目的地与已交付页面映射：

| 入口 | 页面内容 |
| --- | --- |
| Home | 项目状态、继续最近工作、当前需要处理的问题、首次使用的下一步 |
| Collections | Collection 列表和创建；选中 Collection 后进入 Records / Model / Access / API 工作区 |
| API & SDK | 全局端点、请求调试、OpenAPI、SDK 生成、MCP 连接与接入说明 |
| Automations | Extensions / Hooks、Secrets 入口、Webhooks、Event Triggers、Scheduled Triggers 和投递历史 |
| Requests | 应用请求日志、请求详情和从请求进入 API 调试的上下文 |
| Activity & Audit | 活动时间线与管理面审计事实；两类记录清楚区分 |
| Changes | 尚待应用的模型变化、应用尝试和已应用历史 |
| Model health | 已应用模型与运行时投影的 Drift 检查及可执行的恢复路径 |
| Access & keys | Administrators、Service Accounts、Permission 和 API Key |
| Settings | 项目状态与 Runtime、Files & Storage、Mail、Secrets、数据导入 / 导出、Backup & restore |

Connect 的本地子导航为 `API`、`SDK & Contract`、`MCP`。MCP 与 SDK 一样，是接入 Modelry 的开发者接口；Service Account 凭据的生命周期仍由 Access & keys 管理。MCP 子页展示：连接状态与可复制的连接配置命令、绑定的 Service Account 及其权限摘要、最近的 Agent 操作列表（按 Service Account 过滤 Activity）；不在此页管理凭据。

Automations 的子导航按实际运行对象显示：`Hooks`、`Webhooks`、`Triggers`、`Schedules`、`Delivery history`。如果用户无权访问其中一项，只隐藏对应入口，服务端继续负责授权。

Collection 工作区：

~~~text
Records     Model     Access     API
~~~

`Model` 内含 `Fields`、`Relations`、`Indexes`。Auth Collection 的 `Access` 内含 `Rules`、`Authentication`、`App users`、`Sessions`。Normal Collection 不显示只属于认证集合的页面。

## 3.2 导航行为

- 全局主导航切换到新的工作目的地；集合内子导航保留当前 Collection。
- 顶栏固定显示 Modelry 标识、当前项目路径/本地上下文、Runtime 状态、全局搜索/命令、语言、主题和 Admin 账户。
- 自托管单项目没有项目切换器。项目路径仅作当前运行上下文说明，不伪装成可切换的云资源。
- 选中 Collection 后，在页面标题和集合内子导航持续显示 Collection 名称与类型。
- Pending changes 在 Changes 入口、对应 Collection 导航和 Collection 页面内显示同一实时计数；失败状态使用文本和图标说明。
- Runtime、Database 或 Storage 出现问题时，状态控件直接打开可恢复问题的详情页。
- 路由、query、hash 和返回上下文遵守第 15 节的 URL 约定。

## 3.3 桌面工作区框架

~~~text
┌────────────────────────────────────────────────────────────────────────┐
│ modelry  /  local project       Runtime: Ready   ⌘K   EN   ◐   Owner  │
├────────────────────┬───────────────────────────────────────────────────┤
│ Home               │                                                   │
│                    │ Page title                         Primary action │
│ BUILD              │ Context summary / actionable state                │
│ Collections        │                                                   │
│                    │ Main work surface                                  │
│ CONNECT            │                                                   │
│ API & SDK          │                                                   │
│                    │                                                   │
│ AUTOMATE           │                                                   │
│ Automations        │                                                   │
│                    │                                                   │
│ OBSERVE            │                                                   │
│ Requests           │                                                   │
│ Activity & Audit   │                                                   │
│                    │                                                   │
│ EVOLVE             │                                                   │
│ Changes            │                                                   │
│ Model health       │                                                   │
│                    │                                                   │
│ PROJECT            │                                                   │
│ Access & keys      │                                                   │
│ Settings           │                                                   │
└────────────────────┴───────────────────────────────────────────────────┘
~~~

Shell 的侧栏使用低对比度底色，当前目的地使用清晰的左侧标记和底色。主要内容区保持连续画布，不把每个区块做成同等权重的卡片。

# 4. 首次使用与登录

## 4.1 Owner 初始化

首次本机启动直接显示 Owner 创建表单，不要求复制 Setup Token。界面只询问创建 Owner 所需的邮箱与密码，并提供密码显示切换、密码管理器支持和明确的输入错误。

~~~text
创建你的 Modelry 管理员
这个账号管理当前后端项目。

邮箱
[________________________________]

密码
[________________________________]

                         [ 创建管理员 ]
~~~

提交时保留输入；服务端错误关联到表单或具体字段。Owner 创建成功后建立会话并关闭 Bootstrap。若尚无 Collection，直接进入 Create Collection；已有 Collection 则返回用户原始深链接或 Home。

远程首次初始化沿用对应 Security ADR 的 Claim / Secret 规则。无效或过期 claim、已完成初始化和 Runtime 不可用都显示原因及恢复路径。

## 4.2 登录

登录只用于 Modelry Owner / Administrator，不显示应用用户登录入口。成功登录优先返回用户最初访问的安全站内深链接；无法使用的深链接安全回退 Home。

密码错误、账号恢复和会话失效分别给出清楚说明。登录错误不泄露账号是否存在等敏感信息。

# 5. Home — 项目工作台

## 5.1 页面任务

回答：**项目现在能否正常工作？我可以继续做什么？**

Home 以状态和任务顺序组织内容，不展示 KPI 瓷砖墙、重复 Collection 清单、重复请求列表或纯装饰性图表。

~~~text
Home
后端项目的当前状态与下一步工作。

Workspace status
Runtime          Ready
Database         Ready
File storage     Ready
Model            Up to date

Next step
Create your first Collection
定义应用数据并生成对应 API。
[ Create Collection ]

Recent work
Collection name        Updated       Open

Needs attention                         仅在有待处理问题时出现
Storage needs attention · View storage settings
~~~

空项目的主要操作是 Create Collection。创建成功后，首页提示 Create first record；产生记录后可继续配置 Access Rules 或调用 API。引导项只根据当前真实状态生成，完成后自动收起。

## 5.2 已有项目

- 首屏显示 Runtime / Database / Storage / Model 四类当前状态；正常状态精简为一行。
- 显示一项建议的下一步，例如完成 API 调用、查看待应用变化或恢复 Storage。
- 显示最近访问的 Collection 和最近一次有意义的操作；不把时间线复制成 Activity。
- Pending / Failed Change 只在存在时出现，并直达对应的 Changes / Recovery context。
- Agent connection 作为低权重、可复制的接入说明，提供通往 Access & keys 和 MCP 文档的入口。

## 5.3 首页数据失败

某个状态服务失败时，保留已加载的其它状态。明确写出哪些信息不可用，并提供对应重试或设置入口。不可用状态不得显示为零、正常或空项目。

# 6. Build — Collections 与集合工作区

## 6.1 Collections 列表

页面目的：找到要管理的业务数据模型，或创建新的 Collection。

- 标题下说明 Collection 定义数据字段并提供记录、规则和 API 工作区。
- 主操作为 `Create Collection`。
- 支持搜索、Normal / Auth 类型筛选、排序和列表/表格密度切换；不默认展示重复的大图卡片墙。
- 每行显示名称、类型、记录数、字段数和最近更新。Pending / Failed 只在需要关注时强调。
- 打开某项后默认进入 Records；返回时恢复搜索、筛选、排序、分页和滚动位置。

空状态直接说明 Collection 能解决的问题，主按钮仍为 `Create Collection`。

## 6.2 Create Collection

使用一个聚焦的完整页面完成 Collection 名称、类型和首批字段。复杂长表单不放进窄 Dialog，也不拆成需要来回提交的多步向导。

~~~text
Create Collection                             [ Cancel ]
为应用数据创建一个稳定的集合。

Collection name       Type
[ posts             ] [ Normal collection ▼ ]

Initial fields
Name            Type          Required       Unique       More
title           Text          Yes            No
slug            Text          Yes            Yes

[ Field name ] [ Type ▼ ] [ Add field ]

System fields
id · createdAt · updatedAt       Managed by Modelry

                              [ Create Collection ]
~~~

规则：

- Name 可读、必填、唯一性错误就地呈现。
- 系统字段 `id`、`createdAt`、`updatedAt` 始终显示并锁定。
- 字段录入后焦点返回新字段行；Enter 只在输入完整且动作明确时添加字段。
- 重复名称在当前行提示，不清空其它字段或滚回页面顶部。
- 建立 Relation 时在当前行展开目标 Collection 和 cardinality；更复杂的删除行为进入完整字段编辑器。
- 常见 Text / Number / Boolean / Date / JSON / Relation / File 配置就地完成；少见高级选项折叠在字段详情。
- 用户可返回或取消，不会进入无返回路径。

选择 Auth Collection 后原地出现真实可用的认证选项：email + password、是否允许自助注册、会话有效期和 Profile 字段。`email` 是必填唯一标识，`password` 是凭证，不作为普通 Field 展示。V0.2 之前不得出现未交付的 OAuth Provider 选项。

新 Collection 尚无既有数据，创建时直接校验并建立；不展示与风险无关的迁移确认。成功后进入 Records，并提供 `Create first record`。Model 初始字段和 Auth 配置在此上下文中可继续修改。

## 6.3 Collection 工作区

标题区持续提供 Collection 名称、类型、状态以及进入其它集合的返回路径。主操作由当前子页面任务决定。

`Records` | `Model` | `Access` | `API` 四个子页共享 Collection 身份和 pending-change 状态。

记录页头示意：

~~~text
Collections / posts
posts                                     [ Create record ]
Records   Model   Access   API
~~~

## 6.4 Records

- 记录表格支持搜索、筛选、排序、分页、列显示、复制稳定 ID 和恢复 URL 上下文。
- 系统字段作为可理解的系统信息展示；Record 表单不能修改系统字段。
- 创建、查看与编辑在保留列表上下文的宽工作面完成。查看面板显示记录字段、关系、文件值和更新时间。
- 删除使用明确对象名称和可恢复性说明；执行后该行与结果在当前列表中可见。
- Empty、Loading、Error、Permission denied、Partial Data 都有独立表现。
- Auth Collection 创建应用用户时，同一表单完成 Profile Record 和 Password Credential；结果显示用户状态并提供进入 Sessions 的链接。

## 6.5 Model — Fields / Relations / Indexes

Model 统一呈现字段、关系和索引。用户不需要在多个页面间理解同一 Collection 的模型状态。

- `Fields` 是字段默认视图；字段名称、类型、约束和关系目标优先显示。
- `Relations` 是跨集合关系视图，突出来源、目标与 cardinality；不作为另一份独立模型。
- `Indexes` 展示复合索引和高级索引。普通单字段 Unique 留在字段表单。
- 所有字段、关系和索引操作写入同一个 Collection-scoped、durable Pending Changes。
- Policy 与 Authentication 配置有各自保存路径，不计入 Model Pending Changes。
- 用户保存一次本地编辑后，操作才成为 durable pending change。页面显示 `N pending changes`，不把已保存操作称为 unsaved。
- 离开未保存的本地表单时提供保护；离开已保存 pending changes 不再弹“未保存”确认。

## 6.6 Access — Rules / Authentication / Users / Sessions

Normal Collection 的 Access 页展示 Collection Access Rules。

Auth Collection 的 Access 工作区提供：

~~~text
Rules    Authentication    App users    Sessions
~~~

Access Rules 覆盖 List / View / Create / Update / Delete，默认拒绝。先显示易懂的预设：No access、Anyone、Signed-in users、Record owner，再提供 Custom rule。当前规则、受影响操作与策略模拟结果清楚关联；不只靠颜色表达权限。

Authentication 页只展示后端真实支持的配置，如注册开关、密码策略、Session 时长、邮箱验证或密码重置通知状态。不可用的邮件服务提示配置入口，不伪装通知成功。

App users 和 Sessions 使用相同的返回上下文。撤销 Session 后显示已撤销事实并提示可验证的后续结果。

## 6.7 Collection API

Collection API 是全局 API & SDK 工作区的 Collection 过滤视图。保留当前 Collection，并跳转到对应 endpoint、示例、文档或调试表单。Realtime 订阅作为该 Collection 的接口能力在 Collection API 内展示（订阅事件、示例与连接说明）；Connect / API 只保留全局 Realtime 文档入口，不重复连接配置。

# 7. Connect — API & SDK

## 7.1 页面结构

页面任务：**找到应用调用方式，验证一次真实请求，并把正确配置带回应用。**

~~~text
API & SDK
Base URL [复制]

Endpoints                 Request workspace
GET /api/collections/...  Method / Path
POST /api/collections/... Headers / Params / Body
                           [ Run request ]
                           Response
                           Status · Duration · Request ID
~~~

- Endpoint 列表按 Collection 与行为浏览，不要求用户从原始 OpenAPI JSON 开始。
- 请求工作区显示方法、路径、必需参数、认证要求和可编辑请求体。
- 可复制 Base URL、示例命令、请求体和响应；Copy 成功在控件自身反馈。
- 运行后固定展示状态码、耗时和 Request ID。错误保留结构化 code 与可读解释。
- `View request` 打开相同 Request Detail，并保留回到 Runner 的上下文。
- OpenAPI 展示、复制或下载使用当前 Runtime 实际暴露的 Contract。
- SDK 页面选择受支持的 SDK 目标，提供生成产物、安装步骤、首个请求和兼容性信息。`modelry generate` 指引来自真实 CLI，不显示虚构的生成结果。
- API Key 值不在此页面反复暴露；需要身份时链接到对应身份详情。

# 8. Automate — Hooks 与自动化

Automations 汇总生命周期 Hook 和 HTTP / Cron 投递工作，但清楚区分代码扩展、事件触发、定时任务与外部投递事实。

页面子页：`Hooks`、`Webhooks`、`Triggers`、`Schedules`、`Delivery history`。

- Hook 页说明触发事件、脚本、配置状态和最近运行结果。Secrets 在需要时以受控链接进入管理；页面不输出 Secret 值。
- Webhook 配置页显示目标 URL、事件范围、启停和投递状态，不把外部投递描述成 SQLite 事务回滚。
- Event Trigger 明确显示 Collection 事件和目标 Webhook。
- Schedule 显示 Cron、时区（UTC）和下一次运行时间。
- Delivery history 支持按目标、状态和时间检索；失败条目提供响应摘要、重试状态、关联 Request / Activity 与当前恢复动作。
- 任何实际重试都展示投递副作用事实和新的尝试记录；重复投递不能伪装成恰好一次。
- 没有配置时分别提供能完成初始化的主操作，不用单一“Add integration”掩盖配置对象差异。

# 9. Observe — Requests、Activity、Audit 与 Runtime

## 9.1 Requests

Requests 是应用 HTTP 请求日志，围绕诊断一次应用调用设计。

- 列表可按请求 ID、Collection、endpoint、method、status、认证结果、授权结果、错误码和时间筛选。
- 结果列展示时间、方法/路径、状态、耗时、Collection 和 requestId。
- 详情展示请求元数据、结构化响应错误和安全范围内的认证 / 授权结果。
- 禁止显示 Raw Credential、完整 Authorization Header、Full Request Body、Full Response Body 或无限制 Raw Header / Query values。
- API Runner 的失败必须使用同一个 Request ID 直接打开详情。
- 详情展示字段使用显式 allowlist：requestId、时间、method、path、status、耗时、错误码、Collection、认证结果（是否通过与主体类型）、授权结果（是否通过与拒绝原因码）、User-Agent 摘要。未列入 allowlist 的字段一律不展示；新增展示字段必须先更新本清单。

## 9.2 Activity & Audit

Activity 展示各子系统有界的用户可见操作和操作结果；Audit 展示管理面安全事实。通过同一页面容器的本地页签切换，或由 URL 明确分开的子页呈现，不把两类记录混成一个不可解释的 Feed。

两者支持按 Actor、Action、Resource、Result 与时间过滤。字段映射为 Owner、Administrator、Service Account 等产品术语。原始身份标识可在技术详情中查看。

## 9.3 状态与诊断

Runtime、Database、File Storage 各自报告 Ready、Degraded、Unavailable 或 Unknown，并显示最近检查时间和下一步操作。

Settings → Status 是诊断详情和刷新入口；顶栏状态负责快速发现并直达详情。健康页不以颜色单独表达状态，也不把检查失败显示为正常。

# 10. Evolve — Changes 与 Model Health

## 10.1 Changes 列表

Changes 回答：**有哪些模型变化还没完成、哪些需要我复核、历史结果是什么？**

~~~text
Changes
Pending changes (2)          Applied history

Collection   Summary                     Status           Updated
posts        Add publishedAt              Ready            2 min ago
users        Remove legacyRole            Needs review     1 hour ago

[ Review and apply changes ]
~~~

待应用变化按 Collection 聚合，显示业务变化摘要、更新时间和 Ready / Needs review / Failed。用户界面不要求理解 ChangeSet 或 Apply Attempt。

## 10.2 Change Review 与 Apply

- Review 在相同 Collection 上下文中展示字段、关系和索引的 before / after 差异。
- 运行时返回的 Risk、Preconditions 和 Impact 以用户可理解语言显示；Technical details 折叠提供原始契约信息。
- SAFE 变化直接提供 Apply，不增加空确认步骤。
- 需要复核的风险变化明确说明受影响数据、不可逆影响和可用恢复方式，在页面中确认。
- Apply 期间显示可访问的进度状态并锁定重复提交。
- 成功后当前页面保留应用结果、实际变化和 Applied history 链接。
- 失败后同时显示最新状态、失败原因、是否产生耐久副作用及恢复操作。Retry 会成为新的运行时尝试记录。
- Discard 只允许针对尚未应用的 pending operation，并说明会删除哪些已保存操作。

## 10.3 Applied history 与 Model health

Applied history 展示已应用变更事实。Migration ID、Change ID、Ledger 等实现信息只进入 Technical details。

Model health 展示 Drift 检查结果、对比范围和实际支持的校准 / 恢复动作。未知或部分不可读的状态写成 Unknown / Unavailable，不用“0 differences”代替检查失败。

# 11. Project — Access & keys 与 Settings

## 11.1 Access & keys

Project access 只管理 Modelry 管理面身份与权限，不管理 Collection 的 Application Access Rules。

页面切换：`Service Accounts`、`Administrators`。Audit 记录在 Observe 中，相关详情可从身份动作进入。

Service Account 创建一次完成名称、说明和 Permission。默认创建 API Key，提交后只显示一次明文；之后只展示 Key metadata、创建时间、末次使用及状态。创建结果保留在 Service Account Detail，包含复制状态和 MCP 接入说明。

权限使用 Full access、Read only、Custom 等产品语言。权限详情明确列出可执行操作；不向用户暴露 Principal / Capability 图。

Disable Service Account、撤销 API Key 和移除 Administrator 使用确认 Dialog，写出对象名称和影响。Admin 权限仍由服务端执行检查。

## 11.2 Settings

Settings 按用户要完成的设置任务组织：

~~~text
Project status
Runtime

Data and files
Files & Storage
Data import / export
Backup & restore

Service configuration
Mail
Secrets

Project data
Data import / export
Backup & restore
~~~

- Runtime settings 只编辑真实支持字段，标明来源以及变更何时生效；需重启的设置先持久化并明确显示 restart required。
- Files & Storage 显示当前提供方、容量/健康信息和支持的提供方迁移流程。
- Mail 显示实际配置与通知验证结果。
- Secrets 只显示名称、用途、元信息与状态，不回显明文。
- Data import / export 处理 Collection NDJSON，显示目标 Collection、校验结果和实际导入/导出结果。
- Backup & restore 显示已有备份事实、创建操作、恢复预检和 CLI 恢复步骤。历史 `/settings/portability` 继续打开此页。
- API Contract / SDK 与 MCP 统一进入 Connect，避免在 Settings 复制一份开发者接口页面。
- Activity、Drift、Admin 身份和 Service Account 不以旧式单页设置清单重复出现。

# 12. 全局操作与文案规则

## 12.1 Command Search

`⌘K`（macOS）和 `Ctrl+K`（Windows/Linux）打开全局命令搜索。它检索当前用户可见的导航、命令和近期 Collection，不搜索后台全部记录。

支持方向键、Enter、Escape 和关闭后的焦点返回。命令按当前权限、页面和资源上下文显示；服务端仍是授权权威。无实现能力没有占位命令。

## 12.2 术语

界面使用稳定、普通开发者能理解的产品用语：

| 内部领域名 | 界面用语 |
| --- | --- |
| ChangeSet | Pending change / 待应用变更 |
| Apply Attempt | Apply details / 应用详情 |
| Migration | Applied change / 已应用变更；原始 ID 进入技术详情 |
| Principal | Owner、Administrator、Service Account、App user |
| Capability | Permission / 权限 |
| Credential | Password、API Key、Session |
| Policy | Access rule / 访问规则 |
| Collection | Collection / 集合（随 locale 展示） |
| Record | Record / 记录（随 locale 展示） |

API、数据库、Runtime 里的稳定标识、Collection 名称、字段名、ID 和服务端错误码不翻译。错误码可映射到本地化的恢复说明。

## 12.3 写作规则

- 页面标题说明任务或对象，副标题说明用户能在此完成什么。
- Primary Action 使用动作 + 对象，如 `Create Collection`、`Run request`、`Apply changes`。
- 表单每个输入都有可见 Label、持久说明（复杂字段）、Required 标记和字段级错误。
- 成功文案写出已完成的持久结果；Toast 仅用于补充。
- 失败文案依次说明发生了什么、可能原因、是否保存了变化、可执行的下一步。
- 避免“Something went wrong”“Success!”等脱离对象的消息。
- 除运行时原始错误详情外，不把内部包、SQL、表名或 SQLite 实现词汇作为主文案。

## 12.4 语言与主题

- 提供 English 与简体中文。首次加载优先使用已保存选择；没有选择时匹配支持的浏览器 locale，不支持的 locale 回退 English。
- 用户切换语言后立即生效，不重载页面，不修改 pathname、query、hash 或正在查看的资源。
- 数字、日期、时间和相对时间使用共享 locale-aware formatter。用户数据、Collection / Field 名称、ID 和 API 标识不翻译。
- 提供 Light / Dark 主题，第一次使用可跟随系统偏好；用户明确选择后持久化并覆盖系统偏好。
- 语言和主题控件在窄屏上仍可找到，键盘可操作，并具有准确的可访问名称。

# 13. 共享交互模式

## 13.1 Primary Action

每个页面只有一个视觉 Primary Action。次要动作放在工具栏、行菜单、详情页或低强调按钮中。删除、撤销、恢复等破坏性动作不使用 Primary 样式。

## 13.2 工作面

- **页面：** 列表、长表单、Model Review、诊断和需要长期阅读的内容。
- **侧栏面板：** 短详情、快速编辑和保留列表上下文的 Record 详情。
- **宽面板：** Record 编辑、复杂 Field 编辑等需要完整输入宽度的内容。
- **Dialog：** Delete、Revoke、Disable、明确的风险确认和离开未保存本地表单。
- **Split view：** Endpoint 列表与 Runner / Detail 等需要持续切换的工作区。

长表单和长期编辑不能放进窄 Modal。关闭 Panel / Dialog 后焦点返回触发控件。

## 13.3 Form

- 表单控件采用 shadcn/ui 的 Label、Input、Textarea、Select、Checkbox、Switch 等组件，并通过共享 Form / Field 组合表达标签、帮助文本、必填、禁用和错误状态。
- 保存前反馈为本地校验；服务端校验在相应字段旁说明。
- 保存中禁用重复提交并给出进度。
- 失败保留用户输入，focus 到第一处错误字段并关联 `aria-describedby`。
- 禁用态给出原因；不能操作的原因不可只用 tooltip 隐藏。
- 清空、撤销与破坏性结果明确区分。

## 13.4 Table 与结构化结果

- 结构化记录使用 shadcn/ui Table 组合和语义化 HTML Table，行操作使用 shadcn/ui Dropdown Menu 等可访问菜单组件。
- Sorting、Filter、Empty、Loading、Error、Pagination 和 context restore 共享一致模式。
- 无批量操作时不显示行选择框。
- 长文本优先换行；截断时提供可键盘访问的完整内容。
- JSON、Diff、API Request / Response 使用统一结构化查看器，提供格式化、折叠、复制和按需搜索。
- 复制值后在原控件显示 `Copied`，不额外抢焦点或重复 Toast。

## 13.5 状态徽标

状态必须包含文本标签，必要时加图标。颜色只作辅助。使用有限状态：Ready、Needs review、Running、Failed、Unavailable、Unknown、Applied、Disabled 等；不发明相近但含义不同的自由文本状态。

# 14. 页面状态、反馈与恢复

每个主要工作区定义并实现：

- Initial loading；
- Empty；
- Ready；
- Partial data；
- Error；
- Permission denied；
- Mutation in progress；
- Durable success；
- Recovery required。

Partial data 保留成功部分，明确标记不可用部分并提供 Retry。Error 至少回答：

1. 哪一步失败；
2. 失败原因或可以确认的事实；
3. 是否已经产生 Durable Side Effect；
4. 当前服务端记录的最终状态；
5. 用户可以执行的恢复动作及入口。

Mutation 默认等待服务端权威结果。Pending / Applied / Failed 状态以 Runtime 响应为准，不基于乐观 UI 推断成功。重试前显示是否会重复外部副作用。

# 15. URL、返回路径与兼容

可共享或可恢复的状态进入 URL：

- 当前 Collection 和子页；
- Search、Filter、Sort、Page / Cursor；
- 当前选中的 Record、Request、Change、Audit record；
- API endpoint 与 Runner 结果上下文；
- 当前明确可分享的本地页签。

浏览器 Back 尽量恢复原列表筛选和滚动位置。切换到无关主导航时清除不相关 query，但不得丢弃可分享的 resource identity。

旧稳定深链接继续打开同一产品对象，并映射到新导航：

- `/extensions` → Automations / Hooks；
- `/extensions/:extensionId` → Automations / 对应 Hook 详情；
- `/automations` → Automations；
- `/activity` → Activity；
- `/requests/:requestId` → Requests / 同一 Request Detail；
- `/changes` → Changes；
- `/access`、`/administrators` → Access & keys 中对应身份；
- `/access/audit` → Activity & Audit / Audit；
- `/access/audit/:auditRecordId` → Activity & Audit / 对应 Audit 详情；
- `/secrets` → Settings / Secrets；
- `/settings/portability`、`/settings/backups` → Settings / Backup & restore；
- `/settings/data` → Settings / Data import & export；
- `/settings/developer` → Connect / SDK & Contract；
- `/settings/mcp` → Connect / MCP；
- `/settings/drift` → Model health；
- `/settings/runtime` → Settings / Runtime；
- `/settings/storage` → Settings / Files & Storage；
- `/settings/mail` → Settings / Mail；
- `/settings` → Settings；
- `/api` → Connect / API；
- `/collections/new` → Create Collection；
- `/collections/:collectionId` → 对应 Collection / Records；
- `/collections/:collectionId/schema` → 对应 Collection / Model；
- `/collections/:collectionId/security` → 对应 Collection / Access；
- `/collections/:collectionId/api` → 对应 Collection / API；
- 既有 Collection、Schema、Security、API 和 Record 深链接保留资源与页面上下文。

路由映射不得更改 Admin HTTP Contract，也不得丢弃登录前的安全站内 return path。

旧路径映射实现为独立的纯函数路由映射模块，并配套覆盖每一行的单元测试。该模块不依赖任何新页面完成，属于重建的首批交付，保证重建期间既有书签与文档链接持续可用。

# 16. Responsive、键盘与无障碍

## 16.1 断点与空间

- 1440 px 是桌面主设计基准；1280 px 保持完整可用；1920 px 使用限制内容最大宽度的主画布。
- 1024 px 下导航收窄，主工作区保持可操作。
- 768 px 以下全局导航折叠为明确的导航抽屉，集合内子页转为滚动标签或选择器。
- 390 px 手机宽度下不出现页面横向滚动。表单单列；Record / Field 编辑占用全屏工作面；表格允许可辨认的局部横向滚动并固定标识列。
- 全部触控目标至少 44 × 44 CSS px；相邻动作留足间距。
- Sticky header、导航抽屉、Panel 和提示条不能遮住键盘焦点。
- 异步列表预留标题和内容位置；Loading 不引起布局跳动。长列表使用分页或游标，不在单页一次渲染全部记录。
- 加载指示匹配真实等待时长：短操作不闪烁，较长操作使用保留空间的 Skeleton 或具名进度状态。

## 16.2 键盘与读屏

- Tab 顺序跟随视觉顺序，所有可操作元素都有可见焦点。
- `Enter` 仅提交预期的简单表单；长表单可用 `Cmd/Ctrl + Enter`。
- `Escape` 在不会丢失耐久状态时关闭层；破坏性流程不能被无意 Escape 提交。
- Sheet / Dialog 管理焦点陷阱、焦点返回和标题关联。
- 状态变更使用最少数量的 live region；状态文本完整，不逐字打断读屏。
- 图标按钮有稳定可访问名称；装饰图标从读屏树隐藏。
- 文字/背景对比目标 WCAG 2.2 AA；键盘焦点可见且不被遮盖；减少动态效果遵循 `prefers-reduced-motion`。

# 17. 新视觉系统

## 17.1 方向

新版方向命名为 **Quiet Mono（黑白灰开发工作台）**：以高对比黑、白和中性灰建立层级，用留白、字重和细边界表达结构。配色参考 shadcn/ui 官方 `neutral` 基色和语义 CSS 变量约定，明暗主题使用同一组语义 Token 成对映射。

视觉规则：

- Light 使用纯白画布、近黑正文与浅灰分隔；Dark 使用近黑画布、近白正文、炭灰表面与低对比边界。
- 主按钮和选中项使用黑白反差：Light 为近黑底/近白字，Dark 为近白底/近黑字。
- 导航选中、hover、secondary surface、input 和分隔线全部使用中性灰，不增加品牌色强调。
- Ready、Applied、Warning 等状态以中性色背景、图标和文字标签表达；危险操作及明确错误使用 shadcn `destructive` 语义色。
- 以字重、留白、对齐和边界建立信息层次，不依赖卡片阴影。
- 避免大面积渐变、玻璃模糊、彩色发光、扫描线、数字跳动和装饰动画。
- 标题和说明以可读 Sans 为主；代码、路径、ID、时间、API 示例采用等宽字。
- Lucide SVG 使用统一描边；不用 Emoji 充当交互图标。
- 视觉基准（2026-09-29 确认）：以 [ui.shadcn.com](https://ui.shadcn.com/) 官方站点实际使用的 Light / Dark 主题为准；第 17.2 节 Token 表即该主题的 neutral 基线，实现时以站点渲染效果做像素级对照，不引入额外品牌色。重建方式确认为整体重建，不逐页沿用旧版实现。

## 17.2 Token 基线

`components.json` 使用 `baseColor: neutral` 和 CSS variable theming。以下值采用 [shadcn/ui 官方 neutral 默认主题](https://ui.shadcn.com/docs/theming) 的语义变量；组件通过 `background`、`primary`、`muted`、`border`、`ring` 等语义名取色，不在业务组件中写 Hex / OKLCH。

| shadcn Token | Light | Dark |
| --- | --- | --- |
| `background` | `oklch(1 0 0)` | `oklch(0.145 0 0)` |
| `foreground` | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` |
| `card` / `popover` | `oklch(1 0 0)` | `oklch(0.205 0 0)` |
| `card-foreground` / `popover-foreground` | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` |
| `primary` | `oklch(0.205 0 0)` | `oklch(0.922 0 0)` |
| `primary-foreground` | `oklch(0.985 0 0)` | `oklch(0.205 0 0)` |
| `secondary` / `muted` / `accent` | `oklch(0.97 0 0)` | `oklch(0.269 0 0)` |
| `secondary-foreground` / `accent-foreground` | `oklch(0.205 0 0)` | `oklch(0.985 0 0)` |
| `muted-foreground` | `oklch(0.556 0 0)` | `oklch(0.708 0 0)` |
| `border` | `oklch(0.922 0 0)` | `oklch(1 0 0 / 10%)` |
| `input` | `oklch(0.922 0 0)` | `oklch(1 0 0 / 15%)` |
| `ring` | `oklch(0.708 0 0)` | `oklch(0.556 0 0)` |
| `sidebar` | `oklch(0.985 0 0)` | `oklch(0.205 0 0)` |
| `sidebar-foreground` | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` |
| `sidebar-accent` | `oklch(0.97 0 0)` | `oklch(0.269 0 0)` |
| `destructive` | `oklch(0.577 0.245 27.325)` | `oklch(0.704 0.191 22.216)` |

成功、警告、信息不新增彩色品牌 Token；它们使用中性色表面和前景，配合状态文字/图标。只有破坏性操作和错误使用 `destructive` 色。实现时仍须验证完整前景/背景组合符合 WCAG 2.2 AA。

## 17.3 字体、间距与动效

- UI 字体：IBM Plex Sans；若离线/自托管无法加载外部字体，使用随应用打包的本地字体与系统回退，不在运行时依赖 Google Fonts。IBM Plex Sans 不含中文字形，中文回退栈显式定义为系统 CJK 字体（如 PingFang SC、Microsoft YaHei），避免中英混排基线与字重静默失控。
- Code 字体：JetBrains Mono；仅用于 API、字段标识、路径、ID 和技术详情。
- 字号层级：12 / 14 / 16 / 18 / 24 / 32 px；普通正文以 16 px 为基准，辅助标签不低于 12 px，窄屏常规正文为 16 px。
- 间距基于 4 px 单位，常用 8 / 12 / 16 / 24 / 32 px。
- 表面只使用少数一致圆角与一层轻微阴影；列表和工作区以分隔线构建结构。
- 页面内容更换不做入场动画；Panel 使用轻微透明度/位移表示来源，短状态变化快速完成且可打断。
- 所有非必要动效服从 `prefers-reduced-motion`，动效不是状态正确性的前置条件。

## 17.4 组件实现边界

shadcn/ui 是 Admin 唯一的通用 UI 组件体系，作为明确的实现框架使用；不得另建一套与 shadcn/ui 并行的 CSS 组件库。实现基线保持：

~~~text
React + TypeScript + Vite
→ Modelry Design System
→ shadcn/ui
→ Base UI
→ Tailwind CSS v4
~~~

实现约束：

- 通用组件从 `admin/src/components/ui` 导入和复用，遵循仓库 `admin/components.json` 的 shadcn/ui 配置（Base UI、`base-nova`、`neutral`、CSS variables）。组件样式使用第 17.2 节语义 Token。
- Button、Badge、Input、Textarea、Label、Select、Checkbox、Switch、Table、Tabs、Dialog、Alert Dialog、Sheet、Dropdown Menu、Popover、Tooltip、Skeleton 等通用控件及其交互状态，必须使用 shadcn/ui 对应组件与变体组合；禁止用裸 HTML + 手写 CSS 重造一套按钮、字段、徽标、表格、菜单或弹层。
- Tailwind CSS v4 用于页面布局、响应式排布和 shadcn/ui 组件组合；不得借助页面 CSS 或散落的 utility class 另行定义通用控件的视觉、焦点、禁用、错误、悬停和弹出层行为。
- 新增通用组件先检查 shadcn/ui 可用组件并通过兼容的 shadcn/ui registry / CLI 纳入 `components/ui`。确无对应组件时，在同一目录扩展现有组件和变体，沿用 Base UI 原语、语义 Token 与统一调用接口；不得引入第二套组件库或另设样式体系。
- 业务组件可以组合 `components/ui` 中的控件来承载 Modelry 专属语义和流程；页面级 CSS 仅负责独有的结构布局，不能复制通用组件的样式与交互实现。
- 按钮、状态徽标、表单字段、表格、加载/空/错误状态、Dialog 和 Sheet 使用统一组件接口。既有页面迁移时复用这些 shadcn/ui 组件，并清理被替代的旧控件样式。

# 18. 真实浏览器验收

核心页面验收使用真实 Runtime、SQLite、HTTP、Admin 和 Chromium。验收业务耐久状态、HTTP 事实和跨页面结果；无 Mock Backend 替代核心流程。

第 18 节的各闭环在重建动工前先实现为针对现有 Admin 的 Playwright e2e 用例，作为重建期间的持续回归基线；对应新页面或新流程以相关用例全部通过为完成标准。

## 18.1 首次可用后端

~~~text
空 Project Root 启动
→ Owner 初始化
→ 创建 Normal Collection 和字段
→ 创建 Record
→ 刷新后记录仍在
→ 从 Collection API 发出真实请求
→ Requests 中打开同一 requestId
~~~

## 18.2 Access 闭环

~~~text
创建 Auth Collection
→ 创建 App user + Password
→ 关闭默认注册时确认匿名创建被拒绝
→ 配置规则并模拟
→ 登录 / 查看 Session
→ 撤销 Session
→ 验证后续应用访问拒绝
→ 查看对应 Audit fact
~~~

## 18.3 Model Changes 闭环

~~~text
增加 Field
→ 保存成 durable pending change
→ 切换页 / 刷新后仍可见
→ Review 差异和 Runtime Risk
→ Apply
→ 查看 Record/API 结果
→ 重启 Runtime
→ Applied history 仍可验证
~~~

另覆盖失败应用、恢复与新 Retry Attempt 的事实。

## 18.4 API 与观察闭环

~~~text
Run API request
→ 显示 Status / Duration / requestId
→ View request
→ Request Detail 对应同一 ID 和错误码
→ 返回 Runner 保留 endpoint 和输入
~~~

## 18.5 Automation 与身份

- 配置 Hook Secret 后只查看 metadata，不回显明文；验证 Hook 运行结果。
- 配置 Event Trigger / Schedule，查看真实 Delivery history、失败原因、重试与外部副作用状态。
- 创建 Service Account 和 API Key；明文只显示一次，刷新后只显示 metadata。
- 使用 Service Account 权限调用 MCP 可用能力；越权动作仍被服务端拒绝并记录事实。

## 18.6 Shell 与视觉验收

- 浏览器刷新、返回、深链接和 locale/theme preference 保持；
- Light / Dark 的真实 Token 对比通过 WCAG 2.2 AA 检查；
- 对比度验证由自动化 Token 对比测试持续执行（沿用并扩展现有 contrast 测试），不依赖人工抽查；
- 390 / 768 / 1024 / 1440 px 下不丢失主动作与资源上下文；
- 每个流程均可纯键盘完成，Panel/Dialog 关闭后焦点正确返回；
- 无遮挡焦点、控制台异常、未处理页面错误、意外 5xx、失败请求或卡住的 Loading；
- 简体中文和 English 覆盖全部共享 Shell、关键页面、表单错误和恢复消息。

# 19. 完成标准

新版 Admin 交付必须同时满足：

- 工作顺序可从 Home 连续走到第一条真实 API 请求；
- 建模、访问控制、API、自动化、观察和变更演进入口由开发者任务组织；
- 空项目第一步明确，正常状态下 Home 不变成无意义中转页；
- 每项主要操作的成功结果耐久、就地可见且可通过第二观察面验证；
- SAFE 模型变化不需要多余确认，真实高风险变化说明影响并由 Runtime 权威判定；
- 表单、表格、Sheet、Dialog、错误、部分状态、复制和状态反馈遵守共享模式；
- Owner、Administrator、Service Account、App user 身份边界清楚；
- 现有已交付 V0.1.x 页面都有新导航入口，不存在 Placeholder Action；
- 当前 Admin HTTP Contract、CLI、MCP 和业务流程保持不变；
- 旧深链接映射到新信息架构并保留 resource/query context；
- Light / Dark、English / Simplified Chinese、响应式和 WCAG 2.2 AA 验收通过；
- 完成第 18 节真实浏览器的业务闭环与耐久性验收。
