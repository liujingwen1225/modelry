import { useMemo, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  App,
  Button,
  CodeBlock,
  DetailList,
  Drawer,
  ErrorState,
  LoadingBlock,
  Modal,
  Notice,
  PageHeader,
  SectionHeading,
  Segmented,
  Select,
  StateBlock,
  StatusTag,
  Table,
  Tag,
  Typography,
} from '@/ui'
import type { TableColumnsType } from '@/ui'
import {
  DatabaseOutlined,
  ExclamationCircleOutlined,
  HistoryOutlined,
  PullRequestOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons'
import { ApiError, errorMessage } from '@/api/client'
import { collectionsApi, collectionKeys } from '@/api/collections'
import type { CollectionSummary } from '@/api/collections'
import {
  ACTION_LABEL,
  ACTION_MARK,
  CHANGE_STATUS_LABEL,
  CHANGE_STATUS_TONE,
  OPERATION_KIND_LABEL,
  RISK_LABEL,
  RISK_TONE,
  changeKeys,
  changesApi,
  isAppliedMigration,
  isPendingChange,
} from '@/api/changes'
import type {
  AppliedMigration,
  ApplyAttempt,
  DetailView,
  DiffItem,
  PendingChange,
  PendingOperation,
  RecoveryState,
  SchemaPreview,
} from '@/api/changes'
import { formatCount, formatDateTime } from '@/lib/format'
import { useBreadcrumbTail } from '@/app/BreadcrumbContext'
import './changes.css'

type Tone = 'neutral' | 'success' | 'warning' | 'danger'
type Impact = SchemaPreview['impact']
type Risk = 'safe' | 'review' | 'blocked'

/** 把后端原始值安全地转成可复制的技术文本；不编造字段。 */
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

/** operation 只有 definition / targetId，目标名从真实定义里取，取不到就回退技术 ID。 */
function targetName(op: PendingOperation): string {
  const definition = op.definition as { name?: unknown; fieldName?: unknown; fields?: unknown } | null | undefined
  if (definition && typeof definition === 'object') {
    const candidate = definition.name ?? definition.fieldName
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate
    }
    if (Array.isArray(definition.fields)) {
      return definition.fields.map((field) => String(field)).join(', ')
    }
  }
  return op.targetId ?? op.id
}

