# ADR-0010：文件、事件、Hook 与 Webhook 运行模型

- **状态：** Accepted
- **日期：** 2026-09-02

## 背景

Modelry V0.1 需要同时覆盖文件上传、Secret、Hook、Realtime、Webhook 与 Audit。如果这些能力分别监听数据库、各自定义事件和权限语义，会快速形成重复实现与不一致行为。

同时，Modelry 必须保持 Single Binary First 和 SQLite First，不依赖 Redis、Kafka、RabbitMQ 等额外基础设施才能获得可靠的基础事件投递能力。

事件模型还必须避免一个关键可靠性漏洞：如果业务事务已经 Commit，而 Webhook Outbox、可靠 Event Hook 任务或必要 Audit 记录在 Commit 之后才单独持久化，那么 Runtime 在两者之间崩溃会造成“业务成功但副作用任务永久丢失”的状态。

## 决策

### 1. File is a Field

File 在 Backend Model 中作为 Collection Field 表达，而不是独立复杂的 Asset 业务模型。

File Field 可声明数量、大小、MIME Type 等约束，文件读取默认继承所属 Record 的 Read Policy。

底层 File Service 维护稳定 File Reference 与文件元数据，Storage 通过 Adapter 解耦。

V0.1：

- 默认 Local Storage；
- 支持 S3 Compatible Storage 作为扩展路径；
- 通过 Upload Session 管理临时上传、Record 绑定和未绑定文件 GC。

### 2. Secret 是一级 Control Plane 资源

Secret 支持名称/存在性 Inspect，以及创建、替换、删除。普通管理接口默认不允许重新读取明文。

Hook Runtime 可以通过受控 Runtime API 使用 Secret。Coding Agent 可以在明确授权下写入 Secret，但后续只能读取存在状态。

### 3. 区分 Lifecycle Hook 与 Event Hook

Lifecycle Hook 在事务提交前同步执行，用于本地确定性的校验、字段补全和阻止操作。

Event Hook 消费事务成功提交后的 Domain Event，用于邮件、外部 HTTP、第三方 API 等副作用。

**External side effects happen after commit。**

事务内 Lifecycle Hook 不允许依赖不可回滚的外部副作用来保证业务正确性。

### 4. Domain Event 是统一事件骨干

Realtime、Event Hook、Webhook 与 Audit 必须共享同一领域事件语义，不分别监听数据库形成多套事实来源。

概念链路为：

`Mutation -> Policy/Validation -> Lifecycle Hook -> Transaction -> Commit -> Dispatch`

但 **Domain Event 的耐久事实不是 Commit 之后才开始创建**。

对需要可靠处理的事件，业务变更与对应的 Durable Event Fact / Delivery Task 必须在同一个数据库事务中原子写入。

### 5. 可靠事件事实与业务 Mutation 同事务持久化

标准可靠链路：

```text
Policy / Validation
        ↓
Lifecycle Hook
        ↓
BEGIN TRANSACTION
  ├─ Business Mutation
  ├─ Durable Domain Event Fact
  ├─ Webhook Outbox Entry（如有订阅）
  ├─ Durable Event Hook Task（如需可靠执行）
  └─ Required Audit Fact
COMMIT
        ↓
Post-commit Dispatch
  ├─ Realtime
  ├─ Event Hook Worker
  ├─ Webhook Delivery Worker
  └─ Audit Projection / Query
```

因此：

- Outbox Entry 的写入不是“外部副作用”，允许且必须与业务 Mutation 同事务；
- 真正的 HTTP 请求、邮件发送和第三方 API 调用只能在 Commit 之后；
- Runtime 在 Commit 后立即崩溃时，可靠任务仍可在重启后恢复；
- 不允许存在业务数据已 Commit、但本应可靠的 Webhook/Audit/Event Hook 事实尚未持久化的正常窗口。

### 6. 不把 Modelry 变成 Event Store

统一 Domain Event 不意味着保存完整无限 Event History。

V0.1 区分：

- **Realtime** —— transient / best effort；
- **Lifecycle Hook** —— synchronous / transactional；
- **Event Hook** —— 对声明为 reliable 的 Hook 使用 durable / at-least-once；
- **Webhook** —— durable / at-least-once；
- **Audit** —— 按审计策略 durable。

Durable Event Fact 可以在所有相关 Delivery/Audit 要求满足后按照保留策略清理，不要求永久保存为业务 Event Store。

### 7. Event Hook 可靠性必须显式

V0.1 Event Hook 默认按可靠异步副作用设计，避免邮件、第三方同步等任务因 Runtime 短暂崩溃永久丢失。

其语义至少包括：

- at-least-once delivery；
- retry/backoff；
- 最大尝试次数；
- 最终失败状态；
- 可查询的错误与执行记录；
- Hook Handler 必须按幂等执行设计。

如果未来增加显式 best-effort Event Hook，必须作为单独模式声明，不能由实现偶然决定。

### 8. Webhook 使用 Transactional Outbox

Webhook Delivery 使用 SQLite Transactional Outbox，支持：

- 异步 HTTP Delivery；
- 失败重试；
- Backoff；
- 最大重试次数；
- 最终失败状态。

Webhook Outbox Entry 与触发它的业务 Mutation 在同一个事务中创建。

Webhook 使用稳定事件 Envelope，并通过 HMAC Signature 证明请求来源。V0.1 不内置通用 Payload Script/Template Transform，复杂转换交由 Hook。

消费方必须使用稳定 Delivery/Event 标识做幂等处理，因为 at-least-once 语义允许重复投递。

### 9. Audit 分为 Required Audit Fact 与派生展示

涉及 Control Plane、Administrative Data Access、高风险操作以及明确要求审计的业务事件，其最小 Audit Fact 必须与对应状态变更原子持久化或由同一耐久事件事实保证可恢复生成。

面向 UI 的富化字段、索引或查询 Projection 可以异步构建，但不能因为 Projection 失败导致原始审计事实丢失。

### 10. Realtime 保持 Best Effort

SSE Realtime 只面向在线体验，不提供消息队列级 Delivery Guarantee。

如果客户端断线：

- 可以使用标准重连机制恢复连接；
- V0.1 不承诺任意历史事件重放；
- Realtime 不得被应用用作唯一可靠业务任务队列。

## 结果

### 正面影响

- File 权限语义保持与 Collection/Record 一致；
- Realtime、Hook、Webhook 和 Audit 共享同一领域事件事实来源；
- 消除“业务已 Commit，但可靠副作用任务尚未持久化”的 crash window；
- 事务内逻辑与提交后外部副作用边界明确；
- 单机 SQLite 即可实现可靠 Webhook/Event Hook 重试；
- Agent 可以通过 Backend Model 明确理解 File、Event、Webhook 和 Secret，而不是面对隐式运行规则。

### 负面影响

- Runtime 需要维护 Durable Event/Outbox 状态和清理策略；
- Event Hook Handler 必须考虑重复执行和幂等；
- SQLite Outbox 适合 V0.x 单实例模型，但未来多节点高可用场景需要重新评估 Delivery 协调机制；
- File 默认继承 Record Policy，未来若出现独立 Asset Sharing 需求，需要单独新增显式能力。

## 不变量

1. External side effects happen after commit。
2. Reliable delivery intent is persisted before commit completes。
3. Realtime 不是可靠消息队列。
4. Webhook 与 reliable Event Hook 都按 at-least-once 设计。
5. 同一业务事件不得由各子系统自行重新解释数据库状态产生。
