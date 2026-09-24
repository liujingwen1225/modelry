# ADR-0001：Runtime 与 Storage Architecture

- **Status:** Accepted — V0.1 Runtime / Storage Architecture Baseline
- **Date:** 2026-09-24
- **Scope:** Modelry Community V0.1

## Context

Modelry Community V0.1 必须从合法空目录直接启动，以低运维方式运行一个 Project，并在 Reload / Restart 后保留可验证的 Durable Result。V0.1 的技术边界是 Go、Modular Monolith、SQLite Only、Local Storage；Product Semantics 由 Backend Model 定义，不能等同于 SQLite 私有语义。Commercial / Enterprise 的 PostgreSQL 与 Cloud Control Plane 属于后续形态。参见 [V0.1 范围](../04-v0.1-community-scope.md)、[技术路线](../02-technical-roadmap.md) 和 [产品架构](../06-product-architecture.md)。

模型、数据、凭证、会话、控制面事实与本地文件必须形成可恢复的持久化边界。SQLite 事务不能与文件系统 rename/unlink 组成一个原子提交；ADR 因此必须定义数据库提交事实和文件副作用之间的恢复规则。普通用户需要看到健康状态和行动建议，不需要承担理解 WAL 或物理迁移细节的负担。

## Decision

### 1. Go Modular Monolith 与 V0.1 拓扑

- V0.1 使用一个 Go Runtime 进程；Application Data Plane 和 Modelry Control Plane 是同一进程内职责分明的模块，共用领域服务、授权、Change Lifecycle、审计边界和 Project Storage。
- Admin HTTP、Application HTTP、CLI 与后续 Core MCP 调用同一组应用服务，不另建业务旁路。CLI 和 MCP 不是独立后端。
- V0.1 的一个 Runtime 进程只服务一个隐式 Project Root，并独占该 Project 的 SQLite 文件和 Local Storage。启动时持有该 Project 的跨平台进程锁；发现同一 Root 已被另一 Runtime 持有时，拒绝启动并给出可行动错误。该锁是实现 V0.1 单进程拓扑的运行时保护。
- One Runtime / One Project 是 Community V0.1 的部署拓扑，不是永久产品或 Domain 不变量。不要在此基础上引入 Organization、Environment、Tenant URL、Cloud Plane、服务拆分或未来 PostgreSQL 实现。

### 2. Deterministic Project Root 与零配置启动

Project Root 按以下优先级唯一解析：

1. 显式 CLI 参数 `--project-root`；
2. 环境变量 `MODELRY_PROJECT_ROOT`；
3. 进程启动时的当前工作目录。

相对路径一律相对当前工作目录解析。运行时将路径解析为绝对路径并按当前操作系统规范清理；现有目录的符号链接解析为其目标路径。路径比较与文件操作使用 Go `filepath` / 原生文件系统语义，不手工拼接 POSIX `/`，不假设盘符、卷名或大小写语义。Runtime 不因启动而改变进程当前目录。

Project Root 必须是已存在且可访问的目录；合法空目录不需要配置文件、manifest、数据库文件、安装步骤或用户创建子目录。Runtime 只在 Root 下创建和管理 `.modelry/`，不改写 Root 中其它文件。若参数路径不存在、不是目录、无法解析或不可访问，启动失败并指出选择的来源和修复方法；不悄悄回退到可执行文件目录或用户主目录。

Project Root 是定位本地 Project 的边界；绝对路径不是业务身份或产品语义。诊断信息记录 Root 来源（flag / environment / working directory）和解析后的路径，具体 HTTP 表达由 Contract 冻结。V0.1 Settings 保持只读诊断，不增加 Runtime Settings 编辑器。

首次成功初始化时，Runtime 在其受管持久状态中生成并保存稳定、不含路径信息的 Project ID。Project Root 的移动或重命名不改变该逻辑身份；同一路径重新初始化为全新空 Project 时会生成新的身份。

