# ADR-0002：耐久 Record Event 与有界 Realtime Delivery

- **Status:** Accepted — Community V0.1.x
- **Date:** 2026-09-25
- **Scope:** Project Record Event 与 Application Realtime Subscription

## Context

Realtime 必须在 Record 已耐久提交后发布，并支持断线、进程退出和重启后的有序恢复。仅用内存广播会在进程退出或通知丢失时漏掉已提交变更；让 Record mutation 等待每个网络订阅者，又会把慢客户端带入业务事务。应用订阅还必须遵守当前 Applied Access Rule，包括创建、更新、删除与记录变得不可见的情形。

## Decision

每个成功的 Record Create / Update / Delete 都在拥有该变更的同一个 Project data transaction 中追加一条不可变 Record Event。事件写入失败时 Record mutation 一并回滚；事务失败、取消或回滚不会留下事件。Transaction commit 是唯一可观察的发布边界，任何运行时通知都只能在提交后唤醒订阅者，持久事件日志始终是重放事实来源。

每个 Collection 在 Project 内有自己的 Record Event 序列。Event ID 使用 `evt_<Collection ID 的 UTF-8 字节之无填充 Base64 URL-safe 编码>_<20 位单调序号>` 格式，在 Project 内唯一，并且不假设 opaque Collection ID 的前缀或字符集；同一 Collection 的序列顺序与 Record mutation 提交顺序一致，序号不承诺连续无间断。不同 Collection 之间不暴露可观察的总顺序，避免 Collection 订阅游标泄漏 Project 中其它 Collection 的活动。Event Cursor 使用同样的 Collection 编码与 `cur_` 前缀标识首次订阅时的 Collection 序列边界；收到 Record Event 后，稳定 Event ID 可直接作为恢复位置。序号为零只用于空边界游标，不用于 Event ID。游标和 Event ID 均绑定到一个 Collection。Collection-scoped 序号会暴露该 Collection 的序列进度；Collection List admission 是使用此进度的授权范围，ID / cursor 不包含其它 Collection 的活动。V0.1.x 只为 Record Create / Update / Delete 产生事件，不把 RequestRecord、AuditRecord、Schema Change 或通用 Activity 合并到事件序列。

Realtime Delivery 由当前单 Runtime 内的有界订阅协调器完成。它以有界通知唤醒订阅者，订阅者按 Event ID 从耐久日志读取并发送；每条连接单独取消、限流和设写入时限，业务 mutation 不等待 SSE 网络写入。每个 protected Event 发送前重新验证 Application Session、当前 Collection-level List admission 和对应 Record 的当前 List 行规则；每个 heartbeat interval 重新验证 Session 与 Collection-level admission。任一必要检查失败立即关闭该连接。运行时关闭时取消连接；相同 Project 重启后，客户端用 Last-Event-ID 从事件日志恢复。

事件日志使用 Project-wide 有界恢复窗口，最多保留最近 10,000 条事件且事件及授权评估快照合计不超过 64 MiB，先达到的上限生效；追加新事件时在同一事务中清理最旧记录，并按 Collection 持久推进最高已清理序号。单条事件与单次重放页的编码数据各自不超过 1 MiB，且单条事件上限不大于重放页上限；最多八个重放页同时解码或等待发送，活动订阅上限为 64。尚未清理该 Collection 的事件时不存在水位，其空序列零游标仍有效；清理发生后，游标严格早于最高已清理序号时返回明确的过期错误，游标等于水位仍可安全从其后继续。Project-wide 容量意味着其它 Collection 的写入可能缩短本 Collection 的重放窗口；过期响应只透露请求游标不在保留窗口，不返回触发压力的 Collection、事件身份、类型或值。此有界保留压力侧信道为 Community V0.1.x 接受的资源预算取舍。客户端对过期游标重新读取 Collection 当前 Records 并从新的 stream.ready 游标继续。单条事件时间是事务内记录的 UTC mutation timestamp，不承诺代表物理提交瞬间；Collection 序列是交付顺序权威来源。

Create / Update 事件保存提交后的 Record 快照；Update 同时保存变更前快照；Delete 保存删除前快照。快照只用于按当前 Applied Access Rule 过滤事件，不作为可独立读取的 Activity History。SSE 只向具有 Collection List 权限且通过该 Record 的当前 List 行规则的主体发送事件。Create / Update 发送其提交后 Record；Delete 只发送 Record ID；若 Update 使 Record 不再符合该主体的 List 规则，则发送只含 Record ID 的 `record.removed`。无法读取或评估当前规则时 fail closed，不发送该事件。事件快照、SSE 帧和遥测不得包含 Password、Session Token、API Key、Authorization Header 或其他内部 Credential。

Record Event 覆盖所有共享 Records 写服务并已提交的 Record mutation，包括 Admin 管理写入和 Auth Collection Profile Record 写入；事件是否可见仍仅由 Application Access Rule 决定。外部文件动作、Webhooks 和 Extensions 的副作用不能加入 SQLite 事务或伪装成与事件一起原子提交；本 ADR 不实现其 delivery。

## Consequences

- Record 与 Event 可以作为同一 durable fact 原子验证，回滚不产生伪事件。
- Event 重放保留一个明确的容量窗口；过期消费者必须通过当前 Records API 重新同步。
- 保存授权评估快照会短期重复受保护 Record 值，因此保留数量与字节均有硬上限，并且快照不能通过 HTTP 返回。
- Realtime 是单 Runtime / 单 Project 能力，不引入消息代理、外部分布式队列或跨 Project 顺序承诺。
