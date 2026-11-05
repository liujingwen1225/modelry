import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
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
  Popconfirm,
  SectionHeading,
  Segmented,
  Select,
  StateBlock,
  StatusTag,
  Table,
  Tabs,
} from '@/ui'
import type { TableColumnsType } from '@/ui'
import {
  ArrowLeftOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SendOutlined,
} from '@ant-design/icons'
import { errorMessage } from '@/api/client'
import { formatDateTime, formatMoment } from '@/lib/format'
import { collectionKeys, collectionsApi } from '@/api/collections'
import { developerApi, developerKeys, secretsApi } from '@/api/developer'
import type { ContractEndpoint, ContractEndpointValue, DeveloperContract, RequestRecord, SecretMetadata } from '@/api/developer'
import './developer.css'

/**
 * 开发与连接（Figma 画板 13 / 14 / 15 / 16）。
 *
 * 四个标签共用一侧任务标签与顶部标题，各自读取真实后端接口：
 *   api      → /developer/contract 生成接口目录与文档
 *   logs     → /requests 列表、筛选、cursor 分页与单条详情
 *   diagnose → 从 ?requestId= 出发，对真实端点重新发起 GET 请求
 *   secrets  → /secrets 的增删改（明文只写不回显）
 *
 * 页面不保存请求体、不伪造响应；所有示例文本都由真实契约字段推导。
 */
const TABS = [
  { key: 'api', label: 'API 文档' },
  { key: 'logs', label: '请求日志' },
  { key: 'diagnose', label: '请求排错' },
  { key: 'secrets', label: 'Secrets' },
] as const

type DevTab = (typeof TABS)[number]['key']

const TAB_META: Record<DevTab, { title: string; description: string }> = {
  api: { title: '开发与连接', description: '从真实接口开始，把当前项目接到你的前端。' },
  logs: { title: '开发与连接', description: '查看每次请求的身份、结果与耗时，从上下文定位问题。' },
  diagnose: { title: '给请求补上正确的身份', description: '承接请求日志里的失败请求，按端点重新发起真实请求，核对身份与规则。' },
  secrets: { title: '开发与连接', description: '把敏感配置留在后端，不写进前端与业务模板。' },
}

const PAGE_SIZE = 20

type StatusKey = 'all' | '2xx' | '4xx' | '5xx'

/** 后端 filter 是单条件表达式，用 gte 下界做服务端初筛，区间上界在本地精确收窄。 */
const STATUS_FILTER: Record<StatusKey, string | undefined> = {
  all: undefined,
  '2xx': 'status gte 200',
  '4xx': 'status gte 400',
  '5xx': 'status gte 500',
}

function inBand(status: number, key: StatusKey): boolean {
  if (key === 'all') return true
  if (key === '2xx') return status >= 200 && status < 300
  if (key === '4xx') return status >= 400 && status < 500
  return status >= 500
}

function statusTone(status: number): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status >= 400) return 'danger'
  if (status >= 200 && status < 300) return 'success'
  return 'warning'
}

