# Modelry 产品体验与验收标准

## 目的

Modelry 最核心的要求是产品化。

技术行为正确，但用户找不到入口、不理解状态、需要反复跳页、无法恢复错误，仍然不算完成。

本文件定义跨页面体验、Design System 和验收原则。

Exact Sidebar、Collection Workspace 与具体页面结构只由 docs/specs/0001-admin-product-ux-spec.md 定义。

# 产品体验规则

## 1. 一个页面解决一个主要用户问题

页面必须有明确用户任务。

不要因为底层存在一个 Domain Object 就自动为它创建一级页面。

## 2. 一个工作面一个明显 Primary Action

Secondary Action 进入：

- row action
- contextual action
- secondary toolbar
- overflow

## 3. 优先减少用户步骤

每个流程都必须问：

> 当前 N 步能否在保持正确性和安全性的前提下变成 N-1 步？

典型要求：

- 创建对象时一起完成必要初始化；
- 简单配置原地完成；
- API Error 一键进入对应 Request Detail；
- Service Account 创建时默认同时创建 API Key；
- Auth User 创建时同时创建 Profile Record 与 Password Credential；
- 首次 Bootstrap 后直接进入 Create Collection。

## 4. Domain Language 不等于 UI Language

统一 Mapping：

~~~text
Domain / Runtime      Product UI

ChangeSet             Pending change
Apply Attempt         Apply details / Previous attempt
Migration             Applied change / Technical details
Principal             Owner / Administrator / Service account / App user
Capability            Permission
Credential            Password / API key / Session
Policy                Access rule
~~~

内部对象可以存在，但普通用户不需要先学习它们。

## 5. Durable Result，不接受 Toast-only Success

Mutation 成功后，Durable Result 必须继续存在于当前 Context。

Toast 只能作为补充。

## 6. Pending 不等于 Unsaved

Schema 中：

~~~text
Editor local form
→ not yet saved pending operation
~~~

离开编辑器时可触发 Unsaved Protection。

但：

~~~text
saved pending operation
→ durable pending change
~~~

切换页面、刷新、重新登录都不能丢失。

UI 应显示：

~~~text
3 pending changes
~~~

而不是：

~~~text
3 unsaved changes
~~~

## 7. Error 必须可行动

至少回答：

- 什么失败？
- 为什么？
- 是否产生 Durable Side Effect？
- 当前状态是什么？
- 下一步做什么？
- 去哪里恢复？

## 8. Destructive Action 默认安全

Risk 由 Runtime 计算。

SAFE 不增加无意义确认。

Risk / Destructive Change 在当前业务 Context 中 Review / Confirm。

## 9. Progressive Complexity

普通用户不需要理解：

- SQLite WAL
- Physical Migration Internals
- Principal Type
- Capability Graph
- Internal Ledger
- ChangeSet Object Model

高级信息进入 Technical Details / Diagnostics。

# 视觉与 Design System Contract

固定实现关系：

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

## Semantic Tokens

至少定义：

- surface
- surface-subtle
- border
- text
- text-muted
- primary
- success
- warning
- danger
- focus

Light / Dark 使用同一 semantic token contract。

## Density

V0.1 组件支持：

- Standard
- Compact Table

不需要给用户做 Density 设置。

## Form Pattern

统一包含：

- Label
- Description when useful
- Control
- Required state
- Inline validation
- Server error
- Disabled reason

提交失败后 focus 第一处 invalid field。

## Table Pattern

统一：

- header
- sorting
- filtering
- empty
- loading
- error
- row action
- pagination / cursor
- truncation
- copyable stable ID
- context preservation

无 Bulk Action 时不展示 Row Selection。

## Surface Boundary

~~~text
Standard Sheet
→ short detail / short form

Wide Sheet
→ record / complex field

Focused Workspace
→ Create Collection / long-form task

Split Pane
→ list + persistent inspect workflow

Dialog
→ destructive / revoke / disable / unsaved local form
~~~

复杂长期编辑器禁止放进窄 Modal。

## Feedback

默认：

~~~text
Local form edit
→ immediate local feedback

Durable mutation
→ pessimistic by default

Success
→ durable result in context

Toast
→ supplementary

Failure
→ inline actionable error
~~~

## Keyboard

至少支持：

- Tab / Shift+Tab
- Enter for expected simple form action
- Escape where safe
- Cmd/Ctrl + Enter for explicit submit where appropriate
- focus return after Sheet / Dialog
- safe destructive confirmation focus

## Accessibility

目标：**WCAG 2.2 AA**

至少覆盖：

- semantic controls
- keyboard
- visible focus
- contrast
- screen-reader labels
- status announcements
- reduced motion

## URL State / Deep Link

适合共享和返回恢复的状态进入 URL：

- local tab
- filter
- sort
- page / cursor where reasonable
- selected resource
- detail / sheet identity

Browser Back 必须尽可能恢复列表 Context。

## JSON / Structured Data

API、Diff、Debug Surface 共用 Structured Viewer：

- formatted
- collapse
- copy
- wrap
- search when useful

不要每个页面自行使用 Raw pre。

## Copy Interaction

普通 Copy：

~~~text
Copy
→ Copied state
~~~

不需要成功 Toast。

API Key one-time reveal 是单独 Security Flow。

# State Ownership

- Server State → Query / Cache
- Form State → Form Library + Validation Schema
- URL State → navigation / filter / deep-link
- Local UI State → transient presentation

不要因为方便把所有状态放进 Global Store。

# Product Definition of Done

每个用户可见能力必须满足：

### Functional Closure
真实 Runtime 行为正确。

### UX Closure
路径连续、默认值合理、步骤足够少。

### Visual Closure
遵守统一 Design System 与 Information Hierarchy。

### Error Closure
主要失败模式可理解、可恢复。

### Business Flow Closure
能够完成真实任务，并从第二观察面验证 Durable Result。

# Browser Acceptance

Mandatory Acceptance 使用：

~~~text
Real Runtime
+
Real SQLite
+
Real HTTP
+
Real Admin
+
Real Chromium
~~~

禁止用 Mock Backend 代替核心闭环。

至少验证：

### Create Record

~~~text
Create
→ Row appears
→ Detail correct
→ API correct
→ Reload persists
~~~

### Apply Schema Change

~~~text
Pending changes
→ Apply
→ Schema changes
→ Applied History exists
→ Restart persists
~~~

### Revoke Application Session

~~~text
Revoke
→ Session shows Revoked
→ subsequent app access fails
→ Audit fact exists
~~~

### API Error

~~~text
Run request
→ structured error + requestId
→ View request details
→ same request opens directly
~~~

# Browser Health Gate

Mandatory Flow 遇到以下情况直接失败：

- Unexpected Console Error
- Page Exception
- Unexpected 5xx
- Broken Navigation
- Stuck Loading
- Unhandled Network Failure

API Test Passed 不能代替 Product Acceptance。
