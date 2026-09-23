# GitFlow 开发规范

Modelry 自 2026-09-09 起采用 GitFlow 作为正式分支开发模型。

## 长期分支

### `main`

- 仅保存已经发布或准备发布完成的稳定版本。
- 禁止日常功能开发直接提交到 `main`。
- 只接受 `release/*` 与 `hotfix/*` 合并。
- 正式发布后以 `vX.Y.Z` Tag 标记。

### `develop`

- 唯一长期集成分支。
- 所有正常功能开发、契约冻结、文档实现收口最终都合并回 `develop`。
- 禁止把尚未完成或未通过验收的实验性提交直接推入 `develop`。

## 短期分支

### `feature/*`

- 从 `develop` 创建。
- 一个可独立验收的 GitHub Issue 原则上对应一个 `feature/*` 分支。
- 推荐命名：`feature/<issue-number>-<short-name>`。
- 完成后通过 PR 合并回 `develop`，随后删除远端 feature 分支。

示例：

- `feature/39-api-contract-freeze`
- `feature/89-application-auth-runtime`
- `feature/91-runtime-completion-spec-amendment`

### `release/*`

- 当 `develop` 已达到一个可发布版本的功能完整状态时，从 `develop` 创建。
- 仅允许版本稳定化、回归修复、版本号、发布文档等，不继续加入新功能。
- 完成后同时合并到 `main` 和 `develop`。
- 合并到 `main` 后创建正式版本 Tag，例如 `v0.1.0`。

示例：`release/v0.1.0`

### `hotfix/*`

- 仅用于已发布版本的紧急修复。
- 从 `main` 创建。
- 修复完成后同时合并回 `main` 与 `develop`。
- 如影响当前活动 release，也必须同步到对应 `release/*`。

示例：`hotfix/v0.1.1-runtime-lock`

## Prototype / Spike

新的技术验证使用 `spike/*`，从 `develop` 创建；验证结果必须沉淀到 ADR / Spike Result / Specification 后再结束。

Spike 代码不自动获得生产继承权，生产实现仍应通过正式 `feature/*` Issue 开发。

历史 `prototype/*` 分支只作为旧阶段遗留，不再创建新的 `prototype/*` 开发分支。

## PR 与 Issue 规则

- GitHub Issues 是正式任务跟踪器。
- Feature PR 的 base 必须是 `develop`。
- Release PR 的 base 必须是 `main`；release 同时回合 `develop`。
- Hotfix PR 的 base 必须是 `main`；完成后同步 `develop`。
- PR 必须引用对应 Issue，并列出测试 / 验证结果。
- Issue 未达到验收标准，不得因为“代码已提交”而提前关闭。
- 已冻结 Contract 与 Accepted Spec/ADR 冲突时，不允许 feature 分支静默修约；必须创建独立 Contract Gap Issue 并通过 review。

## 首次正式发布前的兼容策略

在 Modelry 首个正式支持版本通过 `main` 发布并创建 `vX.Y.Z` Tag 之前，仓库处于 **pre-release development** 阶段。

此阶段遵循以下规则：

- **不承诺开发期历史数据库、历史物理 Schema、内部实现或错误实现之间的向前升级兼容。** 某个旧 commit 曾经存在的实现，本身不构成兼容义务。
- 当历史开发实现与当前已经确认的 Accepted ADR、`CONTEXT.md`、Product Scope、Specification 或 Frozen Contract 冲突时，按照项目文档优先级修正到当前目标语义，不为错误实现自动增加 compatibility layer、legacy adapter、dual-read、dual-write 或 startup repair。
- 本地开发数据库、fixture DB、test DB、prototype DB 可以删除、重建、重新 bootstrap 或重新 Apply；除非某个 Specification / Issue 明确把 upgrade、migration 或 recovery compatibility 列为验收目标。
- **pre-release 不兼容历史开发状态，不等于可以忽略当前实现正确性。** 当前 HEAD 按当前 Spec 创建的数据，必须在该版本支持的 create / evolve / apply / recovery / restart 等流程中保持一致、精确且可恢复；不能用“开发阶段”作为跳过当前 migration precondition、数据完整性或持久化正确性的理由。
- 只有在以下情况之一成立时，开发阶段才产生明确的兼容要求：Frozen Contract 已经规定；Accepted ADR / Specification / Issue 明确要求；或该数据/格式被明确声明为必须保留的升级基线。
- 首个正式版本发布后，不再默认允许通过“删除重建”解决持久化格式变化。届时必须建立并遵守正式的 Compatibility Policy、Database Upgrade Policy、Migration guarantees 与 Contract deprecation policy。

因此，代码审查必须区分两类问题：

1. **开发历史兼容问题**：仅因为旧开发 commit / DB 曾使用不同实现而产生，默认不阻塞当前实现；
2. **当前版本正确性问题**：当前 Spec 下合法创建的数据在当前支持流程中会损坏、漂移、无法恢复或违反约束，必须作为真实缺陷处理。

## 当前 V0.1 分支映射

Frontend V0.1 Closure 冻结基线：

`5e140d6aa3ea33dbd40dfd3f56bf43949d64b550`

Data Plane Core 与 Runtime Completion Closure 已完成。Release Readiness 当前集成基线从：

`develop@793e0406d832aaa28668d4428a42b9cbebfc6eac`

继续演进。

```text
main
  \
   develop @ 793e0406
      |\
      | feature/129-secret-at-rest -> develop (merged)
      |
      ` feature/100-blog-release-e2e -> develop
               ↓
        Release Readiness / Hardening
               ↓
        release/v0.1.0
           ↙       ↘
        main      develop
          ↓
       tag v0.1.0
```

以下历史阶段分支不再作为开发入口：

- `frontend/admin-v0.1`：Frontend Closure 历史冻结分支。
- `contract/api-v0.1-freeze`：GitFlow 切换前创建，已由 `feature/39-api-contract-freeze` 取代。
- `prototype/admin-core-ui` / `backup/*` / `spec/*` / `docs/design-gap-closure`：旧阶段历史分支，确认无独有内容后删除。
- 已完成的 Data Plane feature 分支：合并且确认无独有内容后删除，不作为 Runtime Completion 的开发基线。

## 当前阶段

当前正式阶段：**V0.1.0 Release Readiness / Hardening**。

阶段规格：`docs/specs/0005-v0.1.0-runtime-completion.md`。

Runtime Completion 已按 Spec 0005 DAG 完成并通过 Closure；PR #129 已补齐 Secret material at-rest 加密。当前 Release Readiness 由 **#100 Blog Reference Application / Release Readiness E2E** 负责。

Release Readiness 必须保持真实 Runtime 闭环、可重复 repository-wide 验证与安全/升级门禁；GitHub Actions 只保留为可选手工诊断，不作为发布阻塞条件。发现 P0/P1 时创建独立 blocker Issue 并停止发布线。

所有实现仍必须通过 PR 合并回 `develop`，不得直接合并到 `main`。只有 Blog E2E、Hardening、repository-wide release gate 与独立 code-review 全部通过，且不存在未解决 P0/P1 后，才能创建 `release/v0.1.0`。
