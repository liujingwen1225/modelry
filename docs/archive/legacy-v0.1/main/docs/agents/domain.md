# 领域文档规范

Modelry 当前采用 **单一上下文（single-context）** 领域文档模型。

## 唯一领域上下文

根目录 `CONTEXT.md` 是统一术语、概念关系和长期领域不变量的唯一主文档。

任何涉及 Collection、Policy、Migration、Principal、Auth、Hook、Event、Data Plane 或 Control Plane 的规划与实现，Agent 和贡献者都必须先阅读该文档。

## CONTEXT.md 应记录什么

只记录已经确认且长期稳定的领域语言，包括：

- 实体与抽象定义；
- 生命周期语义；
- 概念关系；
- 被多个功能共同依赖的产品不变量；
- 同一术语在所有入口都必须保持一致的语义。

## CONTEXT.md 明确禁止记录什么

`CONTEXT.md` 必须保持 implementation-free，不记录：

- 编程语言、Runtime、Framework；
- 数据库、消息队列、对象存储等产品选择；
- 目录结构和文件名；
- JSON/SQL/TypeScript 等具体持久化格式；
- HTTP 路径；
- CLI 命令；
- UI 页面；
- SDK 方法；
- 临时 Spike 结果；
- 尚未决定的备选方案。

这些内容应进入 Product Scope、ADR、Spike 或 Specification。

如果一个术语只能通过具体文件路径、类名或数据库表才能解释清楚，说明它还没有被提升为真正稳定的领域概念，不应直接塞入 `CONTEXT.md`。

## ADR 边界

ADR 用来保存重要且长期的架构决策，不是普通设计笔记。

新 ADR 原则上应同时满足：

1. **难以逆转或改变成本明显**；
2. **如果缺少背景，结果并非显而易见**；
3. **确实存在过有意义的取舍或替代方案**。

如果只是对既有 ADR 的规格细化，应优先修改/补充原 ADR 或进入 Specification，不为每个小决定创建新 ADR。

Modelry 的典型 ADR 主题包括：

- Runtime / Platform 选择；
- Source of Truth 与 Migration 模型；
- Agent / ChangeSet 安全模型；
- Extension 故障边界；
- Data/Control Plane 授权边界；
- Project / Instance 生命周期；
- 难以逆转的公共 API Contract。

## 文档优先级

当文档发生冲突时：

1. Accepted ADR 定义已经做出的架构决策；
2. `CONTEXT.md` 定义这些决策沉淀后的统一领域语言；
3. Product Scope 定义某个 Release 是否实现该能力；
4. Specification 定义具体可实现/可验收行为；
5. README 只作为入口摘要，不得覆盖上述正式基线。

如果 Accepted ADR 与 `CONTEXT.md` 语义冲突，应立即修正漂移，而不是由实现者自行选择其中一个。

## 何时拆分上下文

在仓库真正形成多个具有独立业务含义的 Bounded Context 之前，不引入 `CONTEXT-MAP.md` 或 package 级 Context 文档。

仅仅目录变多、packages 变多，并不足以成为拆分上下文的理由。
