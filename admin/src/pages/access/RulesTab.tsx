import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
  LoadingBlock,
  Mono,
  Notice,
  Segmented,
  Select,
  StatusTag,
} from '@/ui'
import {
  ArrowRightOutlined,
  EditOutlined,
  ExportOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import {
  accessRulesApi,
  RULE_OPERATIONS,
  type Rule,
  type RuleMode,
  type RuleOperation,
  type RulesState,
  type SimulatePrincipal,
  type SimulateResult,
} from '@/api/accessRules'
import { collectionKeys, collectionsApi, type CollectionSummary } from '@/api/collections'
import { recordKeys, recordsApi, type RecordItem } from '@/api/records'
import { appAuthApi, appAuthKeys, type ApplicationUser } from '@/api/appauth'
import { errorMessage } from '@/api/client'
import './rules.css'

/** 访问规则查询键：与页面的 useQuery / useMutation 一起定义在本文件。 */
const accessRuleKeys = {
  state: (collectionId: string) => ['access-rules', collectionId] as const,
}

/** 操作文案：规则列表 5 行，PUT 也按这里的顺序恰好给出 5 条。 */
const OPERATION_META: Record<RuleOperation, { label: string; hint: string }> = {
  list: { label: '读取列表', hint: '列出集合中的记录' },
  view: { label: '读取详情', hint: '查看单条记录的内容' },
  create: { label: '创建', hint: '新增记录' },
  update: { label: '修改', hint: '编辑已有记录' },
  delete: { label: '删除', hint: '移除记录' },
}

/** 模式文案：中文摘要、说明与抽屉下拉共用一份真实映射。 */
const MODE_META: Record<RuleMode, { label: string; hint: string }> = {
  noAccess: { label: '禁止访问', hint: '任何人都不能执行该操作' },
  anyone: { label: '任何人', hint: '包括未登录访客在内的所有人' },
  signedInUsers: { label: '已登录用户', hint: '仅通过认证的应用用户' },
  recordOwner: { label: '记录本人', hint: '仅记录关联字段指向的用户' },
  custom: { label: '自定义条件', hint: '按字段条件表达式判断' },
}

const RULE_MODES: RuleMode[] = ['noAccess', 'anyone', 'signedInUsers', 'recordOwner', 'custom']
const MODE_OPTIONS = RULE_MODES.map((value) => ({ value, label: MODE_META[value].label }))
const OPERATION_OPTIONS = RULE_OPERATIONS.map((value) => ({ value, label: OPERATION_META[value].label }))

/** 右栏身份三选一；本人/其他用户映射到 applicationUser 的真实 recordId。 */
type Identity = 'anonymous' | 'owner' | 'other'
const IDENTITY_LABELS: Record<Identity, string> = {
  anonymous: '未登录',
  owner: '本人',
  other: '其他用户',
}

type RuleDraftItem = { mode: RuleMode; ownerFieldId: string; expressionText: string }
type RuleDraft = Record<RuleOperation, RuleDraftItem>

type VerifyVars = {
  collectionId: string
  operation: RuleOperation
  recordId: string
  identity: Identity
  identityLabel: string
  main: SimulatePrincipal
  owner: SimulatePrincipal | null
  other: SimulatePrincipal | null
}

type VerifySnapshot = {
  collectionId: string
  operation: RuleOperation
  recordId: string
  identity: Identity
  identityLabel: string
  main: SimulateResult
  owner: SimulateResult | null
  other: SimulateResult | null
}

/** 归一成稳定字符串，用于逐项比较 applied 与 pending。 */
function normalizeRule(rule: Rule): string {
  return JSON.stringify({
    operation: rule.operation,
    mode: rule.mode,
    ownerFieldId: rule.ownerFieldId ?? null,
    expression: rule.expression ?? null,
  })
}

/**
 * 后端无 pending 时 pending 是 applied 的完整拷贝，且响应里没有 hasPending 字段，
 * 因此「是否有待应用变更」只能逐项比较两条规则数组，不能用 length 或引用判断。
 */
function hasPendingChanges(state: RulesState): boolean {
  if (state.applied.length !== state.pending.length) return true
  const applied = new Map<RuleOperation, string>(
    state.applied.map((rule) => [rule.operation, normalizeRule(rule)]),
  )
  return state.pending.some((rule) => applied.get(rule.operation) !== normalizeRule(rule))
}

/** 逐项列出 applied / pending 差异，用于方案预览。 */
function diffRules(state: RulesState): Array<{ operation: RuleOperation; before: Rule; after: Rule }> {
  const applied = new Map<RuleOperation, Rule>(state.applied.map((rule) => [rule.operation, rule]))
  const changes: Array<{ operation: RuleOperation; before: Rule; after: Rule }> = []
  for (const rule of state.pending) {
    const before = applied.get(rule.operation)
    if (before && normalizeRule(before) !== normalizeRule(rule)) {
      changes.push({ operation: rule.operation, before, after: rule })
    }
  }
  return changes
}

function emptyDraft(): RuleDraft {
  const draft = {} as RuleDraft
  for (const operation of RULE_OPERATIONS) {
    draft[operation] = { mode: 'noAccess', ownerFieldId: '', expressionText: '' }
  }
  return draft
}

/** 抽屉从 pending（待应用草稿）开始编辑；无变更时 pending 即 applied 的拷贝。 */
function draftFromState(state: RulesState): RuleDraft {
  const byOperation = new Map<RuleOperation, Rule>(state.pending.map((rule) => [rule.operation, rule]))
  const draft = emptyDraft()
  for (const operation of RULE_OPERATIONS) {
    const rule = byOperation.get(operation)
    draft[operation] = {
      mode: rule?.mode ?? 'noAccess',
      ownerFieldId: rule?.ownerFieldId ?? '',
      expressionText: rule?.expression == null ? '' : JSON.stringify(rule.expression, null, 2),
    }
  }
  return draft
}

/**
 * 按 mode 约束投影出恰好 5 条合法规则：
 * noAccess/anyone/signedInUsers 不带附加字段；recordOwner 带 ownerFieldId；custom 带 expression。
 */
function buildRules(draft: RuleDraft): { rules?: Rule[]; error?: string } {
  const rules: Rule[] = []
  for (const operation of RULE_OPERATIONS) {
    const item = draft[operation]
    const rule: Rule = { operation, mode: item.mode }
    if (item.mode === 'recordOwner') {
      if (!item.ownerFieldId) {
        return { error: `${OPERATION_META[operation].label}：记录本人模式必须选择关联字段` }
      }
      rule.ownerFieldId = item.ownerFieldId
    } else if (item.mode === 'custom') {
      if (!item.expressionText.trim()) {
        return { error: `${OPERATION_META[operation].label}：自定义条件必须填写表达式 JSON` }
      }
      try {
        rule.expression = JSON.parse(item.expressionText) as unknown
      } catch {
        return { error: `${OPERATION_META[operation].label}：表达式不是合法 JSON` }
      }
    }
    rules.push(rule)
  }
  return { rules }
}

/** 记录下拉文案：优先取第一个非空文本字段，否则退回记录 ID（全部来自真实记录）。 */
function recordLabel(record: RecordItem): string {
  for (const [key, value] of Object.entries(record)) {
    if (['id', 'createdAt', 'updatedAt'].includes(key)) continue
    if (typeof value === 'string' && value.trim()) return value
  }
  return record.id
}

/**
 * 「访问规则」（Figma 15:11177）。
 *
 * 按 0011 第 8 节，规则按集合存储，集合页的「访问规则」标签是唯一入口；
 * 这里固定作用于 activeId 指定的当前集合，不再提供集合选择器。
 * 集合、规则、记录、应用用户、认证状态全部来自真实 API；验证访问走后端 simulate，
 * 页面只展示后端返回的判定，不推测、不编造任何结果或用户 ID。
 */
export function RulesTab(props: { collections: CollectionSummary[]; activeId: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { message } = App.useApp()

  // 当前集合来自集合页路由，刷新与深链接都保持同一上下文。
  const effectiveId = props.activeId
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const [identity, setIdentity] = useState<Identity>('anonymous')
  const [recordId, setRecordId] = useState('')
  const [operation, setOperation] = useState<RuleOperation>('view')
  const [draft, setDraft] = useState<RuleDraft>(emptyDraft)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [draftBase, setDraftBase] = useState<number | null>(null)

  const current = useMemo(
    () => props.collections.find((item) => item.id === effectiveId),
    [props.collections, effectiveId],
  )
  const authCollection = useMemo(
    () => props.collections.find((item) => item.type === 'Auth'),
    [props.collections],
  )
  const authId = authCollection?.id ?? ''
  const authCollectionIds = useMemo(
    () => new Set(props.collections.filter((item) => item.type === 'Auth').map((item) => item.id)),
    [props.collections],
  )

  const rules = useQuery({
    queryKey: accessRuleKeys.state(effectiveId),
    queryFn: () => accessRulesApi.get(effectiveId),
    enabled: Boolean(effectiveId),
  })
  const recordsQuery = useQuery({
    queryKey: recordKeys.list(effectiveId),
    queryFn: () => recordsApi.list(effectiveId, { limit: 100 }),
    enabled: Boolean(effectiveId),
  })
  // 应用用户住在 Auth 集合：人数、认证状态与 simulate 身份都从这里取真实值。
  const usersQuery = useQuery({
    queryKey: appAuthKeys.users(authId),
    queryFn: () => appAuthApi.list(authId),
    enabled: Boolean(authId),
  })
  const authConfigQuery = useQuery({
    queryKey: appAuthKeys.config(authId),
    queryFn: () => appAuthApi.authentication(authId),
    enabled: Boolean(authId),
  })
  // 抽屉里的 recordOwner 字段来自当前集合已应用的完整 schema。
  const detailQuery = useQuery({
    queryKey: collectionKeys.detail(effectiveId),
    queryFn: () => collectionsApi.get(effectiveId),
    enabled: drawerOpen && Boolean(effectiveId),
  })

  const state = rules.data
  const refresh = () => queryClient.invalidateQueries({ queryKey: accessRuleKeys.state(effectiveId) })

  const save = useMutation({
    mutationFn: (vars: { expectedVersion: number; rules: Rule[] }) =>
      accessRulesApi.save(effectiveId, vars.expectedVersion, vars.rules),
    onSuccess: async (result) => {
      await refresh()
      const text = `已保存到待应用变更（v${result.version}），应用后才会生效。`
      setFeedback({ tone: 'success', text })
      setDraftError(null)
      message.success(text)
      setDrawerOpen(false)
    },
    onError: (error: unknown) => {
      const text = `保存失败：${errorMessage(error)}`
      setFeedback({ tone: 'danger', text })
      setDraftError(text)
      message.error(text)
    },
  })

  const applyChange = useMutation({
    mutationFn: (expectedVersion: number) => accessRulesApi.apply(effectiveId, expectedVersion),
    onSuccess: async (result) => {
      await refresh()
      const text = `已应用访问规则（v${result.version}），现在开始生效。`
      setFeedback({ tone: 'success', text })
      message.success(text)
    },
    onError: (error: unknown) => {
      const text = `应用失败：${errorMessage(error)}`
      setFeedback({ tone: 'danger', text })
      message.error(text)
    },
  })

  const discardChange = useMutation({
    mutationFn: (expectedVersion: number) => accessRulesApi.discard(effectiveId, expectedVersion),
    onSuccess: async (result) => {
      await refresh()
      const text = `已放弃待应用变更（v${result.version}），规则保持当前已生效状态。`
      setFeedback({ tone: 'success', text })
      message.success(text)
    },
    onError: (error: unknown) => {
      const text = `放弃失败：${errorMessage(error)}`
      setFeedback({ tone: 'danger', text })
      message.error(text)
    },
  })

  /** 一次点击并发发起 3 次真实 simulate：当前身份、本人、其他用户，共用同一记录与操作。 */
  const verify = useMutation({
    mutationFn: async (vars: VerifyVars): Promise<VerifySnapshot> => {
      const call = (principal: SimulatePrincipal) =>
        accessRulesApi.simulate(vars.collectionId, {
          operation: vars.operation,
          principal,
          record: { recordId: vars.recordId },
        })
      const [main, owner, other] = await Promise.all([
        call(vars.main),
        vars.owner ? call(vars.owner) : Promise.resolve(null),
        vars.other ? call(vars.other) : Promise.resolve(null),
      ])
      return {
        collectionId: vars.collectionId,
        operation: vars.operation,
        recordId: vars.recordId,
        identity: vars.identity,
        identityLabel: vars.identityLabel,
        main,
        owner,
        other,
      }
    },
    onError: (error: unknown) => {
      message.error(`验证失败：${errorMessage(error)}`)
    },
  })

  const users: ApplicationUser[] = usersQuery.data?.data ?? []
  const firstUser = users[0]
  const secondUser = users[1]
  const hasOwner = Boolean(firstUser)
  const hasOther = Boolean(secondUser)
  // 身份映射严格按契约：登录身份用真实 appAuthApi.list 里的 recordId，绝不编造。
  const ownerPrincipal: SimulatePrincipal | null = firstUser
    ? { kind: 'applicationUser', id: firstUser.recordId }
    : null
  const otherPrincipal: SimulatePrincipal | null = secondUser
    ? { kind: 'applicationUser', id: secondUser.recordId }
    : null

  const records: RecordItem[] = recordsQuery.data?.data ?? []
  const recordOptions = records.map((record) => ({ value: record.id, label: recordLabel(record) }))

  // relation 字段必须指向 type==='Auth' 的目标集合，才能作为记录归属字段。
  const ownerFields = useMemo(() => {
    const fields = detailQuery.data?.fields ?? []
    return fields.filter(
      (field) => field.type === 'relation' && field.relation && authCollectionIds.has(field.relation.targetCollectionId),
    )
  }, [detailQuery.data, authCollectionIds])

  const appliedByOp = useMemo(
    () => new Map<RuleOperation, Rule>((state?.applied ?? []).map((rule) => [rule.operation, rule])),
    [state],
  )
  const diff = useMemo(() => (state ? diffRules(state) : []), [state])
  const hasPending = state ? hasPendingChanges(state) : false

  const identityOptions: Array<{ label: string; value: Identity; disabled?: boolean }> = [
    { label: IDENTITY_LABELS.anonymous, value: 'anonymous', disabled: false },
    { label: IDENTITY_LABELS.owner, value: 'owner', disabled: !hasOwner },
    { label: IDENTITY_LABELS.other, value: 'other', disabled: !hasOther },
  ]

  const mainPrincipal: SimulatePrincipal =
    identity === 'owner' && ownerPrincipal
      ? ownerPrincipal
      : identity === 'other' && otherPrincipal
        ? otherPrincipal
        : { kind: 'anonymous', id: '' }

  const canVerify =
    Boolean(effectiveId && recordId) &&
    !verify.isPending &&
    !(identity === 'owner' && !ownerPrincipal) &&
    !(identity === 'other' && !otherPrincipal)

  // 切换集合后不再展示上一个集合的验证结果。
  const visibleResult = verify.data && verify.data.collectionId === effectiveId ? verify.data : null
  const resultStale = Boolean(
    visibleResult &&
      (visibleResult.operation !== operation ||
        visibleResult.recordId !== recordId ||
        visibleResult.identity !== identity),
  )

  const subtitle = !state
    ? '正在读取当前生效规则…'
    : state.applied.some((rule) => rule.mode === 'anyone')
      ? `存在公开访问规则：${current?.name ?? '当前集合'} 的部分操作对任何人开放。`
      : state.applied.length > 0 &&
          state.applied.every((rule) => rule.mode === 'noAccess' || rule.mode === 'recordOwner')
        ? '当前所有笔记均为私人笔记；没有任何公开读取权限。'
        : '当前规则仅对已登录用户或满足条件的身份开放，未登录访客无法访问。'

  const submit = () => {
    if (!state) return
    const built = buildRules(draft)
    if (!built.rules) {
      setDraftError(built.error ?? '规则草稿不完整')
      return
    }
    setDraftError(null)
    save.mutate({ expectedVersion: state.version, rules: built.rules })
  }

  const updateDraft = (operationKey: RuleOperation, patch: Partial<RuleDraftItem>) => {
    setDraft((previous) => {
      const next: RuleDraft = { ...previous }
      next[operationKey] = { ...previous[operationKey], ...patch }
      return next
    })
  }

  // 切换集合时清掉选择与该集合无关的上一次反馈；验证结果按 collectionId 门控展示。
  useEffect(() => {
    setRecordId('')
    setIdentity('anonymous')
    setFeedback(null)
  }, [effectiveId])

  // 没有真实应用用户时禁用并回退登录身份，避免提交编造的 ID。
  useEffect(() => {
    if ((identity === 'owner' && !hasOwner) || (identity === 'other' && !hasOther)) {
      setIdentity('anonymous')
    }
  }, [identity, hasOwner, hasOther])

  // 抽屉每次打开都从当前 pending 重新初始化；后端版本变化时也重置，避免展示过期草稿。
  useEffect(() => {
    if (!drawerOpen) {
      setDraftBase(null)
      return
    }
    if (!state) return
    if (draftBase === state.version) return
    setDraft(draftFromState(state))
    setDraftError(null)
    setDraftBase(state.version)
  }, [drawerOpen, state, draftBase])

  if (!current) {
    return (
      <div className="mr-rules">
        <Notice>还没有任何集合，无法配置访问规则。请先在「数据」页创建集合。</Notice>
      </div>
    )
  }
  if (rules.isPending) {
    return (
      <div className="mr-rules">
        <LoadingBlock rows={6} label="正在读取访问规则…" />
      </div>
    )
  }
  if (rules.isError) {
    return (
      <div className="mr-rules">
        <ErrorState error={rules.error} title="访问规则读不到" onRetry={() => void rules.refetch()} />
      </div>
    )
  }

  return (
    <div className="mr-rules">
      {/* 访问上下文：当前集合由集合页固定，链接跳到认证集合内的用户 / 认证标签。 */}
      <div className="mr-rules__context">
        <div className="mr-rules__context-primary">
          <span className="mr-rules__eyebrow">访问上下文</span>
          <div className="mr-rules__picker">
            <span className="mr-rules__current-collection" aria-label="当前集合">
              {current?.name ?? effectiveId}
            </span>
            {hasPending ? (
              <StatusTag tone="warning">待审阅</StatusTag>
            ) : (
              <StatusTag tone="success">已生效</StatusTag>
            )}
          </div>
        </div>
        <div className="mr-rules__links">
          <Button
            type="link"
            className="mr-rules__link"
            disabled={!authCollection}
            onClick={() => navigate(`/data/${authId}/users`)}
          >
            <TeamOutlined />
            用户管理 ·{' '}
            {!authCollection
              ? '暂无认证集合'
              : usersQuery.isPending
                ? '读取中'
                : usersQuery.isError
                  ? '读取失败'
                  : `${users.length} 位用户`}
            <ExportOutlined />
          </Button>
          <Button
            type="link"
            className="mr-rules__link"
            disabled={!authCollection}
            onClick={() => navigate(`/data/${authId}/auth`)}
          >
            <SafetyCertificateOutlined />
            邮箱密码认证 ·{' '}
            {!authCollection
              ? '暂无认证集合'
              : authConfigQuery.isPending
                ? '读取中'
                : authConfigQuery.isError
                  ? '读取失败'
                  : authConfigQuery.data?.applied.emailPasswordEnabled
                    ? '已启用'
                    : '已停用'}
            <ExportOutlined />
          </Button>
        </div>
      </div>

      {/* 保存 / 应用 / 放弃的真实反馈；数量与版本号都来自后端响应。 */}
      {feedback ? <Notice tone={feedback.tone}>{feedback.text}</Notice> : null}

      {/* 待审阅提示条（黄底）：只在逐项比较确认有待应用变更时出现。 */}
      {hasPending ? (
        <Notice
          tone="warning"
          extra={
            <Button size="small" onClick={() => setDrawerOpen(true)}>
              审阅方案 <ArrowRightOutlined />
            </Button>
          }
        >
          访问规则方案待审阅 · {diff.length} 项变更尚未生效（v{state?.version}）
        </Notice>
      ) : null}

      {/* 主页面另外提供应用 / 放弃；无待应用变更时禁用，避免后端 404。 */}
      <div className="mr-rules__review-bar">
        <span className="mr-rules__review-label">
          {hasPending
            ? `有 ${diff.length} 项改动待审阅 · 版本 v${state?.version}`
            : `当前规则已生效 · 版本 v${state?.version ?? '—'}`}
        </span>
        <div className="mr-rules__review-actions">
          <Button
            size="small"
            type="primary"
            loading={applyChange.isPending}
            disabled={!hasPending || !state}
            onClick={() => state && applyChange.mutate(state.version)}
          >
            应用
          </Button>
          <Button
            size="small"
            loading={discardChange.isPending}
            disabled={!hasPending || !state}
            onClick={() => state && discardChange.mutate(state.version)}
          >
            放弃
          </Button>
        </div>
      </div>

      <div className="mr-rules__grid">
        <div className="mr-rules__main">
          {/* 左栏引导：副标题根据当前已生效规则动态生成。 */}
          <div className="mr-rules__intro">
            <div className="mr-rules__intro-text">
              <h2 className="mr-rules__intro-title">
                <LockOutlined className="mr-rules__intro-icon" />
                你的笔记，仍然只属于你
              </h2>
              <p className="mr-rules__intro-sub">{subtitle}</p>
            </div>
            <Button
              type="primary"
              icon={<EditOutlined />}
              disabled={!state}
              onClick={() => setDrawerOpen(true)}
            >
              编辑规则
            </Button>
          </div>

          {/* 5 行规则：每行展示真实 mode 摘要与规则表达式 JSON。 */}
          <ul className="mr-rules__list">
            {RULE_OPERATIONS.map((operationKey) => {
              const rule = appliedByOp.get(operationKey)
              return (
                <li className="mr-rules__rule" key={operationKey}>
                  <div className="mr-rules__rule-head">
                    <span className="mr-rules__op">{OPERATION_META[operationKey].label}</span>
                    <Mono>{operationKey}</Mono>
                  </div>
                  <div className="mr-rules__rule-body">
                    <div className="mr-rules__summary">
                      <strong>{rule ? MODE_META[rule.mode].label : '未配置'}</strong>
                      <span>{rule ? MODE_META[rule.mode].hint : OPERATION_META[operationKey].hint}</span>
                    </div>
                    <CodeBlock
                      code={JSON.stringify(rule ?? { operation: operationKey }, null, 2)}
                      label="rule"
                      maxHeight={120}
                    />
                  </div>
                </li>
              )
            })}
          </ul>

          {/* 方案预览：逐项展示真实的 applied → pending 差异。 */}
          {hasPending ? (
            <div className="mr-rules__preview">
              <div className="mr-rules__preview-head">
                <span className="mr-rules__preview-title">公开分享 · 方案预览，未生效</span>
                <StatusTag tone="warning">待应用</StatusTag>
              </div>
              <p className="mr-rules__preview-desc">
                以下改动已保存为待应用变更，应用后才会影响真实访问。差异来自后端 applied / pending 的逐项比较。
              </p>
              {diff.length > 0 ? (
                <ul className="mr-rules__diff">
                  {diff.map((item) => (
                    <li key={item.operation}>
                      <span className="mr-rules__diff-op">{OPERATION_META[item.operation].label}</span>
                      <div className="mr-rules__diff-values">
                        <div>
                          <span className="mr-meta">已生效</span>
                          <Mono>{MODE_META[item.before.mode].label}</Mono>
                        </div>
                        <div>
                          <span className="mr-meta">待应用</span>
                          <Mono>{MODE_META[item.after.mode].label}</Mono>
                        </div>
                        <CodeBlock code={JSON.stringify(item.after, null, 2)} label="pending" maxHeight={120} />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mr-muted-note">待应用变更与已生效规则的差异无法逐项归类，请在编辑抽屉中查看。</p>
              )}
              <Button type="link" className="mr-inline-link" onClick={() => setDrawerOpen(true)}>
                查看字段与规则差异 <ArrowRightOutlined />
              </Button>
            </div>
          ) : null}
        </div>

        {/* 右栏 350px：验证一次访问，全部结果来自真实 simulate。 */}
        <aside className="mr-rules__verify">
          <div className="mr-rules__verify-head">
            <SafetyCertificateOutlined className="mr-rules__verify-icon" />
            <div>
              <h3 className="mr-rules__verify-title">验证一次访问</h3>
              <p className="mr-rules__verify-sub">用真实身份与真实记录，模拟一次访问判定。</p>
            </div>
          </div>

          <Field label="身份">
            <Segmented
              block
              options={identityOptions}
              value={identity}
              onChange={(value: string | number) => setIdentity(String(value) as Identity)}
            />
          </Field>

          {!authCollection ? (
            <Notice>当前项目没有认证集合，无法读取应用用户；「本人 / 其他用户」已禁用。</Notice>
          ) : usersQuery.isError ? (
            <Notice tone="danger">应用用户读取失败：{errorMessage(usersQuery.error)}</Notice>
          ) : !hasOwner ? (
            <Notice>认证集合中还没有应用用户，「本人 / 其他用户」已禁用。请先在「用户」页添加用户后再验证登录身份。</Notice>
          ) : !hasOther ? (
            <Notice>
              当前只有 {users.length} 位应用用户，「其他用户」需要第二位真实用户，已禁用；不会编造用户 ID。
            </Notice>
          ) : null}

          <Field
            label="具体记录"
            hint={
              recordsQuery.isPending
                ? '正在读取记录…'
                : recordsQuery.isError
                  ? '记录读取失败'
                  : records.length === 0
                    ? '当前集合还没有记录'
                    : undefined
            }
          >
            <Select
              value={recordId || undefined}
              placeholder="选择一条记录"
              options={recordOptions}
              loading={recordsQuery.isPending}
              disabled={recordsQuery.isPending || records.length === 0}
              onChange={(value: string) => setRecordId(value)}
            />
          </Field>
          {recordsQuery.isError ? (
            <Notice tone="danger">记录读取失败：{errorMessage(recordsQuery.error)}</Notice>
          ) : null}

          <Field label="操作">
            <Select
              value={operation}
              options={OPERATION_OPTIONS}
              onChange={(value: RuleOperation) => setOperation(value)}
            />
          </Field>

          <Button
            type="primary"
            block
            icon={<SafetyCertificateOutlined />}
            loading={verify.isPending}
            disabled={!canVerify}
            onClick={() =>
              verify.mutate({
                collectionId: effectiveId,
                operation,
                recordId,
                identity,
                identityLabel: IDENTITY_LABELS[identity],
                main: mainPrincipal,
                owner: ownerPrincipal,
                other: otherPrincipal,
              })
            }
          >
            验证访问
          </Button>

          {verify.isError ? (
            <Notice tone="danger">验证失败：{errorMessage(verify.error)}</Notice>
          ) : null}

          {visibleResult ? (
            <>
              <div className="mr-divider-line" />
              {resultStale ? (
                <span className="mr-meta">以上为上一次验证结果；输入已变化，请重新验证。</span>
              ) : null}
              <div className="mr-rules__result">
                <div className="mr-rules__result-head">
                  <StatusTag tone={visibleResult.main.allowed ? 'success' : 'danger'}>
                    {visibleResult.main.allowed ? '允许访问' : '拒绝访问'}
                  </StatusTag>
                  <span className="mr-meta">
                    {visibleResult.identityLabel} · {OPERATION_META[visibleResult.operation].label}
                  </span>
                </div>
                <DetailList
                  items={[
                    { label: 'HTTP 码', value: String(visibleResult.main.code ?? '—') },
                    { label: '后端说明', value: visibleResult.main.message, mono: false },
                    { label: '决定性操作', value: visibleResult.main.decidingOperation || '—' },
                    { label: '决定性模式', value: visibleResult.main.decidingMode || '—' },
                    { label: '权威性', value: visibleResult.main.authoritative ? '是' : '否' },
                    visibleResult.main.notice
                      ? { label: '提示', value: visibleResult.main.notice, mono: false }
                      : null,
                  ]}
                />
                <CodeBlock
                  code={JSON.stringify(visibleResult.main.reason ?? null, null, 2)}
                  label="reason"
                  maxHeight={140}
                />
              </div>

              {/* 「同一记录，切换身份后」两行：结果分别来自真实 simulate，不做任何推测。 */}
              <div className="mr-rules__expectations">
                <span className="mr-rules__expect-title">同一记录，切换身份后</span>
                <ExpectationRow label="本人" result={visibleResult.owner} />
                <ExpectationRow label="其他用户" result={visibleResult.other} />
              </div>
            </>
          ) : (
            <Notice>选择记录、身份与操作后，点击「验证访问」查看真实判定结果。</Notice>
          )}
        </aside>
      </div>

      {/* 编辑规则抽屉：风格参考 SchemaTab 的 FieldDrawer。 */}
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={480}
        rootClassName="mr-drawer"
        title={
          <div className="mr-drawer__title">
            <span className="mr-drawer__heading">编辑访问规则 · {current.name}</span>
            <span className="mr-drawer__subtitle">改动先保存为待应用变更，应用后才会影响真实访问。</span>
          </div>
        }
        footer={
          <div className="mr-drawer__footer">
            <span className="mr-meta">当前版本 v{state?.version ?? '—'} · 共 5 条规则</span>
            <div className="mr-drawer__actions">
              <Button onClick={() => setDrawerOpen(false)}>取消</Button>
              <Button type="primary" loading={save.isPending} onClick={submit}>
                保存到待应用变更
              </Button>
            </div>
          </div>
        }
      >
        {draftError ? <Notice tone="danger">{draftError}</Notice> : null}
        {detailQuery.isError ? (
          <Notice tone="danger">集合字段读取失败：{errorMessage(detailQuery.error)}</Notice>
        ) : null}
        {RULE_OPERATIONS.map((operationKey) => {
          const item = draft[operationKey]
          return (
            <div className="mr-rules__edit-row" key={operationKey}>
              <div className="mr-rules__edit-head">
                <span className="mr-rules__edit-title">{OPERATION_META[operationKey].label}</span>
                <Mono>{operationKey}</Mono>
              </div>
              <Field label="规则模式">
                <Select
                  value={item.mode}
                  options={MODE_OPTIONS}
                  onChange={(value: RuleMode) => updateDraft(operationKey, { mode: value })}
                />
              </Field>
              <p className="mr-rules__edit-hint">{MODE_META[item.mode].hint}</p>

              {item.mode === 'recordOwner' ? (
                <Field
                  label="记录归属字段"
                  required
                  hint={
                    detailQuery.isPending
                      ? '正在读取集合字段…'
                      : ownerFields.length === 0
                        ? '当前集合没有指向认证集合的关联字段'
                        : '仅列出目标集合 type 为 Auth 的 relation 字段'
                  }
                >
                  <Select
                    value={item.ownerFieldId || undefined}
                    placeholder="选择关联字段"
                    options={ownerFields.map((field) => ({
                      value: field.id,
                      label: `${field.name} · ${field.relation?.targetCollectionId ?? ''}`,
                    }))}
                    disabled={ownerFields.length === 0}
                    onChange={(value: string) => updateDraft(operationKey, { ownerFieldId: value })}
                  />
                </Field>
              ) : null}

              {item.mode === 'custom' ? (
                <Field
                  label="条件表达式（JSON）"
                  required
                  hint={'形如 {"version":1,"all":[{"fieldId":"...","operator":"eq","value":...}]}'}
                >
                  <Input.TextArea
                    className="mr-mono"
                    rows={5}
                    value={item.expressionText}
                    onChange={(event) => updateDraft(operationKey, { expressionText: event.target.value })}
                  />
                </Field>
              ) : null}
            </div>
          )
        })}
      </Drawer>
    </div>
  )
}

/** 期望行：静态文案 + 真实 simulate 结果；无真实用户时明确说明未发起模拟。 */
function ExpectationRow(props: { label: string; result: SimulateResult | null }) {
  return (
    <div className="mr-rules__expect-row">
      <span className="mr-rules__expect-label">{props.label}</span>
      {props.result ? (
        <>
          <StatusTag tone={props.result.allowed ? 'success' : 'danger'}>
            {props.result.allowed ? '允许' : '拒绝'}
          </StatusTag>
          <span className="mr-meta">
            HTTP {String(props.result.code ?? '—')} · {props.result.message}
          </span>
        </>
      ) : (
        <span className="mr-meta">缺少可对比的真实应用用户，未发起模拟</span>
      )}
    </div>
  )
}