### 3. 受管文件布局

Runtime 在 Project Root 下使用以下平台无关的相对布局，实际分隔符由操作系统处理：

```text
<Project Root>/
  .modelry/
    project.sqlite              # 含稳定 Project ID 与 Runtime 持久状态
    runtime.lock
    files/
      tmp/
      objects/
```

- `.modelry/project.sqlite` 是该 Project 唯一的持久 SQLite 数据库。它承载该 Project 的 Applied Model 状态及 SQLite 物理投影、Runtime 数据、Admin / Application 身份与会话、Control Plane 状态、Change / Migration Ledger 和 Audit 等结构化数据。模块保有语义与写入边界，不直接共享原始数据库 Handle。
- `.modelry/files/` 是 V0.1 Local Storage；`tmp/` 只放未绑定上传，`objects/` 放不可变的已落盘文件对象。持久化到 DB 的 Storage Key 是由 Runtime 生成的相对 opaque key，不包含用户提交的文件名、Root 绝对路径或可执行的 `..` 路径片段。
- Runtime 仅管理 `.modelry/`。不把 DB / Storage 放到用户 Home、二进制所在目录或临时目录。产品 UI 仅显示 Local provider、路径、健康及可信的用量诊断。
- Project Root 与 SQLite/WAL/Local Storage 必须位于同一台机器的本地文件系统。WAL 需要同机连接共享内存，不支持通过网络文件系统共享数据库；V0.1 不承诺网络挂载 Project Root。路径语法仍须适配 Windows、macOS、Linux 的原生绝对路径和卷规则。

### 4. SQLite 所有权、打开方式与连接设置

- Runtime 是 SQLite 的唯一生命周期所有者：启动阶段打开并验证连接池，所有模块通过有界的 Storage / Migration Boundary 使用它；服务停止并完成排空后关闭它。不得在每个请求中私自重新打开数据库或把裸连接暴露给业务模块。
- V0.1 使用单个落盘 SQLite 数据库和有界连接池，默认最多打开 8 条物理连接，所有事务固定在单条连接内。使用 WAL 允许本进程读请求与写请求并行读取各自快照；SQLite 仍一次只允许一个写者，写操作必须短小并有明确事务范围。V0.1 启用 WAL，因此运行时携带的 SQLite 必须包含 2026-03 WAL-reset corruption fix：SQLite 3.51.3 或更高版本，或经上游确认包含相同修复的受支持回补版本。启动时检查 SQLite 版本和实际 PRAGMA 值；不满足时拒绝进入 READY。
- 每条新建物理连接都必须显式设置并验证 `foreign_keys=ON`、`busy_timeout=5000` 毫秒和 `synchronous=FULL`；不能依赖 SQLite 默认值或只初始化池中的第一条连接。WAL 模式在数据库初始化时启用并读取确认，无法启用时视为 Storage 初始化失败。保留 SQLite 的自动 WAL checkpoint；正常关闭时完成连接关闭和可完成的 checkpoint。健康或退出错误必须保留可诊断信息。
- Busy 等待耗尽或请求取消时，操作返回可重试、可追踪的存储错误，不无限重试、不报告成功。统一错误码及 HTTP 映射由 Core HTTP Contract 定义。
- WAL 的数据库文件、`-wal` 与 `-shm` 在 Runtime 运行期间属于同一持久状态；不得建议用户只拷贝主 `.sqlite` 文件。V0.1 不实现 Backup / Restore 产品面；运行时外部备份需要停机或使用一致性备份机制。

### 5. Transaction Boundaries

所有事务由领域应用服务界定；一个产品操作只有一个逻辑提交边界。一个事务内不能通过另一个连接绕过其隔离边界，也不将整个 HTTP 请求或整个 Runtime 包进一个全局事务。