function preconditionLabel(status: string): string {
  const labels: Record<string, string> = {
    ok: '已通过',
    pass: '已通过',
    passed: '已通过',
    satisfied: '已通过',
    met: '已通过',
    failed: '未通过',
    blocked: '被阻塞',
    error: '出错',
    pending: '待确认',
    warning: '需注意',
  }
  return labels[status] ?? status
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

function attemptLabel(attempt: ApplyAttempt): string {
  return String(attempt.state ?? attempt.status ?? (attempt.error !== undefined ? '失败' : '已提交'))
}

function attemptTone(attempt: ApplyAttempt): Tone {
  if (attempt.error !== undefined && attempt.error !== null) {
    return 'danger'
  }
  const raw = String(attempt.state ?? attempt.status ?? '').toLowerCase()
  if (raw.includes('success') || raw.includes('applied') || raw.includes('succeeded')) {
    return 'success'
  }
  return 'warning'
}

function recoveryFrom(error: unknown): RecoveryState | undefined {
  if (!(error instanceof ApiError)) {
    return undefined
  }
  const details = error.details as { recovery?: RecoveryState } | null | undefined
  return details?.recovery
}

/**
 * 变更中心（Figma 画板 19「变更中心 · 待审阅与历史」）。
 *
 * 全部数据来自真实 API：/changes 混合流按字段判别出「待审阅」与「历史」，
 * 集合名来自 /collections，详情来自 /changes/{id}，风险与差异来自 schema/preview。
 * tab 走路由路径（刷新保留），?changeSet= 驱动右侧详情抽屉（深链接保留）。
 */
export function ChangesPage() {
  const params = useParams<{ tab?: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()

  useBreadcrumbTail([])

  // 兼容 /changes/:tab 与 /changes/* 两种接线方式：路径末段决定标签。
  const pathTail = location.pathname.split('/').filter(Boolean).pop()
  const tab = (params.tab ?? pathTail) === 'history' ? 'history' : 'pending'
  const changeSetId = searchParams.get('changeSet')
  const [detailView, setDetailView] = useState<DetailView>('diff')

  const collections = useQuery({ queryKey: collectionKeys.list, queryFn: collectionsApi.list })
  const feed = useInfiniteQuery({
    queryKey: changeKeys.feed,
    queryFn: ({ pageParam, signal }) => changesApi.list({ cursor: pageParam || undefined, limit: 50, signal }),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })

  const items = useMemo(() => feed.data?.pages.flatMap((page) => page.data) ?? [], [feed.data])
  const pending = useMemo(() => items.filter(isPendingChange), [items])
  const applied = useMemo(() => items.filter(isAppliedMigration), [items])

  const collectionName = (id: string): string =>
    collections.data?.find((collection) => collection.id === id)?.name ?? id

  const openDetail = (id: string, view: DetailView = 'diff') => {
    setDetailView(view)
    const next = new URLSearchParams(searchParams)
    next.set('changeSet', id)
    setSearchParams(next)
  }

  const closeDetail = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('changeSet')
    setSearchParams(next, { replace: true })
  }

  const switchTab = (next: 'pending' | 'history') => {
    // 保留 query，让 ?changeSet= 深链接在切换标签后仍然有效。
    navigate({
      pathname: next === 'history' ? '/changes/history' : '/changes/pending',
      search: location.search,
    })
  }

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: changeKeys.feed })
    void queryClient.invalidateQueries({ queryKey: ['changes', 'collection-history'] })
    void queryClient.invalidateQueries({ queryKey: ['changes', 'preview'] })
    void queryClient.invalidateQueries({ queryKey: collectionKeys.list })
    if (changeSetId) {
      void queryClient.invalidateQueries({ queryKey: changeKeys.detail(changeSetId) })
    }
  }

  return (
    <div className="mr-page mr-changes">
      <PageHeader
        title="变更中心"
        description="把计划、差异与实际结果分开。你确认之前，AI 方案不会修改本地项目。"
      />

      <div className="mr-changes__tabs" role="tablist" aria-label="变更中心视图">
        <Button
          type="text"
          role="tab"
          aria-selected={tab === 'pending'}
          className={`mr-changes__tab${tab === 'pending' ? ' mr-changes__tab--active' : ''}`}
          onClick={() => switchTab('pending')}
        >
          待审阅 · {pending.length}
        </Button>
        <Button
          type="text"
          role="tab"
          aria-selected={tab === 'history'}
          className={`mr-changes__tab${tab === 'history' ? ' mr-changes__tab--active' : ''}`}
          onClick={() => switchTab('history')}
        >
          历史 · {applied.length}
        </Button>
      </div>

      {/* 三种状态的真实区分：未保存表单 / 已保存待应用变更 / 已应用历史。 */}
      <Notice>
        <Typography.Text type="secondary">
          变更中心只展示已保存、等待确认的结构变更。数据工作区里未保存的表单不会出现在这里；确认应用后才会写入本地项目，并进入「历史」。已应用或失败都不是待审阅草案。
        </Typography.Text>
      </Notice>

      {collections.isError ? (
        <Notice tone="warning">
          集合列表读不到，集合名暂以 ID 显示：{errorMessage(collections.error)}
          <Button type="link" size="small" className="mr-inline-link" onClick={() => void collections.refetch()}>
            重试
          </Button>
        </Notice>
      ) : null}

      {feed.isPending ? <LoadingBlock rows={6} label="正在读取变更流…" /> : null}
      {feed.isError ? (
        <ErrorState error={feed.error} title="变更列表读不到" onRetry={() => void feed.refetch()} />
      ) : null}

      {feed.data
        ? tab === 'pending'
          ? (
            <PendingList
              changes={pending}
              collectionName={collectionName}
              onOpen={openDetail}
              onGoData={() => navigate('/data')}
              hasNextPage={feed.hasNextPage}
              isFetchingNextPage={feed.isFetchingNextPage}
              onLoadMore={() => void feed.fetchNextPage()}
            />
          )
          : (
            <HistoryList
              migrations={applied}
              collections={collections.data ?? []}
              collectionName={collectionName}
              onOpen={openDetail}
              onGoData={() => navigate('/data')}
              hasNextPage={feed.hasNextPage}
              isFetchingNextPage={feed.isFetchingNextPage}
              onLoadMore={() => void feed.fetchNextPage()}
            />
          )
        : null}

      {changeSetId ? (
        <ChangeDetailDrawer
          changeSetId={changeSetId}
          view={detailView}
          onViewChange={setDetailView}
          collectionName={collectionName}
          onClose={closeDetail}
          onChanged={refresh}
          onGoCollection={(id) => navigate(`/data/${id}`)}
        />
      ) : null}
    </div>
  )
}

