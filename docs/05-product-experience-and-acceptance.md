# Modelry 产品体验与验收标准

## 目的

Modelry 最核心的要求是产品化。

技术行为正确，但用户找不到入口、不理解状态、需要反复跳页、无法恢复错误，仍然不算完成。

本文件定义跨页面体验、状态、可访问性和真实验收原则，不定义新前端的具体页面、导航、视觉和组件布局。

新前端的页面、信息架构、视觉、组件组合和交互唯一依据是：

- Figma：https://www.figma.com/design/WDn5msOTqcN4j6eEWBNjwM/modelry?node-id=0-1
- `docs/specs/0010-figma-frontend-rebuild.md`


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

具体位置和视觉形式以 Figma 为准。

## 3. 优先减少用户步骤

每个流程都必须问：

> 当前 N 步能否在保持正确性和安全性的前提下变成 N-1 步？

典型要求：

- 创建对象时一起完成必要初始化；
- 简单配置原地完成；
- API Error 一键进入对应 Request Detail；
- Service Account 创建时默认同时创建 API Key；
- Auth User 创建时同时创建 Profile Record 与 Password Credential；
- 首次 Bootstrap 后直接进入 Figma 设计的下一步。

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

UI 应显示明确的待处理变更数量和状态，不要将已保存的待应用变更描述为未保存表单。

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

Risk / Destructive Change 在当前业务 Context 中 Review / Confirm。确认交互以 Figma 为准。

## 9. Progressive Complexity

普通用户不需要理解：

- SQLite WAL
- Physical Migration Internals
- Principal Type
- Capability Graph
- Internal Ledger
- ChangeSet Object Model

高级信息进入 Technical Details / Diagnostics；没有出现在 Figma 中的技术工作台不应擅自增加。

# 视觉与组件使用规则

- 新前端只使用 Ant Design（`antd`）作为基础 UI 组件库。
- 不引入 shadcn/ui、Base UI、Mantine、Ant Design X 或其它 UI 组件库。
- 基础交互控件必须使用 Ant Design 对应组件，并通过统一 UI 出口和静态检查约束。
- Ant Design 默认主题不等于 Modelry 视觉；颜色、字体、间距、尺寸、边框、圆角、状态和亮暗主题均按 Figma 定制。
- Figma 的「界面控件与状态基线」画板是组件和状态验收参考。
- 自定义组件只负责产品特有的业务组合，不重复实现 Ant Design 已有的基础交互能力。
- 不以旧前端组件、旧 CSS、旧 Design Tokens 或旧 Surface 规则约束新前端。

## Form Pattern

统一包含：

- Label
- Description when useful
- Control
- Required state
- Inline validation
- Server error
- Disabled reason

提交失败后 focus 第一处 invalid field。具体控件、布局和反馈形式以 Figma 为准。

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

无 Bulk Action 时不展示 Row Selection。表格的列、密度、工具栏和操作位置以 Figma 为准。

## Surface Boundary

Card、Drawer、Modal、Popover、Split Pane、Focused Workspace 等具体表面类型和组合，全部按 Figma 实现。跨页面通用的安全和可用性要求不能成为偏离 Figma 的理由。

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
- focus return after overlay
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
- detail / overlay identity

Browser Back 必须尽可能恢复列表 Context。

## JSON / Structured Data

API、Diff、Debug Surface 共用 Structured Viewer：

- formatted
- collapse
- copy
- wrap
- search when useful

不要每个页面自行使用 Raw pre。展示形式按 Figma。

## Copy Interaction

普通 Copy：

~~~text
Copy
→ Copied state
~~~

不需要成功 Toast。

API Key one-time reveal 是单独 Security Flow。

# State Ownership

- Server State：使用明确的请求、缓存和刷新策略。
- Form State：由表单组件与校验规则管理。
- URL State：管理导航、筛选和深链接状态。
- Local UI State：只保存临时展示状态。

不要因为方便把所有状态放进 Global Store。不要将旧前端的状态管理库作为新前端的强制依赖。

# Product Definition of Done

每个用户可见能力必须满足：

### Functional Closure
真实 Runtime 行为正确。

### UX Closure
路径连续、默认值合理、步骤足够少。

### Visual Closure
遵守 Figma 的页面和视觉设计。

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
Real Frontend
+
Real Browser
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
