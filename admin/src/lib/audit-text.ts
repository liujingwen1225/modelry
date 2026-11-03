import type { AuditRecord } from '@/api/audit'

/**
 * 把审计动作翻译成产品语言。
 *
 * 只翻译已知语义；未知动作保留原始名称，避免用编造的文案掩盖真实行为。
 */
const ACTION_LABELS: Array<[RegExp, string]> = [
  [/^record\.created$/, '新建记录'],
  [/^record\.updated$/, '更新记录'],
  [/^record\.deleted$/, '删除记录'],
  [/^record\.file\.uploaded$/, '上传文件'],
  [/^collection\.created$/, '创建集合'],
  [/^collection\.deleted$/, '删除集合'],
  [/^schema\.pending/, '保存结构变更'],
  [/^schema\.applied$/, '应用结构变更'],
  [/^schema\.discarded$/, '放弃结构变更'],
  [/^schema\.failed$/, '结构变更失败'],
  [/^accessRule\.(saved|updated)$/, '保存访问规则'],
  [/^accessRule\.applied$/, '应用访问规则'],
  [/^accessRule\.discarded$/, '放弃访问规则'],
  [/^authentication\./, '修改认证配置'],
  [/^appUser\./, '变更应用用户'],
  [/^serviceAccount\.created$/, '创建服务账号'],
  [/^serviceAccount\./, '变更服务账号'],
  [/^apiKey\.created$/, '创建 API Key'],
  [/^apiKey\./, '变更 API Key'],
  [/^secret\./, '变更 Secret'],
  [/^settings\./, '修改运行时设置'],
  [/^webhook\./, '变更 Webhook'],
  [/^eventHook\./, '变更事件钩子'],
  [/^job\./, '变更定时任务'],
  [/^extension\./, '变更业务逻辑'],
  [/^storage\./, '变更文件存储'],
  [/^backup\./, '备份项目'],
  [/^restore\./, '恢复项目'],
  [/^administrator\./, '变更管理员'],
  [/^auth\./, '登录与账号'],
]

const RESOURCE_LABELS: Record<string, string> = {
  record: '记录',
  collection: '集合',
  schema: '结构',
  accessRule: '访问规则',
  authentication: '认证配置',
  appUser: '应用用户',
  serviceAccount: '服务账号',
  apiKey: 'API Key',
  secret: 'Secret',
  settings: '运行时设置',
  webhook: 'Webhook',
  eventHook: '事件钩子',
  job: '定时任务',
  extension: '业务逻辑',
  storage: '文件存储',
  file: '文件',
  administrator: '管理员',
  session: '会话',
}

export function auditActionLabel(action: string): string {
  for (const [pattern, label] of ACTION_LABELS) {
    if (pattern.test(action)) {
      return label
    }
  }
  return action
}

export function auditResourceLabel(kind?: string): string {
  return (kind && RESOURCE_LABELS[kind]) || kind || '资源'
}

export function auditActorLabel(record: AuditRecord): string {
  return record.actor.displayName || record.actor.id || '本地管理员'
}

/** 一行标题：动作 + 资源名（有名字时用名字，否则用短 ID）。 */
export function auditTitle(record: AuditRecord): string {
  const label = auditActionLabel(record.action)
  const name = record.resource.displayName
  if (name) {
    return `${label}「${name}」`
  }
  const kind = auditResourceLabel(record.resource.kind)
  if (record.resource.id && record.resource.id.length <= 12) {
    return `${label} · ${kind} ${record.resource.id}`
  }
  return `${label} · ${kind}`
}
