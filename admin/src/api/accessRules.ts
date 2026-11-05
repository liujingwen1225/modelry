import { api } from './client'

/**
 * 集合「访问规则」Admin API 的字段契约。
 *
 * 后端为每个集合固定维护 5 条规则，list/view/create/update/delete 各一条；
 * PUT 必须恰好提交 5 条。所有字段与后端 JSON 一一对应，不在此处做臆测转换。
 */

/** 操作：一条规则对应一个操作，PUT 时每个操作恰好一条。 */
export type RuleOperation = 'list' | 'view' | 'create' | 'update' | 'delete'

/** 模式：不同模式对 ownerFieldId / expression 有互斥约束。 */
export type RuleMode = 'noAccess' | 'anyone' | 'signedInUsers' | 'recordOwner' | 'custom'

export type Rule = {
  operation: RuleOperation
  mode: RuleMode
  /** 仅 recordOwner：指向目标集合 type==='Auth' 的已应用 relation 字段。 */
  ownerFieldId?: string
  /** 仅 custom：{version:1,all:[{fieldId,operator:'eq'|'neq'|'in',value}]}。 */
  expression?: unknown
}

/**
 * GET 返回的状态。
 * 注意：后端在「没有待应用变更」时，pending 是 applied 的完整拷贝，且响应里没有
 * hasPending 字段；是否有待审阅变更必须逐项比较 applied 与 pending（见 RulesTab）。
 */
export type RulesState = {
  applied: Rule[]
  pending: Rule[]
  version: number
}

/** simulate 身份种类，与后端 principal.kind 一一对应。 */
export type SimulatePrincipalKind = 'anonymous' | 'owner' | 'applicationUser' | 'serviceAccount'

export type SimulatePrincipal = {
  kind: SimulatePrincipalKind
  /** applicationUser 必须是真实的应用用户 recordId；匿名身份传空串。 */
  id: string
}

/** record.recordId 与 record.payload 二选一；页面统一使用 recordId。 */
export type SimulateRequest = {
  operation: RuleOperation
  principal: SimulatePrincipal
  record?: { recordId?: string; payload?: Record<string, unknown> }
}

export type SimulateResult = {
  allowed: boolean
  /** 后端给出的 HTTP 码（数字或码值字符串）。 */
  code: number | string
  message: string
  /** 判定理由，页面按 JSON 展示。 */
  reason: unknown
  decidingOperation: string
  decidingMode: string
  authoritative: boolean
  notice?: string
}

const base = (collectionId: string) => `/admin/api/v1/collections/${collectionId}/access-rules`

/** 固定顺序：页面规则列表、抽屉与 PUT 都按这个顺序产出恰好 5 条规则。 */
export const RULE_OPERATIONS: RuleOperation[] = ['list', 'view', 'create', 'update', 'delete']

export const accessRulesApi = {
  /** GET → { data: { applied, pending, version } }。 */
  get: (collectionId: string) =>
    api.get<{ data: RulesState }>(base(collectionId)).then((response) => response.data),

  /** PUT 保存到待应用变更：body { expectedVersion, rules }，rules 必须恰好 5 条。 */
  save: (collectionId: string, expectedVersion: number, rules: Rule[]) =>
    api
      .put<{ data: RulesState }>(base(collectionId), { expectedVersion, rules })
      .then((response) => response.data),

  /** 应用待应用变更；无 pending 时后端返回 404。 */
  apply: (collectionId: string, expectedVersion: number) =>
    api
      .post<{ data: RulesState }>(`${base(collectionId)}/apply`, { expectedVersion })
      .then((response) => response.data),

  /** 放弃待应用变更；无 pending 时后端返回 404。 */
  discard: (collectionId: string, expectedVersion: number) =>
    api
      .post<{ data: RulesState }>(`${base(collectionId)}/discard`, { expectedVersion })
      .then((response) => response.data),

  /** 真实模拟一次访问判定，结果不做任何本地推测。 */
  simulate: (collectionId: string, payload: SimulateRequest) =>
    api
      .post<{ data: SimulateResult }>(`${base(collectionId)}/simulate`, payload)
      .then((response) => response.data),
}
