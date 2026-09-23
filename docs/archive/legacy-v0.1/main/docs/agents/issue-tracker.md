# Issue Tracker 规范

## 唯一正式跟踪器

Modelry 使用 **GitHub Issues** 作为已经具备实现条件的工程工作的唯一正式任务跟踪器。

## 阶段边界

设计讨论不会自动变成实现 Ticket。

默认生命周期：

`grill-with-docs -> to-spec -> to-tickets -> implement -> code-review`

只有当相关产品/架构决策已经 Accepted，并且已经形成足够具体的 Specification 后，才创建实现级 Issue。

## 实现级 Issue 质量要求

一个可直接进入实现的 Issue 应明确：

- 用户或系统最终要达到的结果
- 范围和明确的非目标
- 相关产品不变量和 ADR 引用
- 验收标准
- 依赖关系或实施顺序
- 测试与验证要求

## 工作粒度

优先拆成小型、可独立审查、能够保持架构边界的 Issue。

除非工作本身就是 Prototype / Spike，否则不要把 Schema Engine、Auth、UI、MCP、Deployment 等多个大型关注点混在一个 Issue 中。

## Spike

一次性技术验证必须明确标记或描述为 Spike。Spike 的目标是产出可复现证据和架构决策，而不是悄悄演化成生产实现。

## Labels

当前尚未配置 Matt triage vocabulary，因为仓库目前没有引入 triage skill/configuration。只有在正式引入 triage 工作流后再增加对应 Label 映射。
