/**
 * AI 协作（Issue #48）主工作面。
 *
 * 设计来自 Figma 画板 20「需求与理解」、21「应用后结果与验证」、24「变更审阅 · 公开分享」，
 * 但 /ai 是独立页面：左栏上下文与提案列表，中栏需求 / 理解 / 方案 / 验证主工作面，
 * 右栏 324px「AI 助手」形态合并为只读的上下文助手。
 *
 * 关键产品判断：本页不接入大模型，也没有对话式生成。understandingJson 是后端对
 * 「当前项目真实状态」的结构化计算（规则化理解，非大模型生成），页面只把它当事实清单
 * 解析展示，不写成「AI 说了什么」。方案、应用、验证、分享全部走真实 API 与变更生命周期。
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  App,
  Button,
  CodeBlock,
  DetailList,
  Drawer,
  ErrorState,
  Field,
  Input,
  InputNumber,
  LoadingBlock,
  Notice,
  PageHeader,
  Popconfirm,
  Segmented,
  Select,
  StateBlock,
  StatusTag,
  Tag,
} from '@/ui'
import {
  ArrowRightOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
  ExperimentOutlined,
  FileProtectOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  LoadingOutlined,
  PlusOutlined,
  PullRequestOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SendOutlined,
} from '@ant-design/icons'
import { ApiError, errorMessage } from '@/api/client'
import { collectionKeys, collectionsApi } from '@/api/collections'
import type { CollectionSummary } from '@/api/collections'
import {
  AI_RISK_LABEL,
  AI_RISK_TONE,
  PROPOSAL_STATUS_LABEL,
  PROPOSAL_STATUS_TONE,
  aiKeys,
  aicollabApi,
} from '@/api/aicollab'
import type { AiRisk, Proposal, ProposalDetail, ProposalPlan, ShareLink, Verification, VerificationCheck } from '@/api/aicollab'
import { formatCount, formatDateTime } from '@/lib/format'
import './ai.css'

type View = 'understanding' | 'plan' | 'verification' | 'share'
type Tone = 'neutral' | 'success' | 'warning' | 'danger'
type Avail = { disabled: boolean; reason: string }

/* ── 小工具：只做容错与展示，不臆造数据 ───────────────────── */

function json(value: unknown): string {
  if (value === undefined || value === null) {
    return '（无）'
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function statusLabel(status: string): string {
  return PROPOSAL_STATUS_LABEL[status] ?? status
}

function statusTone(status: string): Tone {
  return PROPOSAL_STATUS_TONE[status] ?? 'neutral'
}

function riskLabel(risk: string): string {
  return AI_RISK_LABEL[risk] ?? risk
}

function riskTone(risk: string): Tone {
  return AI_RISK_TONE[risk] ?? 'neutral'
}

/** 后端用空字符串表示「未设置」，统一收敛成占位符，不臆造内容。 */
function displayText(value: string | null | undefined): string {
  return value && value.trim() !== '' ? value : '—'
}

/**
 * understandingJson 有两种真实形态：书面契约是 JSON 字符串，真实后端用
 * json.RawMessage 输出内嵌对象。两种都兼容，解析失败不假装理解成功。
 */
function parseUnderstanding(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined || raw === '') {
    return null
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return { 原始值: parsed }
    } catch {
      return null
    }
  }
  return null
}

/** 后端结构可能变化：按多个别名取第一个真实存在的值。 */
function pick(obj: Record<string, unknown> | null, keys: string[]): unknown {
  if (!obj) {
    return undefined
  }
  for (const key of keys) {
    const value = obj[key]
    if (value !== undefined && value !== null) {
      return value
    }
  }
  return undefined
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}

/** 字段清单可能是字符串数组，也可能是 { name } 对象数组。 */
function fieldNames(value: unknown): string[] {
  const out: string[] = []
  if (!Array.isArray(value)) {
    return out
  }
  for (const item of value) {
    if (typeof item === 'string') {
      out.push(item)
      continue
    }
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      const name = asString(obj.name ?? obj.fieldName ?? obj.key)
      if (name) {
        out.push(name)
      }
    }
  }
  return out
}

function preconditionLabel(status: string): string {
  const key = status.toLowerCase()
  if (['ok', 'pass', 'passed', 'satisfied', 'met'].includes(key)) {
    return '已通过'
  }
  if (['failed', 'blocked', 'error'].includes(key)) {
    return '未通过'
  }
  if (['pending', 'warning', 'warn'].includes(key)) {
    return '需注意'
  }
  return status
}

function preconditionTone(status: string): Tone {
  const key = status.toLowerCase()
  if (['ok', 'pass', 'passed', 'satisfied', 'met'].includes(key)) {
    return 'success'
  }
  if (['failed', 'blocked', 'error'].includes(key)) {
    return 'danger'
  }
  if (['pending', 'warning', 'warn'].includes(key)) {
    return 'warning'
  }
  return 'neutral'
}

function shareState(share: ShareLink): { tone: Tone; label: string; valid: boolean } {
  if (share.revokedAt) {
    return { tone: 'neutral', label: '已撤销', valid: false }
  }
  const expires = new Date(share.expiresAt).getTime()
  if (Number.isFinite(expires) && expires <= Date.now()) {
    return { tone: 'warning', label: '已过期', valid: false }
  }
  return { tone: 'success', label: '有效', valid: true }
}

/* ── 按钮可用性：每个禁用状态都给出真实原因，不是静态按钮 ────── */

function planAvail(d: ProposalDetail | undefined, busy: boolean): Avail {
  if (!d) {
    return { disabled: true, reason: '请先选择或创建一条需求。' }
  }
  if (busy) {
    return { disabled: true, reason: '正在处理，请稍候。' }
  }
  if (d.status === 'draft') {
    return { disabled: false, reason: '将基于当前项目真实状态创建一条待审阅结构变更，尚未写入结构。' }
  }
  if (d.status === 'failed') {
    return { disabled: true, reason: '应用失败已落库，后端只允许 draft 生成方案；请到变更中心处理后另建需求。' }
  }
  if (d.status === 'planned') {
    return { disabled: true, reason: '已生成方案，请先到变更中心审阅或执行应用。' }
  }
  return { disabled: true, reason: `当前状态为「${statusLabel(d.status)}」，方案已应用，不能重复生成。` }
}

