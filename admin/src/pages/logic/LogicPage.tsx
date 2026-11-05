import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  App,
  Button,
  CodeBlock,
  DetailList,
  ErrorState,
  Field,
  Input,
  InputNumber,
  LoadingBlock,
  Modal,
  Notice,
  Segmented,
  Select,
  StateBlock,
  StatusTag,
  Switch,
  Table,
  Tag,
} from '@/ui'
import type { TableColumnsType } from '@/ui'
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  EditOutlined,
  InfoCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useBreadcrumbTail } from '@/app/BreadcrumbContext'
import { collectionKeys, collectionsApi } from '@/api/collections'
import { ApiError, errorMessage } from '@/api/client'
import {
  visualRuleKeys,
  visualRulesApi,
  type Rule,
  type RuleInput,
  type RuleUser,
  type Run,
  type TestResult,
  type TriggerEvent,
} from '@/api/visualRules'
import './logic.css'

/** 三个视图名同时是 URL 路径段；刷新 / 深链接都由 URL 还原。 */
type View = 'rules' | 'edit' | 'runs'
type Go = (view: View, query?: Record<string, string>) => void

/** 编辑表单的本地草稿；values 只保存用户实际填写的模板字符串。 */
type Draft = {
  name: string
  triggerCollectionId: string
  triggerEvent: TriggerEvent
  targetCollectionId: string
  values: Record<string, string>
  enabled: boolean
  retryEnabled: boolean
  timeoutMs: number
}

const EMPTY_DRAFT: Draft = {
  name: '',
  triggerCollectionId: '',
  triggerEvent: 'record.created',
  targetCollectionId: '',
  values: {},
  enabled: true,
  retryEnabled: false,
  timeoutMs: 5000,
}

/** 触发事件只允许后端约定的三个值。 */
const EVENT_LABELS: Record<TriggerEvent, string> = {
  'record.created': '创建记录后',
  'record.updated': '更新记录后',
  'record.deleted': '删除记录后',
}

const EVENT_OPTIONS: Array<{ value: TriggerEvent; label: string }> = (
  ['record.created', 'record.updated', 'record.deleted'] as TriggerEvent[]
).map((value) => ({ value, label: `${EVENT_LABELS[value]} · ${value}` }))

const PLACEHOLDERS = '{{user.id}}、{{user.email}}、{{user.displayName}}'

function normalizeView(raw?: string | null): View {
  return raw === 'edit' || raw === 'runs' || raw === 'rules' ? raw : 'rules'
}