/** 从放宽类型的端点字典里容错取字符串字段。 */
function pickText(endpoint: ContractEndpoint, keys: string[]): string {
  for (const key of keys) {
    const value = endpoint[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return ''
}

function readMethod(endpoint: ContractEndpoint): string {
  return (pickText(endpoint, ['method', 'verb', 'httpMethod']) || 'GET').toUpperCase()
}

function readPath(endpoint: ContractEndpoint): string {
  return pickText(endpoint, ['path', 'url', 'route', 'endpoint', 'uri'])
}

function readName(endpoint: ContractEndpoint): string {
  return pickText(endpoint, ['name', 'title', 'label', 'summary'])
}

/**
 * 后端当前把端点写成 "GET /api/v1/notes" 字符串；对象结构也兼容，
 * 避免契约演进时页面把真实端点当成空列表。
 */
function parseEndpoint(raw: ContractEndpointValue): { method: string; path: string; name: string } {
  if (typeof raw === 'string') {
    const separator = raw.trim().indexOf(' ')
    if (separator > 0) {
      return { method: raw.slice(0, separator).trim().toUpperCase(), path: raw.slice(separator + 1).trim(), name: '' }
    }
    return { method: 'GET', path: raw.trim(), name: '' }
  }
  const endpoint: ContractEndpoint = raw && typeof raw === 'object' ? raw : {}
  return { method: readMethod(endpoint), path: readPath(endpoint), name: readName(endpoint) }
}

/** 端点中文说明：优先用契约里的 name，缺失时按 method/path 推导。 */
function describeEndpoint(method: string, path: string, name: string): string {
  if (name) return name
  const single = /\{[^}]+\}|:[A-Za-z_]/.test(path)
  switch (method) {
    case 'GET':
      return single ? '读取单条记录' : '获取记录列表'
    case 'POST':
      return '创建记录'
    case 'PATCH':
    case 'PUT':
      return '修改记录'
    case 'DELETE':
      return '删除记录'
    default:
      return '调用接口'
  }
}

function joinPath(base: string, path: string): string {
  if (!path) return base
  if (/^https?:\/\//.test(path)) return path
  if (path.startsWith(base)) return path
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

type EndpointView = {
  id: string
  collectionId: string
  collectionName: string
  method: string
  path: string
  name: string
  description: string
}

function flattenEndpoints(contract: DeveloperContract): EndpointView[] {
  const views: EndpointView[] = []
  for (const collection of contract.collections) {
    const endpoints = Array.isArray(collection.endpoints) ? collection.endpoints : []
    for (const [index, raw] of endpoints.entries()) {
      const { method, path, name } = parseEndpoint(raw)
      views.push({
        id: `${collection.id}:${index}:${method}:${path}`,
        collectionId: collection.id,
        collectionName: collection.name,
        method,
        path,
        name,
        description: describeEndpoint(method, path, name),
      })
    }
  }
  return views
}

type ReplayResult = {
  status: number
  ok: boolean
  requestId: string
  durationMs: number
  sizeBytes: number
  body: string
}

/** 依据真实 HTTP 状态给出可理解的恢复路径，不编造服务端数据。 */
function recoveryHint(status: number, errorCode?: string): string {
  const code = errorCode ? `（错误码 ${errorCode}）` : ''
  if (status === 401) return `会话或凭据缺失、已过期${code}。先用应用用户登录取得会话，再携带 Authorization 重试。`
  if (status === 403) return `身份已识别但访问规则拒绝${code}。核对集合访问规则与记录归属，不要为消除 403 直接放开规则。`
  if (status === 404) return `端点或资源不存在${code}。确认集合名、记录 ID 与 API 基础路径是否仍然有效。`
  if (status >= 500) return `服务端处理失败${code}。稍后重试，并在请求日志里查同一 X-Request-Id 的服务端记录。`
  if (status >= 400) return `请求参数不被接受${code}。对照 API 文档检查查询参数与字段类型。`
  return `请求已成功${code}。可回到请求日志核对这次真实记录。`
}

type MessageApi = ReturnType<typeof App.useApp>['message']

/** 统一复制反馈：clipboard 不可用时给出真实错误，而不是静默失败。 */
async function copyText(text: string, message: MessageApi) {
  try {
    await navigator.clipboard.writeText(text)
    message.success('已复制到剪贴板')
  } catch (cause) {
    message.error(`复制失败：${errorMessage(cause)}`)
  }
}

export function DeveloperPage() {
  const params = useParams<{ tab?: string }>()
  const location = useLocation()
  const navigate = useNavigate()

  const query = new URLSearchParams(location.search)
  const requestId = query.get('requestId')
  const logSearch = query.get('search') ?? ''

  // 兼容 /developer/:tab 与 /developer/* 两种接线方式，始终由 URL 决定激活标签。
  const rawTab = params.tab ?? location.pathname.split('/').filter(Boolean)[1]
  const tab: DevTab = TABS.some((entry) => entry.key === rawTab) ? (rawTab as DevTab) : 'api'

  const goTab = (next: DevTab) => navigate(`/developer/${next}`)
  const goLogs = () => navigate('/developer/logs')
  const goLogsWithSearch = (search: string) => navigate(`/developer/logs?search=${encodeURIComponent(search)}`)
  const goDiagnose = (id: string) => navigate(`/developer/diagnose?requestId=${encodeURIComponent(id)}`)

  const meta = TAB_META[tab]

  return (
    <div className="mr-page mr-dev">
      <header className="mr-dev__head">
        <div>
          <h1 className="mr-dev__title">{meta.title}</h1>
          <p className="mr-dev__lede">{meta.description}</p>
        </div>
      </header>

      <div className="mr-dev__tabs">
        <Tabs
          activeKey={tab}
          onChange={(key) => goTab(key as DevTab)}
          //  inactive 面板保持挂载会让「请求详情」抽屉的遮罩挡住其它标签；
          //  切换标签即卸载，保证每个工作面都是干净的。
          destroyInactiveTabPane
          items={[
            { key: 'api', label: 'API 文档', children: <ApiDocTab onViewLogs={goLogsWithSearch} /> },
            {
              key: 'logs',
              label: '请求日志',
              children: <LogsTab key={`logs:${logSearch}`} initialSearch={logSearch} onDiagnose={goDiagnose} />,
            },
            {
              key: 'diagnose',
              label: '请求排错',
              children: <DiagnoseTab key={`diagnose:${requestId ?? ''}`} requestId={requestId} onBack={goLogs} />,
            },
            { key: 'secrets', label: 'Secrets', children: <SecretsTab /> },
          ]}
        />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ api 标签 */

function ApiDocTab(props: { onViewLogs: (search: string) => void }) {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const contract = useQuery({ queryKey: developerKeys.contract, queryFn: developerApi.contract })
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const views = useMemo(() => (contract.data ? flattenEndpoints(contract.data) : []), [contract.data])
  const selected = views.find((view) => view.id === selectedId) ?? views[0] ?? null

  const groups = useMemo(() => {
    if (!contract.data) return []
    return contract.data.collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      type: collection.type,
      schemaVersion: collection.schemaVersion,
      fieldCount: Array.isArray(collection.fields) ? collection.fields.length : 0,
      accessRules: Array.isArray(collection.accessRules) ? collection.accessRules : [],
      items: views.filter((view) => view.collectionId === collection.id),
    }))
  }, [contract.data, views])

  // react-query 的结果是可辨识联合；先取出重试函数，避免在后续窄化分支里访问 never。
  const retryContract = () => void contract.refetch()
  if (contract.isPending) {
    return <LoadingBlock rows={5} label="正在读取 API 契约…" />
  }
  if (contract.isError) {
    return <ErrorState error={contract.error} title="API 契约读不到" onRetry={retryContract} />
  }
  if (!contract.data) {
    return <StateBlock title="契约内容为空" description="服务端没有返回契约正文，请稍后重新读取。" actions={<Button onClick={retryContract}>重新读取契约</Button>} />
  }

  const data = contract.data
  const origin = window.location.origin
  const baseUrl = `${origin}${data.apiBasePath}`
  const group = selected ? groups.find((entry) => entry.id === selected.collectionId) : undefined
  const fullPath = selected ? joinPath(data.apiBasePath, selected.path) : ''
  const curl = selected
    ? [
        `curl '${origin}${fullPath}' \\`,
        `  -X ${selected.method} \\`,
        `  -H 'Accept: application/json' \\`,
        `  -H 'Authorization: Bearer <SESSION_TOKEN>'`,
      ].join('\n')
    : ''

  return (
    <div className="mr-dev__body">
      <div className="mr-dev-toolbar">
        <span className="mr-meta">
          契约版本 v{data.version} · 内容指纹 <Mono>{data.contentHash}</Mono>
        </span>
        <Button icon={<CopyOutlined />} onClick={() => void copyText(baseUrl, message)}>
          复制基础地址
        </Button>
      </div>

      {groups.length === 0 ? (
        <StateBlock
          eyebrow="暂无接口"
          title="还没有可用的集合"
          description="先在「数据」里创建集合，API 文档会按真实契约自动生成，不展示任何示例数据。"
          actions={
            <>
              <Button onClick={() => void contract.refetch()}>重新读取契约</Button>
              <Button type="primary" onClick={() => navigate('/data')}>
                前往数据
              </Button>
            </>
          }
        />
      ) : (
        <div className="mr-dev-api">
          <aside className="mr-dev-api__nav">
            <Mono className="mr-dev-api__origin">{origin}</Mono>
            <div className="mr-dev-api__rule" />
            {groups.map((entry) => (
              <div className="mr-dev-api__group" key={entry.id}>
                <div className="mr-dev-api__group-title">
                  <Mono>{entry.name}</Mono>
                  <span>· {entry.type === 'Auth' ? '邮箱与密码' : '数据集合'}</span>
                </div>
                {entry.items.length === 0 ? (
                  <p className="mr-dev-hint">该集合暂未暴露端点。</p>
                ) : (
                  entry.items.map((item) => (
                    <Button
                      key={item.id}
                      type="text"
                      block
                      className={`mr-dev-api__item${selected?.id === item.id ? ' mr-dev-api__item--active' : ''}`}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <span className={`mr-dev-api__method mr-dev-api__method--${item.method.toLowerCase()}`}>
                        {item.method}
                      </span>
                      <span className="mr-dev-api__item-name">{item.description}</span>
                    </Button>
                  ))
                )}
              </div>
            ))}
            <Notice>会话属于具体用户，不是万能管理密钥。不要把工作台权限交给前端。</Notice>
          </aside>

          <section className="mr-dev-api__detail">
            {!selected || !group ? (
              <StateBlock
                eyebrow="暂无端点"
                title="契约里没有可展示的端点"
                description="集合存在，但 /developer/contract 未返回任何 endpoints。请先在后端为集合声明端点。"
                actions={<Button onClick={() => void contract.refetch()}>重新读取契约</Button>}
              />
            ) : (
              <>
                <div className="mr-dev-api__endpoint">
                  <StatusTag tone="action">{selected.method}</StatusTag>
                  <Mono className="mr-dev-api__path">{fullPath}</Mono>
                </div>
                <p className="mr-dev-api__desc">
                  {selected.description}。{selected.name ? `契约名称：${selected.name}。` : ''}
                  实际返回内容由集合字段与访问规则决定，这里不展示示例数据。
                </p>

                <SectionHeading title="端点信息" meta={<Mono>v{data.version}</Mono>} />
                <DetailList
                  items={[
                    { label: '基础地址', value: baseUrl },
                    { label: '完整路径', value: fullPath },
                    { label: '请求方法', value: selected.method },
                    { label: '所属集合', value: `${group.name}（${group.type}）` },
                    { label: 'Schema 版本', value: `v${group.schemaVersion}` },
                    { label: '字段数', value: String(group.fieldCount) },
                    { label: '内容指纹', value: data.contentHash },
                  ]}
                />

                <SectionHeading title="访问规则（来自契约）" />
                {group.accessRules.length > 0 ? (
                  <DetailList
                    items={group.accessRules.map((rule) => ({
                      label: rule.operation,
                      value: rule.mode,
                      mono: false,
                    }))}
                  />
                ) : (
                  <p className="mr-dev-hint">该集合的契约未声明 accessRules。</p>
                )}

                <SectionHeading
                  title="请求 · cURL"
                  action={
                    <Button type="link" size="small" icon={<CopyOutlined />} onClick={() => void copyText(curl, message)}>
                      复制
                    </Button>
                  }
                />
                <CodeBlock code={curl} label="请求 · cURL" maxHeight={200} />

                <SectionHeading title="请求与响应要点" />
                <ul className="mr-dev-points">
                  <li>方法 {selected.method}，路径 {fullPath}</li>
                  <li>基础地址 {baseUrl}，契约版本 v{data.version}</li>
                  <li>凭据用同源 Cookie 会话或 Authorization: Bearer &lt;SESSION_TOKEN&gt;</li>
                  <li>响应为 JSON：成功 2xx；认证失败 401；访问规则拒绝 403</li>
                  <li>{group.accessRules.map((rule) => `${rule.operation} → ${rule.mode}`).join('；') || '契约未声明访问规则'}</li>
                </ul>

                <div className="mr-dev-toolbar">
                  <Button onClick={() => void copyText(`${origin}${fullPath}`, message)}>复制端点地址</Button>
                  <Button type="primary" onClick={() => props.onViewLogs(fullPath)}>
                    在请求日志中查看
                  </Button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

/* ----------------------------------------------------------------- logs 标签 */

function LogsTab(props: { initialSearch: string; onDiagnose: (requestId: string) => void }) {
  const queryClient = useQueryClient()
  const [searchInput, setSearchInput] = useState(props.initialSearch)
  const [search, setSearch] = useState(props.initialSearch)
  const [statusKey, setStatusKey] = useState<StatusKey>('all')
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([undefined])
  const [activeId, setActiveId] = useState<string | null>(null)

  const collections = useQuery({ queryKey: collectionKeys.list, queryFn: collectionsApi.list })
  const names = useMemo(
    () => new Map((collections.data ?? []).map((collection) => [collection.id, collection.name])),
    [collections.data],
  )

  const cursor = cursorStack[cursorStack.length - 1]
  const filter = STATUS_FILTER[statusKey]
  const requests = useQuery({
    queryKey: developerKeys.requests({ limit: PAGE_SIZE, cursor, search: search || undefined, filter }),
    queryFn: () => developerApi.requests({ limit: PAGE_SIZE, cursor, search: search || undefined, filter }),
    placeholderData: keepPreviousData,
  })

  const rows = useMemo(
    () => (requests.data?.data ?? []).filter((record) => inBand(record.status, statusKey)),
    [requests.data, statusKey],
  )

  const applySearch = () => {
    setSearch(searchInput)
    setCursorStack([undefined])
  }

  const columns: TableColumnsType<RequestRecord> = [
    {
      title: '时间',
      dataIndex: 'time',
      width: 130,
      render: (value) => <Mono className="mr-dev-cell">{formatMoment(String(value ?? ''))}</Mono>,
    },
    {
      title: '方法',
      dataIndex: 'method',
      width: 90,
      render: (value) => <Mono className="mr-dev-cell">{String(value ?? '—')}</Mono>,
    },
    {
      title: '路径',
      dataIndex: 'endpoint',
      render: (value, record) => (
        <div className="mr-dev-cell">
          <Mono className="mr-dev-cell__path">{String(value ?? '—')}</Mono>
          <span className="mr-meta">{names.get(record.collectionId) ?? record.collectionId}</span>
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value) => <StatusTag tone={statusTone(Number(value))}>{String(value ?? '—')}</StatusTag>,
    },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      width: 90,
      render: (value) => <Mono className="mr-dev-cell">{String(value ?? '—')} ms</Mono>,
    },
    {
      title: '身份',
      dataIndex: 'authenticationOutcome',
      width: 130,
      render: (value) => <span className="mr-dev-cell">{String(value ?? '—')}</span>,
    },
    {
      title: '操作',
      width: 110,
      render: (_value, record) => (
        <Button type="link" size="small" onClick={() => props.onDiagnose(record.requestId)}>
          排错验证
        </Button>
      ),
    },
  ]

  return (
    <div className="mr-dev__body">
      <div className="mr-dev-toolbar">
        <div className="mr-dev-tools">
          <Input
            className="mr-dev-search"
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索路径或请求 ID…"
            value={searchInput}
            onChange={(event) => {
              const next = event.target.value
              setSearchInput(next)
              if (!next) {
                setSearch('')
                setCursorStack([undefined])
              }
            }}
            onPressEnter={applySearch}
          />
          <Button onClick={applySearch}>搜索</Button>
          <Segmented
            value={statusKey}
            onChange={(value) => {
              setStatusKey(value as StatusKey)
              setCursorStack([undefined])
            }}
            options={[
              { label: '全部', value: 'all' },
              { label: '2xx', value: '2xx' },
              { label: '4xx', value: '4xx' },
              { label: '5xx', value: '5xx' },
            ]}
          />
        </div>
        <Button
          icon={<ReloadOutlined />}
          loading={requests.isFetching}
          onClick={() => void queryClient.invalidateQueries({ queryKey: ['developer-requests'] })}
        >
          刷新日志
        </Button>
      </div>

      {requests.isPending ? (
        <LoadingBlock rows={5} label="正在读取请求日志…" />
      ) : requests.isError ? (
        <ErrorState error={requests.error} title="请求日志读不到" onRetry={() => void requests.refetch()} />
      ) : (
        <>
          <Table<RequestRecord>
            rowKey="requestId"
            size="small"
            pagination={false}
            columns={columns}
            dataSource={rows}
            className="mr-dev-table"
            rowClassName={(record) => (record.requestId === activeId ? 'mr-dev-row--active' : '')}
            onRow={(record) => ({ onClick: () => setActiveId(record.requestId) })}
            locale={{ emptyText: '当前条件下没有请求记录。调整搜索词或状态筛选后再试。' }}
          />

          <div className="mr-dev-pager">
            <Button disabled={cursorStack.length <= 1} onClick={() => setCursorStack((stack) => stack.slice(0, -1))}>
              上一页
            </Button>
            <span className="mr-meta">
              第 {cursorStack.length} 页 · 本页 {rows.length} 条
              {requests.isFetching ? ' · 正在刷新…' : ''}
            </span>
            <Button
              disabled={!requests.data?.nextCursor}
              onClick={() => {
                const next = requests.data?.nextCursor
                if (next) setCursorStack((stack) => [...stack, next])
              }}
            >
              下一页
            </Button>
          </div>

          <p className="mr-dev-footer">
            已显示 {rows.length} 条请求 · 本地日志 · 不记录请求体、密码或完整会话凭据
          </p>
          <Notice>请求日志只用于排错，不改变数据或访问规则。状态分段先用 filter 在服务端初筛，再在本地按区间精确收窄。</Notice>
        </>
      )}

      {activeId ? (
        <RequestDetailDrawer
          requestId={activeId}
          collectionName={names.get(requests.data?.data.find((row) => row.requestId === activeId)?.collectionId ?? '') ?? '—'}
          onClose={() => setActiveId(null)}
          onDiagnose={props.onDiagnose}
        />
      ) : null}
    </div>
  )
}

function RequestDetailDrawer(props: {
  requestId: string
  collectionName: string
  onClose: () => void
  onDiagnose: (requestId: string) => void
}) {
  const detail = useQuery({
    queryKey: developerKeys.request(props.requestId),
    queryFn: () => developerApi.request(props.requestId),
    retry: false,
  })

  let content = <LoadingBlock rows={4} label="正在读取这条请求…" />
  if (detail.isError) {
    content = (
      <ErrorState
        error={detail.error}
        title="这条请求读不到"
        onRetry={() => void detail.refetch()}
        secondary={<span className="mr-dev-hint">可能已被清理，或 requestId 不存在（404）。</span>}
      />
    )
  } else if (!detail.isPending && detail.data) {
    const record = detail.data
    content = (
      <>
        <div className="mr-dev-detail__head">
          <h2 className="mr-dev-detail__title">{statusTone(record.status) === 'danger' ? '请求被拒绝' : '请求详情'}</h2>
          <StatusTag tone={statusTone(record.status)}>{record.status}</StatusTag>
        </div>
        <Mono className="mr-dev-detail__id">{record.requestId}</Mono>
        <DetailList
          items={[
            { label: '请求 ID', value: record.requestId },
            { label: '时间', value: formatDateTime(record.time) },
            { label: '集合', value: props.collectionName },
            { label: '端点', value: record.endpoint },
            { label: '方法', value: record.method },
            { label: 'HTTP 状态', value: String(record.status) },
            { label: '耗时', value: `${record.durationMs} ms` },
            { label: '响应大小', value: `${record.responseSizeBytes} B` },
            { label: '认证结论', value: record.authenticationOutcome || '—' },
            { label: '授权结论', value: record.authorizationOutcome || '—' },
            { label: '错误码', value: record.errorCode || '—' },
            { label: '恢复路径', value: recoveryHint(record.status, record.errorCode), mono: false },
          ]}
        />
        <CodeBlock
          code={`${record.method} ${record.endpoint}\n时间 ${formatDateTime(record.time)} · 耗时 ${record.durationMs} ms`}
          label="请求"
        />
        <Button type="primary" block onClick={() => props.onDiagnose(record.requestId)}>
          排错验证 →
        </Button>
      </>
    )
  }

  return (
    <Drawer open onClose={props.onClose} width={420} title="请求详情" className="mr-dev-drawer">
      {content}
    </Drawer>
  )
}

/* ------------------------------------------------------------- diagnose 标签 */

function DiagnoseTab(props: { requestId: string | null; onBack: () => void }) {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  const contract = useQuery({ queryKey: developerKeys.contract, queryFn: developerApi.contract })
  const detail = useQuery({
    queryKey: developerKeys.request(props.requestId ?? ''),
    queryFn: () => developerApi.request(props.requestId ?? ''),
    enabled: Boolean(props.requestId),
    retry: false,
  })

  const [endpointPath, setEndpointPath] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<ReplayResult | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)

  /** 只能用真实 GET 端点重发：非 GET 端点让用户从契约里另选。 */
  const getEndpoints = useMemo(() => {
    const data = contract.data
    if (!data) return []
    const options: Array<{ label: string; value: string }> = []
    for (const collection of data.collections) {
      const endpoints = Array.isArray(collection.endpoints) ? collection.endpoints : []
      for (const raw of endpoints) {
        const { method, path } = parseEndpoint(raw)
        if (method === 'GET' && path) {
          const full = joinPath(data.apiBasePath, path)
          options.push({ label: `${method} ${full} · ${collection.name}`, value: full })
        }
      }
    }
    // RequestRecord.endpoint 是脱敏后的路由模板（如 /api/v1/{collectionName}），
    // 不是可直接重放的真实地址；下拉只放契约里可直接发起的具体端点。
    return options
  }, [contract.data])

  useEffect(() => {
    if (endpointPath) return
    const first = getEndpoints[0]
    if (first) setEndpointPath(first.value)
  }, [getEndpoints, endpointPath])

  const send = async () => {
    if (!endpointPath) {
      message.warning('请先选择要重新发起的 GET 端点')
      return
    }
    setSending(true)
    setResult(null)
    setFetchError(null)
    const started = performance.now()
    try {
      const response = await fetch(endpointPath, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
      const text = await response.text()
      const durationMs = Math.round(performance.now() - started)
      let body = text
      try {
        body = JSON.stringify(JSON.parse(text) as unknown, null, 2)
      } catch {
        // 非 JSON 响应保留原文，不伪造结构。
      }
      const next: ReplayResult = {
        status: response.status,
        ok: response.ok,
        requestId: response.headers.get('X-Request-Id') ?? '—',
        durationMs,
        sizeBytes: new Blob([text]).size,
        body: body || '（空响应体）',
      }
      setResult(next)
      // 这次真实请求会被后端记入 RequestRecord，让日志页能刷新看到。
      void queryClient.invalidateQueries({ queryKey: ['developer-requests'] })
      if (next.ok) message.success(`重新发起成功：HTTP ${next.status}`)
      else message.error(`重新发起返回 HTTP ${next.status}`)
    } catch (cause) {
      const text = errorMessage(cause)
      setFetchError(text)
      message.error(`重新发起失败：${text}`)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mr-dev__body">
      <div className="mr-dev-toolbar">
        <Button icon={<ArrowLeftOutlined />} onClick={props.onBack}>
          返回请求日志
        </Button>
      </div>

      <Notice>
        日志只保存脱敏后的端点模板与请求 ID，不含请求体；下面是按契约里真实 GET 端点重新发起的 HTTP 请求，不是原样重放原始请求。
      </Notice>

      {!props.requestId ? (
        <StateBlock
          eyebrow="缺少上下文"
          title="先从请求日志选择一条失败请求"
          description="排错验证需要 ?requestId= 指向一条真实记录。请到请求日志点击「排错验证」。"
          actions={<Button type="primary" onClick={props.onBack}>去请求日志</Button>}
        />
      ) : detail.isPending ? (
        <LoadingBlock rows={4} label="正在读取这条失败请求…" />
      ) : detail.isError ? (
        <ErrorState
          error={detail.error}
          title="这条请求读不到"
          onRetry={() => void detail.refetch()}
          secondary={<span className="mr-dev-hint">requestId 可能已失效（404）。</span>}
        />
      ) : !detail.data ? (
        <StateBlock title="请求上下文为空" description="服务端没有返回这条记录，请回到请求日志重新选择。" actions={<Button onClick={props.onBack}>去请求日志</Button>} />
      ) : (
        <div className="mr-dev-diagnose">
          <section className="mr-dev-card">
            <h2 className="mr-dev-card__title">失败请求上下文</h2>
            <DetailList
              items={[
                { label: '请求 ID', value: detail.data.requestId },
                { label: '错误码', value: detail.data.errorCode || '—' },
                { label: 'HTTP 状态', value: String(detail.data.status) },
                { label: '时间', value: formatDateTime(detail.data.time) },
                { label: '端点', value: detail.data.endpoint },
                { label: '方法', value: detail.data.method },
                { label: '认证结论', value: detail.data.authenticationOutcome || '—' },
                { label: '授权结论', value: detail.data.authorizationOutcome || '—' },
                { label: '恢复路径', value: recoveryHint(detail.data.status, detail.data.errorCode), mono: false },
              ]}
            />
            {detail.data.method.toUpperCase() !== 'GET' ? (
              <Notice tone="warning">
                原请求是 {detail.data.method}，日志不含请求体，无法原样重发。请从下面的真实 GET 端点里选择一个进行验证。
              </Notice>
            ) : null}
          </section>

          <section className="mr-dev-card">
            <h2 className="mr-dev-card__title">重新发起真实请求</h2>
            {contract.isPending ? (
              <LoadingBlock rows={2} label="正在读取可重发的 GET 端点…" />
            ) : contract.isError ? (
              <ErrorState error={contract.error} title="契约读不到" onRetry={() => void contract.refetch()} />
            ) : getEndpoints.length === 0 ? (
              <StateBlock
                tone="neutral"
                title="契约里没有 GET 端点"
                description="没有可安全重发的端点，因此不提供「重新发起请求」。请先在后端为集合声明 GET 端点。"
              />
            ) : (
              <>
                <Field label="真实端点" hint="端点全部来自 /developer/contract，只列出可直接重发的 GET 请求。">
                  <Select
                    value={endpointPath || undefined}
                    options={getEndpoints}
                    placeholder="选择 GET 端点"
                    onChange={(value) => setEndpointPath(String(value))}
                  />
                </Field>
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  loading={sending}
                  disabled={!endpointPath}
                  onClick={() => void send()}
                >
                  重新发起请求
                </Button>
              </>
            )}

            {result ? (
              <div className="mr-dev-result">
                <Notice tone={result.ok ? 'success' : 'danger'}>
                  {result.ok
                    ? `结论：成功（HTTP ${result.status}）。这是浏览器真实收到的响应。`
                    : `结论：失败（HTTP ${result.status}）。${recoveryHint(result.status)}`}
                </Notice>
                <DetailList
                  items={[
                    { label: 'HTTP 状态', value: String(result.status) },
                    { label: 'X-Request-Id', value: result.requestId },
                    { label: '耗时', value: `${result.durationMs} ms` },
                    { label: '响应大小', value: `${result.sizeBytes} B` },
                    { label: '结论', value: result.ok ? '成功' : '失败', mono: false },
                  ]}
                />
                <div className="mr-dev-toolbar">
                  <Button icon={<CopyOutlined />} onClick={() => void copyText(result.requestId, message)}>
                    复制 X-Request-Id
                  </Button>
                  <Button onClick={() => void copyText(result.body, message)}>复制响应正文</Button>
                </div>
                <CodeBlock code={result.body} label="真实响应正文" maxHeight={280} />
                <Notice>
                  这次请求已被后端记入真实 RequestRecord。切到「请求日志」点「刷新日志」即可看到；用 X-Request-Id 可对照。
                </Notice>
                <Button onClick={props.onBack}>去请求日志查看 →</Button>
              </div>
            ) : null}

            {fetchError ? (
              <Notice tone="danger">
                请求没有发出：{fetchError}。检查端点是否可达、网络与同源 Cookie 是否正常，再重试。
              </Notice>
            ) : null}
          </section>
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------- secrets 标签 */

type SecretDrawerMode = 'create' | 'rename' | 'value'

function SecretsTab() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  const list = useQuery({ queryKey: developerKeys.secrets, queryFn: secretsApi.list })
  const [search, setSearch] = useState('')
  const [drawer, setDrawer] = useState<{ mode: SecretDrawerMode; secret?: SecretMetadata } | null>(null)

  const rows = useMemo(() => {
    const data = list.data ?? []
    const keyword = search.trim().toLowerCase()
    if (!keyword) return data
    return data.filter((secret) => secret.name.toLowerCase().includes(keyword))
  }, [list.data, search])

  const remove = async (secret: SecretMetadata) => {
    try {
      await secretsApi.remove(secret.id)
      message.success(`已删除 ${secret.name}`)
      await queryClient.invalidateQueries({ queryKey: developerKeys.secrets })
    } catch (cause) {
      message.error(`删除失败：${errorMessage(cause)}`)
    }
  }

  const columns: TableColumnsType<SecretMetadata> = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (value) => <Mono className="mr-dev-cell">{String(value ?? '—')}</Mono>,
    },
    {
      title: '敏感值',
      width: 160,
      render: () => <span className="mr-dev-mask">••••••••••••</span>,
    },
    {
      title: '配置状态',
      dataIndex: 'configured',
      width: 120,
      render: (value) => (
        <StatusTag tone={value ? 'success' : 'warning'}>{value ? '已配置' : '未配置'}</StatusTag>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (value) => <Mono className="mr-dev-cell">{formatDateTime(String(value ?? ''))}</Mono>,
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 180,
      render: (value) => <Mono className="mr-dev-cell">{formatDateTime(String(value ?? ''))}</Mono>,
    },
    {
      title: '操作',
      width: 200,
      render: (_value, record) => (
        <div className="mr-dev-actions">
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => setDrawer({ mode: 'rename', secret: record })}>
            改名
          </Button>
          <Button type="link" size="small" onClick={() => setDrawer({ mode: 'value', secret: record })}>
            改值
          </Button>
          <Popconfirm
            title="删除这个 Secret？"
            description="删除后引用它的配置会立即失效，且不可恢复。"
            okText="删除"
            cancelText="取消"
            onConfirm={() => void remove(record)}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </div>
      ),
    },
  ]

  return (
    <div className="mr-dev__body">
      <div className="mr-dev-toolbar">
        <Input
          className="mr-dev-search"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索名称…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawer({ mode: 'create' })}>
          新增 Secret
        </Button>
      </div>

      {list.isPending ? (
        <LoadingBlock rows={4} label="正在读取 Secrets…" />
      ) : list.isError ? (
        <ErrorState error={list.error} title="Secrets 读不到" onRetry={() => void list.refetch()} />
      ) : rows.length === 0 && (list.data ?? []).length === 0 ? (
        <StateBlock
          eyebrow="暂无配置"
          title="还没有 Secret"
          description="敏感配置只保存在当前实例的本地数据中，列表与 API 文档都不会显示明文。"
          actions={
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawer({ mode: 'create' })}>
              新增 Secret
            </Button>
          }
        />
      ) : (
        <>
          <Table<SecretMetadata>
            rowKey="id"
            size="small"
            pagination={false}
            columns={columns}
            dataSource={rows}
            className="mr-dev-table"
            locale={{ emptyText: '没有匹配名称的 Secret。清空搜索词可查看全部。' }}
          />
          <p className="mr-dev-footer">共 {(list.data ?? []).length} 项 · 值始终遮蔽，不会显示在 API 文档中。</p>
          <Notice>Secret 的明文永不从服务端返回；这里只管理敏感配置，不是应用用户的密码或会话列表。</Notice>
        </>
      )}

      {drawer ? (
        <SecretDrawer
          mode={drawer.mode}
          secret={drawer.secret}
          onClose={() => setDrawer(null)}
        />
      ) : null}
    </div>
  )
}

function SecretDrawer(props: {
  mode: SecretDrawerMode
  secret?: SecretMetadata
  onClose: () => void
}) {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  const [name, setName] = useState(props.secret?.name ?? '')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const needsName = props.mode !== 'value'
  const needsValue = props.mode !== 'rename'
  const nameBytes = new TextEncoder().encode(name.trim()).length
  const valueBytes = new TextEncoder().encode(value).length
  const nameError = !name.trim() ? '名称不能为空' : nameBytes > 128 ? '名称最多 128 字节' : null
  const valueError = !value ? '明文值不能为空' : valueBytes > 16 * 1024 ? '明文值最多 16 KiB' : null
  const canSave = (needsName ? !nameError : true) && (needsValue ? !valueError : true) && !busy

  const title =
    props.mode === 'create'
      ? '新增 Secret'
      : props.mode === 'rename'
        ? `改名 · ${props.secret?.name ?? ''}`
        : `更新明文值 · ${props.secret?.name ?? ''}`

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      if (props.mode === 'create') {
        await secretsApi.create({ name: name.trim(), value })
        message.success(`已创建 ${name.trim()}`)
      } else if (props.mode === 'rename' && props.secret) {
        await secretsApi.rename(props.secret.id, name.trim())
        message.success(`已改名为 ${name.trim()}`)
      } else if (props.mode === 'value' && props.secret) {
        await secretsApi.setValue(props.secret.id, value)
        message.success('明文值已更新，服务端不会回显')
      }
      // 明文只写不回显：保存后立即清空输入框。
      setName('')
      setValue('')
      await queryClient.invalidateQueries({ queryKey: developerKeys.secrets })
      props.onClose()
    } catch (cause) {
      setError(cause)
      message.error(`保存失败：${errorMessage(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      open
      onClose={props.onClose}
      width={440}
      title={title}
      className="mr-dev-drawer"
      footer={
        <div className="mr-dev-drawer__footer">
          <Button onClick={props.onClose}>取消</Button>
          <Button type="primary" loading={busy} disabled={!canSave} onClick={() => void save()}>
            保存
          </Button>
        </div>
      }
    >
      {needsName ? (
        <Field label="名称" required error={nameError} hint="1～128 字节，名称必须唯一。">
          <Input
            className="mr-mono"
            value={name}
            maxLength={128}
            placeholder="输入 Secret 名称"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      ) : (
        <DetailList items={[{ label: '当前名称', value: props.secret?.name ?? '—' }]} />
      )}

      {needsValue ? (
        <Field
          label={props.mode === 'create' ? '明文值' : '新的明文值'}
          required
          error={valueError}
          hint={`1～16 KiB；保存后输入框会立即清空。当前 ${valueBytes} 字节。`}
        >
          <Input.Password value={value} onChange={(event) => setValue(event.target.value)} />
        </Field>
      ) : null}

      <Notice tone={props.mode === 'value' ? 'warning' : 'neutral'}>
        {props.mode === 'value'
          ? '更新会生成新版本，服务端永不回显明文；旧的引用方需要使用新值。'
          : '明文值只在写入时经过浏览器，列表、详情与 API 文档都不会显示它。'}
      </Notice>

      {error ? <Notice tone="danger">{errorMessage(error)}</Notice> : null}
    </Drawer>
  )
}
