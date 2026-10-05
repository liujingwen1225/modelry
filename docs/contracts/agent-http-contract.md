# Agent HTTP 契约

状态：已接受。前缀 `/admin/api/v1/agent`，使用现有控制面认证、结构化错误与请求 ID。

| 路由 | 行为 |
| --- | --- |
| GET /config、PUT /config | Owner 读取或替换模型设置；明文密钥只写入，不回传 |
| POST /config/test | Owner 测试已保存的模型连接 |
| GET /tools | 共享工具目录、参数和业务许可 |
| GET /policies/{identity}、PUT /policies/{identity} | Owner 管理内置 Agent（builtin）或服务账号执行策略 |
| GET /sessions、POST /sessions | 列出或创建调用者自己的会话；Owner 可见全部 |
| GET /sessions/{sessionId} | 消息、步骤、运行及待确认状态 |
| POST /sessions/{sessionId}/messages | Owner 启动内置 Agent，输入 content 与 pageContext |
| POST /sessions/{sessionId}/cancel | 中止后续执行 |
| GET /sessions/{sessionId}/events | SSE；Last-Event-ID / after 断线续读 |
| POST /sessions/{sessionId}/tools | 调用共享工具，输入 name 与 arguments；批次最多 20 项 |
| POST /operations/{operationId}/approve、/reject | Owner 批准固定参数与目标快照或拒绝 |
| GET /operations/{operationId} | 查询调用者自己的操作；Owner 可见全部 |
| POST /sessions/{sessionId}/approve-batch | Owner 批准同会话固定普通操作清单 operationIds；高风险不能加入 |
| POST /sessions/{sessionId}/data-grants | Owner 授权具体集合及字段 |

执行策略包含 mode（readOnly / confirmWrites / autoWrites）、allowedOperations、autoOperations 和 revision。新增身份默认为 confirmWrites；内置 Agent 默认可访问工具目录中的业务许可，MCP 另与服务账号当前许可相交。

写入需要确认时返回 approvalRequired、operationId、reviewUrl；结果状态包括 awaitingApproval、executing、succeeded、failed、rejected、stale、interrupted。重复批准不重复调用业务 API。任务状态包括 running、awaitingApproval、completed、failed、cancelled、interrupted、paused。

模型设置包括 baseUrl、model、apiKeyConfigured、revision；保存 apiKey 可替换，clearApiKey 可清除。API URL 仅接受无用户信息的 HTTP(S) 地址；禁止重定向与配置外地址。配置在下一次任务生效。业务记录工具需要具体字段授权；结果不持久化，敏感字段被过滤。

内置任务固定启动时的模型与密钥；会话绑定发起时登录会话或 API Key，撤销后不能恢复权限。SSE 传递带递增序号的耐久状态快照，重连返回最新状态（含全部步骤），不自动重放写入。

恢复任务向模型提供最近耐久步骤摘要，禁止重放已完成或结果不确定的写入。普通写入自动必须同时勾选具体类别，不因选择策略而自动扩大操作许可。