function formatTime(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

/** 把渲染后的字段值渲染成 Figma「预计创建的记录」那样的可读文本。 */
function renderValues(values?: Record<string, string>): string {
  const entries = Object.entries(values ?? {})
  if (entries.length === 0) return '（无字段值）'
  return entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** 去掉空白输入，避免把空字段发给后端；body 允许只剩一个空 user。 */
function cleanUser(user: RuleUser): RuleUser {
  const next: RuleUser = {}
  if (user.id?.trim()) next.id = user.id.trim()
  if (user.email?.trim()) next.email = user.email.trim()
  if (user.displayName?.trim()) next.displayName = user.displayName.trim()
  return next
}

function isRetryable(run: Run): boolean {
  return run.kind === 'live' && run.status === 'failed'
}

/** 统一呈现后端真实错误：错误码 / 信息 / 恢复建议 / 请求 ID，不吞错、不造假结果。 */
function FailureNotice(props: { error: unknown; title?: string }) {
  const detail = props.error instanceof ApiError ? props.error : null
  return (
    <Notice tone="danger">
      <div className="mr-logic__failure">
        <div className="mr-logic__failure-title">{props.title ?? '请求失败'}</div>
        <div>{detail ? detail.message : errorMessage(props.error)}</div>
        <DetailList
          items={[
            detail ? { label: '错误码', value: detail.code } : null,
            detail?.hint ? { label: '恢复建议', value: detail.hint, mono: false } : null,
            detail?.requestId ? { label: '请求 ID', value: detail.requestId } : null,
          ]}
        />
      </div>
    </Notice>
  )
}

/** 测试用户 / 执行用户共用：三个真实输入，对应 payload.user。 */
function UserInputs(props: { value: RuleUser; onChange: (next: RuleUser) => void; disabled?: boolean }) {
  return (
    <div className="mr-logic__user-inputs">
      <Field label="用户 id">
        <Input
          value={props.value.id ?? ''}
          placeholder="可留空"
          disabled={props.disabled}
          onChange={(event) => props.onChange({ ...props.value, id: event.target.value })}
        />
      </Field>
      <Field label="邮箱 email">
        <Input
          value={props.value.email ?? ''}
          placeholder="可留空"
          disabled={props.disabled}
          onChange={(event) => props.onChange({ ...props.value, email: event.target.value })}
        />
      </Field>
      <Field label="显示名 displayName">
        <Input
          value={props.value.displayName ?? ''}
          placeholder="可留空"
          disabled={props.disabled}
          onChange={(event) => props.onChange({ ...props.value, displayName: event.target.value })}
        />
      </Field>
    </div>
  )
}

/**
 * 可视化业务逻辑（Figma 画板 25 / 17 / 18）。
 *
 * 全部数据来自真实 API：规则、集合与字段、测试、执行记录。
 * 视图由 URL 决定：/logic/rules、/logic/edit?rule=<id> | ?new=1、/logic/runs?rule=<id>。
 * 规格明确禁止代码 / Hook 编辑器，这里只做可视化触发条件 + 字段模板 + 测试 + 执行记录。
 */
export function LogicPage() {
  const params = useParams<{ tab?: string }>()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  // 兼容 /logic/:tab 与 /logic/* 两种接线：取路径末段作为视图名。
  const pathTail = location.pathname.split('/').filter(Boolean).pop()
  const view = normalizeView(params.tab ?? pathTail)
  const ruleId = searchParams.get('rule') ?? ''
  const isNew = searchParams.get('new') === '1'

  const go: Go = (next, query = {}) => {
    const qs = new URLSearchParams(query).toString()
    navigate(`/logic/${next}${qs ? `?${qs}` : ''}`)
  }

  useBreadcrumbTail([
    view === 'rules' ? null : view === 'edit' ? (isNew ? '新建业务逻辑' : '编辑业务逻辑') : '执行记录',
  ])

  if (view === 'edit' && !isNew && !ruleId) {
    return (
      <div className="mr-page mr-logic">
        <StateBlock
          tone="neutral"
          eyebrow="未指定业务逻辑"
          title="请选择要编辑的业务逻辑"
          description="编辑页需要 ?rule=<id>（编辑已有规则）或 ?new=1（新建规则）。"
          actions={
            <>
              <Button onClick={() => go('rules')}>返回业务逻辑列表</Button>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => go('edit', { new: '1' })}>
                新建业务逻辑
              </Button>
            </>
          }
        />
      </div>
    )
  }

  if (view === 'runs' && !ruleId) {
    return (
      <div className="mr-page mr-logic">
        <StateBlock
          tone="neutral"
          eyebrow="未指定业务逻辑"
          title="请选择要查看的业务逻辑"
          description="执行记录页需要 ?rule=<id>，可从业务逻辑列表的「查看执行记录」进入。"
          actions={<Button onClick={() => go('rules')}>返回业务逻辑列表</Button>}
        />
      </div>
    )
  }

  return (
    <div className="mr-page mr-logic">
      {view === 'rules' ? <RulesView go={go} /> : null}
      {view === 'edit' ? (
        <EditView key={`edit:${ruleId}:${isNew ? 'new' : 'saved'}`} go={go} ruleId={isNew ? '' : ruleId} isNew={isNew} />
      ) : null}
      {view === 'runs' ? <RunsView key={`runs:${ruleId}`} go={go} ruleId={ruleId} /> : null}
    </div>
  )
}

/** 画板 25：真实规则表格，行操作全部走真实 API。 */
function RulesView(props: { go: Go }) {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  const rulesQuery = useQuery({ queryKey: visualRuleKeys.list, queryFn: visualRulesApi.list })
  const collectionsQuery = useQuery({ queryKey: collectionKeys.list, queryFn: collectionsApi.list })
  const rules = rulesQuery.data ?? []

  const nameOf = (id: string): string =>
    collectionsQuery.data?.find((collection) => collection.id === id)?.name ?? id

  const toggle = useMutation({
    mutationFn: (vars: { id: string; enable: boolean }) =>
      vars.enable ? visualRulesApi.enable(vars.id) : visualRulesApi.disable(vars.id),
    onSuccess: (rule) => {
      void queryClient.invalidateQueries({ queryKey: visualRuleKeys.list })
      message.success(rule.enabled ? `已启用「${rule.name}」` : `已停用「${rule.name}」`)
    },
    onError: (error) => message.error(`启用 / 停用失败：${errorMessage(error)}`),
  })

  const columns: TableColumnsType<Rule> = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (value: string, record) => (
        <div className="mr-logic__rule-name">
          <span className="mr-logic__strong">{value}</span>
          <span className="mr-logic__hint">
            {nameOf(record.triggerCollectionId)} {EVENT_LABELS[record.triggerEvent] ?? record.triggerEvent} →{' '}
            {nameOf(record.targetCollectionId)}
          </span>
        </div>
      ),
    },
    {
      title: '触发集合 / 事件',
      width: 200,
      render: (_value, record: Rule) => (
        <div>
          <div className="mr-mono">{nameOf(record.triggerCollectionId)}</div>
          <div className="mr-logic__hint">{EVENT_LABELS[record.triggerEvent] ?? record.triggerEvent}</div>
          <div className="mr-mono mr-logic__hint">{record.triggerEvent}</div>
        </div>
      ),
    },
    {
      title: '目标集合',
      width: 140,
      render: (_value, record: Rule) => <span className="mr-mono">{nameOf(record.targetCollectionId)}</span>,
    },
    {
      title: '启用状态',
      dataIndex: 'enabled',
      width: 100,
      render: (enabled: boolean) =>
        enabled ? <StatusTag tone="success">已启用</StatusTag> : <StatusTag>已停用</StatusTag>,
    },
    {
      title: '版本',
      dataIndex: 'revision',
      width: 80,
      render: (revision: number) => <span className="mr-mono">v{revision}</span>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 175,
      render: (value: string) => <span className="mr-mono">{formatTime(value)}</span>,
    },
    {
      title: '操作',
      width: 270,
      render: (_value, record: Rule) => (
        <div className="mr-logic__row-actions">
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => props.go('edit', { rule: record.id })}>
            编辑
          </Button>
          <Button type="link" size="small" onClick={() => props.go('runs', { rule: record.id })}>
            查看执行记录
          </Button>
          <Button
            type="link"
            size="small"
            loading={toggle.isPending && toggle.variables?.id === record.id}
            onClick={() => toggle.mutate({ id: record.id, enable: !record.enabled })}
          >
            {record.enabled ? '停用' : '启用'}
          </Button>
        </div>
      ),
    },
  ]

  return (
    <>
      <header className="mr-logic__header">
        <div>
          <h1 className="mr-logic__title">业务逻辑</h1>
          <p className="mr-logic__desc">把重复的应用行为，交给清楚、可验证的规则。</p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => props.go('edit', { new: '1' })}>
          新建业务逻辑
        </Button>
      </header>
      <div className="mr-logic__divider" />
      <Notice icon={<InfoCircleOutlined />}>
        每条逻辑都有独立的测试与执行记录，修改不会追溯影响已有数据；测试为 dry-run，不会写入业务数据。
      </Notice>

      {rulesQuery.isPending ? (
        <LoadingBlock rows={5} label="正在读取业务逻辑…" />
      ) : rulesQuery.isError ? (
        <ErrorState
          error={rulesQuery.error}
          title="业务逻辑读取失败"
          onRetry={() => void rulesQuery.refetch()}
          retryLabel="重新读取"
        />
      ) : rules.length === 0 ? (
        <StateBlock
          tone="neutral"
          eyebrow="还没有业务逻辑"
          icon={<ThunderboltOutlined />}
          title="把第一个重复行为交给规则"
          description="选择触发集合与事件，按目标集合真实字段配置模板，先测试再启用。"
          actions={
            <Button type="primary" icon={<PlusOutlined />} onClick={() => props.go('edit', { new: '1' })}>
              新建业务逻辑
            </Button>
          }
        />
      ) : (
        <>
          <Table<Rule>
            rowKey="id"
            size="small"
            pagination={false}
            columns={columns}
            dataSource={rules}
            className="mr-logic__table"
          />
          <div className="mr-logic__summary">共 {rules.length} 条业务逻辑</div>
          {toggle.isError ? <FailureNotice error={toggle.error} title="启用 / 停用失败" /> : null}
        </>
      )}
    </>
  )
}