function applyAvail(d: ProposalDetail | undefined, busy: boolean, risk: AiRisk | undefined): Avail {
  if (!d) {
    return { disabled: true, reason: '请先选择一条提案。' }
  }
  if (busy) {
    return { disabled: true, reason: '正在处理，请稍候。' }
  }
  if (d.status !== 'planned') {
    return { disabled: true, reason: `当前状态为「${statusLabel(d.status)}」，只有「已生成方案 · 待审阅」且未应用时可以应用。` }
  }
  if (!d.plan || !d.plan.preview) {
    return { disabled: true, reason: '方案缺少 preview（风险 / 影响未就绪），不能应用；请以变更中心记录为准。' }
  }
  if (risk === 'blocked') {
    return { disabled: true, reason: '预检判定为「被阻塞」，应用已禁用；请先处理前置条件。' }
  }
  if (risk === 'review') {
    return { disabled: false, reason: '风险为「需要确认」，应用将携带显式风险确认（confirmRisk=true）。' }
  }
  return { disabled: false, reason: '差异已就绪，确认后沿真实 schema apply 写入结构。' }
}

function verifyAvail(d: ProposalDetail | undefined, busy: boolean): Avail {
  if (!d) {
    return { disabled: true, reason: '请先选择一条提案。' }
  }
  if (busy) {
    return { disabled: true, reason: '正在处理，请稍候。' }
  }
  if (d.status === 'applied' || d.status === 'verified') {
    return { disabled: false, reason: '读取真实 Applied Model，核对目标字段是否已真实存在。' }
  }
  return { disabled: true, reason: `当前状态为「${statusLabel(d.status)}」，需先应用方案再验证。` }
}

/* ── 子视图们 ─────────────────────────────────────────────── */

function ImpactStat(props: { label: string; value: number }) {
  return (
    <div className="mr-ai__impact-stat">
      <span className="mr-ai__impact-value">{formatCount(props.value)}</span>
      <span className="mr-ai__impact-label">{props.label}</span>
    </div>
  )
}