| 操作 | 原子提交内容 | 失败语义 |
| --- | --- | --- |
| Record Create / Update / Delete | 当前 Record 及同一产品操作涉及的结构化值、Relation 引用和必要的系统字段 | 全部回滚；不留下半写 Record。外部文件动作按下方 Local Storage 恢复规则处理。 |
| Schema Apply | Apply 时重新验证 Preconditions；物理 DDL；Applied Model 更新；成功的 Applied Migration Ledger fact；对应 Change 状态及 Pending Operation 清理；本次必须产生的 AuditRecord | 事务失败则物理 Model / Applied Model / Ledger 一并回滚，Pending 保留。失败 Apply Attempt 在回滚后以独立事务保存诊断；进程崩溃留下的 In Progress Attempt 在重启时标记为中断 / 待恢复。重试创建新的 Apply Attempt。 |
| App User 创建 | Profile Record 与 Password Credential 的建立 | 两者在同一 SQLite 事务内成功或失败；不得出现只有 Profile 或只有密码凭证的用户。 |
| Credential / Session 操作 | Credential 变更、受影响的 Session 撤销、Session 签发或撤销状态 | 凭证更新与同一产品操作要求的 Session 状态变化在一个事务提交。Session 必须先持久化再向客户端确认签发；持久化失败不得返回有效 Session。 |
| Control Plane Mutation | Owner / Service Account / API Key / Access Rule / Auth Configuration 等对应状态及按语义必需的 AuditRecord | 业务状态与必需 Audit fact 同一事务提交。不能只提交其中一方。 |
| Audit | Append-only 的安全 / 治理 Durable Fact；与它所证明的受审计控制面操作同一事务 | Audit 写入失败时回滚该受审计操作；不可伪报成功。Audit 不与 Application RequestRecord 混为一类。 |

Record 或 API 调用的 RequestRecord 属于运行遥测，不是 Audit fact。它只保留已接受范围内的请求元数据；不因记录失败而伪造业务提交，也不把 Raw Credential、Authorization Header 或敏感完整请求 / 响应体写入日志。#4 Domain Spec 定义事件级归属和安全字段；本 ADR 冻结提交原子性。

密码等 Credential 的原始值不作为持久数据库值或日志内容保存；#4 Domain Spec 定义凭证对象，具体派生算法由后续安全设计冻结。该边界与 [Admin Product UX Spec](../specs/0001-admin-product-ux-spec.md) 中 password 不进入 Schema、不回显、不出现在普通 Record API response 的要求一致。

### 6. Applied Model、Pending Change、Physical Migration 与 Ledger

- **Pending Model Change** 是已耐久保存但尚未应用的提案；它不能改变当前 API / Records 所依据的 Applied Model 或物理数据库。
- **Applied Model** 是 Runtime 当前已接受的 Backend Model 语义状态，也是运行时行为的产品语义依据。
- **Physical Migration** 是把 Applied Model 投影落实到 SQLite 结构所执行的有界、可恢复物理操作；其 DDL 与 Applied Model 更新必须处于同一 SQLite 事务。V0.1 支持的 Apply 操作不得依赖不能回滚的文件或网络副作用。
- **Applied Migration Ledger** 是已提交变更的不可变 Durable Fact，至少能关联成功的模型变更 / Change、差异摘要和提交事实。仅在上述物理变更与 Applied Model 同一事务成功时写入；创建后不更新、不删除。数据库拒绝此事务即代表这次应用没有成功 fact。
- **Apply Attempt** 表示一次独立尝试，有自己的 ID 和最终结果。尝试记录先耐久建立为 In Progress；成功时与 Physical Migration / Ledger 一起完成，失败时回滚应用事务后单独记录失败和诊断。重试始终建立新的 Apply Attempt，不覆写旧结果，也不能改写已应用 Ledger fact。
- Runtime 自身的内部 Store Schema Upgrade 有独立版本空间与内部迁移记录；不得伪装成用户的 Backend Model Change 或写入用户可见 Applied Migration History。
- SQLite 表名、DDL 或迁移脚本不取代 Domain Spec；未来 PostgreSQL 可采用不同物理 DDL，但必须继续遵守相同 Product / Domain Contract。