/** 待审阅列表：来自 /changes 混合流里带 operations 的 PendingChange。 */
function PendingList(props: {
  changes: PendingChange[]
  collectionName: (id: string) => string
  onOpen: (id: string, view: DetailView) => void
  onGoData: () => void
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
}) {
  const columns: TableColumnsType<PendingChange> = [
    {
      title: '集合',
      dataIndex: 'collectionId',
      width: 220,
      render: (_value, record) => (
        <div className="mr-changes__cell">
          <span className="mr-changes__cell-title">{props.collectionName(record.collectionId)}</span>
          <span className="mr-mono mr-changes__cell-sub">{record.changeSetId}</span>
        </div>
      ),
    },
    {
      title: '变更条目',
      dataIndex: 'operations',
      width: 100,
      render: (_value, record) => <span>{record.operations.length} 项</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (_value, record) => (
        <StatusTag tone={CHANGE_STATUS_TONE[record.status]}>{CHANGE_STATUS_LABEL[record.status]}</StatusTag>
      ),
    },
    {
      title: '版本',
      dataIndex: 'version',
      width: 80,
      render: (value) => <span className="mr-mono">v{Number(value)}</span>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (value) => (
        <span className="mr-mono mr-changes__cell-time">{formatDateTime(String(value))}</span>
      ),
    },
    {
      title: '操作',
      width: 220,
      render: (_value, record) => (
        <div className="mr-changes__row-actions" onClick={(event) => event.stopPropagation()}>
          <Button
            type="link"
            size="small"
            className="mr-inline-link"
            onClick={() => props.onOpen(record.changeSetId, 'diff')}
          >
            审阅差异
          </Button>
          <Button
            type="link"
            size="small"
            className="mr-inline-link"
            icon={<SafetyCertificateOutlined />}
            onClick={() => props.onOpen(record.changeSetId, 'risk')}
          >
            风险预览
          </Button>
        </div>
      ),
    },
  ]

  return (
    <section className="mr-changes__section">
      <SectionHeading title="待审阅变更" meta={`${props.changes.length} 份已保存、等待确认的草案`} />
      {props.changes.length === 0 ? (
        <StateBlock
          eyebrow="待审阅 · 空"
          icon={<PullRequestOutlined />}
          title="还没有待审阅的变更"
          description="变更中心只展示已保存、等待确认的结构变更。数据工作区里未保存的表单不会出现在这里；只有确认应用后，差异才会写入真实结构并进入「历史」。"
          actions={
            <Button type="primary" icon={<DatabaseOutlined />} onClick={props.onGoData}>
              去数据工作区
            </Button>
          }
        />
      ) : (
        <>
          <Table<PendingChange>
            rowKey="changeSetId"
            size="small"
            pagination={false}
            columns={columns}
            dataSource={props.changes}
            className="mr-changes__table"
            onRow={(record) => ({ onClick: () => props.onOpen(record.changeSetId, 'diff') })}
          />
          <div className="mr-changes__toolbar">
            <span className="mr-meta">共 {props.changes.length} 份待审阅草案 · 来自真实变更流</span>
            {props.hasNextPage ? (
              <Button size="small" loading={props.isFetchingNextPage} onClick={props.onLoadMore}>
                加载更多
              </Button>
            ) : null}
          </div>
        </>
      )}
    </section>
  )
}

/**
 * 历史列表：默认展示 /changes 混合流里带 appliedAt 的 AppliedMigration，
 * 选中集合后额外调用 schema/history 补充该集合的完整历史（按 id 去重）。
 */
