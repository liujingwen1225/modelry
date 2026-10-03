---
version: "0.1"
name: "Modelry Quiet Workbench"
description: >
  Modelry Admin 的视觉实现规范。它描述一个面向个人开发者与编码智能体的本地优先 Backend Workbench：
  连续画布、低装饰、高信息清晰度、代码与数据优先，以 neutral 黑白灰为主，仅保留有限状态色。
  本文件约束视觉语言、排版、密度、Surface、组件组合、响应式和交互反馈；不重新定义产品能力、
  信息架构、业务流程、HTTP Contract 或领域语义。

sources:
  product: "AGENTS.md + docs/00-product-vision.md"
  ux: "docs/specs/0001-admin-product-ux-spec.md"
  implementation: "admin/components.json + admin/src/components/ui/* + admin/src/styles/globals.css"
  inspiration: "VoltAgent/awesome-design-md（方法论参考；不复制任何单一品牌）"

colors:
  background: "oklch(1 0 0)"
  foreground: "oklch(0.145 0 0)"
  card: "oklch(1 0 0)"
  muted: "oklch(0.97 0 0)"
  muted-foreground: "oklch(0.556 0 0)"
  border: "oklch(0.922 0 0)"
  primary: "oklch(0.205 0 0)"
  primary-foreground: "oklch(0.985 0 0)"
  success: "oklch(0.527 0.154 150.069)"
  success-soft: "oklch(0.982 0.018 155.826)"
  warning: "oklch(0.555 0.163 48.998)"
  warning-soft: "oklch(0.987 0.022 95.277)"
  danger: "oklch(0.514 0.222 16.935)"
  danger-soft: "oklch(0.969 0.015 12.422)"
  info: "oklch(0.488 0.243 264.376)"
  info-soft: "oklch(0.97 0.014 254.604)"

typography:
  page-title:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.4px"
  section-title:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  body-comfortable:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.4
  metadata:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
  code:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55

rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  full: "9999px"

spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  xxl: "48px"

components:
  page-header:
    title: "{typography.page-title}"
    description: "{typography.body}"
    gap: "{spacing.xs}"
    bottomPadding: "{spacing.md}"
  section:
    title: "{typography.section-title}"
    gap: "{spacing.sm}"
    verticalGap: "{spacing.lg}"
  button-default:
    height: "40px"
    minHitTarget: "44px"
    rounded: "{rounded.md}"
    typography: "{typography.label}"
  button-compact:
    visualHeight: "32-36px"
    minHitTarget: "44px"
    rounded: "{rounded.sm}"
    typography: "{typography.label}"
  input:
    height: "40px"
    minHitTarget: "44px"
    rounded: "{rounded.sm}"
    typography: "{typography.body}"
  nav-row:
    visualHeight: "36-40px"
    minHitTarget: "44px"
    rounded: "{rounded.sm}"
    typography: "{typography.body}"
  table:
    header: "{typography.metadata}"
    body: "{typography.body}"
    rowMinHeight: "44px"
  status:
    typography: "{typography.metadata}"
    rounded: "{rounded.full}"
  surface-standard:
    background: "transparent or {colors.card}"
    border: "only when it creates a real boundary"
    shadow: "none"
    rounded: "{rounded.md}"
  surface-raised:
    background: "{colors.card}"
    border: "{colors.border}"
    shadow: "reserved for overlays and exceptional lifted context"
    rounded: "{rounded.lg}"

breakpoints:
  mobile: "390px"
  tablet: "768px"
  desktop: "1024px"
  canvas: "1440px"
---

# Modelry DESIGN.md

## 1. 作用与权威边界

本文件是 Modelry Admin 的**视觉实现规范**，供人类开发者、Codex 和其它编码智能体在实现或修改前端时共同遵循。

权威关系：

~~~text
产品定位 / 能力 / 业务语义
AGENTS.md + docs/00~06
        ↓
