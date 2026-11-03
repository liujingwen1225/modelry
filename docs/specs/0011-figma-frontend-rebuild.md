# Figma 驱动的新前端实施基线

- 状态：已确认，当前实施基线
- 适用范围：Modelry 新 Admin 前端
- 设计源： [Figma — Modelry](https://www.figma.com/design/WDn5msOTqcN4j6eEWBNjwM/modelry?node-id=0-1)
- UI 组件库：Ant Design（antd）

## 1. 核心决策

新前端直接按照 Figma 实现。Figma 是页面范围、信息架构、视觉、组件组合和交互的唯一产品设计依据。不得沿用旧 Admin 的页面、信息架构、视觉或组件约束。

这是一次全新前端实现，不是旧前端 V2，也不是在旧页面上逐步换肤。

保留现有 Go 后端、SQLite、业务服务、安全边界和已确认的 HTTP Contracts。新前端重新建立页面、路由、状态、API Client 和组件体系；按 Figma 页面实际需要复用或扩展后端 API。

## 2. Figma 实施范围

Figma Page 1 的顶层画板如下。除第 23 项外，其余均为需要实现的页面或独立页面状态：

1. 首次进入 · 空项目
2. 数据 · 创建集合
3. 数据 · notes 结构
4. 数据 · 编辑作者关系
5. 数据 · 编辑笔记记录
6. 数据 · 删除集合确认
7. 数据 · notes API
8. 用户与访问 · 用户列表
9. 用户与访问 · 林晓与会话
10. 用户与访问 · 认证配置
11. 数据 · 文件字段配置
12. 数据 · 记录文件字段与上传
13. 开发与连接 · API 文档
14. 开发与连接 · API 请求日志
15. 开发与连接 · 请求排错验证
16. 开发与连接 · Secrets 编辑
17. 业务逻辑 · 编辑与测试欢迎笔记
18. 业务逻辑 · 执行记录与重试
19. 变更中心 · 待审阅与历史
20. AI 协作 · 需求与理解
21. AI 协作 · 应用后结果与验证
22. 设置 · 本地项目
23. 界面控件与状态基线（设计系统参考，不单独创建产品页面）
24. AI 变更审阅 · 公开分享
25. 业务逻辑 · 欢迎笔记
26. 用户与访问 · 访问规则
27. 数据 · notes 工作台
28. 概览 · 继续工作

实现时以对应 Figma 画板为准，不把画板名称机械转换成一级导航；导航、页面归属和页面关系均按画板中的实际设计实现。

## 3. 前端技术基线

- React
- TypeScript
- Vite
- Ant Design（`antd`）
- Ant Design Icons（`@ant-design/icons`）
- 使用 Ant Design ConfigProvider / Design Tokens 和 CSS 变量映射 Figma 视觉规范。
- 继续满足 Go 单二进制嵌入交付，构建产物输出到 `internal/webui/dist`。

不引入 shadcn/ui、Base UI、Mantine、Ant Design X 或其它第二套 UI 组件库。

## 4. Ant Design 强制使用规则

1. Button、Input、Select、Checkbox、Radio、Switch、Tabs、Table、Modal、Drawer、Dropdown、Menu、Tooltip、Popover、Upload、DatePicker、Message、Notification 等已有基础组件，必须使用 Ant Design 对应组件。
2. 在新前端建立统一的 `src/ui/` 组件出口。业务页面从统一出口使用基础 UI，不直接重复封装 Ant Design 已提供的基础能力。
3. 只有 Figma 特有的业务组合、业务展示和复杂工作面允许编写自定义组件；不得借此重造基础交互控件。
4. 通过 ESLint / 静态检查约束业务页面：禁止直接使用原生 button、input、select、textarea 等替代 Ant Design 控件；禁止从业务页面绕过统一出口直接引入其它 UI 库。
5. Ant Design 只提供组件行为和基础能力。默认主题不是产品设计，必须根据 Figma 定制颜色、字体、尺寸、边框、圆角、状态和亮暗主题，不得直接套用默认 Ant Design 外观。
6. AI 协作界面使用 Ant Design 基础组件和项目业务组件实现；不引入 Ant Design X。

## 5. 产品范围约束

- Figma 已设计的页面和交互必须实现完整。
- Figma 没有的功能、页面、菜单和额外工作流，本轮不实现，暂存待后续确认。
- 不因后端已有某项能力就自动为它增加前端入口。
- 不再建设需要用户编写或调试 JavaScript / TypeScript 的 Hook、Lifecycle Hook、Extension 代码编辑器或管理工作台。
- Figma 中的「业务逻辑」可视化编辑、测试、执行记录和重试属于本轮范围，不能与代码型 Hook 混为一谈。
- 不擅自改变 Figma 已表达的产品语义。画板未表达清楚的局部交互，优先采用与现有画板一致的最小交互；涉及业务规则的不确定点先记录并确认，不自行扩展产品能力。

## 6. 旧前端与后端边界

- 旧 `admin/src` 页面、组件、布局、导航、路由、状态管理、CSS / Design Tokens 不作为新前端实现基础，不复制或渐进迁移。
- `admin/` 目录名及 Go Embed 构建接缝可以保留，以减少部署改动；目录保留不代表旧源代码可复用。
- 新 API Client 根据当前后端 HTTP Contracts / OpenAPI 重新实现，不复制旧前端 API Client。
- 仅当 Figma 中的真实操作无法由现有后端 API 完成时，才补充最小必要的后端接口；不借机重构无关后端模块。
- 保留 Go 单二进制、SQLite 和现有数据耐久性、安全、权限及变更生命周期语义。

## 7. 验收标准

- 所有 27 个产品页面 / 状态画板均有对应实现；第 23 个画板作为组件与状态验收基线。
- 视觉对照以 Figma 为准，检查布局、间距、字体、颜色、图标、边界、组件尺寸和页面状态。
- Figma 中可见的操作均可实际执行，不以静态按钮、假数据或无效交互代替。
- 页面数据通过真实 Go API 和 SQLite 读写；不以 mock-only 测试作为业务验收。
- 覆盖 Figma 所表达的空、加载、成功、错误、禁用、确认、待审阅等状态。
- 使用 Playwright 对核心用户旅程做真实浏览器验收，并进行截图对照。
- 验证前端构建、Go Embed、单二进制启动及刷新后的路由和数据持久性。
- 静态检查确认没有引入第二套 UI 组件库，也没有在业务页面绕过 Ant Design 使用原生基础交互控件。
