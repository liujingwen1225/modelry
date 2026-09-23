# Issue Tracker 规范

## 唯一正式跟踪器

Modelry 使用 **GitHub Issues** 作为已经具备实现条件的工程工作的唯一正式任务跟踪器。

## 阶段边界

设计讨论不会自动变成实现 Ticket。

默认生命周期：

`grill-with-docs -> to-spec -> to-tickets -> implement -> code-review`

只有当相关产品/架构决策已经 Accepted，并且已经形成足够具体的 Specification 后，才创建实现级 Issue。

当前 V0.1 已完成 Frontend Closure 与 API Contract Freeze。Backend implementation 已进入正式阶段；所有 Backend Issue 必须以 `docs/contracts/0001-v0.1.0-api-contract-freeze.md`、OpenAPI、Contract Manifest 与 Repository Mapping 为冻结机器边界。发现 Contract Gap 时必须先创建独立 Contract Issue 并完成 Review，不得在 Backend feature 中顺手修改冻结契约。

## GitFlow 分支绑定

正式 Issue 开发必须遵守 `docs/agents/gitflow.md`：

- `main`：发布稳定线；
- `develop`：唯一长期集成线；
- 普通 Issue：从 `develop` 创建 `feature/<issue-number>-<short-name>`；
- 发布稳定化：`release/*`；
- 已发布版本紧急修复：`hotfix/*`。

一个可独立验收的 Issue 原则上只对应一个短期工作分支。Feature 完成后通过 PR 合并回 `develop`，不得直接进入 `main`。

Issue 的 `Blocked by` 依赖必须真实反映阶段 Gate。上游 Gate 未完成时，不允许仅因代码可写就提前启动下游实现；已经完成并合并的 Gate 应及时从阻塞状态中解除。

## 实现级 Issue 质量要求

一个可直接进入实现的 Issue 应明确：

- 用户或系统最终要达到的结果
- 范围和明确的非目标
- 相关产品不变量和 ADR 引用
- 验收标准
- 依赖关系或实施顺序
- 工作分支或可推导的 GitFlow 分支名
- 测试与验证要求

## 工作粒度

优先拆成小型、可独立审查、能够保持架构边界的 Issue。

除非工作本身就是 Prototype / Spike，否则不要把 Schema Engine、Auth、UI、MCP、Deployment 等多个大型关注点混在一个 Issue 中。

## Spike

一次性技术验证必须明确标记或描述为 Spike。Spike 的目标是产出可复现证据和架构决策，而不是悄悄演化成生产实现。

新的 Spike 使用 `spike/*` 短期分支；结果沉淀后结束，不创建新的长期 `prototype/*` 分支。

## 完成与关闭

Issue 只有在验收标准、测试和必要 CI 全部通过，且对应 Feature PR 已按 GitFlow 合并到正确长期分支后才能关闭。

“代码已提交到 feature 分支”本身不构成完成。

## Labels

当前尚未配置 Matt triage vocabulary，因为仓库目前没有引入 triage skill/configuration。只有在正式引入 triage 工作流后再增加对应 Label 映射。