### 7. Local Storage / Single File Field 生命周期

V0.1 只支持 Local Storage 和 Single File Value。多个文件值、S3 provider、通用文件资产管理与额外 Hook 均不进入此 ADR 的实现范围。

1. 上传内容流式写入 `.modelry/files/tmp/` 下 Runtime 生成且独占创建的临时名；在绑定前完成大小与 MIME 约束校验。不得把用户文件名用作路径，上传失败时尽力删除临时内容。
2. 绑定到 Record 时，Runtime 将完整临时文件关闭并 flush，然后在同一文件系统内把它 atomic rename 到 `.modelry/files/objects/` 下新的不可变 opaque 名称；避免覆盖已有对象。只有随后将 Storage Key 与 Record 在同一 SQLite 事务持久化后，业务层才报告绑定成功、允许读取。
3. SQLite 与文件系统不可组成同一事务。若 rename 成功而 DB 事务失败，保持 DB 引用不变；新文件是孤儿，按恢复规则清理。若 DB 提交成功而旧文件删除失败，提交仍然成功，旧对象保留为孤儿并由清理器回收。文件删除必须发生在 DB 引用移除之后。
4. Runtime 以数据库中的有效引用为已绑定事实。启动 / 后台 reconcile 清理过期未绑定临时文件和已超过安全宽限期的未引用对象；清理前确认对象不再被 Durable Record 引用，并避免回收仍有活动租约的上传。无引用对象清理失败可重试并暴露诊断；被 Record 引用的缺失文件不得伪装为可用或被清理器忽略。
5. 文件更新使用新对象并原子切换 DB 引用，不原位覆盖旧对象。文件读取始终先鉴权并解析 Runtime 管理的 Storage Key；不得信任调用者提供的文件系统路径。

### 8. Startup Readiness

启动只在以下条件全部满足后报告 `READY`：

1. Project Root 已唯一解析，`.modelry/` 及 Local Storage 路径可用，且当前进程取得该 Root 的 Runtime 锁；
2. SQLite 版本受支持，数据库文件成功打开，必要 PRAGMA 已验证，内部 Store Schema Migration 已完成，Applied Model / 物理投影可以安全服务请求；
3. Local Storage 的必要目录通过读写检查，文件引用一致性检查无阻断问题；
4. Runtime 模块初始化成功，HTTP Listener 已成功 bind，受保护的 Domain Services 已可用。

顺序为：解析配置与 Root → 锁定 Project → 建立目录 → 打开 / 验证 SQLite → 执行内部迁移与一致性检查 → 初始化模块 → bind Listener → 对外切换至 READY。更早的阶段是 Starting；任一步失败都不得报告 READY。可提供诊断响应时必须明确标为 Not Ready / Unavailable，且不允许通过产品 API 执行不安全写操作；否则退出并附可行动错误。运行期依赖失效时立即撤销 READY，并遵守同一门禁。

Status/Settings 诊断遵从 [Admin Product UX Spec](../specs/0001-admin-product-ux-spec.md)：Runtime、Database、Storage 的 Unknown / Unavailable 不得显示为 Ready；展示 provider、路径、健康和适用的重启指导。外部 HTTP 字段与错误映射由 Contract 定义。

### 9. Graceful Shutdown

收到适用的终止信号（POSIX SIGINT / SIGTERM、Windows Ctrl+C 或进程取消）时，Runtime 按统一停止流程执行：撤销 READY 并停止接收新业务流量 → 有界排空已开始的 HTTP / CLI / MCP 操作与上传 → 取消超时操作并回滚尚未提交的 DB 事务 → 停止后台 reconcile / checkpoint 任务 → 关闭连接池并记录关闭错误 → 释放 Project 锁并退出。默认排空窗口为 10 秒；到期后强制取消尚未完成工作，但不伪报未提交操作成功。已成功提交的 SQLite 事务按 `synchronous=FULL` 保留；文件孤儿交给下一次安全 reconcile。

