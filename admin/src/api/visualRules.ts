import { api, apiRequest } from './client'

/** 触发事件：与后端允许值一一对应，不在前端扩展。 */
export type TriggerEvent = 'record.created' | 'record.updated' | 'record.deleted'

/** 触发用户：三个字段都可缺省，对应 test / run 请求体里的 user。 */
export type RuleUser = {
  id?: string
  email?: string
  displayName?: string
}

/**
 * 单条可视化业务规则。
 * values 的键必须是目标集合真实存在、且非 system 的字段名；值是模板字符串。
 */
export type Rule = {
  id: string
  name: string
  triggerCollectionId: string
  triggerEvent: TriggerEvent
  targetCollectionId: string
  values: Record<string, string>
  enabled: boolean
  retryEnabled: boolean
  timeoutMs: number
  revision: number
  createdAt: string
  updatedAt: string
}

/** 创建 / 更新规则的请求体；三个高级配置项可省略。 */
export type RuleInput = {
  name: string
  triggerCollectionId: string
  triggerEvent: TriggerEvent
  targetCollectionId: string
  values: Record<string, string>
  enabled?: boolean
  retryEnabled?: boolean
  timeoutMs?: number
}

/** 一次执行记录：test 为 dry-run，live 为真实写入。 */
export type Run = {
  id: string
  ruleId: string
  kind: 'test' | 'live'
  status: 'succeeded' | 'failed'
  payload: { user?: RuleUser }
  values: Record<string, string>
  recordId?: string
  errorCode?: string
  errorMessage?: string
  attemptOf?: string
  createdAt: string
  finishedAt?: string
}

export type TestCheck = {
  label: string
  passed: boolean
  detail?: string
}

/** test 响应：dry-run 不写入业务数据，但会持久化一条 kind='test' 的执行记录。 */
export type TestResult = {
  passed: boolean
  checks: TestCheck[]
  values: Record<string, string>
  runId: string
}

export const visualRuleKeys = {
  list: ['visual-rules'] as const,
  detail: (id: string) => ['visual-rule', id] as const,
  runs: (id: string) => ['visual-rule-runs', id] as const,
}

export const visualRulesApi = {
  list: () =>
    api.get<{ data: Rule[] }>('/admin/api/v1/visual-rules').then((response) => response.data),

  get: (id: string) =>
    api.get<{ data: Rule }>(`/admin/api/v1/visual-rules/${id}`).then((response) => response.data),

  create: (input: RuleInput) =>
    api.post<{ data: Rule }>('/admin/api/v1/visual-rules', input).then((response) => response.data),

  update: (id: string, input: RuleInput) =>
    api.put<{ data: Rule }>(`/admin/api/v1/visual-rules/${id}`, input).then((response) => response.data),

  // 启用 / 停用按契约「无 body」：走底层 apiRequest，不发送空 JSON 请求体。
  enable: (id: string) =>
    apiRequest<{ data: Rule }>('POST', `/admin/api/v1/visual-rules/${id}/enable`).then((response) => response.data),

  disable: (id: string) =>
    apiRequest<{ data: Rule }>('POST', `/admin/api/v1/visual-rules/${id}/disable`).then((response) => response.data),

  /** dry-run：只渲染模板并逐项校验，不写任何业务数据，但会留下一条测试执行记录。 */
  test: (id: string, body: { user?: RuleUser }) =>
    api.post<{ data: TestResult }>(`/admin/api/v1/visual-rules/${id}/test`, body).then((response) => response.data),

  /** 真实执行：向目标集合创建一条 Record，返回 202 的 Run。 */
  run: (id: string, body: { user?: RuleUser }) =>
    api.post<{ data: Run }>(`/admin/api/v1/visual-rules/${id}/run`, body).then((response) => response.data),

  runs: (id: string) =>
    api.get<{ data: Run[] }>(`/admin/api/v1/visual-rules/${id}/runs`).then((response) => response.data),

  /** 仅 kind='live' && status='failed' 可重试；后端要求无 body，新 run 的 attemptOf 指向原 run。 */
  retry: (runId: string) =>
    apiRequest<{ data: Run }>('POST', `/admin/api/v1/visual-rule-runs/${runId}/retry`).then((response) => response.data),
}