/**
 * 画板 17：左栏「编辑业务逻辑」表单 + 右栏 330px「先验证一次」卡片。
 * 测试是 dry-run，绝不写业务数据；保存后才可以测试与真实执行一次。
 */
function EditView(props: { go: Go; ruleId: string; isNew: boolean }) {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  const hasSavedRule = !props.isNew && !!props.ruleId

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const patch = (next: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...next }))

  const [testUser, setTestUser] = useState<RuleUser>({})
  const [runUser, setRunUser] = useState<RuleUser>({})
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [testError, setTestError] = useState<unknown>(null)
  const [runResult, setRunResult] = useState<Run | null>(null)
  const [runError, setRunError] = useState<unknown>(null)

  const ruleQuery = useQuery({
    queryKey: visualRuleKeys.detail(props.ruleId),
    queryFn: () => visualRulesApi.get(props.ruleId),
    enabled: hasSavedRule,
  })
  const collectionsQuery = useQuery({ queryKey: collectionKeys.list, queryFn: collectionsApi.list })
  const targetQuery = useQuery({
    queryKey: collectionKeys.detail(draft.targetCollectionId),
    queryFn: () => collectionsApi.get(draft.targetCollectionId),
    enabled: !!draft.targetCollectionId,
  })

  // 读取已有规则后回填表单；新建时保持空草稿。
  useEffect(() => {
    if (!ruleQuery.data) return
    const rule = ruleQuery.data
    setDraft({
      name: rule.name ?? '',
      triggerCollectionId: rule.triggerCollectionId ?? '',
      triggerEvent: rule.triggerEvent ?? 'record.created',
      targetCollectionId: rule.targetCollectionId ?? '',
      values: { ...(rule.values ?? {}) },
      enabled: Boolean(rule.enabled),
      retryEnabled: Boolean(rule.retryEnabled),
      timeoutMs: rule.timeoutMs ?? EMPTY_DRAFT.timeoutMs,
    })
  }, [ruleQuery.data])

  const save = useMutation({
    mutationFn: (input: RuleInput) =>
      props.isNew ? visualRulesApi.create(input) : visualRulesApi.update(props.ruleId, input),
    onSuccess: (rule) => {
      void queryClient.invalidateQueries({ queryKey: visualRuleKeys.list })
      if (props.isNew) {
        message.success('业务逻辑已保存，可先测试或执行一次')
        props.go('edit', { rule: rule.id })
      } else {
        void queryClient.invalidateQueries({ queryKey: visualRuleKeys.detail(rule.id) })
        message.success(`已保存 · 版本 v${rule.revision}`)
      }
    },
  })

  const test = useMutation({
    mutationFn: (user: RuleUser) => visualRulesApi.test(props.ruleId, { user }),
    onSuccess: (result) => {
      setTestResult(result)
      setTestError(null)
      void queryClient.invalidateQueries({ queryKey: visualRuleKeys.runs(props.ruleId) })
    },
    onError: (error) => {
      setTestResult(null)
      setTestError(error)
    },
  })

  const runOnce = useMutation({
    mutationFn: (user: RuleUser) => visualRulesApi.run(props.ruleId, { user }),
    onSuccess: (run) => {
      setRunResult(run)
      setRunError(null)
      void queryClient.invalidateQueries({ queryKey: visualRuleKeys.runs(props.ruleId) })
      if (run.status === 'succeeded') {
        message.success(`执行成功 · 创建记录 ${run.recordId ?? '—'}`)
      } else {
        message.error(`执行失败：${run.errorMessage ?? run.errorCode ?? '未知原因'}`)
      }
    },
    onError: (error) => {
      setRunResult(null)
      setRunError(error)
      message.error(`执行请求失败：${errorMessage(error)}`)
    },
  })

  const collectionOptions = (collectionsQuery.data ?? []).map((collection) => ({
    value: collection.id,
    label: collection.name,
  }))
  const nameOf = (id: string): string =>
    collectionsQuery.data?.find((collection) => collection.id === id)?.name ?? (id || '未选择')
  const writableFields = (targetQuery.data?.fields ?? []).filter((field) => !field.system)

  const canSave =
    draft.name.trim().length > 0 && !!draft.triggerCollectionId && !!draft.targetCollectionId && !save.isPending
  const saveHint = !draft.name.trim()
    ? '请填写逻辑名称'
    : !draft.triggerCollectionId
      ? '请选择触发集合'
      : !draft.targetCollectionId
        ? '请选择目标集合'
        : '配置校验通过后即可保存；测试与执行使用已保存的规则。'

  const buildInput = (): RuleInput => {
    const values: Record<string, string> = {}
    for (const [key, template] of Object.entries(draft.values)) {
      if (template.trim() !== '') values[key] = template
    }
    return {
      name: draft.name.trim(),
      triggerCollectionId: draft.triggerCollectionId,
      triggerEvent: draft.triggerEvent,
      targetCollectionId: draft.targetCollectionId,
      values,
      enabled: draft.enabled,
      retryEnabled: draft.retryEnabled,
      timeoutMs: draft.timeoutMs,
    }
  }

  return (
    <>
      <header className="mr-logic__header">
        <div>
          <Button
            type="text"
            size="small"
            className="mr-logic__back"
            icon={<ArrowLeftOutlined />}
            onClick={() => props.go('rules')}
          >
            ← 返回业务逻辑
          </Button>
          <h1 className="mr-logic__title">
            {props.isNew ? '编辑业务逻辑' : (ruleQuery.data?.name ?? '编辑业务逻辑')}
          </h1>
          <p className="mr-logic__desc">
            配好行为，先测试，再保存启用。可视化触发条件 + 字段模板，不提供代码 / Hook 编辑器。
          </p>
        </div>
        <Button
          icon={<EditOutlined />}
          disabled={!hasSavedRule}
          onClick={() => props.go('runs', { rule: props.ruleId })}
        >
          查看执行记录
        </Button>
      </header>
      <div className="mr-logic__divider" />

      {hasSavedRule && ruleQuery.isPending ? (
        <LoadingBlock rows={6} label="正在读取业务逻辑…" />
      ) : hasSavedRule && ruleQuery.isError ? (
        <ErrorState
          error={ruleQuery.error}
          title="业务逻辑读取失败"
          onRetry={() => void ruleQuery.refetch()}
          retryLabel="重新读取"
        />
      ) : (
        <div className="mr-logic__columns">
          <div className="mr-logic__main">
            <Field label="逻辑名称" required>
              <Input
                value={draft.name}
                placeholder="给这条业务逻辑起个名字"
                onChange={(event) => patch({ name: event.target.value })}
              />
            </Field>

            <h2 className="mr-logic__section-title">触发条件与行为</h2>
            <div className="mr-logic__trigger-grid">
              <Field label="触发集合" required>
                <Select
                  value={draft.triggerCollectionId || undefined}
                  placeholder="选择真实集合"
                  options={collectionOptions}
                  onChange={(value: string) => patch({ triggerCollectionId: value })}
                />
              </Field>
              <Field label="触发事件" required>
                <Select
                  value={draft.triggerEvent}
                  options={EVENT_OPTIONS}
                  onChange={(value: TriggerEvent) => patch({ triggerEvent: value })}
                />
              </Field>
              <Field label="目标集合" required>
                <Select
                  value={draft.targetCollectionId || undefined}
                  placeholder="选择真实集合"
                  options={collectionOptions}
                  onChange={(value: string) => patch({ targetCollectionId: value, values: {} })}
                />
              </Field>
            </div>
            {collectionsQuery.isError ? (
              <FailureNotice error={collectionsQuery.error} title="集合列表读取失败" />
            ) : null}
            <div className="mr-logic__flow">
              <div className="mr-logic__flow-step">
                <span className="mr-logic__flow-eyebrow">当什么发生</span>
                <strong className="mr-logic__flow-value">{nameOf(draft.triggerCollectionId)}</strong>
                <span className="mr-logic__flow-meta">
                  {EVENT_LABELS[draft.triggerEvent] ?? draft.triggerEvent}
                </span>
              </div>
              <span className="mr-logic__flow-arrow">→</span>
              <div className="mr-logic__flow-step">
                <span className="mr-logic__flow-eyebrow">执行什么行为</span>
                <strong className="mr-logic__flow-value">{nameOf(draft.targetCollectionId)}</strong>
                <span className="mr-logic__flow-meta">创建一条记录</span>
              </div>
              <span className="mr-logic__flow-arrow">→</span>
              <div className="mr-logic__flow-step">
                <span className="mr-logic__flow-eyebrow">写入内容</span>
                <strong className="mr-logic__flow-value">字段模板</strong>
                <span className="mr-logic__flow-meta">{writableFields.length} 个可写字段</span>
              </div>
            </div>
            <Notice icon={<InfoCircleOutlined />}>
              命中触发事件即按下方模板在目标集合创建记录；当前版本不做额外条件过滤，也不提供代码 / Hook 编辑器。
            </Notice>

            <h2 className="mr-logic__section-title">创建内容 · {nameOf(draft.targetCollectionId)}</h2>
            <p className="mr-logic__hint">
              按目标集合真实非系统字段动态生成；每个模板支持 {PLACEHOLDERS} 三个占位符，渲染结果均为字符串（建议用于
              text 类字段）。留空表示该字段不写入。
            </p>
            {!draft.targetCollectionId ? (
              <Notice>请先在上方选择目标集合，字段模板会按真实字段自动生成。</Notice>
            ) : targetQuery.isPending ? (
              <LoadingBlock rows={2} label="正在读取目标集合字段…" />
            ) : targetQuery.isError ? (
              <FailureNotice error={targetQuery.error} title="目标集合字段读取失败" />
            ) : writableFields.length === 0 ? (
              <Notice>目标集合没有可写入的非系统字段，请先在结构页添加字段。</Notice>
            ) : (
              <div className="mr-logic__fields">
                {writableFields.map((field) => (
                  <Field
                    key={field.id}
                    label={
                      <span className="mr-logic__field-label">
                        <span className="mr-mono">{field.name}</span>
                        <Tag>{field.type}</Tag>
                        {field.required ? <span className="mr-logic__required">必填</span> : null}
                      </span>
                    }
                    hint={field.description}
                  >
                    <Input
                      className="mr-mono"
                      value={draft.values[field.name] ?? ''}
                      placeholder={`留空则不写入 · 支持 ${PLACEHOLDERS}`}
                      onChange={(event) =>
                        patch({ values: { ...draft.values, [field.name]: event.target.value } })
                      }
                    />
                  </Field>
                ))}
              </div>
            )}

            <h2 className="mr-logic__section-title">高级配置 · 重试与超时</h2>
            <p className="mr-logic__hint">以下均为可视化配置项，不是代码编辑器。</p>
            <div className="mr-logic__config-row">
              <div className="mr-logic__config-text">
                <strong className="mr-logic__config-title">保存后保持启用</strong>
                <span className="mr-logic__config-desc">只影响后续触发；不会自动补跑历史失败记录。</span>
              </div>
              <Switch checked={draft.enabled} onChange={(checked) => patch({ enabled: checked })} />
            </div>
            <div className="mr-logic__config-row">
              <div className="mr-logic__config-text">
                <strong className="mr-logic__config-title">失败自动重试</strong>
                <span className="mr-logic__config-desc">
                  启用后由运行时处理可重试失败；历史失败仍需单独确认。
                </span>
              </div>
              <Switch checked={draft.retryEnabled} onChange={(checked) => patch({ retryEnabled: checked })} />
            </div>
            <div className="mr-logic__config-row">
              <div className="mr-logic__config-text">
                <strong className="mr-logic__config-title">超时（毫秒）</strong>
                <span className="mr-logic__config-desc">单次执行的最长等待时间。</span>
              </div>
              <InputNumber
                min={0}
                step={1000}
                value={draft.timeoutMs}
                onChange={(value) => patch({ timeoutMs: value ?? 0 })}
              />
            </div>

            <div className="mr-logic__footer">
              <span className="mr-logic__hint">{saveHint}</span>
              <div className="mr-logic__footer-actions">
                <Button onClick={() => props.go('rules')}>取消</Button>
                <Button
                  type="primary"
                  loading={save.isPending}
                  disabled={!canSave}
                  onClick={() => save.mutate(buildInput())}
                >
                  保存
                </Button>
              </div>
            </div>
            {save.isError ? <FailureNotice error={save.error} title="保存失败" /> : null}

            <RunPanel
              saved={hasSavedRule}
              loading={runOnce.isPending}
              user={runUser}
              onUserChange={setRunUser}
              onRun={() => runOnce.mutate(cleanUser(runUser))}
              result={runResult}
              error={runError}
              onViewRuns={() => props.go('runs', { rule: props.ruleId })}
            />
          </div>

          <TestCard
            saved={hasSavedRule}
            loading={test.isPending}
            user={testUser}
            onUserChange={setTestUser}
            onRetest={() => test.mutate(cleanUser(testUser))}
            result={testResult}
            error={testError}
            onViewRuns={() => props.go('runs', { rule: props.ruleId })}
          />
        </div>
      )}
    </>
  )
}