## Consequences

- 空目录零配置启动和路径来源可以复现；Runtime 不依赖调用者从特定 shell 或安装位置启动。
- 同一 Project 的应用数据、控制面、安全事实与模型变化使用同一 SQLite 提交边界；操作失败后的持久状态可解释并可恢复。
- SQLite / WAL 的本地文件约束、文件系统非原子副作用与诊断规则明确；产品可以在未来更换物理 Storage，而不把 SQL 私有细节泄露到 Domain / HTTP。
- WAL + FULL 提供同机读写并发和较强的已提交数据耐久性，代价是需要兼容版本、checkpoint 管理和同机本地文件系统。已知上游 SQLite 文档记录 WAL-reset 修复要求；SQLite 版本升级必须重新核验该风险。
- 事务必须保持短小；长文件流不持有 SQLite 写事务。若未来 Apply 包含不可回滚外部副作用，必须通过新 ADR / Domain Contract 定义恢复状态，不能静默扩大本事务假设。
- 10 秒排空窗口是 V0.1 运行时默认，不引入可编辑 Runtime Settings 产品面。

## Non-goals

- PostgreSQL Runtime、任意数据库 Adapter Marketplace、S3-compatible Storage、Multiple File Values；
- Cloud / Organization / Environment / Tenant Plane；
- Microservices、分布式队列、Workers、HA、多 Project Runtime；
- Realtime、Lifecycle Hooks、Extension Runtime、Secrets；
- Full Backup / Restore 产品工作流或可编辑 Runtime Settings。

## References

### Repository authority

- [Issue #2 — V0.1 Foundation Closure](https://github.com/liujingwen1225/modelry/issues/2)
- [Issue #3 — ADR-0001 scope and acceptance criteria](https://github.com/liujingwen1225/modelry/issues/3)
- [CONTEXT.md](../../CONTEXT.md)
- [AGENTS.md](../../AGENTS.md)
- [00 Product Vision](../00-product-vision.md)
- [01 Product Roadmap](../01-product-roadmap.md)
- [02 Technical Roadmap](../02-technical-roadmap.md)
- [03 Editions and Cloud](../03-editions-and-cloud.md)
- [04 V0.1 Community Scope](../04-v0.1-community-scope.md)
- [05 Product Experience and Acceptance](../05-product-experience-and-acceptance.md)
- [06 Product Architecture](../06-product-architecture.md)
- [SPEC-0001 Admin Product UX](../specs/0001-admin-product-ux-spec.md)

### SQLite primary references

- [Write-Ahead Logging](https://www.sqlite.org/wal.html) — WAL reader/writer behavior, same-host requirement, checkpointing and current WAL-reset fix notice.
- [SQLite Foreign Key Support](https://www.sqlite.org/foreignkeys.html) — Foreign keys must be enabled per connection.
- [SQLite PRAGMA Reference](https://www.sqlite.org/pragma.html) — `foreign_keys`, `busy_timeout`, `synchronous`, `journal_mode` and checkpoint behavior.
- [SQLite Temporary Files](https://www.sqlite.org/tempfiles.html) — WAL/SHM file lifecycle and the limits of multi-file atomic commit in WAL mode.

## Implementation Constraints for #7

- The selected Go SQLite driver / connector must guarantee per-physical-connection PRAGMA initialization and expose its bundled SQLite version for the startup check. Driver selection must not weaken the stated WAL, transaction or durability contract.
- The cross-platform Project lock adapter must have process-lifetime lock semantics on supported Windows, macOS and Linux filesystems; stale lock files must not prevent a later valid startup after process exit.
- The `5,000 ms` busy timeout, 8-connection pool limit and `10 s` shutdown drain window are V0.1 defaults. Any change requires an explicit ADR amendment and real-runtime verification.
