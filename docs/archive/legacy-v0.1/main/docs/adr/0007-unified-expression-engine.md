# ADR-0007：统一 Filter、Policy 与 Realtime 的 Expression Engine

- **状态：** Accepted
- **日期：** 2026-09-02

## 背景

Modelry 至少有三处需要表达条件：

1. Data API 的 Record Filter；
2. Record Policy；
3. Realtime Subscription Filter。

如果分别实现三套条件语言，会产生语义漂移、重复解析器、重复验证逻辑和不同安全边界。对于 Coding Agent 来说，同一个业务条件在不同位置必须使用不同语法，也会显著增加理解和生成错误。

直接暴露 SQL 虽然实现简单，但会把产品模型绑定到物理数据库，同时扩大注入风险，也不利于未来其他存储执行器。

## 决策

### 1. 建立统一 Expression Engine

V0.1 建立统一的声明式 **Expression Engine**，至少服务：

- Record Filter；
- Record Policy；
- Realtime Subscription Filter；
- Admin 数据查询条件。

这些能力共用同一套：

- 语法；
- Parser；
- AST；
- 类型检查；
- 字段与 Relation 解析；
- 运算符语义；
- 错误模型。

示例表达式：

`status == "published" && price >= 100 && author.id == auth.id`

表达式先解析为稳定 AST，再由当前存储执行层转换为查询条件或其他执行形式。

禁止把用户或 Agent 提供的 Filter / Policy 字符串直接拼接成 SQL。

### 2. V0.1 表达式能力保持有限且可静态分析

首版只支持清晰、可静态分析的能力，例如：

- `==` / `!=`；
- `<` / `<=` / `>` / `>=`；
- `&&` / `||` / `!`；
- 空值判断；
- 集合/枚举包含类操作；
- 字段访问；
- 有限 Relation 字段访问；
- 当前认证主体等显式上下文引用，例如 `auth.id`。

复杂任意 JavaScript 表达式、原始 SQL 函数和数据库特有函数不进入 V0.1 Expression Engine。

### 3. Record Policy 按操作独立求值

Record Policy 不是一个模糊的“Collection 权限字符串”，而是针对数据操作分别声明和求值。

V0.1 至少区分：

- `list`；
- `view`；
- `create`；
- `update`；
- `delete`。

同一个 Collection 可以为不同操作声明不同 Policy。

### 4. Policy 上下文必须显式

Policy 求值只能访问规格明确暴露的上下文，不允许隐式读取任意 Runtime 状态。

V0.1 至少保留以下概念性上下文：

- 当前认证 Principal；
- 当前 Record；
- Update/Delete 场景中的变更前 Record；
- Create/Update 场景中的候选变更后 Record；
- 明确允许访问的 Relation 字段。

具体语法在 Spec 中固定，但语义必须满足：

- **Create**：对候选新 Record 求值；
- **View/List**：对已持久化 Record 求值；
- **Update**：默认同时允许 Policy 检查变更前与候选变更后状态，避免通过更新把 Record 移出授权边界；
- **Delete**：对删除前 Record 求值。

任何需要只检查 before 或只检查 after 的例外，都必须通过显式语义表达，不能由执行顺序偶然决定。

### 5. List Policy 必须下推到查询

列表查询不能先读取全部 Record 再在应用层逐条过滤。List Policy 必须与用户 Filter 组合，并尽可能由同一个 Expression Engine 编译为存储查询条件。

这既是性能要求，也是避免未授权数据进入不必要内存路径的安全要求。

### 6. Relation Expand 不得绕过目标 Record Policy

Relation Expand 是二次数据读取，不因为父 Record 可读就自动获得关联 Record 的读取权限。

V0.1 规则：

- 父 Record 先按自身 Policy 判断；
- 每个被 Expand 的关联 Record 再按目标 Collection 的 `view` Policy 判断；
- 无权读取的关联对象不得泄露字段内容；
- 对单值/多值 Relation 的具体省略、`null` 或过滤表现，由 API Spec 固定并保持一致。

禁止因为 Expand 实现方便而绕过目标 Collection Policy。

### 7. Realtime Filter 受同一数据授权约束

Realtime Subscription Filter 与 Record Filter 共用 Expression Engine，但订阅过滤不能替代 Record Policy。

客户端只有在目标事件对应 Record 对当前 Principal 可读时，才允许接收该 Record 的实时事件；用户提供的 Subscription Filter 只是在授权结果之上进一步缩小事件集合。

## 后果

### 正面影响

- Filter、Policy 和 Realtime 条件语义一致；
- Agent 只需学习一套条件语言；
- Policy 的 Create/Update/Delete 边界变得可测试、可审计；
- Relation Expand 与 Realtime 不会形成旁路授权漏洞；
- 表达式可以被解析、校验、Diff、审计和结构化报错；
- 避免把公开产品契约绑定到 SQLite SQL 方言。

### 负面影响

- Modelry 需要实现并长期维护一套自己的表达式语言与 AST；
- List Policy 下推、Relation Policy 和 Update before/after 语义会增加规格与测试复杂度；
- 数据库高级查询能力不会自动暴露，必须显式扩展 Expression Engine；
- Relation、NULL、类型转换等边界语义必须在规格阶段定义清楚，否则容易产生执行差异。

## Spec Gate

进入实现前，Policy Spec 必须至少给出以下表格化验收案例：

- list/view/create/update/delete；
- anonymous / authenticated；
- before/after update；
- Relation Expand；
- Realtime；
- Policy 与用户 Filter 组合；
- NULL、缺失字段、Relation 不存在等边界。
