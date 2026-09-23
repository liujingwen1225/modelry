# Modelry 产品体验与验收标准

## 为什么需要这份文档

Modelry 最核心的要求是产品化。

一个技术正确的 Backend，如果用户：

- 找不到入口；
- 不理解状态；
- 不知道下一步；
- 出错后不会恢复；
- 无法完成完整业务闭环；

它仍然不是一个合格产品。

## 产品体验规则

### 1. 一个页面只解决一个主要问题

页面必须明确回答用户问题。

例如：

- **Overview**：Backend 是否健康？现在有什么需要处理？
- **Collections**：有哪些业务数据模型？
- **Records**：真实数据是什么？
- **Schema**：结构是什么？
- **Changes**：准备改什么？风险是什么？最终发生了什么？
- **API**：应用能调用什么？最近实际请求发生了什么？
- **Hooks**：有哪些扩展逻辑？是否健康？
- **Access**：谁可以管理 Modelry？发生过什么管理审计？
- **Activity**：当前有哪些运行事件值得处理？

### 2. 一个工作面只有一个明显 Primary Action

不要出现多个同等强调按钮。

Secondary Action 应进入：

- Context Menu
- Row Action
- Secondary Toolbar
- Overflow Menu

### 3. Common Path 默认简单

普通任务不应该要求用户先理解 Advanced Configuration。

高级能力采用 Progressive Disclosure。

### 4. Durable Result，不接受 Toast-only Success

Mutation 成功后，结果必须继续存在于当前 Context。

例如创建 Record 后，用户应立刻看到真实 Record。

Toast 只能作为瞬时反馈。

### 5. Error 必须可行动

Error 至少回答：

- 什么失败了？
- 为什么？
- 哪些状态受到影响？
- 是否已有部分数据写入？
- 用户下一步做什么？
- 去哪里恢复？

禁止只返回 Operation failed。

### 6. Destructive Action 默认安全

破坏性 Schema / Data / Runtime Operation 需要匹配风险级别的确认。

Risk 由 Runtime 计算，而不是用户选择。

### 7. Empty State 是产品教学

Empty State 应该：

- 解释当前页面用途；
- 告诉用户下一步；
- 提供一个明显 Primary Action。

不要只展示装饰插画或空表。

### 8. Progressive Complexity

普通用户不需要理解：

- SQLite WAL
- Physical Migration Internals
- Principal Type
- Event Durability
- Internal Ledger

才能完成普通业务操作。

这些信息只在 Advanced / Diagnostic Context 中出现。

## 视觉产品标准

Admin 必须有统一 Design System，至少覆盖：

- Typography
- Spacing
- Button
- Form
- Table
- Card
- Drawer / Sheet
- Dialog
- Tabs
- Status
- Empty State
- Error State
- Destructive Confirmation

禁止形成“工程后台感”：

- 不把 Metric Card 当成所有页面默认布局；
- 不在适合 Card Discovery 的场景强行使用 Dense Table；
- 不把 Raw ID / JSON 作为主要用户界面；
- 不允许每个模块创造自己的 Button / Dialog / Form 行为。

## 信息架构

一级导航：

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

Collection：

~~~text
Records
Schema
Policy
Auth
API
~~~

Schema：

~~~text
Fields
Relations
Indexes
~~~

## State Ownership

状态职责明确：

- **Server State**：Query / Cache Layer
- **Form State**：Form Library + Validation Schema
- **URL State**：Filter / Tab / Selection / Deep-link State
- **Local UI State**：纯瞬时 Presentation State

不要为了“方便”而把所有状态塞进 Global Store。

## Product Definition of Done

每个用户可见功能必须满足五个 Closure。

### Functional Closure

真实 Runtime 行为正确。

### UX Closure

用户工作流清晰、顺畅、可发现。

### Visual Closure

遵守统一 Design System 和 Information Hierarchy。

### Error Closure

主要失败模式有明确反馈和恢复路径。

### Business Flow Closure

用户能够完成真实任务，并从第二观察面验证 Durable Result。

## Browser Acceptance

Mandatory Acceptance 必须使用：

~~~text
Real Modelry Runtime
+
Real SQLite
+
Real HTTP
+
Real Admin UI
+
Real Chromium
~~~

核心产品闭环禁止依赖 Mock Backend。

## Cross-Surface Verification

### Create Record

~~~text
Create
→ Records 中出现
→ Detail 数据正确
→ API 查询正确
→ Reload 后仍存在
~~~

### Apply ChangeSet

~~~text
ChangeSet Applied
→ Apply Attempt Succeeded
→ Schema 改变
→ Migration History 更新
→ Restart 后仍保持
~~~

### Revoke Session

~~~text
Session 标记 revoked
→ Application 后续访问失败
→ Audit / Activity 可追踪
~~~

## Browser Health Gate

Mandatory Flow 遇到以下情况直接失败：

- Unexpected Console Error
- Page Exception
- Unexpected 5xx
- Broken Navigation
- Infinite / Stuck Loading
- Unhandled Network Failure

## Interaction Quality

Acceptance 还必须检查：

- Focus / Keyboard
- Loading State
- Disabled State
- Empty State
- Error State
- Primary Action 是否明显
- Layout 是否稳定
- 是否可能 Duplicate Submission
- Deep Link 是否正确

API Test Passed 不能代替 Product Acceptance。
