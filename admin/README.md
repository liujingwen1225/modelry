# Modelry 新前端（admin）

按 Figma 从零实现的 Modelry 管理面前端。它不是旧 Admin 的 V2，也不复用旧页面、组件、路由、
状态管理或 CSS。

- 设计唯一来源：[Modelry Figma](https://www.figma.com/design/WDn5msOTqcN4j6eEWBNjwM/modelry)
- 实施基线：[`docs/specs/0011-figma-frontend-rebuild.md`](../docs/specs/0011-figma-frontend-rebuild.md)
- 技术栈：React + TypeScript + Vite + Ant Design（唯一 UI 组件库）+ Ant Design Icons

## 目录

```text
src/
  api/       按产品域拆分的 HTTP Client 与类型（session/overview/activity/audit/runtime…）
  app/       全局工作区外壳、导航、面包屑、项目上下文
  lib/       时间与审计文案等纯函数
  pages/     按 Figma 画板组织的页面
  routes/    路由表
  session/   管理面身份守卫与查询
  theme/     Figma 设计变量（tokens.css）与 Ant Design 主题映射（antd.ts）
  ui/        唯一 UI 出口：Ant Design re-export + Figma 业务组件
```

## 设计变量

`src/theme/tokens.css` 是唯一视觉来源，取值来自 Figma 画板「界面控件与状态基线」：

| 语义 | 值 |
| --- | --- |
| 正文 / 辅助 / 说明 | `#252B28` / `#6D756F` / `#98A099` |
| 操作与成功 | `#385A4B` |
| 待审阅 | `#8A6939` |
| 错误与危险 | `#A45149` |
| 表面 / 侧栏 / 次级底 / 浅绿底 | `#FFFFFF` / `#F7F8F6` / `#F6F7F5` / `#EAF1EB` |
| 分隔线 | `#E6E9E4` |
| 控件高度 | 按钮 34 / 输入 38 / 导航 40 |
| 圆角 | 4 / 6 / 8 |

字体按 Figma 使用 Noto Sans SC（中文）、Inter（品牌）、JetBrains Mono（技术数据）；
三者都通过系统字体栈回落，不引入网络字体，保持本地优先与离线可用。

`src/theme/antd.ts` 把同一组值映射到 Ant Design Token。Ant Design 只负责组件行为，
外观全部由这些变量覆盖，不使用默认主题。

## Ant Design 约束

- 业务页面只从 `@/ui` 使用 UI 能力；`antd` 的直接引用被 ESLint 限制在 `src/ui` 与 `src/theme`。
- 业务页面禁止使用原生 `button` / `input` / `select` / `textarea`，由 ESLint `no-restricted-syntax` 拦截。
- 不引入第二套 UI 库（shadcn、Mantine、Ant Design X、MUI、Radix… 均在禁止列表）。
- 关闭 Ant Design 的中文按钮自动空格（`button.autoInsertSpace: false`），保持 Figma 的「登录」而不是「登 录」。

## 命令

```bash
npm run dev      # Vite dev server（API 代理到 MODELRY_DEV_RUNTIME，默认 127.0.0.1:8090）
npm run build    # tsc --noEmit + vite build，产物写入 ../internal/webui/dist
npm run check    # 类型检查 + ESLint
npm run browser:acceptance        # 构建前后端 → 临时空项目启动真实运行时 → Playwright
npm run browser:smoke             # 只跑 e2e/foundation.spec.ts
```

`browser:acceptance` 由 `e2e/run-acceptance.mjs` 驱动：先构建前端与 Go 单二进制，
再在临时目录启动真实运行时（真实 SQLite），跑完 Playwright 后清理。它不使用 dev server，
也不 mock 接口。

`e2e/capture.mjs` 用于视觉对照：对真实运行时逐路由截图，便于与 Figma 画板并排检查。

## 页面与 Figma 对照

| 路由 | Figma 画板 | 交付 Issue |
| --- | --- | --- |
| `/`（无集合） | 首次进入 · 空项目 | #42 |
| `/`（有集合） | 概览 · 继续工作 | #42 |
| `/data`… | 数据 · 创建集合 / 结构 / 记录 / 工作台 | #43 |
| `/access`… | 用户与访问 | #44 |
| `/developer`… | 开发与连接 | #45 |
| `/logic`… | 业务逻辑 | #46 |
| `/changes`… | 变更中心 | #47 |
| `/ai`… | AI 协作 | #48 |
| `/settings`… | 设置 · 本地项目 | #49 |

`/setup` 与 `/login` 不在 Figma 画板内，但缺少它们无法安全进入管理面，
因此保留为最小必要页面，并复用同一套设计变量。

## 构建接缝

Vite 产物输出到 `../internal/webui/dist`，由 Go `internal/webui` 的 `embed` 打进单二进制；
路由使用 BrowserRouter，刷新深链接时由 Go 侧回退到 `index.html`。