/** 右栏「先验证一次」：真实 test 接口的 checks / 渲染值，明确标注本次未写入数据。 */
function TestCard(props: {
  saved: boolean
  loading: boolean
  user: RuleUser
  onUserChange: (next: RuleUser) => void
  onRetest: () => void
  result: TestResult | null
  error: unknown
  onViewRuns: () => void
}) {
  return (
    <aside className="mr-logic__test-card">
      <h2 className="mr-logic__test-title">先验证一次</h2>
      <p className="mr-logic__test-desc">
        模拟触发事件，只预览字段渲染与校验结果。这是 dry-run，<strong>不会写入任何业务数据</strong>，但会保留一条测试执行记录。
      </p>

      <div className="mr-logic__test-label">测试用户</div>
      <UserInputs value={props.user} onChange={props.onUserChange} disabled={!props.saved || props.loading} />

      <Button
        block
        icon={<PlayCircleOutlined />}
        loading={props.loading}
        disabled={!props.saved}
        onClick={props.onRetest}
      >
        重新测试
      </Button>
      {!props.saved ? (
        <Notice>保存业务逻辑后即可测试；测试接口需要一个已保存的规则 ID。</Notice>
      ) : null}

      <div className="mr-logic__divider" />

      {props.error ? <FailureNotice error={props.error} title="测试请求失败" /> : null}

      {props.result ? (
        <>
          <StatusTag tone={props.result.passed ? 'success' : 'danger'}>
            {props.result.passed ? '测试通过 · 模拟执行' : '测试未通过'}
          </StatusTag>
          <ul className="mr-logic__checks">
            {props.result.checks.map((check, index) => (
              <li
                key={index}
                className={`mr-logic__check ${check.passed ? 'mr-logic__check--pass' : 'mr-logic__check--fail'}`}
              >
                <span className="mr-logic__check-icon">
                  {check.passed ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                </span>
                <span className="mr-logic__check-body">
                  <span className="mr-logic__check-label">{check.label}</span>
                  {check.detail ? <span className="mr-logic__check-detail">{check.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          <CodeBlock label="预计写入的字段值" code={renderValues(props.result.values)} />
          <Notice tone="neutral" icon={<InfoCircleOutlined />}>
            本次未写入数据。测试只渲染模板、执行校验并生成一条测试记录，不会在目标集合创建任何业务记录。
          </Notice>
          <div className="mr-logic__hint">
            测试执行记录 ID · <span className="mr-mono">{props.result.runId}</span>
          </div>
        </>
      ) : !props.error ? (
        <StateBlock
          tone="neutral"
          eyebrow="尚无测试结果"
          title="点击「重新测试」查看结果"
          description="结果来自后端真实 test 接口，包含逐项 checks 与渲染后的字段值。"
        />
      ) : null}

      <Button type="link" size="small" className="mr-logic__link" onClick={props.onViewRuns}>
        查看失败执行 →
      </Button>
    </aside>
  )
}

/** 左栏「执行一次」：真实 run 接口，展示真实 recordId 或真实失败原因。 */
function RunPanel(props: {
  saved: boolean
  loading: boolean
  user: RuleUser
  onUserChange: (next: RuleUser) => void
  onRun: () => void
  result: Run | null
  error: unknown
  onViewRuns: () => void
}) {
  return (
    <section className="mr-logic__run-panel">
      <h2 className="mr-logic__section-title">执行一次</h2>
      <p className="mr-logic__hint">
        这是真实执行：会向目标集合创建一条记录，并写入一条实际执行记录。与「先验证一次」的 dry-run 不同，请确认后再操作。
      </p>
      {!props.saved ? (
        <Notice>保存业务逻辑后可手动执行一次。</Notice>
      ) : (
        <>
          <div className="mr-logic__test-label">执行用户</div>
          <UserInputs value={props.user} onChange={props.onUserChange} disabled={props.loading} />
          <Button type="primary" icon={<ThunderboltOutlined />} loading={props.loading} onClick={props.onRun}>
            执行一次
          </Button>

          {props.error ? <FailureNotice error={props.error} title="执行请求失败" /> : null}

          {props.result ? (
            props.result.status === 'succeeded' ? (
              <Notice tone="success">
                执行成功 · 已在目标集合创建记录 <span className="mr-mono">{props.result.recordId ?? '—'}</span>。
              </Notice>
            ) : (
              <Notice tone="danger">
                <div className="mr-logic__failure">
                  <div className="mr-logic__failure-title">执行失败</div>
                  <div>{props.result.errorMessage ?? '后端未提供错误信息'}</div>
                  <DetailList
                    items={[
                      { label: '错误码', value: props.result.errorCode ?? '—' },
                      { label: '执行 ID', value: props.result.id },
                    ]}
                  />
                  <div className="mr-logic__hint">
                    可在执行记录页对该失败记录发起重试；原失败结果会保留。
                  </div>
                </div>
              </Notice>
            )
          ) : null}

          <Button type="link" size="small" className="mr-logic__link" onClick={props.onViewRuns}>
            查看执行记录 →
          </Button>
        </>
      )}
    </section>
  )
}

/** 画板 18：真实执行记录表格，展开详情，仅 live+failed 可重试。 */
function RunsView(props: { go: Go; ruleId: string }) {
  const { message } = App.useApp()
  const queryClient = useQueryClient()

  const ruleQuery = useQuery({
    queryKey: visualRuleKeys.detail(props.ruleId),
    queryFn: () => visualRulesApi.get(props.ruleId),
    enabled: !!props.ruleId,
  })
  const runsQuery = useQuery({
    queryKey: visualRuleKeys.runs(props.ruleId),
    queryFn: () => visualRulesApi.runs(props.ruleId),
    enabled: !!props.ruleId,
  })

  const [retryTarget, setRetryTarget] = useState<Run | null>(null)
  const [lastRetry, setLastRetry] = useState<Run | null>(null)

  const retry = useMutation({
    mutationFn: (runId: string) => visualRulesApi.retry(runId),
    onSuccess: (run) => {
      setRetryTarget(null)
      setLastRetry(run)
      void queryClient.invalidateQueries({ queryKey: visualRuleKeys.runs(props.ruleId) })
      message.success(`已发起重试 · 新记录 ${run.id}${run.attemptOf ? `（关联 ${run.attemptOf}）` : ''}`)
    },
    onError: (error) => message.error(`重试失败：${errorMessage(error)}`),
  })

  const runs = runsQuery.data ?? []
  const succeeded = runs.filter((run) => run.status === 'succeeded').length
  const failed = runs.filter((run) => run.status === 'failed').length

  const columns: TableColumnsType<Run> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 175,
      render: (value: string) => <span className="mr-mono">{formatTime(value)}</span>,
    },
    {
      title: '类型',
      dataIndex: 'kind',
      width: 120,
      render: (kind: string) => (kind === 'test' ? <Tag>测试 · 不写入</Tag> : <Tag>实际执行</Tag>),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 150,
      render: (status: string, record: Run) => (
        <span className="mr-logic__status-cell">
          <StatusTag tone={status === 'succeeded' ? 'success' : 'danger'}>
            {status === 'succeeded' ? '成功' : '失败'}
          </StatusTag>
          {isRetryable(record) ? <StatusTag tone="warning">可重试</StatusTag> : null}
        </span>
      ),
    },
    {
      title: '记录 ID',
      dataIndex: 'recordId',
      width: 140,
      render: (value: string) => (value ? <span className="mr-mono">{value}</span> : '—'),
    },
    {
      title: '错误',
      render: (_value, record: Run) =>
        record.errorCode || record.errorMessage ? (
          <span className="mr-logic__error-cell">
            <span className="mr-mono">{record.errorCode ?? '—'}</span>
            <span>{record.errorMessage ?? ''}</span>
          </span>
        ) : (
          '—'
        ),
    },
    {
      title: '关联',
      dataIndex: 'attemptOf',
      width: 130,
      render: (value: string) => (value ? <span className="mr-mono">{value}</span> : '—'),
    },
    {
      title: '操作',
      width: 90,
      render: (_value, record: Run) =>
        isRetryable(record) ? (
          <Button
            type="link"
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => {
              retry.reset()
              setRetryTarget(record)
            }}
          >
            重试
          </Button>
        ) : (
          <span className="mr-logic__muted">—</span>
        ),
    },
  ]

  return (
    <>
      <header className="mr-logic__header">
        <div>
          <Button
            type="text"
            size="small"
            className="mr-logic__back"
            icon={<ArrowLeftOutlined />}
            onClick={() => props.go('rules')}
          >
            ← 返回业务逻辑
          </Button>
          <h1 className="mr-logic__title">{ruleQuery.data?.name ?? '执行记录'}</h1>
          <p className="mr-logic__desc">每次执行都保留独立结果。失败不会影响触发事件，不会擅自补跑。</p>
        </div>
        <Button icon={<EditOutlined />} onClick={() => props.go('edit', { rule: props.ruleId })}>
          编辑逻辑
        </Button>
      </header>
      <div className="mr-logic__divider" />

      <Segmented
        className="mr-logic__segmented"
        value="执行记录"
        options={[
          { value: '配置', label: '配置' },
          { value: '执行记录', label: '执行记录' },
        ]}
        onChange={(value) => {
          if (String(value) === '配置') props.go('edit', { rule: props.ruleId })
        }}
      />

      {lastRetry ? (
        <Notice tone={lastRetry.status === 'succeeded' ? 'success' : 'warning'}>
          <div className="mr-logic__failure">
            <div className="mr-logic__failure-title">已新增一条重试执行记录（真实结果）</div>
            <DetailList
              items={[
                { label: '新记录 ID', value: lastRetry.id },
                { label: '状态', value: lastRetry.status === 'succeeded' ? '成功' : '失败', mono: false },
                { label: '关联原记录 attemptOf', value: lastRetry.attemptOf ?? '—' },
                { label: '创建记录 ID', value: lastRetry.recordId ?? '—' },
                { label: '错误码', value: lastRetry.errorCode ?? '—' },
                { label: '错误信息', value: lastRetry.errorMessage ?? '—', mono: false },
              ]}
            />
            <Button type="link" size="small" className="mr-logic__link" onClick={() => setLastRetry(null)}>
              关闭
            </Button>
          </div>
        </Notice>
      ) : null}

      <Notice icon={<InfoCircleOutlined />}>
        只有「实际执行 · 失败」的记录可以重试；测试记录与成功记录不可重试。重试会新增一条执行记录，原失败结果保留。
      </Notice>

      {runsQuery.isPending ? (
        <LoadingBlock rows={5} label="正在读取执行记录…" />
      ) : runsQuery.isError ? (
        <ErrorState
          error={runsQuery.error}
          title="执行记录读取失败"
          onRetry={() => void runsQuery.refetch()}
          retryLabel="重新读取"
        />
      ) : runs.length === 0 ? (
        <StateBlock
          tone="neutral"
          eyebrow="还没有执行记录"
          title="测试或执行一次后，这里会留下真实结果"
          description="测试（dry-run）不会写入业务数据；真实执行会向目标集合创建记录。"
          actions={<Button onClick={() => props.go('edit', { rule: props.ruleId })}>返回配置并测试</Button>}
        />
      ) : (
        <>
          <Table<Run>
            rowKey="id"
            size="small"
            pagination={false}
            columns={columns}
            dataSource={runs}
            className="mr-logic__table"
            expandable={{ expandedRowRender: (record: Run) => <RunDetail run={record} /> }}
          />
          <div className="mr-logic__summary">
            共 {runs.length} 次执行 · {succeeded} 次成功 · {failed} 次失败
          </div>
        </>
      )}

      <Modal
        open={retryTarget !== null}
        title="确认使用当前模板重试？"
        okText="确认重试本次"
        cancelText="取消"
        confirmLoading={retry.isPending}
        onOk={() => {
          if (retryTarget) retry.mutate(retryTarget.id)
        }}
        onCancel={() => {
          setRetryTarget(null)
          retry.reset()
        }}
        width={520}
      >
        {retryTarget ? (
          <div className="mr-logic__retry-body">
            <p>
              将对原失败执行 <span className="mr-mono">{retryTarget.id}</span> 发起重试，使用当前保存的字段模板。
            </p>
            <DetailList
              items={[
                { label: '触发时间', value: formatTime(retryTarget.createdAt), mono: false },
                { label: '错误码', value: retryTarget.errorCode ?? '—' },
                { label: '错误信息', value: retryTarget.errorMessage ?? '—', mono: false },
                { label: '原记录 ID', value: retryTarget.id },
              ]}
            />
            <Notice tone="warning">
              重试将新增一条执行记录，原失败结果保留；新记录的 attemptOf 会指向本次原记录。重试属于真实执行，会创建记录。
            </Notice>
            {retry.isError ? <FailureNotice error={retry.error} title="重试请求失败" /> : null}
          </div>
        ) : null}
      </Modal>
    </>
  )
}

/** 执行记录展开详情：真实 payload / values / 错误，不做任何加工。 */
function RunDetail(props: { run: Run }) {
  const run = props.run
  return (
    <div className="mr-logic__run-detail">
      <DetailList
        items={[
          { label: '执行 ID', value: run.id },
          { label: '规则 ID', value: run.ruleId },
          { label: '类型', value: run.kind === 'test' ? '测试（dry-run，不写入业务数据）' : '实际执行', mono: false },
          { label: '状态', value: run.status === 'succeeded' ? '成功' : '失败', mono: false },
          { label: '创建记录 ID', value: run.recordId ?? '—' },
          { label: '错误码', value: run.errorCode ?? '—' },
          { label: '错误信息', value: run.errorMessage ?? '—', mono: false },
          { label: '重试来源', value: run.attemptOf ?? '—' },
          { label: '开始时间', value: formatTime(run.createdAt), mono: false },
          { label: '结束时间', value: formatTime(run.finishedAt), mono: false },
        ]}
      />
      <div className="mr-logic__detail-block">
        <span className="mr-logic__detail-label">当时输入 · payload.user</span>
        <CodeBlock label="json" code={prettyJson(run.payload?.user ?? {})} />
      </div>
      <div className="mr-logic__detail-block">
        <span className="mr-logic__detail-label">渲染后的字段值 · values</span>
        <CodeBlock label="text" code={renderValues(run.values)} />
      </div>
      {run.status === 'failed' ? (
        <Notice tone="danger">
          该次执行失败：{run.errorMessage ?? '后端未提供错误信息'}
          {run.errorCode ? <>（{run.errorCode}）</> : null}。原始输入与错误会保留，不会被新模板覆盖。
        </Notice>
      ) : null}
    </div>
  )
}