function ChecksList(props: { checks: VerificationCheck[] }) {
  return (
    <ul className="mr-ai__checks">
      {props.checks.map((check, index) => (
        <li className="mr-ai__check" key={`${check.label}-${index}`}>
          <span className={`mr-ai__check-icon${check.passed ? ' mr-ai__check-icon--pass' : ' mr-ai__check-icon--fail'}`}>
            {check.passed ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
          </span>
          <span className="mr-ai__check-body">
            <strong>{check.label}</strong>
            <span className="mr-ai__check-detail">{check.detail || '（无更多说明）'}</span>
          </span>
          <StatusTag tone={check.passed ? 'success' : 'danger'}>{check.passed ? '通过' : '未通过'}</StatusTag>
        </li>
      ))}
    </ul>
  )
}

function ContextCard(props: { collections: CollectionSummary[]; isPending: boolean }) {
  return (
    <section className="mr-ai__card mr-ai__card--nav">
      <div className="mr-ai__card-head">
        <span className="mr-ai__card-title"><DatabaseOutlined /> 当前项目上下文</span>
        <span className="mr-meta">{props.collections.length} 个集合</span>
      </div>
      {props.isPending ? <LoadingBlock rows={2} label="正在读取集合…" /> : null}
      {!props.isPending && props.collections.length === 0 ? (
        <p className="mr-ai__hint">当前没有集合，可先在数据工作区创建。</p>
      ) : null}
      <div className="mr-ai__context-tags">
        {props.collections.map((collection) => (
          <Tag key={collection.id} className="mr-ai__tag">
            <span className="mr-mono">{collection.name}</span>
            <span className="mr-ai__tag-meta"> · {formatCount(collection.recordCount)} 条</span>
          </Tag>
        ))}
      </div>
      <p className="mr-ai__hint">集合来自真实项目，仅作为需求作用范围的上下文引用；只为选中的集合准备方案，不改动其他资源。</p>
    </section>
  )
}

function ProposalList(props: {
  proposals: Proposal[]
  isPending: boolean
  isError: boolean
  error: unknown
  onRetry: () => void
  selectedId: string | null
  onSelect: (id: string) => void
  onNew: () => void
}) {
  return (
    <section className="mr-ai__card mr-ai__card--nav">
      <div className="mr-ai__card-head">
        <span className="mr-ai__card-title">提案列表</span>
        <Button type="text" size="small" icon={<PlusOutlined />} onClick={props.onNew}>新建</Button>
      </div>
      {props.isPending ? <LoadingBlock rows={4} label="正在读取提案…" /> : null}
      {props.isError ? <ErrorState error={props.error} title="提案列表读不到" onRetry={props.onRetry} /> : null}
      {!props.isPending && !props.isError && props.proposals.length === 0 ? (
        <p className="mr-ai__hint">还没有提案。点击「新建需求」提交第一条。</p>
      ) : null}
      <ul className="mr-ai__list">
        {props.proposals.map((proposal) => (
          <li key={proposal.id}>
            <Button
              type="text"
              block
              className={`mr-ai__list-item${proposal.id === props.selectedId ? ' mr-ai__list-item--active' : ''}`}
              onClick={() => props.onSelect(proposal.id)}
            >
              <span className="mr-ai__item-row">
                <span className="mr-ai__item-title">{proposal.title}</span>
                <StatusTag tone={statusTone(proposal.status)}>{statusLabel(proposal.status)}</StatusTag>
              </span>
              <span className="mr-ai__item-meta">
                <span className="mr-mono">{proposal.collectionId}</span>
                <span>{formatDateTime(proposal.createdAt)}</span>
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function EmptyWorkspace(props: { onNew: () => void; isPending: boolean }) {
  if (props.isPending) {
    return <div className="mr-ai__card"><LoadingBlock rows={4} label="正在读取提案…" /></div>
  }
  return (
    <div className="mr-ai__card">
      <StateBlock
        eyebrow="AI 协作 · 空"
        icon={<RobotOutlined />}
        title="还没有提案"
        description="提交一条需求后，后端会返回对当前项目真实状态的结构化理解（规则化理解，非大模型生成），再据此生成待审阅变更。"
        actions={<Button type="primary" icon={<PlusOutlined />} onClick={props.onNew}>新建需求</Button>}
      />
    </div>
  )
}

function RequirementForm(props: {
  requirement: string
  onRequirement: (value: string) => void
  collectionId: string
  onCollectionId: (value: string) => void
  fieldName: string
  onFieldName: (value: string) => void
  collections: CollectionSummary[]
  busy: boolean
  canCancel: boolean
  onSubmit: () => void
  onCancel: () => void
}) {
  return (
    <section className="mr-ai__card">
      <div className="mr-ai__card-head">
        <span className="mr-ai__card-title">新建需求</span>
        <StatusTag tone="neutral">规则化理解 · 非大模型生成</StatusTag>
      </div>
      <Notice tone="neutral" icon={<InfoCircleOutlined />}>
        提交后，后端会返回对当前项目真实状态的结构化理解（规则化计算，非大模型生成），并创建一条状态为「草稿」的提案。此操作不会改动项目。
      </Notice>
      <div className="mr-ai__form">
        <Field label="需求内容" hint="用自然语言描述你想做的事；后续方案、应用、验证都以真实项目状态为准。" required>
          <Input.TextArea
            rows={4}
            maxLength={2000}
            className="mr-ai__control"
            value={props.requirement}
            onChange={(event) => props.onRequirement(event.target.value)}
            placeholder="例如：给笔记增加公开分享能力"
          />
        </Field>
        <Field label="作用集合" hint="下拉来自真实集合列表。" required>
          <Select
            className="mr-ai__select"
            value={props.collectionId || undefined}
            onChange={(value) => props.onCollectionId(String(value))}
            options={props.collections.map((collection) => ({ value: collection.id, label: collection.name }))}
            placeholder="选择集合"
          />
        </Field>
        <Field label="目标字段名" hint="默认 is_public，可编辑；须小写字母开头、仅含小写字母 / 数字 / 下划线。后端据此核对字段是否已真实存在。">
          <Input
            className="mr-ai__control"
            value={props.fieldName}
            onChange={(event) => props.onFieldName(event.target.value)}
          />
        </Field>
      </div>
      <div className="mr-ai__actions">
        <Button type="primary" icon={<SendOutlined />} loading={props.busy} onClick={props.onSubmit}>提交需求</Button>
        {props.canCancel ? <Button onClick={props.onCancel}>取消</Button> : null}
        <span className="mr-ai__hint">提交将真实调用 POST /admin/api/v1/ai/proposals。</span>
      </div>
    </section>
  )
}

function UnderstandingView(props: {
  detail: ProposalDetail
  collections: CollectionSummary[]
  onNew: () => void
}) {
  const understanding = parseUnderstanding(props.detail.understandingJson)
  const collection = props.collections.find((item) => item.id === props.detail.collectionId)
  // 真实后端把集合身份放在内嵌 collection 对象里；同时兼容扁平别名的契约形态。
  const nestedValue = pick(understanding, ['collection'])
  const nested = nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue)
    ? (nestedValue as Record<string, unknown>)
    : null
  const name = asString(pick(nested, ['name', 'collectionName']) ?? pick(understanding, ['collectionName', 'name']))
    ?? collection?.name ?? props.detail.collectionId
  const type = asString(pick(nested, ['type']) ?? pick(understanding, ['type', 'collectionType']))
    ?? collection?.type ?? null
  const schemaVersion = pick(nested, ['schemaVersion', 'version']) ?? pick(understanding, ['schemaVersion', 'version'])
  const fields = fieldNames(pick(understanding, ['fields', 'fieldNames', 'existingFields', 'schemaFields', 'currentFields']))
  const note = asString(pick(understanding, ['note', 'message', 'summary']))
  const target = displayText(props.detail.fieldName)
  const existsRaw = pick(understanding, ['targetFieldExists', 'fieldExists', 'targetExists', 'exists'])
  let exists: boolean | null = null
  if (typeof existsRaw === 'boolean') {
    exists = existsRaw
  } else if (fields.length > 0) {
    exists = fields.includes(target)
  }
  const crossCheck = collection ? collection.fields.some((field) => field.name === target) : null

  const existsNode = exists === null
    ? <StatusTag tone="neutral">后端未提供该结论</StatusTag>
    : <StatusTag tone={exists ? 'success' : 'warning'}>{exists ? '是 · 已存在' : '否 · 尚未添加'}</StatusTag>

  return (
    <div className="mr-ai__view-body">
      <div className="mr-ai__section-head">
        <span className="mr-ai__section-title">需求理解</span>
        <StatusTag tone="neutral">规则化理解 · 非大模型生成</StatusTag>
      </div>
      <Notice tone="neutral" icon={<InfoCircleOutlined />}>
        规则化理解，非大模型生成：以下由后端依据当前项目真实状态计算得出，是结构化的事实清单，不是语言模型生成的文字或建议，也不代表 AI 的判断。
      </Notice>

      {note ? (
        <div className="mr-ai__req">
          <span className="mr-ai__req-label">后端原始标注 · understandingJson.note</span>
          <p className="mr-ai__req-text">{note}</p>
        </div>
      ) : null}

      <div className="mr-ai__req">
        <span className="mr-ai__req-label">你提交的需求</span>
        <p className="mr-ai__req-text">{props.detail.requirement}</p>
        <Button type="link" size="small" icon={<PlusOutlined />} onClick={props.onNew}>另建一条需求</Button>
      </div>

      {!understanding ? (
        <Notice tone="warning">后端尚未返回可解析的结构化理解数据；下方展示原始返回值。</Notice>
      ) : null}

      <DetailList
        items={[
          { label: '集合名', value: name },
          { label: '集合类型', value: type ?? '—', mono: false },
          { label: '结构版本 (schemaVersion)', value: schemaVersion === undefined ? '—' : `v${String(schemaVersion)}` },
          { label: '目标字段名', value: target },
          { label: '目标字段是否已存在（来自理解数据）', value: existsNode, mono: false },
          { label: '与真实集合字段核对', value: crossCheck === null ? '集合列表不可用' : crossCheck ? '已存在' : '尚未添加', mono: false },
          { label: '字段清单', value: fields.length > 0 ? `${fields.length} 个` : '后端未提供清单', mono: false },
        ]}
      />
      {fields.length > 0 ? (
        <div className="mr-ai__field-list">
          {fields.map((field) => <Tag key={field} className="mr-ai__tag"><span className="mr-mono">{field}</span></Tag>)}
        </div>
      ) : null}

      <div className="mr-ai__section-head">
        <span className="mr-ai__section-title">原始结构化数据</span>
        <span className="mr-meta">后端返回的 understandingJson，未改写</span>
      </div>
      <CodeBlock code={json(props.detail.understandingJson)} label="understandingJson · 后端原始返回值" maxHeight={220} />
    </div>
  )
}

function PlanView(props: {
  detail: ProposalDetail
  plan: ProposalPlan | null
  onPlan: () => void
  onApply: () => void
  planAvail: Avail
  applyAvail: Avail
  planPending: boolean
  changesHref: string
  failure: unknown
  onRetry: () => void
}) {
  const plan = props.plan
  const preview = plan?.preview ?? null
  const risk = preview?.risk
  return (
    <div className="mr-ai__view-body">
      <div className="mr-ai__section-head">
        <span className="mr-ai__section-title">方案与影响</span>
        <span className="mr-meta">来自真实 preview，非模拟数据</span>
      </div>

      {props.planPending ? (
        <div className="mr-ai__generating">
          <LoadingOutlined className="mr-ai__generating-icon" />
          <div>
            <strong>正在生成方案并创建待审阅变更…</strong>
            <p>基于当前项目真实状态计算，完成后可查看差异、影响范围与前置条件。当前项目尚未修改。</p>
          </div>
        </div>
      ) : null}

      {!plan && !props.planPending ? (
        <>
          <StateBlock
            eyebrow="待审阅 · 空"
            icon={<PullRequestOutlined />}
            title="还没有生成方案"
            description="生成方案会真实创建一条待应用的结构变更，进入变更生命周期；这一步不会写入结构。"
            actions={<Button type="primary" icon={<PullRequestOutlined />} disabled={props.planAvail.disabled} onClick={props.onPlan}>生成方案</Button>}
          />
          <p className="mr-ai__hint">{props.planAvail.reason}</p>
        </>
      ) : null}

      {plan ? (
        <>
          <Notice tone={props.detail.status === 'planned' ? 'warning' : 'success'} icon={<InfoCircleOutlined />}>
            {props.detail.status === 'planned'
              ? '这是待审阅变更，尚未写入结构。确认「应用」之前，本地项目不会改变；请先到变更中心核对差异。'
              : '这条变更已应用 / 已验证，以下为当时的真实记录。'}
          </Notice>
          <div className="mr-ai__actions">
            <Link to={props.changesHref} className="mr-ai__link">到变更中心审阅 <ArrowRightOutlined /></Link>
            <span className="mr-meta">变更集 {displayText(props.detail.changeSetId || plan.changeSetId)}</span>
          </div>

          {/* 变更已归档且后端没有持久评估时 preview 为 null：如实说明，不编造风险 / 差异。 */}
          {!preview ? (
            <Notice tone="warning" icon={<InfoCircleOutlined />}>
              这条变更已归档，后端没有返回 preview（风险 / 影响 / 差异）。差异与执行结果请以变更中心的真实记录为准；此处不提供基于 preview 的应用。
            </Notice>
          ) : (
            <>
              <div className="mr-ai__section-head">
                <span className="mr-ai__section-title">风险 · {riskLabel(risk ?? '—')}</span>
                <StatusTag tone={riskTone(risk ?? '')}>{riskLabel(risk ?? '—')}</StatusTag>
              </div>
              <p className="mr-ai__hint">
                {risk === 'blocked'
                  ? '预检判定为被阻塞，应用已禁用；请先处理未通过的前置条件。'
                  : risk === 'review'
                    ? '这次变更会扩大访问范围或影响现有记录，应用时必须携带显式风险确认（confirmRisk）。'
                    : risk === 'safe'
                      ? '预检没有发现阻塞项，确认后即可沿真实 schema apply 写入结构。'
                      : '风险来自 preview.risk 字符串枚举。'}
              </p>

              <div className="mr-ai__section-head"><span className="mr-ai__section-title">影响范围</span></div>
              <div className="mr-ai__impact">
                <ImpactStat label="受影响集合" value={preview.impact.affectedCollections} />
                <ImpactStat label="受影响字段" value={preview.impact.affectedFields} />
                <ImpactStat label="受影响索引" value={preview.impact.affectedIndexes} />
                <ImpactStat label="受影响记录" value={preview.impact.affectedRecords} />
              </div>
              {preview.impact.summary ? <p className="mr-ai__hint">{preview.impact.summary}</p> : null}

              <div className="mr-ai__section-head">
                <span className="mr-ai__section-title">前置条件</span>
                <span className="mr-meta">{preview.preconditions.length} 项</span>
              </div>
              {preview.preconditions.length === 0 ? (
                <p className="mr-ai__hint">预检没有列出额外前置条件。</p>
              ) : (
                <ul className="mr-ai__preconditions">
                  {preview.preconditions.map((item, index) => (
                    <li className="mr-ai__precondition" key={`${item.code}-${index}`}>
                      <StatusTag tone={preconditionTone(item.status)}>{preconditionLabel(item.status)}</StatusTag>
                      <span className="mr-mono">{item.code}</span>
                      <span>{item.message}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mr-ai__section-head"><span className="mr-ai__section-title">变更差异</span></div>
              <CodeBlock code={json(preview.diff)} label="preview.diff · 真实差异" maxHeight={220} />
            </>
          )}

          <div className="mr-ai__divider" />
          <CodeBlock code={json(plan.operations)} label="operations · 真实操作清单" maxHeight={200} />

          <div className="mr-ai__divider" />
          <div className="mr-ai__actions">
            <Button type="primary" icon={<CheckCircleOutlined />} disabled={props.applyAvail.disabled} onClick={props.onApply}>应用到结构</Button>
            <span className="mr-ai__hint">{props.applyAvail.reason}</span>
          </div>
          {risk === 'blocked' ? (
            <Notice tone="danger" icon={<ExclamationCircleOutlined />}>应用已禁用：预检判定为被阻塞，请先处理前置条件。</Notice>
          ) : null}
          {props.failure ? (
            <ErrorState
              error={props.failure}
              title={props.failure instanceof ApiError && props.failure.code === 'CHANGE_CONFIRMATION_REQUIRED' ? '需要显式确认风险' : '操作没有完成'}
              onRetry={props.onRetry}
              retryLabel="重新检查"
              secondary={<Link to={props.changesHref} className="mr-ai__link">去变更中心处理 <ArrowRightOutlined /></Link>}
            />
          ) : null}
          {props.detail.status === 'failed' ? (
            <Notice tone="danger" icon={<ExclamationCircleOutlined />}>
              上次应用失败（后端落库真实结果）：<span className="mr-mono"> {displayText(props.detail.errorCode)}</span>
              {' · '}{displayText(props.detail.errorMessage)}。
              恢复路径：请 <Link to={props.changesHref} className="mr-ai__link">到变更中心查看执行记录与恢复状态 <ArrowRightOutlined /></Link>，处理后另建需求重试。
            </Notice>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function VerificationView(props: {
  verification: Verification | null
  /** 只有 applied / verified 才把 checks 当作正式验证结论展示。 */
  eligible: boolean
  verifyAvail: Avail
  onVerify: () => void
  onOpenDrawer: () => void
  verifyPending: boolean
}) {
  return (
    <div className="mr-ai__view-body">
      <div className="mr-ai__section-head">
        <span className="mr-ai__section-title">应用后验证</span>
        <span className="mr-meta">读取真实 Applied Model</span>
      </div>
      <Notice tone="neutral" icon={<ExperimentOutlined />}>
        验证由后端读取真实 Applied Model，核对目标字段是否已真实存在；以下结论来自 /verify 返回的 checks，不是模拟结果。
      </Notice>
      <div className="mr-ai__actions">
        <Button icon={<ExperimentOutlined />} loading={props.verifyPending} disabled={props.verifyAvail.disabled} onClick={props.onVerify}>验证</Button>
        <span className="mr-ai__hint">{props.verifyAvail.reason}</span>
      </div>

      {!props.eligible || !props.verification ? (
        <StateBlock
          eyebrow="验证 · 空"
          icon={<SafetyCertificateOutlined />}
          title="还没有验证结论"
          description={props.eligible
            ? '点击「验证」读取真实 Applied Model 并核对目标字段。'
            : '需先生成方案并应用后，才能验证目标字段是否已进入真实 Applied Model。'}
        />
      ) : (
        <>
          <div className="mr-ai__section-head">
            <span className="mr-ai__section-title">验证结论</span>
            <StatusTag tone={props.verification.passed ? 'success' : 'danger'}>
              {props.verification.passed ? '已通过' : '未通过'}
            </StatusTag>
          </div>
          <ChecksList checks={props.verification.checks} />
          <Notice tone={props.verification.passed ? 'success' : 'danger'}>
            共 {props.verification.checks.length} 项真实检查，{props.verification.passed ? '全部通过' : '存在未通过项'}。
          </Notice>
          <Button icon={<SafetyCertificateOutlined />} onClick={props.onOpenDrawer}>查看验证结论</Button>
        </>
      )}
    </div>
  )
}

function ShareView(props: {
  shares: ShareLink[]
  sharesPending: boolean
  sharesError: unknown
  onRetryShares: () => void
  expiresInHours: number
  onExpires: (value: number) => void
  onCreate: () => void
  createPending: boolean
  revokePending: boolean
  onRevoke: (id: string) => void
  lastCreated: ShareLink | null
  onCopy: (text: string) => void
}) {
  /** 创建响应含 url；列表项刻意不含明文 token/url，取不到就返回 null。 */
  const fullUrl = (share: ShareLink): string | null =>
    share.url ? `${window.location.origin}${share.url}` : null
  const createdUrl = props.lastCreated ? fullUrl(props.lastCreated) : null
  const missingUrl = props.shares.some((share) => !share.url)
  return (
    <div className="mr-ai__view-body">
      <div className="mr-ai__section-head">
        <span className="mr-ai__section-title">公开分享</span>
        <StatusTag tone="neutral">只读</StatusTag>
      </div>
      <Notice tone="neutral" icon={<FileProtectOutlined />}>
        链接只读、到时自动失效，只暴露提案摘要（标题、需求、状态、风险 / 影响、验证结论、过期时间）；不含记录内容、Secret、凭据或服务器绝对路径。
      </Notice>

      <div className="mr-ai__actions">
        <span className="mr-ai__hint">有效期（小时，1–168）</span>
        <InputNumber
          className="mr-ai__hours"
          min={1}
          max={168}
          value={props.expiresInHours}
          onChange={(value) => props.onExpires(typeof value === 'number' ? value : 24)}
        />
        <Button icon={<LinkOutlined />} loading={props.createPending} disabled={props.createPending} onClick={props.onCreate}>创建分享链接</Button>
      </div>

      {props.lastCreated && createdUrl ? (
        <div className="mr-ai__created">
          <div className="mr-ai__section-head">
            <span className="mr-ai__section-title">新创建的链接</span>
            <StatusTag tone="success">有效</StatusTag>
          </div>
          <CodeBlock code={createdUrl} label="完整 URL · window.location.origin + url" maxHeight={80} />
          <div className="mr-ai__actions">
            <Button size="small" icon={<CopyOutlined />} onClick={() => props.onCopy(createdUrl)}>复制完整 URL</Button>
            <span className="mr-meta">过期时间 {formatDateTime(props.lastCreated.expiresAt)}</span>
          </div>
        </div>
      ) : null}

      <div className="mr-ai__section-head">
        <span className="mr-ai__section-title">已有链接</span>
        <span className="mr-meta">{props.shares.length} 条</span>
      </div>
      {props.sharesPending ? <LoadingBlock rows={2} label="正在读取分享链接…" /> : null}
      {props.sharesError ? <ErrorState error={props.sharesError} title="分享链接读不到" onRetry={props.onRetryShares} /> : null}
      {!props.sharesPending && !props.sharesError && props.shares.length === 0 ? (
        <p className="mr-ai__hint">还没有分享链接。创建后即可复制给未登录的访客只读查看。</p>
      ) : null}
      <ul className="mr-ai__shares">
        {props.shares.map((share) => {
          const state = shareState(share)
          const url = fullUrl(share)
          return (
            <li className="mr-ai__share" key={share.id}>
              {url ? (
                <div className="mr-ai__share-url" title={url}>{url}</div>
              ) : (
                <div className="mr-ai__share-url">链接 {share.id} · 列表不返回明文 URL</div>
              )}
              <div className="mr-ai__share-meta">
                <StatusTag tone={state.tone}>{state.label}</StatusTag>
                <span className="mr-mono">至 {formatDateTime(share.expiresAt)}</span>
                {share.revokedAt ? <span className="mr-mono">撤销于 {formatDateTime(share.revokedAt)}</span> : null}
                {share.scope ? <span className="mr-mono">{share.scope}</span> : null}
              </div>
              <div className="mr-ai__share-actions">
                <Button size="small" icon={<CopyOutlined />} disabled={!state.valid || !url} onClick={() => url && props.onCopy(url)}>复制</Button>
                <Popconfirm
                  title="撤销这条链接？撤销后立即失效，访客将无法再访问。"
                  okText="撤销"
                  cancelText="取消"
                  onConfirm={() => props.onRevoke(share.id)}
                  disabled={!state.valid || props.revokePending}
                >
                  <Button size="small" danger icon={<DeleteOutlined />} disabled={!state.valid || props.revokePending} loading={props.revokePending}>撤销</Button>
                </Popconfirm>
              </div>
            </li>
          )
        })}
      </ul>
      {missingUrl ? (
        <Notice tone="neutral" icon={<InfoCircleOutlined />}>
          列表只返回链接元数据，明文 token / url 仅在创建时返回一次。如需可分享的链接，请重新创建后立即复制。
        </Notice>
      ) : null}
      <Notice tone="warning" icon={<InfoCircleOutlined />}>
        链接失效（过期 / 被撤销 / token 无效）时，访客只会看到统一的「链接不可用或已失效」空状态，不会区分原因。
      </Notice>
    </div>
  )
}

const STEPS = ['提交需求', '规则化理解', '生成方案', '应用到结构', '验证', '公开分享']
const STEP_FOR: Record<string, number> = { draft: 2, planned: 3, applied: 4, verified: 5, failed: 3 }

function AssistantSidebar(props: {
  detail: ProposalDetail | undefined
  collections: CollectionSummary[]
  changesHref: string | null
}) {
  const d = props.detail
  const current = d ? (STEP_FOR[d.status] ?? 0) : 0
  return (
    <aside className="mr-ai__card mr-ai__card--nav mr-ai__assistant">
      <div className="mr-ai__card-head">
        <span className="mr-ai__card-title"><RobotOutlined /> AI 助手</span>
        <StatusTag tone="neutral">规则化</StatusTag>
      </div>
      <Notice tone="neutral" icon={<InfoCircleOutlined />}>
        本页不接入大模型，也没有对话式生成。「需求理解」是后端对真实项目状态的结构化计算（规则化理解，非大模型生成）。AI 不会替你自动执行。
      </Notice>

      <div className="mr-ai__section-head"><span className="mr-ai__section-title">当前上下文</span></div>
      <div className="mr-ai__context-tags">
        {props.collections.slice(0, 8).map((collection) => (
          <Tag key={collection.id} className="mr-ai__tag"><span className="mr-mono">{collection.name}</span></Tag>
        ))}
        {props.collections.length === 0 ? <span className="mr-ai__hint">没有可用集合</span> : null}
      </div>
      <p className="mr-ai__hint">只为选中的集合准备方案，不改动其他资源。</p>

      <div className="mr-ai__divider" />

      <div className="mr-ai__section-head"><span className="mr-ai__section-title">提案进度</span></div>
      <ol className="mr-ai__steps">
        {STEPS.map((step, index) => {
          const state = index < current ? 'done' : index === current ? 'active' : 'todo'
          return (
            <li className={`mr-ai__step mr-ai__step--${state}`} key={step}>
              <span className="mr-ai__step-dot">{state === 'done' ? <CheckCircleOutlined /> : index + 1}</span>
              <span>{step}</span>
              {state === 'active' ? <StatusTag tone="warning">当前</StatusTag> : null}
            </li>
          )
        })}
      </ol>

      <div className="mr-ai__divider" />

      <div className="mr-ai__section-head"><span className="mr-ai__section-title">提案引用</span></div>
      {!d ? (
        <p className="mr-ai__hint">选中或新建一条提案后，这里显示真实摘要。</p>
      ) : (
        <div className="mr-ai__ref">
          <div className="mr-ai__ref-title">{d.title}</div>
          <DetailList
            items={[
              { label: '状态', value: statusLabel(d.status), mono: false },
              { label: '目标字段', value: displayText(d.fieldName) },
              { label: '集合', value: d.collectionId },
              { label: '变更集', value: displayText(d.changeSetId) },
              { label: '更新于', value: formatDateTime(d.updatedAt), mono: false },
            ]}
          />
          {props.changesHref ? <Link to={props.changesHref} className="mr-ai__link">到变更中心审阅 <ArrowRightOutlined /></Link> : null}
        </div>
      )}

      <div className="mr-ai__assistant-foot">
        <p className="mr-ai__hint">请核对资源与访问范围。确认应用之前，不会有任何修改；AI 可能出错，结论以真实检查为准。</p>
      </div>
    </aside>
  )
}

/* ── 页面 ─────────────────────────────────────────────────── */

export function AICollabPage() {
  const { message, modal } = App.useApp()
  const queryClient = useQueryClient()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [view, setView] = useState<View>('understanding')
  const [verificationDrawer, setVerificationDrawer] = useState(false)
  const [expiresInHours, setExpiresInHours] = useState<number>(24)
  const [failure, setFailure] = useState<unknown>(null)
  const [lastCreated, setLastCreated] = useState<ShareLink | null>(null)

  const [requirement, setRequirement] = useState('')
  const [collectionId, setCollectionId] = useState('')
  const [fieldName, setFieldName] = useState('is_public')

  const collections = useQuery({ queryKey: collectionKeys.list, queryFn: collectionsApi.list })
  const proposals = useQuery({ queryKey: aiKeys.proposals, queryFn: aicollabApi.list })
  const detail = useQuery({
    queryKey: aiKeys.detail(selectedId ?? ''),
    queryFn: () => aicollabApi.detail(selectedId!),
    enabled: Boolean(selectedId),
  })
  const shares = useQuery({
    queryKey: aiKeys.shares(selectedId ?? ''),
    queryFn: () => aicollabApi.listShares(selectedId!),
    enabled: Boolean(selectedId),
  })

  const createMutation = useMutation({ mutationFn: aicollabApi.create })
  const planMutation = useMutation({ mutationFn: (id: string) => aicollabApi.plan(id) })
  const applyMutation = useMutation({
    mutationFn: (input: { id: string; confirmRisk: boolean }) => aicollabApi.apply(input.id, input.confirmRisk),
  })
  const verifyMutation = useMutation({ mutationFn: (id: string) => aicollabApi.verify(id) })
  const createShareMutation = useMutation({
    mutationFn: (input: { id: string; hours: number }) => aicollabApi.createShare(input.id, input.hours),
  })
  const revokeShareMutation = useMutation({ mutationFn: (id: string) => aicollabApi.revokeShare(id) })

  const busy = createMutation.isPending || planMutation.isPending || applyMutation.isPending ||
    verifyMutation.isPending || createShareMutation.isPending || revokeShareMutation.isPending

  const list = proposals.data ?? []
  const d = detail.data
  const detailStatus = d?.status
  const plan = d?.plan ?? null
  const risk = plan?.preview?.risk
  const verification = d?.verification ?? null

  // 列表就绪后默认选中第一条；避免空列表时把工作面卡在「未选中」。
  useEffect(() => {
    if (!selectedId && !formOpen && list.length > 0) {
      const first = list[0]
      if (first) {
        setSelectedId(first.id)
      }
    }
  }, [list, selectedId, formOpen])

  // 表单默认作用集合取真实集合列表第一条。
  useEffect(() => {
    if (!collectionId && collections.data && collections.data.length > 0) {
      const first = collections.data[0]
      if (first) {
        setCollectionId(first.id)
      }
    }
  }, [collections.data, collectionId])

  // 提案 / 状态变化时把工作面切到对应环节；用户仍可手动切换 Segmented。
  useEffect(() => {
    if (!detailStatus) {
      return
    }
    setView(
      detailStatus === 'planned' || detailStatus === 'failed'
        ? 'plan'
        : detailStatus === 'applied' || detailStatus === 'verified'
          ? 'verification'
          : 'understanding',
    )
  }, [selectedId, detailStatus])

  const changesHrefFor = (item: ProposalDetail): string => {
    // 后端用空字符串表示未设置，因此用 || 而不是 ?? 回退到 plan.changeSetId。
    const id = item.changeSetId || item.plan?.changeSetId
    return id ? `/changes/pending?changeSet=${encodeURIComponent(id)}` : '/changes/pending'
  }

  const refresh = (id: string, schema = false) => {
    void queryClient.invalidateQueries({ queryKey: aiKeys.proposals })
    void queryClient.invalidateQueries({ queryKey: aiKeys.detail(id) })
    void queryClient.invalidateQueries({ queryKey: aiKeys.shares(id) })
    if (schema) {
      void queryClient.invalidateQueries({ queryKey: collectionKeys.list })
    }
  }

  const copy = (text: string) => {
    if (!navigator.clipboard) {
      message.warning('浏览器不支持自动复制，请手动选择链接。')
      return
    }
    void navigator.clipboard.writeText(text).then(
      () => message.success('已复制到剪贴板'),
      () => message.warning('复制失败，请手动选择链接。'),
    )
  }

  const openForm = () => setFormOpen(true)

  const selectProposal = (id: string) => {
    setSelectedId(id)
    setFormOpen(false)
    setFailure(null)
    setLastCreated(null)
    setView('understanding')
  }

  const submitRequirement = async () => {
    const text = requirement.trim()
    if (!text) {
      message.warning('请填写需求内容。')
      return
    }
    if (!collectionId) {
      message.warning('请选择作用集合。')
      return
    }
    try {
      const result = await createMutation.mutateAsync({
        requirement: text,
        collectionId,
        fieldName: fieldName.trim() || undefined,
      })
      setSelectedId(result.id)
      setFormOpen(false)
      setView('understanding')
      setFailure(null)
      setLastCreated(null)
      setRequirement('')
      refresh(result.id)
      message.success('需求已提交，后端已返回对当前项目状态的结构化理解。')
    } catch (cause) {
      message.error(`创建需求失败：${errorMessage(cause)}`)
    }
  }

  const runPlan = async () => {
    if (!selectedId) {
      return
    }
    setView('plan')
    try {
      const result = await planMutation.mutateAsync(selectedId)
      refresh(selectedId)
      message.success(result.status === 'failed' ? '方案生成未成功，请查看失败信息。' : '已创建一条待审阅结构变更，尚未写入结构。')
    } catch (cause) {
      message.error(`生成方案失败：${errorMessage(cause)}`)
      refresh(selectedId)
    }
  }

  const runApply = async () => {
    if (!selectedId || !d || !d.plan || !d.plan.preview) {
      return
    }
    const currentRisk = d.plan.preview.risk
    if (currentRisk === 'blocked') {
      message.warning('预检判定为被阻塞，不能应用。')
      return
    }
    const confirmRisk = currentRisk === 'review'

    const proceed = async () => {
      setFailure(null)
      try {
        const result = await applyMutation.mutateAsync({ id: selectedId, confirmRisk })
        refresh(selectedId, true)
        if (result.status === 'failed') {
          message.error(`应用未成功：${displayText(result.errorCode)} ${displayText(result.errorMessage)}`.trim())
          setView('plan')
        } else {
          message.success('已应用到真实结构；现在可以验证目标字段是否已进入 Applied Model。')
          setView('verification')
        }
      } catch (cause) {
        setFailure(cause)
        message.error(`应用失败：${errorMessage(cause)}`)
        refresh(selectedId, true)
      }
    }

    if (confirmRisk) {
      modal.confirm({
        title: '确认应用（风险：需要确认）',
        content: '这次变更风险为「需要确认」。应用将携带显式风险确认（confirmRisk），并沿真实 schema apply 写入结构。确认前不会修改本地项目。',
        okText: '确认应用',
        cancelText: '取消',
        onOk: () => void proceed(),
      })
    } else {
      await proceed()
    }
  }

  const runVerify = async () => {
    if (!selectedId) {
      return
    }
    try {
      const result = await verifyMutation.mutateAsync(selectedId)
      refresh(selectedId)
      message.success(result.verification?.passed ? '验证通过，请查看每条结论。' : '验证未通过，请查看每条结论。')
    } catch (cause) {
      message.error(`验证失败：${errorMessage(cause)}`)
      refresh(selectedId)
    }
  }

  const runCreateShare = async () => {
    if (!selectedId) {
      return
    }
    try {
      const result = await createShareMutation.mutateAsync({ id: selectedId, hours: expiresInHours })
      setLastCreated(result)
      void queryClient.invalidateQueries({ queryKey: aiKeys.shares(selectedId) })
      message.success('已创建只读分享链接。')
    } catch (cause) {
      message.error(`创建分享链接失败：${errorMessage(cause)}`)
    }
  }

  const runRevoke = async (shareId: string) => {
    if (!selectedId) {
      return
    }
    try {
      await revokeShareMutation.mutateAsync(shareId)
      void queryClient.invalidateQueries({ queryKey: aiKeys.shares(selectedId) })
      message.success('链接已撤销，立即失效。')
    } catch (cause) {
      message.error(`撤销失败：${errorMessage(cause)}`)
    }
  }

  const changesHref = d ? changesHrefFor(d) : null

  return (
    <div className="mr-page mr-ai">
      <PageHeader
        title="AI 协作"
        description="把需求、规则化理解、待审阅变更、真实应用结果与验证串起来；你确认之前，项目不会被改动。"
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={openForm}>新建需求</Button>}
      />

      <Notice tone="neutral" icon={<InfoCircleOutlined />}>
        本页不接入大模型。「需求理解」是后端对当前项目真实状态的结构化计算（规则化理解，非大模型生成）；方案、应用、验证、分享全部走真实 API 与变更生命周期，AI 不会自动改动项目。
      </Notice>

      {collections.isError ? (
        <Notice tone="warning">
          集合列表读不到，集合名暂以 ID 显示：{errorMessage(collections.error)}
          <Button type="link" size="small" onClick={() => void collections.refetch()}>重试</Button>
        </Notice>
      ) : null}

      <div className="mr-ai__layout">
        {/* 左栏：真实集合上下文 + 提案列表 */}
        <div className="mr-ai__col">
          <ContextCard collections={collections.data ?? []} isPending={collections.isPending} />
          <ProposalList
            proposals={list}
            isPending={proposals.isPending}
            isError={proposals.isError}
            error={proposals.error}
            onRetry={() => void proposals.refetch()}
            selectedId={selectedId}
            onSelect={selectProposal}
            onNew={openForm}
          />
        </div>

        {/* 中栏：主工作面 */}
        <div className="mr-ai__col">
          {formOpen ? (
            <RequirementForm
              requirement={requirement}
              onRequirement={setRequirement}
              collectionId={collectionId}
              onCollectionId={setCollectionId}
              fieldName={fieldName}
              onFieldName={setFieldName}
              collections={collections.data ?? []}
              busy={createMutation.isPending}
              canCancel={Boolean(selectedId)}
              onSubmit={() => void submitRequirement()}
              onCancel={() => setFormOpen(false)}
            />
          ) : !selectedId ? (
            <EmptyWorkspace onNew={openForm} isPending={proposals.isPending} />
          ) : detail.isPending ? (
            <div className="mr-ai__card"><LoadingBlock rows={6} label="正在读取提案详情…" /></div>
          ) : detail.isError ? (
            <ErrorState error={detail.error} title="提案详情读不到" onRetry={() => void detail.refetch()} />
          ) : d ? (
            <>
              <div className="mr-ai__statusbar">
                <StatusTag tone={statusTone(d.status)}>{statusLabel(d.status)}</StatusTag>
                <span className="mr-ai__card-title">{d.title}</span>
                <span className="mr-meta">更新于 {formatDateTime(d.updatedAt)}</span>
                <Button size="small" icon={<PlusOutlined />} onClick={openForm}>新建需求</Button>
              </div>

              {planMutation.isPending ? (
                <Notice tone="neutral" icon={<LoadingOutlined />}>正在生成方案并创建待审阅变更…（基于真实项目状态，当前项目尚未修改）</Notice>
              ) : null}
              {d.status === 'planned' ? (
                <Notice tone="warning" icon={<PullRequestOutlined />}>待审阅变更已生成，尚未写入结构。请先到变更中心审阅，再决定是否应用。</Notice>
              ) : null}
              {d.status === 'applied' ? (
                <Notice tone="success" icon={<CheckCircleOutlined />}>已沿真实 schema apply 写入结构。下一步：验证目标字段是否已进入 Applied Model。</Notice>
              ) : null}
              {d.status === 'verified' && verification ? (
                <Notice tone={verification.passed ? 'success' : 'danger'} icon={<SafetyCertificateOutlined />}>
                  验证结论：{verification.passed ? '已通过' : '未通过'} · 共 {verification.checks.length} 项真实检查。
                  <Button type="link" size="small" onClick={() => setVerificationDrawer(true)}>查看验证结论</Button>
                </Notice>
              ) : null}
              {d.status === 'failed' ? (
                <Notice tone="danger" icon={<ExclamationCircleOutlined />}>
                  应用失败（后端落库真实结果）：<span className="mr-mono"> {displayText(d.errorCode)}</span>
                  {' · '}{displayText(d.errorMessage)}。
                  恢复路径：请 <Link to={changesHrefFor(d)} className="mr-ai__link">到变更中心查看执行记录与恢复状态 <ArrowRightOutlined /></Link>，处理后另建需求重试。
                </Notice>
              ) : null}
              {failure ? (
                <ErrorState
                  error={failure}
                  title={failure instanceof ApiError && failure.code === 'CHANGE_CONFIRMATION_REQUIRED' ? '需要显式确认风险' : '操作没有完成'}
                  onRetry={() => { setFailure(null); void detail.refetch() }}
                  retryLabel="重新检查"
                  secondary={<Link to={changesHrefFor(d)} className="mr-ai__link">去变更中心处理 <ArrowRightOutlined /></Link>}
                />
              ) : null}

              <div className="mr-ai__card">
                <Segmented
                  block
                  value={view}
                  onChange={(value) => setView(value as View)}
                  options={[
                    { label: '需求理解', value: 'understanding' },
                    { label: '方案与影响', value: 'plan' },
                    { label: '验证', value: 'verification' },
                    { label: '公开分享', value: 'share' },
                  ]}
                />
                <div className="mr-ai__view">
                  {view === 'understanding' ? (
                    <UnderstandingView detail={d} collections={collections.data ?? []} onNew={openForm} />
                  ) : null}
                  {view === 'plan' ? (
                    <PlanView
                      detail={d}
                      plan={plan}
                      onPlan={() => void runPlan()}
                      onApply={() => void runApply()}
                      planAvail={planAvail(d, busy)}
                      applyAvail={applyAvail(d, busy, risk)}
                      planPending={planMutation.isPending}
                      changesHref={changesHrefFor(d)}
                      failure={failure}
                      onRetry={() => { setFailure(null); void detail.refetch() }}
                    />
                  ) : null}
                  {view === 'verification' ? (
                    <VerificationView
                      verification={verification}
                      eligible={d.status === 'applied' || d.status === 'verified'}
                      verifyAvail={verifyAvail(d, busy)}
                      onVerify={() => void runVerify()}
                      onOpenDrawer={() => setVerificationDrawer(true)}
                      verifyPending={verifyMutation.isPending}
                    />
                  ) : null}
                  {view === 'share' ? (
                    <ShareView
                      shares={shares.data ?? []}
                      sharesPending={shares.isPending}
                      sharesError={shares.isError ? shares.error : null}
                      onRetryShares={() => void shares.refetch()}
                      expiresInHours={expiresInHours}
                      onExpires={setExpiresInHours}
                      onCreate={() => void runCreateShare()}
                      createPending={createShareMutation.isPending}
                      revokePending={revokeShareMutation.isPending}
                      onRevoke={(id) => void runRevoke(id)}
                      lastCreated={lastCreated}
                      onCopy={copy}
                    />
                  ) : null}
                </div>
              </div>
            </>
          ) : null}
        </div>

        {/* 右栏：324px「AI 助手」形态，合并为只读上下文助手 */}
        <AssistantSidebar detail={d} collections={collections.data ?? []} changesHref={changesHref} />
      </div>

      <Drawer
        open={verificationDrawer && Boolean(verification)}
        onClose={() => setVerificationDrawer(false)}
        width={560}
        title="验证结论 · 真实 Applied Model"
      >
        {verification ? (
          <div className="mr-ai__view-body">
            <Notice tone={verification.passed ? 'success' : 'danger'}>
              共 {verification.checks.length} 项真实检查，{verification.passed ? '全部通过' : '存在未通过项'}。
            </Notice>
            <ChecksList checks={verification.checks} />
            <p className="mr-ai__hint">结论由 POST /admin/api/v1/ai/proposals/{'{id}'}/verify 读取真实 Applied Model 后返回，核对目标字段是否已真实存在。</p>
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}