function HistoryList(props: {
  migrations: AppliedMigration[]
  collections: CollectionSummary[]
  collectionName: (id: string) => string
  onOpen: (id: string, view: DetailView) => void
  onGoData: () => void
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
}) {
  const [selected, setSelected] = useState<string>('all')

  const supplement = useQuery({
    queryKey: changeKeys.collectionHistory(selected),
    queryFn: () => changesApi.history(selected, { limit: 100 }),
    enabled: selected !== 'all',
  })

  const rows = useMemo(() => {
    if (selected === 'all') {
      return props.migrations
    }
    const fromFeed = props.migrations.filter((migration) => migration.collectionId === selected)
    const extras = (supplement.data ?? []).filter(
      (item) => !fromFeed.some((migration) => migration.id === item.id),
    )
    return [...fromFeed, ...extras].sort((a, b) => (a.appliedAt < b.appliedAt ? 1 : -1))
  }, [props.migrations, selected, supplement.data])

  const columns: TableColumnsType<AppliedMigration> = [
    {
      title: '时间',
      dataIndex: 'appliedAt',
      width: 170,
      render: (value) => (
        <span className="mr-mono mr-changes__cell-time">{formatDateTime(String(value))}</span>
      ),
    },
    {
      title: '变更',
      dataIndex: 'collectionId',
      render: (_value, record) => (
        <div className="mr-changes__cell">
          <span className="mr-changes__cell-title">{props.collectionName(record.collectionId)}</span>
          <span className="mr-mono mr-changes__cell-sub">{record.changeSetId}</span>
        </div>
      ),
    },
    {
      title: '结构版本',
      dataIndex: 'schemaVersion',
      width: 100,
      render: (value) => <span className="mr-mono">v{Number(value)}</span>,
    },
    {
      title: '差异条目',
      dataIndex: 'diff',
      width: 100,
      render: (_value, record) => <span>{record.diff.length} 条</span>,
    },
    {
      title: '结果',
      width: 100,
      render: () => <StatusTag tone="success">已应用</StatusTag>,
    },
    {
      title: '操作',
      width: 200,
      render: (_value, record) => (
        <div className="mr-changes__row-actions" onClick={(event) => event.stopPropagation()}>
          <Button
            type="link"
            size="small"
            className="mr-inline-link"
            onClick={() => props.onOpen(record.changeSetId, 'diff')}
          >
            查看差异
          </Button>
          <Button
            type="link"
            size="small"
            className="mr-inline-link"
            onClick={() => props.onOpen(record.changeSetId, 'attempts')}
          >
            执行记录
          </Button>
        </div>
      ),
    },
  ]

  return (
    <section className="mr-changes__section">
      <SectionHeading
        title="最近历史"
        meta="来源与执行结果独立记录；已应用、失败都不是待审阅草案"
      />
      <div className="mr-changes__toolbar">
        <div className="mr-changes__filter">
          <span className="mr-meta">按集合查看</span>
          <Select
            size="small"
            className="mr-changes__select"
            value={selected}
            onChange={(value) => setSelected(String(value))}
            options={[
              { value: 'all', label: '全部集合' },
              ...props.collections.map((collection) => ({ value: collection.id, label: collection.name })),
            ]}
          />
        </div>
        {selected !== 'all' && supplement.isPending ? <LoadingBlock rows={2} label="正在读取该集合的完整历史…" /> : null}
        {selected !== 'all' && supplement.isError ? (
          <Notice tone="danger">
            该集合历史读不到：{errorMessage(supplement.error)}
            <Button type="link" size="small" className="mr-inline-link" onClick={() => void supplement.refetch()}>
              重试
            </Button>
          </Notice>
        ) : null}
      </div>

      {rows.length === 0 && !(selected !== 'all' && supplement.isPending) ? (
        <StateBlock
          eyebrow="历史 · 空"
          icon={<HistoryOutlined />}
          title="还没有已应用的历史"
          description="来源与执行结果独立记录。确认应用后的变更才会出现在这里；已应用或失败的记录都是只读回看，不是待审阅草案。"
          actions={
            <Button icon={<DatabaseOutlined />} onClick={props.onGoData}>
              去数据工作区
            </Button>
          }
        />
      ) : (
        <>
          <Table<AppliedMigration>
            rowKey="id"
            size="small"
            pagination={false}
            columns={columns}
            dataSource={rows}
            className="mr-changes__table"
            onRow={(record) => ({ onClick: () => props.onOpen(record.changeSetId, 'diff') })}
          />
          <div className="mr-changes__toolbar">
            <span className="mr-meta">
              共 {rows.length} 条已应用记录
              {selected === 'all' ? ' · 来自真实变更流' : ` · 已按 ${props.collectionName(selected)} 补充完整历史`}
            </span>
            {selected === 'all' && props.hasNextPage ? (
              <Button size="small" loading={props.isFetchingNextPage} onClick={props.onLoadMore}>
                加载更多
              </Button>
            ) : null}
          </div>
        </>
      )}
    </section>
  )
}