信息架构 / 页面职责 / 用户旅程 / 状态与 URL
docs/specs/0001-admin-product-ux-spec.md
        ↓
视觉语言 / 页面层级 / 排版 / 密度 / Surface / 组件组合
DESIGN.md
        ↓
通用交互原语
admin/src/components/ui/*
        ↓
Modelry 业务组件与页面
admin/src/*
~~~

规则：

- 如果本文件与 `Spec 0001` 在产品能力、IA、URL、业务流程上冲突，以 `Spec 0001` 为准。
- 如果页面实现与本文件在视觉层级、组件密度、Surface、排版或交互反馈上冲突，以本文件为准。
- `components/ui` 是实现原语，不允许页面绕过它重新建立第二套按钮、输入框、弹层、表格或状态样式。
- 本文件不把任何外部产品的设计当作 Modelry 的品牌规范。外部参考只用于提取方法，不进行像素级复制。

## 2. 设计方向：Quiet Workbench

Modelry 不是企业 Dashboard，也不是通用 Admin Template。

它是面向个人开发者、独立开发者和 Coding Agent 的本地优先 Backend Workbench。视觉必须支持以下心智：

- 我正在处理一个真实项目，而不是浏览管理报表；
- 数据、Schema、API、Hooks、任务、变更和访问规则是主要工作对象；
- 系统状态用于帮助继续工作，而不是占据页面；
- 代码、路径、ID、请求与结构化数据是第一等内容；
- 正常状态安静，异常状态清楚；
- 高频任务少跳转、少确认、少装饰。

一句话：

> **连续画布、低装饰、高信息清晰度、代码与数据优先。**

### 2.1 视觉关键词

- Quiet
- Technical
- Precise
- Local-first
- Dense but readable
- Neutral
- Durable
- Keyboard-friendly

### 2.2 非目标

不要把 Modelry 做成：

- KPI Dashboard；
- 企业治理控制台；
- 彩色 SaaS 后台；
- 大量卡片堆叠的 Admin Template；
- 依赖渐变、Glow、Glass、品牌插画的 Marketing UI；
- 为追求“紧凑”而使用 9–11px 正文和 30px 点击目标的界面。

## 3. 外部设计参考如何使用

`awesome-design-md` 用于学习“把视觉判断写成机器可执行上下文”的方法，而不是选择一个品牌直接复制。

Modelry 可以吸收：

- Vercel：neutral 层级、hairline、克制阴影、技术产品精确感；
- Supabase：Developer Console 的数据/API/代码优先与工作台密度；
- Ollama：低装饰、Flat Surface、让内容本身成为视觉主体；
- Cal.com：黑白主操作、清晰排版、现代 SaaS 的可读性；
- Resend：技术内容层级与代码表达。

Modelry 不采用：

- Vercel 的 Marketing 渐变；
- Supabase 的绿色品牌主色；
- Ollama 的全局 Pill 形状；
- Cal.com 的 Marketing Card 语言；
- Resend 的 Dark-first、Glow 和 Serif 品牌表达。

## 4. 颜色

### 4.1 Neutral First

默认界面只依赖 shadcn neutral 语义 Token：

- `background`
- `foreground`
- `card`
- `muted`
- `muted-foreground`
- `border`
- `input`
- `ring`
- `primary`
- `primary-foreground`
- `sidebar`
- `sidebar-accent`

业务组件禁止直接写 Hex / RGB / OKLCH 值。

### 4.2 有限状态色

彩色只用于四类状态语义：

| 语义 | Token | 示例 |
| --- | --- | --- |
| Ready / Applied / Succeeded | `success` | Runtime Ready、Applied Change |
| Needs review / Warning / Pending attention | `warning` | Pending Change、需要复核 |
| Failed / Error / Unavailable | `danger` | 请求失败、Webhook 失败 |
| Unknown / Informational | `info` | Unknown、Loading context、信息提示 |

约束：

- 状态色必须和**文本标签或图标**同时出现；
- 不允许只靠颜色表达状态；
- 不新增第五种业务状态色；
- 破坏性操作使用 shadcn `destructive`，不要拿 `danger` 状态红替代；
- 链接、CTA、导航选中不使用品牌蓝或品牌绿，继续使用 neutral 黑白反差。

### 4.3 Dark

Dark 与 Light 是同一设计语言的语义映射，不是另一套视觉主题。

Dark 中：

- 不增加 Glow；
- 不提高彩色饱和度作为装饰；
- Surface 主要依赖亮度差和 hairline；
- 仍保持正常状态低视觉权重。

## 5. Typography

### 5.1 字体

- UI：IBM Plex Sans；
- 中文回退：PingFang SC / Microsoft YaHei / 系统 CJK；
- Code：JetBrains Mono；
- 不在运行时依赖 Google Fonts；
- 不增加 Display Font 或品牌字体。

### 5.2 尺寸层级

默认只使用以下层级：

| 层级 | 推荐 | 用途 |
| --- | ---: | --- |
| Page title | 24px / 600 | 页面唯一 H1 |
| Section title | 16–18px / 600 | 页面主要分区 |
| Body comfortable | 16px / 400 | 说明性正文、首次引导 |
| Body / UI | 14px / 400–500 | 绝大多数控件和内容 |
| Label | 13px / 500 | 按钮、字段标签、紧凑导航 |
| Metadata | 12px / 400–500 | 时间、ID 附属信息、表头 |
| Code | 13px / mono | API、路径、ID、Schema、日志 |

**禁止在正常产品 UI 中使用小于 12px 的文字。**

例外仅限：

- 截图/图表中的非交互辅助标记；
- 明确的测试或开发可视化。

### 5.3 文案层级

不要依赖全大写 + 极小字号制造“专业感”。

导航分组可使用 uppercase，但必须 ≥12px，并保持低对比。

中英文切换后必须维持相同层级，不允许英文因为字宽较小而使用更小字号。

## 6. 布局

### 6.1 连续画布

页面默认是连续画布：

~~~text
Page Header
────────────────────────

Section

Section
────────────────────────

Section
~~~

不是：

~~~text
Card  Card  Card

Card  Card

Card
~~~

页面结构优先使用：

- whitespace；
- divider；
- alignment；
- typography；
- row / column；
- table / list；

最后才使用 Card。

### 6.2 页面最大宽度

- Admin 主画布上限：1440px；
- 表单/设置类页面应使用更窄阅读宽度；
- 结构化数据与 API 工作区可以使用完整主画布；
- 不因为屏幕达到 1920px 就无限拉宽表单正文。

### 6.3 Page Header

所有一级页面都必须有可见 Page Header：

~~~text
Page title                         Primary action
Short context / state
~~~

约束：

- 页面标题不能只放在 `sr-only`；
- 一个页面只允许一个主要 CTA；
- 第二动作使用 outline / ghost；
- 标题区域不做 Hero，不使用大字号 Marketing 文案；
- 页面说明保持 1–2 行。

### 6.4 Section Rhythm

同一页面：

- Section 间距：24–32px；
- Section 内部：12–16px；
- 强相关内容使用 8px；
- 不通过给每个 Section 套 Card 来制造分隔。

## 7. Surface 与层级

### 7.1 Surface 的原则

Surface 必须表达真实边界，而不是装饰。

允许使用 Surface 的情况：

- Dialog / Sheet / Popover；
- 独立编辑上下文；
- 创建流程；
- Empty / First-run 引导；
- 危险或恢复状态；
- 代码、请求、响应、Diff 等需要形成视觉容器的结构化内容；
- 单个资源对象需要明确可点击边界时。

不应该使用 Surface 的情况：

- 普通页面 Section；
- “因为内容看起来太空”；
- 四个并列 KPI；
- 每一组 Label + Value；
- 每一个列表区域；
- 每个状态摘要。

### 7.2 Elevation

层级优先顺序：

1. whitespace；
2. hairline；
3. background tone；
4. border；
5. shadow。

Shadow 主要保留给：

- Dialog；
- Popover；
- Command Palette；
- Floating overlay；
- 极少数 Raised Recovery Surface。

普通页面 Card 不使用明显 Drop Shadow。

### 7.3 Radius

- 4px：微型技术元素；
- 6px：Input、紧凑控件；
- 8px：Button、标准 Surface；
- 12px：Dialog / Sheet / Empty state；
- Full：Badge、Avatar、真正的 pill status。

不要所有东西都圆成 pill，也不要所有容器都 12–16px 大圆角。

## 8. 组件语言

### 8.1 Button

Primary：

- neutral 黑白反差；
- 每个页面首屏原则上最多一个明显 Primary；
- 高度视觉上 40px 左右；
- 点击目标不小于 44px。

Secondary：

- outline 或 ghost；
- 不用彩色背景抢占 Primary。

Compact：

- 可以视觉上 32–36px；
- 但通过 padding / hit area 保证 44px 最小交互目标；
- 不通过 10px 文本和 30px 高度制造密度。

Destructive：

- 只用于会造成明确破坏性结果的动作；
- 不能用红色强调普通失败状态的导航动作。

### 8.2 Input / Select

- 标准高度 40px；
- 有清晰 Label；
- Help / Error 就地显示；
- Focus 必须可见；
- Placeholder 不替代 Label；
- 长表单按 Section 分组，不用多层 Card。

### 8.3 Table

Developer Workbench 中 Table 是核心组件，不应过度弱化。

规则：

- 表头 ≥12px；
- 行高 ≥44px；
- 默认不用斑马纹；
- 行边界用 hairline；
- Hover 只做低对比 surface change；
- ID / path / technical value 使用 mono；
- 状态使用统一 Status；
- 没有批量动作时不显示 checkbox；
- 行动作使用统一 Dropdown Menu；
- 保留横向信息时允许局部横向滚动，不让整个页面溢出。

### 8.4 Status

状态组成：

~~~text
icon/dot + text
~~~

Badge 是辅助，不应成为满屏彩色药丸。

正常 Ready 状态应安静；只有 Warning / Failed 才提高视觉注意力。

### 8.5 Empty State

Empty State 解决三个问题：

1. 这里是什么；
2. 为什么现在为空；
3. 下一步是什么。

空项目不要渲染一墙 `0` 指标。

### 8.6 Code / JSON / Diff

技术信息是一等内容：

- JSON / Request / Response / Diff / Path / ID 统一使用 mono；
- 容器支持复制；
- 长内容可折叠；
- 错误位置可定位；
- 不把技术详情藏到 Tooltip；
- 同一页避免出现多套不同 Code Box 风格。

## 9. App Shell

### 9.1 Sidebar

Sidebar 是导航，不是数据面板。

规则：

- 一级导航按 `Spec 0001 §3`；
- 默认宽度约 220–248px；
- 选中项：neutral accent surface + stronger text；
- 不使用品牌色左边条；
- 分组标签低对比但 ≥12px；
- 图标统一 Lucide 16–18px；
- 导航行最小点击目标 44px；
- count 只展示真实可解释事实；
- 正常情况下不在 Sidebar 堆积大量状态徽标。

### 9.2 Topbar

Topbar 只保留全局能力：

- 当前目的地；
- Runtime 状态；
- Command Palette；
- Language；
- Theme；
- Admin account。

不要把页面级按钮放到 Topbar。

### 9.3 Command Palette

Command Palette 是 Modelry 的高价值工作入口：

- `Cmd/Ctrl + K`；
- 导航；
- 打开最近 Collection；
- 创建资源；
- 切换主题/语言；
- 定位异常。

它使用 Dialog/Popover 层级，不能被 Topbar 或 Sticky 区域裁切。

## 10. Overview

Overview 不是 KPI Dashboard。

页面回答：

1. 项目能不能正常工作；
2. 有什么值得处理；
3. 从哪里继续。

### 10.1 推荐结构

~~~text
项目总览                              [打开 API 工作区]
今天真正需要处理的项目状态和最近工作。

Collections      API             Events          Changes
12               284 requests    8 enabled       3 pending
2 pending        4 errors        1 failed        1 review
────────────────────────────────────────────────────────

继续工作
users            1,204 records   Pending        Open
posts            8,932 records   Ready          Open
audit_events     94,118 records  Ready          Open

快捷开始
New collection   Debug API   Create webhook   Create schedule

最近活动
11:21  users schema changed
10:42  POST /users 401
09:18  webhook delivery failed

系统
Runtime          Ready
SQLite           Ready
Storage          Ready
Schema drift     1
~~~

### 10.2 Status Strip

原本四个 Summary Card 应收敛为一个紧凑 Status Strip 或同一 Section 内四列摘要。

它们可以点击，但不要形成四张同权重浮动卡片。

### 10.3 Continue Working

这是 Overview 最大的业务区域。

- 最近 3–5 个 Collection；
- 使用 Table / Resource List；
- Pending / Failed 才提高视觉权重；
- 空项目直接替换为 Create Collection 引导。

### 10.4 Recent Activity

只展示和下一步有关的 3–5 条事实。

不复制完整 Activity 页面，也不要把 Timeline 做成装饰型 Feed。

## 11. Collection Workspace

Collection 是 Modelry 最重要的本地工作上下文。

顶部持续显示：

- Collection 名称；
- 类型；
- pending change；
- 本地 Tab：Records / Schema / Access / API。

Tabs 是真实链接，不是纯 JS 临时状态。

### 11.1 Schema

Schema 是结构编辑工作面：

- Fields / Relations / Indexes 在同一上下文；
- 支持连续多个修改；
- 一次形成一个 Collection-scoped Change Set；
- Pending Change 就地可见；
- 不为每个 Field 套独立 Card；
- 数据密集部分优先 Table/List + inline action。

### 11.2 Records

Records 优先优化：

- scanability；
- search/filter；
- row action；
- detail edit；
- keyboard；
- URL restore。

不把数据库记录浏览器做成“卡片 CRM”。

## 12. API Workspace

API Workspace 应更像 Developer Tool：

- endpoint tree/list；
- method + path；
- request editor；
- response；
- status / duration / requestId；
- OpenAPI；
- logs。

关键技术值使用 mono。

请求成功后结果原地保留，不依赖 Toast 作为唯一反馈。

## 13. Hooks, Events 与 Scheduled Jobs

这些页面视觉上共享“定义 + 运行事实”模式：

~~~text
Definitions
───────────
name / trigger / status / last run

Execution / Delivery facts
──────────────────────────
time / result / duration / error
~~~

不要把每个 Hook / Job 都变成大卡片。

失败执行可以使用状态色，但正常运行保持 neutral。

## 14. Changes

Changes 是变更控制工作面，不是警告中心。

- Pending；
- Applied History；
- Drift。

Diff 是视觉主体。

Risk / Needs Review 是辅助层级。

SAFE 变化不要因为“重要”就使用警告色；只有确实需要用户注意的状态才用 warning。

## 15. Access & Auth

身份对象要清晰区分：

- Administrator；
- Application Auth；
- Service Account / API Token；
- App User（Collection 上下文）。

Secret / API Key 明文只显示一次。

敏感信息不通过 UI 装饰弱化其风险；使用明确文案和一次性显示状态。

## 16. Settings

Settings 是本地配置工作面。

Desktop 推荐：

~~~text
Local settings nav | Settings content
~~~

而不是所有设置做成一级 Card Grid。

配置页每个 Section 最多一个明确 Save Action，成功结果就地耐久可见。

## 17. Focus、Keyboard 与 Accessibility

### 17.1 Focus State

**Focus 必须可见，但不默认增加额外外圈。**

Modelry 优先使用与 Quiet Workbench 一致的低装饰焦点反馈：

1. 轻微背景变化；
2. 原有边框颜色或对比度增强；
3. inset highlight / inset shadow；
4. 文字或图标对比度轻微增强；
5. 输入框、编辑器等需要明确输入焦点的控件，必要时才使用轻量 ring。

要求：

- 键盘 Tab 移动时必须能判断当前焦点；
- 鼠标点击不应无意义地出现强烈焦点装饰；
- Light / Dark 都必须清晰可辨；
- Focus 不新增第二层厚边框，不形成“一圈套一圈”的视觉效果；
- Sticky / Overlay 不得遮挡焦点状态。

可以移除浏览器默认 outline，但前提是组件提供了等价且可见的 focus state。

不允许仅写：

~~~css
:focus-visible {
  outline: none;
  box-shadow: none;
}
~~~

然后没有任何可见替代状态。

### 17.2 Touch / Pointer Target

所有主要交互目标：

- 最小 44 × 44 CSS px；
- 紧凑视觉尺寸可以通过 invisible hit area / padding 达成；
- 不接受 30–34px Icon Button 作为最终实现。

### 17.3 Motion

- 页面切换不做入场动画；
- Overlay 仅轻微 fade / translate；
- 状态变化快速；
- 遵循 `prefers-reduced-motion`；
- 动画不能承担正确性信息。

## 18. Responsive

权威设计基准：

| Width | 行为 |
| --- | --- |
| 1440 | 主桌面设计基准 |
| 1024 | 完整工作台，允许 Sidebar 收窄 |
| 768 | Sidebar 进入明确 Drawer / Collapsible navigation |
| 390 | 手机基准，无页面级横向滚动 |

### 18.1 768px 以下

- 全局导航使用 Drawer；
- 不把完整一级导航变成永久横向滚动条；
- Collection Tab 可横向滚动或使用 compact selector；
- Table 允许局部滚动；
- Primary action 保持可见。

### 18.2 390px

- 表单单列；
- 编辑 Sheet 可以全屏；
- Topbar 只保留必要全局动作；
- 页面不能因为 email、ID、path、button group 造成整体横向溢出。

## 19. Do / Don't

### Do

- 用 hierarchy 而不是 decoration；
- 用 whitespace、divider 和 alignment 组织页面；
- 让代码、数据、Diff 成为视觉主体；
- 默认使用 neutral；
- 让异常比正常状态更显眼；
- 使用 shadcn/Base UI 作为通用原语；
- 保证页面标题可见；
- 保证 Focus 可见，但优先使用背景、现有边框或 inset 状态，不默认增加外圈；
- 保证 44px hit target；
- 使用 URL 保存可共享工作状态；
- 中英文使用同一视觉层级；
- Light/Dark 使用同一语义 Token。

### Don't

- 不要 Card Everywhere；
- 不要 9px / 10px / 11px 正常 UI 文本；
- 不要 Gradient、Glow、Glass、Scanline；
- 不要为 Modelry 新增品牌彩色 CTA；
- 不要用 Emoji 做交互图标；
- 不要隐藏页面标题只留下工具栏；
- 不要为了“密度”缩小点击目标；
- 不要在没有替代状态的情况下全局关闭 focus-visible；
- 不要给普通页面 Surface 使用大阴影；
- 不要在页面里重新手写 Button / Input / Select / Dialog；
- 不要让 Dashboard 指标压过真实工作对象；
- 不要把系统内部模块名重新提升成一级导航。

## 20. 实现边界

实现栈保持：

~~~text
React + TypeScript + Vite
        ↓
Modelry business components
        ↓
shadcn/ui components
        ↓
Base UI
        ↓
Tailwind CSS v4 + semantic CSS variables
~~~

### 20.1 components/ui

`admin/src/components/ui`：

- 通用 UI 原语；
- 负责 focus / disabled / hover / pressed / overlay；
- 使用 semantic Token；
- 不包含 Modelry 业务语义。

### 20.2 Modelry Components

建议逐步形成：

~~~text
components/modelry/
  page-header.tsx
  section.tsx
  status.tsx
  data-toolbar.tsx
  resource-list.tsx
  code-block.tsx
  empty-state.tsx
  detail-list.tsx
~~~

这些组件组合 shadcn 原语并承载 Modelry 视觉语义。

不要建立第二套通用 UI Library。

### 20.3 Compatibility Wrapper

现有 `components/button.tsx` 等兼容层可以在迁移期间保留，但：

- 不继续扩展新的 legacy variant；
- 新页面优先使用最终设计组件；
- 当调用方迁移完成后删除兼容层；
- 避免同时存在两套视觉参数源。

### 20.4 Surface

现有 `Surface` 可以保留为业务布局组件，但必须改变使用心智：

> Surface = meaningful boundary，而不是 default section wrapper。

## 21. 当前分支优先整改

针对 `feature/20-v01-product-surface-closure` 当前实现，优先级如下。

### P1 — Design-system correctness

1. 建立统一可见、低装饰的 focus state；
2. 正常 UI 字号全部提升到 ≥12px；
3. 主要交互目标达到 ≥44px；
4. 响应式断点与 390 / 768 / 1024 / 1440 对齐。

### P1 — Shell

1. Sidebar 密度收敛；
2. 768 以下改为 Drawer，而不是永久横向导航；
3. Topbar 只保留全局能力；
4. Command Palette 保持 Portal 与完整视口可达。

### P1 — Overview

1. 恢复可见 Page title / description；
2. 四个 Summary Card → Status Strip；
3. Continue Working 成为视觉主体；
4. Quick Start 降低 Card 感；
5. Recent Activity / Runtime 使用 section + divider。

### P2 — Page convergence

按以下顺序收敛：

1. Collections + Collection Workspace；
2. API Workspace；
3. Hooks & Events；
4. Scheduled Jobs；
5. Changes；
6. Access & Auth；
7. Activity；
8. Settings。

## 22. 验收

视觉实现完成不能只看单张截图。

至少检查：

~~~text
Light / Dark
×
zh-CN / en
×
390 / 768 / 1024 / 1440
~~~

并覆盖：

- Overview；
- Collections；
- Collection Records；
- Collection Schema；
- API Workspace；
- Events；
- Schedules；
- Changes；
- Access；
- Settings；
- Dialog / Sheet / Popover / Command Palette；
- Empty / Loading / Error / Partial / Disabled / Destructive。

真实浏览器验收仍遵循 `Spec 0001 §18`，不得以静态 Story 或 Mock 页面替代。

## 23. Agent Iteration Guide

编码智能体修改 Admin 前端时：

1. 先读 `AGENTS.md`；
2. 读当前页面对应的产品 / UX Spec；
3. 读本 `DESIGN.md`；
4. 检查 `components/ui` 是否已有原语；
5. 优先复用既有 Token 与组件；
6. 一次只引入一个新的视觉概念；
7. 新增 Token 前先证明现有语义无法表达；
8. 页面完成后检查 Light/Dark、zh/en、390/768/1024/1440；
9. 不因为截图“看起来更丰富”增加无业务意义的 Card、颜色或指标；
10. 如果设计选择无法用本文件现有规则解释，先更新设计决策，再实现。

## 24. 最终判断标准

一个页面符合 Modelry Quiet Workbench，不是因为它“像 shadcn”或“像 Vercel”。

而是因为：

- 第一眼知道自己在哪里；
- 第一眼知道能做什么；
- 数据和工作对象比装饰更突出；
- 正常状态安静；
- 异常状态可处理；
- 页面层级稳定；
- 操作密度高但不牺牲可读性；
- 鼠标、键盘、触摸都能可靠使用；
- Light/Dark 与中英文不改变产品结构；
- 编码智能体能够从文档直接推导出一致的实现。
