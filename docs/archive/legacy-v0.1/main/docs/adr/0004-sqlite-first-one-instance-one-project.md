# ADR-0004：采用 SQLite First，并坚持 One Instance, One Project

- **状态：** Accepted
- **日期：** 2026-09-02

## 背景

Modelry 的核心产品价值之一是极低的运维成本。如果 V0.x 就要求外部数据库、多 Project Control Plane、Redis 或 Message Broker，会削弱 Single Binary First，也会在 Backend Model 尚未验证前引入不必要复杂度。

同时，逻辑层 Backend Model 不应主动绑定 SQLite-only 产品语义，以免未来支持其他 Storage Runtime 时需要推翻产品模型。

但“未来可能支持 PostgreSQL”也不能成为 V0.x 提前制造一套通用 Database Adapter / Dialect Framework 的理由。只有一个真实数据库实现时，为假设中的第二个实现建立大量 pass-through interface 会增加代码表面积和 Agent 认知负担，而没有实际替换收益。

## 决策

V0.x：

- SQLite 是应用 Record 与 Modelry Metadata 唯一必需的数据库/存储引擎；
- 一个运行中的 Modelry Instance 只对应一个 Project；
- Project 数据存放在该 Instance 独立的数据生命周期中；
- File Storage 采用 Local First，并支持 S3-compatible 作为真实第二存储实现；
- Realtime 采用 SSE First。

V0.1 Core 不引入 Workspace 或多 Project Hosting。

### Backend Model 与 SQLite 产品语义解耦

Backend Model、Expression Engine、ChangeSet 和 Migration Operation 不直接暴露 SQLite SQL 作为公共产品契约。

这保证未来可以评估其他 Storage Runtime，而不承诺 V0.x 已经具备可插拔数据库架构。

### 不提前建立假设性 Database Adapter

V0.x 的实现应优先建立一个**深的 SQLite Persistence Module**，在内部封装：

- Record persistence；
- Schema/Migration execution；
- transaction；
- query compilation；
- Runtime metadata persistence。

不因为未来可能支持 PostgreSQL，就提前要求：

- `DatabaseAdapter` / `DialectAdapter` 一类覆盖所有数据库操作的通用接口；
- 为每个 SQLite 操作增加一层只有单一实现的 pass-through abstraction；
- 为不存在的 PostgreSQL 实现提前限制 SQLite 模块内部设计。

真正出现以下任一条件时，再通过“Design It Twice”评估并提取数据库 seam：

1. 已决定开始实现第二个 Storage Runtime；
2. 至少有两个真实执行路径需要变化；
3. 当前 SQLite-specific 细节已经泄漏到多个上层调用者，提取 seam 能显著恢复 locality。

公共 Backend Model 与 Expression AST 可以保持存储无关，但内部 persistence interface 不以“未来也许需要”作为存在理由。

### 真实多实现的 Adapter 可以保留

当产品当前就存在多个真实实现时，Adapter 是合理 seam。

例如 File Storage 同时存在 Local 与 S3-compatible 路径，因此 Storage Adapter 有现实变化来源，不属于假设性抽象。

## 影响

### 正面影响

- 零/低依赖的本地与自托管部署保持现实可行；
- Backup、Restore、迁移和 Project 检查具有简单统一的心智模型；
- V0.x 不提前承担分布式系统复杂度；
- SQLite 代码可以形成深模块，而不是被大量“未来 PostgreSQL”接口切碎；
- Backend Model 仍保持长期存储语义独立。

### 负面影响

- High Availability 与多节点水平扩展不是 V0.x 目标；
- 大规模写入场景未来可能需要其他 Storage 路径；
- 真正实现第二个数据库 Runtime 时，可能需要基于届时的两个真实实现重新提取 persistence seam；
- 不承诺当前内部 SQLite 模块可以无修改替换为 PostgreSQL。

## 实现护栏

V0.x Code Review 应主动标记以下 smell：

- 只有 SQLite 一个实现却出现大面积 `DatabaseAdapter`；
- 上层调用者为了抽象层而传递 SQLite 已经能内部推导的机械参数；
- Storage-agnostic interface 只是逐方法镜像 SQLite API，没有隐藏复杂度；
- 为假设中的 PostgreSQL 降低当前 SQLite 模块的 locality。

目标是：**产品语义保持存储独立，内部实现不做投机式通用化。**
