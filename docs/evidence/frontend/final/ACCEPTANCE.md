# Modelry 新前端重建 · 最终验收报告

- Epic：[#41](https://github.com/liujingwen1225/modelry/issues/41)
- 收尾 Issue：[#50](https://github.com/liujingwen1225/modelry/issues/50)
- 设计唯一依据：[Figma — Modelry](https://www.figma.com/design/WDn5msOTqcN4j6eEWBNjwM/modelry?node-id=0-1) 与 `docs/specs/0011-figma-frontend-rebuild.md`
- 验收对象：Go 单二进制 + 真实 SQLite + 真实 HTTP + 真实 Chromium，**不使用 dev server、不 mock 任何业务数据**
- 采集视口：1512 × 1000（与 Figma 画板一致）

## 1. 验收环境与方法

`admin/e2e/run-acceptance.mjs` 每次运行会：

1. 先 `npm run build`（产物落到 `internal/webui/dist`）再 `go build ./cmd/modelry`，保证验收跑的是本次代码；
2. 为**每个 spec 文件**创建一个全新的临时空项目目录并启动独立 Runtime（各 spec 的「首次运行 / 还没有集合」假设互不污染）；
3. 用 Playwright Chromium 访问真实 HTTP 端口，跑完即关闭 Runtime 并清理临时项目。

`admin/e2e/capture-final.mjs` 另外启动一个独立的临时项目，通过真实 Admin API 播种认证集合、笔记/标签集合、记录、文件字段、访问规则、Secret、可视化业务逻辑、待应用变更、AI 提案与公开分享链接，再按 Figma 画板逐页截图。

视觉证据：

- Figma 原图：`docs/evidence/frontend/final/figma/*.png`（28 张，全部 1512×1000）
- 本实现截图：`docs/evidence/frontend/final/*.png`（30 张，含抽屉 / 确认框等交互态）
- 采集摘要：`docs/evidence/frontend/final/summary.json`

## 2. Figma 画板逐页对照

| # | Figma 画板 | 实现位置 | Figma 原图 | 实现截图 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | 首次进入 · 空项目 | `/`（空项目态） | `figma/figma-01-empty-project.png` | `01-empty-project.png` | 已对照 |
| 2 | 数据 · 创建集合 | `/data` 创建集合抽屉 | `figma/figma-02-create-collection.png` | `02-create-collection.png` | 已对照 |
| 3 | 数据 · notes 结构 | `/data/:id/schema` | `figma/figma-03-notes-schema.png` | `03-notes-schema.png` | 已对照 |
| 4 | 数据 · 编辑作者关系 | 结构页字段抽屉（关联字段） | `figma/figma-04-edit-author-relation.png` | `04-edit-author-relation.png` | 已对照，`integration.spec.ts` 守住真实契约 |
| 5 | 数据 · 编辑笔记记录 | 记录页新增 / 编辑抽屉 | `figma/figma-05-edit-note-record.png` | `05-edit-note-record.png` | 已对照 |
| 6 | 数据 · 删除集合确认 | 集合操作菜单 → 确认对话框 | `figma/figma-06-delete-collection.png` | `06-delete-collection-confirm.png` | 已对照，名称校验与真实级联删除 |
| 7 | 数据 · notes API | `/data/:id/api` | `figma/figma-07-notes-api.png` | `07-notes-api.png` | 已对照 |
| 8 | 用户与访问 · 用户列表 | `/access` | `figma/figma-08-users-list.png` | `08-users-list.png` | 已对照 |
| 9 | 用户与访问 · 林晓与会话 | `/access` 用户详情抽屉 | `figma/figma-09-user-sessions.png` | `09-user-and-sessions.png` | 已对照 |
| 10 | 用户与访问 · 认证配置 | `/access/auth` | `figma/figma-10-auth-config.png` | `10-auth-config.png` | 已对照 |
| 11 | 数据 · 文件字段配置 | `/data/:id/schema?field=:fieldId` | `figma/figma-11-file-field-config.png` | `11-file-field-config.png` | 已对照，约束经待应用变更生效 |
| 12 | 数据 · 记录文件字段与上传 | 记录编辑抽屉文件字段 | `figma/figma-12-record-file-upload.png` | `12-record-file-upload.png` | 已对照，上传写入真实 Runtime 引用 |
| 13 | 开发与连接 · API 文档 | `/developer/api` | `figma/figma-13-api-docs.png` | `13-api-docs.png` | 已对照 |
| 14 | 开发与连接 · API 请求日志 | `/developer/logs` | `figma/figma-14-request-logs.png` | `14-request-logs.png` | 已对照 |
| 15 | 开发与连接 · 请求排错验证 | `/developer/diagnose?requestId=…` | `figma/figma-15-request-diagnose.png` | `15-request-diagnose.png` | 已对照，重新发起真实 HTTP 请求 |
| 16 | 开发与连接 · Secrets 编辑 | `/developer/secrets` + 抽屉 | `figma/figma-16-secrets-edit.png` | `16-secrets.png` / `16-secrets-edit.png` | 已对照，明文只写不回显 |
| 17 | 业务逻辑 · 编辑与测试欢迎笔记 | `/logic/edit?rule=…` | `figma/figma-17-logic-edit-test.png` | `17-logic-edit-test.png` | 已对照，测试为 dry-run |
| 18 | 业务逻辑 · 执行记录与重试 | `/logic/runs?rule=…` | `figma/figma-18-logic-runs-retry.png` | `18-logic-runs-retry.png` | 已对照，重试真实再执行 |
| 19 | 变更中心 · 待审阅与历史 | `/changes/pending` `/changes/history` | `figma/figma-19-change-center.png` | `19-change-center.png` / `19-change-center-history.png` | 已对照 |
| 20 | AI 协作 · 需求与理解 | `/ai` 需求理解视图 | `figma/figma-20-ai-understanding.png` | `20-ai-requirement-understanding.png` | 已对照，明确标注「规则化理解，非大模型生成」 |
| 21 | AI 协作 · 应用后结果与验证 | `/ai` 验证视图 | `figma/figma-21-ai-applied-verification.png` | `21-ai-applied-verification.png` | 已对照 |
| 22 | 设置 · 本地项目 | `/settings` | `figma/figma-22-settings.png` | `22-local-project-settings.png` | 已对照 |
| 23 | 界面控件与状态基线 | 设计系统参考，**不单独创建产品页面** | `figma/figma-23-baseline.png` | `foundation.spec.ts`「视觉基线」+ `src/theme/tokens.css` | 已对照（组件与状态基线） |
| 24 | AI 变更审阅 · 公开分享 | `/ai/share/:token`（匿名只读） | `figma/figma-24-ai-public-share.png` | `24-ai-public-share.png` | 已对照，匿名上下文验证 |
| 25 | 业务逻辑 · 欢迎笔记 | `/logic/rules` | `figma/figma-25-logic-welcome-note.png` | `25-logic-welcome-note.png` | 已对照 |
| 26 | 用户与访问 · 访问规则 | `/access/rules` 与 `/data/:id/access` | `figma/figma-26-access-rules.png` | `26-access-rules-page.png` / `26-access-rules.png` | 已对照 |
| 27 | 数据 · notes 工作台 | `/data/:id` | `figma/figma-27-notes-workspace.png` | `27-notes-workspace.png` | 已对照 |
| 28 | 概览 · 继续工作 | `/`（有数据态） | `figma/figma-28-overview.png` | `28-overview-continue-work.png` | 已对照 |

第 23 项按规格作为组件与状态验收基线，不作为产品页面；其余 27 个产品页面 / 状态画板均有对应实现与截图。

## 3. 真实业务验收结果

| 验收项 | 结果 |
| --- | --- |
| `go test ./...` | 全量通过（含 `internal/aicollab`、`internal/visualrules`、`internal/projectprefs`、`internal/runtime` 的真实 SQLite / Runtime 测试） |
| `npm run admin:test`（`tsc --noEmit` + ESLint） | 通过 |
| `npm run admin:build` | 通过，产物写入 `internal/webui/dist` |
| `go build ./cmd/modelry` + 单二进制启动 | 通过；`READY {"state":"ready","url":"http://127.0.0.1:8080",…}`，嵌入首页 `GET /` → 200（444 B，`<title>Modelry</title>`），嵌入 JS 资源 → 200（1,514,776 B）。每次验收也由启动器真实编译并启动 |
| `go test ./internal/webui ./cmd/modelry` | 通过（Embed 与启动测试） |
| 静态约束扫描 | 业务页面无第二套 UI 库 import、无 `antd` 直连（仅 `src/ui` / `src/theme`）、无原生 `button/input/select/textarea/dialog`；ESLint 规则本身也强制这些约束 |
| `node e2e/run-acceptance.mjs` | **9 个 spec 文件 / 19 个用例全部通过**，每个 spec 独立临时项目与独立 Runtime |

Playwright 用例分布：

| spec | 用例数 | 覆盖 |
| --- | --- | --- |
| `foundation.spec.ts` | 5 | 首次运行、导航页眉、概览真实计数、视觉基线与无第二套 UI 库、404 |
| `data-workspace.spec.ts` | 6 | 创建集合、记录 CRUD、结构变更应用、API 标签、文件字段约束、删除集合级联与审计 |
| `users-access.spec.ts` | 2 | 认证集合空态、访问规则编辑 / 应用 / 真实 simulate |
| `developer.spec.ts` | 1 | 真实契约、请求日志、真实请求排错、Secrets 生命周期与明文不回显 |
| `changes.spec.ts` | 1 | 待审阅、差异与风险预检、应用、真实历史、深链接 |
| `logic.spec.ts` | 1 | 可视化规则编辑、dry-run 不写数据、真实执行、执行记录、失败重试与 attemptOf |
| `ai-collaboration.spec.ts` | 1 | 需求理解、真实待审阅方案、应用、验证、匿名公开分享与撤销失效 |
| `settings.spec.ts` | 1 | 基本设置持久化、409 冲突、运行时设置保存与刷新 |
| `integration.spec.ts` | 1 | **关联字段跨界面贯通**（见下） |

### 3.1 全站联调发现并修复的真实缺陷

`integration.spec.ts` 覆盖「结构里的关联字段 → 记录里的关联值 → 访问规则」链路，发现前端曾把后端 `Relation` 契约写错：

- 后端：`{ targetCollectionId, cardinality: one-to-one | many-to-one | one-to-many | many-to-many }`，且关联字段必须使用 `kind: 'relation'` 的待应用操作；
- 前端误用：`{ collectionId, multiple }` 并以 `kind: 'field'` 提交，导致从界面保存关联字段必然 400，关联记录值也无法写入。

本次修复涉及 `src/api/collections.ts`、`SchemaTab.tsx`、`RecordDrawer.tsx`、`RulesTab.tsx`，并新增一条贯穿结构、记录与访问规则的集成用例。该用例验证：界面新增关联字段 → 待应用变更应用后真实结构含 `targetCollectionId/cardinality` → 记录抽屉列出目标集合真实记录并写入真实关联值 → 访问规则页读取同一集合的 5 条真实规则 → 刷新后保持。

**第二处跨界面缺口**：Figma 画板 22 的项目名称与全局导航 / 面包屑里的项目名是同一个事实，但 #49 保存的 `projectName` 只停留在设置页，主导航仍显示数据目录名（`project`）。本次让 `ProjectProvider` 读取真实项目偏好并在未命名时回退数据目录名，`settings.spec.ts` 增加断言：保存项目名称后主导航立即显示该名称。截图 `28-overview-continue-work.png` 与 Figma `figma-28-overview.png` 的项目名现已一致。

## 4. 状态、耐久性与安全验收

- **空 / 加载 / 成功 / 错误 / 禁用 / 确认 / 待审阅**：各页面均来自真实 API 状态；成功反馈改用全局 message，避免待应用变更消失后提示条立即卸载导致结果不可见。
- **刷新 / 深链接 / 后退**：集合与标签走路由，变更详情用 `?changeSet=`，排错用 `?requestId=`，分享用 `/ai/share/:token`，均已验证刷新后保持。
- **Runtime 重启后数据仍在**：`go test ./internal/runtime`（含集合删除重启用例）与各 spec 的 `page.reload()` 覆盖；Go 单二进制每次从同一 SQLite 项目目录重启。
- **权限与敏感信息**：Admin 会话与应用用户分离；Secret 明文只写不回显；公开分享只读、可撤销、过期失效，不返回 Secret / 凭据 / 记录内容 / 绝对路径；匿名浏览器上下文验证公开页不含管理面导航。
- **不绕过变更生命周期**：AI 方案、结构变更、文件字段约束、访问规则均经「保存待应用变更 → 预览差异与风险 → 明确审阅 → 应用 → 历史」；`risk=review` 带 `confirmRisk`，`blocked` 禁用应用。
- **静态约束**：ESLint 禁止业务页面直接 import `antd` 或其它 UI 库、禁止原生 `button/input/select/textarea`；`foundation.spec.ts` 在真实浏览器中校验 216px 导航、语义色与主按钮色，并检查样式表不含第二套 UI 库。

## 5. 已知差异与经确认的例外

1. **图标**：Figma 使用 Lucide 线性图标，本项目按约束统一使用 Ant Design Icons，形状略有差异。
2. **字体**：按 Figma 使用 Noto Sans SC / Inter / JetBrains Mono 字体栈并回落系统字体，不加载网络字体。
3. **AI 协作不接入大模型**：项目没有 LLM 凭据与后端能力，「需求理解」是对真实项目状态的结构化计算，界面与后端返回都明确标注「规则化理解，非大模型生成」；不伪造 AI 自然语言输出，也不合并 PR #39。
4. **请求排错不是原样重放**：后端 RequestRecord 刻意不保存请求体且端点被脱敏成路由模板，因此按契约里的真实 GET 端点重新发起一次真实 HTTP 请求，并展示真实状态码、`X-Request-Id`、响应正文与恢复路径；页面明确说明这不是字节级重放。该请求本身会被记入真实 RequestRecord。
5. **可视化业务逻辑不是代码型 Hook**：按规格只提供触发事件 + 字段模板 + 测试 + 执行记录 + 重试，不建设 JS/TS 代码编辑器。
6. **设置偏好**：工作台语言 / 外观作为真实项目偏好持久化，但当前视觉基线按 Figma 固定为浅色简体中文，不假装已完成深色主题或多语言翻译。
7. **采集日志中的 401**：首次运行时浏览器探测 `GET /admin/api/v1/auth/session` 返回一次 401，这是未登录状态判定的预期请求（见 `summary.json` 的 `httpErrors`），不是页面异常；没有未处理的 Page Exception、5xx 或卡住的 Loading。匿名应用请求真实返回 403 并留下 `failedRequestId`，用于画板 15 的排错上下文。

## 6. 结论

Figma 定义的 27 个产品页面 / 状态画板均有真实实现与截图对照，第 23 个画板作为组件与状态基线验收；所有可见操作都连接真实 Go API 与 SQLite；全站 19 个真实浏览器用例、全量 Go 测试、前端类型与静态检查、单二进制构建与启动均通过。

按 #50 要求，本报告交由项目所有者做真实体验确认；**本任务不自动发布**。