/** 恢复路径：把后端 recovery.state / summary / actions 原样展示。 */
function RecoveryNotice(props: { recovery: RecoveryState }) {
  return (
    <Notice tone="warning" icon={<ExclamationCircleOutlined />}>
      <div>
        <strong>恢复路径 · {props.recovery.state}</strong>
        {props.recovery.summary ? <div>{props.recovery.summary}</div> : null}
        {props.recovery.actions && props.recovery.actions.length > 0 ? (
          <ul className="mr-changes__recovery-actions">
            {props.recovery.actions.map((action, index) => (
              <li key={`${action}-${index}`}>{action}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </Notice>
  )
}

function ImpactStat(props: { label: string; value: number }) {
  return (
    <div className="mr-changes__impact-stat">
      <span className="mr-changes__impact-value">{formatCount(props.value)}</span>
      <span className="mr-changes__impact-label">{props.label}</span>
    </div>
  )
}

/** 子视图一：操作清单（真实 operations）+ before → after 的 JSON 差异。 */
function DiffView(props: { operations: PendingOperation[]; diff: DiffItem[]; isHistory: boolean }) {
  return (
    <>
      <SectionHeading title="操作清单" meta={`${props.operations.length} 项已保存的操作`} />
      {props.operations.length === 0 ? (
        <p className="mr-muted-note">这份变更集没有逐条操作记录。</p>
      ) : (
        <ul className="mr-changes__ops">
          {props.operations.map((op) => (
            <li className="mr-changes__op" key={op.id}>
              <div className="mr-changes__op-head">
                <StatusTag tone={op.action === 'remove' ? 'danger' : op.action === 'add' ? 'success' : 'warning'}>
                  {ACTION_MARK[op.action] ?? ''} {ACTION_LABEL[op.action] ?? op.action}
                </StatusTag>
                <Tag>{OPERATION_KIND_LABEL[op.kind] ?? op.kind}</Tag>
                <span className="mr-mono mr-changes__op-target">{targetName(op)}</span>
              </div>
              <CodeBlock code={json(op.definition)} label={`${op.kind} · ${op.action} · definition`} maxHeight={200} />
            </li>
          ))}
        </ul>
      )}

      <div className="mr-divider-line" />

      <SectionHeading title="字段与规则差异" meta={`${props.diff.length} 条 before → after`} />
      {props.diff.length === 0 ? (
        <p className="mr-muted-note">
          {props.isHistory
            ? '这条迁移没有记录逐字段差异。'
            : '预检没有返回逐字段差异；应用前仍可在上方查看每条操作的定义。'}
        </p>
      ) : (
        <ul className="mr-changes__ops">
          {props.diff.map((item, index) => (
            <li className="mr-changes__op" key={`${item.targetId}-${index}`}>
              <div className="mr-changes__op-head">
                <StatusTag tone={item.action === 'remove' ? 'danger' : item.action === 'add' ? 'success' : 'warning'}>
                  {ACTION_MARK[item.action] ?? ''} {ACTION_LABEL[item.action] ?? item.action}
                </StatusTag>
                <Tag>{OPERATION_KIND_LABEL[item.kind] ?? item.kind}</Tag>
                <span className="mr-mono mr-changes__op-target">{item.name ?? item.targetId}</span>
              </div>
              <div className="mr-changes__before-after">
                <CodeBlock code={json(item.before)} label="before" maxHeight={200} />
                <span className="mr-changes__arrow" aria-hidden>
                  <RightOutlined />
                </span>
                <CodeBlock code={json(item.after)} label="after" maxHeight={200} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** 子视图二：前置条件、影响范围与预检差异明细。 */
function RiskView(props: {
  risk: Risk | undefined
  impact: Impact | undefined
  preconditions: SchemaPreview['preconditions']
  diff: DiffItem[]
  isPending: boolean
  error: unknown
  isHistory: boolean
  onRetry: () => void
}) {
  return (
    <>
      <SectionHeading
        title="前置条件与验证"
        meta={`${props.preconditions.length} 项 · 风险 ${props.risk ? RISK_LABEL[props.risk] : '未预检'}`}
      />
      {props.isPending ? <LoadingBlock rows={3} label="正在预检风险…" /> : null}
      {props.error ? (
        <ErrorState error={props.error} title="风险预检读不到" onRetry={props.onRetry} />
      ) : null}
      {props.isHistory ? <Notice>历史记录不再重新预检；差异来自已应用迁移的真实记录。</Notice> : null}
      {props.preconditions.length === 0 && !props.isPending && !props.error && !props.isHistory ? (
        <p className="mr-muted-note">预检没有列出额外前置条件。</p>
      ) : (
        <ul className="mr-changes__preconditions">
          {props.preconditions.map((item, index) => (
            <li key={`${item.code}-${index}`}>
              <StatusTag tone={preconditionTone(item.status)}>{preconditionLabel(item.status)}</StatusTag>
              <span className="mr-mono">{item.code}</span>
              <span>{item.message}</span>
            </li>
          ))}
        </ul>
      )}

      {props.impact ? (
        <>
          <div className="mr-divider-line" />
          <SectionHeading title="影响范围" />
          <DetailList
            items={[
              { label: '受影响集合', value: formatCount(props.impact.affectedCollections), mono: false },
              { label: '受影响字段', value: formatCount(props.impact.affectedFields), mono: false },
              { label: '受影响索引', value: formatCount(props.impact.affectedIndexes), mono: false },
              { label: '受影响记录', value: formatCount(props.impact.affectedRecords), mono: false },
            ]}
          />
          <p className="mr-muted-note">{props.impact.summary}</p>
        </>
      ) : null}

      {props.diff.length > 0 ? (
        <>
          <div className="mr-divider-line" />
          <SectionHeading title="预检差异明细" meta={`${props.diff.length} 条`} />
          <CodeBlock code={json(props.diff)} label="preview.diff" maxHeight={240} />
        </>
      ) : null}
    </>
  )
}

/** 子视图三：应用尝试与恢复状态，未知字段用真实 JSON 兜底展示。 */
function AttemptsView(props: {
  attempts: ApplyAttempt[]
  recovery: RecoveryState | null
  appliedMigration: AppliedMigration | null
}) {
  return (
    <>
      <SectionHeading title="应用尝试" meta={`${props.attempts.length} 次`} />
      {props.attempts.length === 0 ? (
        <p className="mr-muted-note">还没有应用尝试记录。</p>
      ) : (
        <ul className="mr-changes__ops">
          {props.attempts.map((attempt, index) => (
            <li className="mr-changes__op" key={String(attempt.id ?? index)}>
              <div className="mr-changes__op-head">
                <StatusTag tone={attemptTone(attempt)}>{attemptLabel(attempt)}</StatusTag>
                <span className="mr-mono">{String(attempt.id ?? `尝试 ${index + 1}`)}</span>
                {typeof attempt.finishedAt === 'string' ? (
                  <span className="mr-meta">{formatDateTime(attempt.finishedAt)}</span>
                ) : null}
              </div>
              <CodeBlock code={json(attempt)} label="applyAttempt" maxHeight={220} />
            </li>
          ))}
        </ul>
      )}

      <div className="mr-divider-line" />
      <SectionHeading title="恢复状态" />
      {props.recovery ? (
        <RecoveryNotice recovery={props.recovery} />
      ) : (
        <p className="mr-muted-note">当前没有恢复状态。</p>
      )}

      {props.appliedMigration ? (
        <>
          <div className="mr-divider-line" />
          <SectionHeading title="已应用迁移" />
          <DetailList
            items={[
              { label: '迁移 ID', value: props.appliedMigration.id },
              { label: '结构版本', value: `v${props.appliedMigration.schemaVersion}`, mono: false },
              { label: '应用时间', value: formatDateTime(props.appliedMigration.appliedAt), mono: false },
              { label: '差异条目', value: String(props.appliedMigration.diff.length), mono: false },
            ]}
          />
        </>
      ) : null}
    </>
  )
}

/**
 * 变更详情抽屉（Figma「提案与影响」两栏 + 右侧「风险与确认」卡）。
 * 由 ?changeSet= 驱动，刷新后自动重新打开。
 */
function ChangeDetailDrawer(props: {
  changeSetId: string
  view: DetailView
  onViewChange: (view: DetailView) => void
  collectionName: (id: string) => string
  onClose: () => void
  onChanged: () => void
  onGoCollection: (collectionId: string) => void
}) {
  const { message } = App.useApp()
  const [busy, setBusy] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [failure, setFailure] = useState<{ error: unknown; recovery?: RecoveryState } | null>(null)

  const detail = useQuery({
    queryKey: changeKeys.detail(props.changeSetId),
    queryFn: () => changesApi.detail(props.changeSetId),
  })

  const d = detail.data
  const isHistory = Boolean(d?.appliedMigration) || d?.status === 'applied' || d?.status === 'discarded'

  // 已应用历史不再重新预检（此时集合可能已经没有 pending）；差异取 appliedMigration.diff。
  const preview = useQuery({
    queryKey: changeKeys.preview(d?.collectionId ?? '', d?.version ?? 0),
    queryFn: () => changesApi.preview(d!.collectionId, d!.version),
    enabled: Boolean(d) && !isHistory,
    retry: false,
  })

  const name = d ? props.collectionName(d.collectionId) : ''
  const risk: Risk | undefined = preview.data?.risk
  const impact = preview.data?.impact
  const diffItems: DiffItem[] = isHistory
    ? (d?.appliedMigration?.diff ?? [])
    : (preview.data?.diff ?? [])
  const recovery = failure?.recovery ?? d?.recoveryState ?? null

  const applyDisabled =
    busy || !d || isHistory || preview.isPending || preview.data?.risk === 'blocked'

  const apply = async () => {
    if (!d) {
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      // 契约：risk=review 必须显式确认，否则后端 409 CHANGE_CONFIRMATION_REQUIRED。
      const result = await changesApi.apply(d.collectionId, d.version, risk === 'review')
      const text = result.appliedMigrationId
        ? `已应用到结构（迁移 ${result.appliedMigrationId}）`
        : `应用已提交，状态 ${result.state}`
      message.success(text)
      if (result.recovery) {
        message.info(`恢复状态 · ${result.recovery.state}${result.recovery.summary ? `：${result.recovery.summary}` : ''}`)
      }
      props.onChanged()
      props.onClose()
    } catch (cause) {
      setFailure({ error: cause, recovery: recoveryFrom(cause) })
      message.error(errorMessage(cause))
      void detail.refetch()
      void preview.refetch()
    } finally {
      setBusy(false)
    }
  }

  const discard = async () => {
    if (!d) {
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      await changesApi.discard(d.collectionId, d.version)
      message.success('草案已放弃，待应用变更已移除')
      props.onChanged()
      setDiscardOpen(false)
      props.onClose()
    } catch (cause) {
      setFailure({ error: cause })
      message.error(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const footerNote = risk === 'blocked'
    ? '被阻塞：请先处理前置条件'
    : d?.status === 'failed'
      ? '上次应用失败：请查看「执行记录」里的恢复路径后重试'
      : risk === 'review'
        ? '应用将携带显式风险确认'
        : '差异已就绪，确认后写入结构'

  const failureCode = failure && failure.error instanceof ApiError ? failure.error.code : undefined

  return (
    <>
      <Drawer
        open
        onClose={props.onClose}
        width={880}
        rootClassName="mr-changes__drawer"
        title={
          <div className="mr-changes__drawer-title">
            <span className="mr-changes__drawer-heading">{name || '变更详情'}</span>
            <span className="mr-changes__drawer-subtitle">变更集 · {props.changeSetId}</span>
          </div>
        }
        footer={
          !d
            ? undefined
            : isHistory
              ? (
                <div className="mr-changes__footer">
                  <span className="mr-meta">历史记录只读，不能再应用或放弃</span>
                  <Button onClick={props.onClose}>关闭</Button>
                </div>
              )
              : (
                <div className="mr-changes__footer">
                  <span className="mr-meta">{footerNote}</span>
                  <div className="mr-changes__actions">
                    <Button onClick={() => props.onGoCollection(d.collectionId)} disabled={busy}>
                      在 {name} 中修改
                    </Button>
                    <Button danger disabled={busy} onClick={() => setDiscardOpen(true)}>
                      放弃草案…
                    </Button>
                    <Button type="primary" loading={busy} disabled={applyDisabled} onClick={() => void apply()}>
                      应用到结构
                    </Button>
                  </div>
                </div>
              )
        }
      >
        {detail.isPending ? <LoadingBlock rows={6} label="正在读取变更详情…" /> : null}
        {detail.isError ? (
          <ErrorState error={detail.error} title="变更详情读不到" onRetry={() => void detail.refetch()} />
        ) : null}

        {d ? (
          <div className="mr-changes__detail">
            <div className="mr-changes__detail-head">
              <StatusTag tone={d.status === 'discarded' ? 'neutral' : isHistory ? 'success' : 'warning'}>
                {d.status === 'discarded'
                  ? '已放弃 · 历史记录'
                  : isHistory
                    ? '已应用 · 历史记录'
                    : '草案 · 尚未生效'}
              </StatusTag>
              <span className="mr-meta">
                版本 v{d.version}
                {isHistory && d.appliedMigration
                  ? ` · 应用于 ${formatDateTime(d.appliedMigration.appliedAt)}`
                  : ''}
              </span>
            </div>

            <h2 className="mr-changes__detail-title">{name} 的结构变更</h2>
            <p className="mr-changes__detail-lede">
              {isHistory
                ? '这是已写入结构的历史记录，只用于回看差异与执行结果，不能再应用或放弃。'
                : '这是已保存、等待你确认的结构变更。差异写入真实结构前都可以放弃；确认应用后才会进入「历史」。'}
            </p>

            <div className="mr-changes__detail-grid">
              <div className="mr-changes__detail-main">
                <Segmented
                  block
                  value={props.view}
                  onChange={(value) => props.onViewChange(value as DetailView)}
                  options={[
                    { label: '变更差异', value: 'diff' },
                    { label: '风险与影响', value: 'risk' },
                    { label: '执行记录', value: 'attempts' },
                  ]}
                />
                <div className="mr-changes__panel">
                  {props.view === 'diff' ? (
                    <DiffView operations={d.operations} diff={diffItems} isHistory={isHistory} />
                  ) : null}
                  {props.view === 'risk' ? (
                    <RiskView
                      risk={risk}
                      impact={impact}
                      preconditions={preview.data?.preconditions ?? []}
                      diff={preview.data?.diff ?? []}
                      isPending={preview.isPending && !isHistory}
                      error={isHistory ? null : preview.error}
                      isHistory={isHistory}
                      onRetry={() => void preview.refetch()}
                    />
                  ) : null}
                  {props.view === 'attempts' ? (
                    <AttemptsView
                      attempts={d.applyAttempts}
                      recovery={recovery}
                      appliedMigration={d.appliedMigration}
                    />
                  ) : null}
                </div>
              </div>

              {/* Figma 右侧 355px「风险与确认」卡：始终可见，不随子视图切换消失。 */}
              <aside className="mr-changes__risk">
                <h3 className="mr-changes__risk-title">
                  <SafetyCertificateOutlined />
                  {risk ? `风险 · ${RISK_LABEL[risk]}` : '风险与确认'}
                </h3>
                {risk ? <StatusTag tone={RISK_TONE[risk]}>{RISK_LABEL[risk]}</StatusTag> : null}
                <p className="mr-changes__risk-text">
                  {risk === 'blocked'
                    ? '当前变更被现有数据或前置条件阻塞，不能应用。请在「风险与影响」里处理未通过的前置条件。'
                    : risk === 'review'
                      ? '这次变更会扩大访问范围或影响现有记录，应用时必须携带显式风险确认。'
                      : risk === 'safe'
                        ? '预检没有发现阻塞项，确认后即可写入结构。'
                        : isHistory
                          ? '这是已应用的历史记录，风险信息来自当时的迁移结果。'
                          : '正在读取预检结果；确认之前不会修改本地项目。'}
                </p>

                {preview.data && preview.data.preconditions.length > 0 ? (
                  <div className="mr-changes__blockers">
                    {preview.data.preconditions
                      .filter((item) => preconditionTone(item.status) === 'danger')
                      .map((item, index) => (
                        <p className="mr-changes__risk-text" key={`${item.code}-${index}`}>
                          <StatusTag tone="danger">{preconditionLabel(item.status)}</StatusTag>{' '}
                          <span className="mr-mono">{item.code}</span> {item.message}
                        </p>
                      ))}
                  </div>
                ) : null}

                {impact ? (
                  <div className="mr-changes__impact">
                    <ImpactStat label="受影响集合" value={impact.affectedCollections} />
                    <ImpactStat label="受影响字段" value={impact.affectedFields} />
                    <ImpactStat label="受影响索引" value={impact.affectedIndexes} />
                    <ImpactStat label="受影响记录" value={impact.affectedRecords} />
                  </div>
                ) : null}
                {impact?.summary ? <p className="mr-changes__risk-text">{impact.summary}</p> : null}

                <div className="mr-divider-line" />
                <p className="mr-changes__risk-text">
                  审阅页可检查完整差异、风险与验证计划。此处不提供跳过审阅的直接应用。
                </p>
                <Button
                  type="link"
                  size="small"
                  className="mr-inline-link"
                  onClick={() => props.onGoCollection(d.collectionId)}
                >
                  返回 {name} 工作台 →
                </Button>

                {!isHistory && preview.isPending ? (
                  <Notice tone="neutral">正在读取风险预检，应用按钮暂时不可用。</Notice>
                ) : null}
                {!isHistory && preview.isError ? (
                  <Notice tone="warning">
                    风险预检读不到：{errorMessage(preview.error)}。应用将按未确认风险提交，后端可能要求显式确认。
                  </Notice>
                ) : null}
                {risk === 'blocked' ? (
                  <Notice tone="danger">应用已禁用：预检判定为被阻塞，请先处理前置条件。</Notice>
                ) : null}
              </aside>
            </div>

            {failure ? (
              <>
                <ErrorState
                  error={failure.error}
                  title={failureCode === 'CHANGE_CONFIRMATION_REQUIRED' ? '需要显式确认风险' : '操作没有完成'}
                  onRetry={() => {
                    setFailure(null)
                    void detail.refetch()
                    void preview.refetch()
                  }}
                  retryLabel="重新检查"
                  secondary={
                    <Button
                      type="link"
                      size="small"
                      className="mr-inline-link"
                      onClick={() => props.onGoCollection(d.collectionId)}
                    >
                      去 {name} 工作台处理
                    </Button>
                  }
                />
                {failureCode === 'CHANGE_CONFIRMATION_REQUIRED' ? (
                  <Notice tone="warning">
                    后端返回 CHANGE_CONFIRMATION_REQUIRED：这次变更的风险为 review，应用必须携带 confirmRisk。请重新预检后再试。
                  </Notice>
                ) : null}
                {failureCode === 'VALIDATION_FAILED' ? (
                  <Notice tone="warning">
                    后端返回 VALIDATION_FAILED：预检前置条件未通过，结构没有被改动。请查看「风险与影响」与下方恢复路径。
                  </Notice>
                ) : null}
                {recovery ? <RecoveryNotice recovery={recovery} /> : null}
              </>
            ) : null}
          </div>
        ) : null}
      </Drawer>

      <Modal
        open={discardOpen}
        title="放弃这份草案？"
        okText="放弃草案"
        cancelText="保留草案"
        okButtonProps={{ danger: true }}
        confirmLoading={busy}
        onOk={() => void discard()}
        onCancel={() => setDiscardOpen(false)}
      >
        <p>放弃后，{name} 里这份已保存、等待确认的结构变更会被移除，差异不会写入真实结构。</p>
        <p>数据工作区里未保存的表单不受影响；已经应用的历史记录也不会被改动。</p>
      </Modal>
    </>
  )
}
