import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Drawer, ErrorState, Field, Input, InputNumber, LoadingBlock, Notice, Select, Switch, Table } from '@/ui'
import type { TableColumnsType } from '@/ui'
import { PlusOutlined, SearchOutlined } from '@ant-design/icons'
import { collectionsApi, collectionKeys, type CollectionSummary } from '@/api/collections'
import { recordsApi } from '@/api/records'
import { appAuthApi, appAuthKeys, type ApplicationSession, type AuthConfig } from '@/api/appauth'
import { errorMessage } from '@/api/client'
import { formatDateTime, formatMoment } from '@/lib/format'
import { useBreadcrumbTail } from '@/app/BreadcrumbContext'
import { CreateCollectionDrawer } from '@/pages/data/CreateCollectionDrawer'
import { RulesTab } from './RulesTab'
import './access.css'

const TABS = [
  { key: 'users', label: '用户' },
  { key: 'auth', label: '认证' },
  { key: 'rules', label: '访问规则' },
] as const

type AccessTab = (typeof TABS)[number]['key']

/**
 * 用户与访问（Figma 画板 8 / 9 / 10 / 26）。
 *
 * 应用用户住在认证集合里：用户资料是集合记录，密码与会话由 appauth 管理。
 * 管理面管理员与这里完全分离——添加应用用户不会获得工作台权限。
 */
export function AccessPage() {
  const params = useParams<{ tab?: string }>()
  const navigate = useNavigate()
  const tab = (params.tab ?? 'users') as AccessTab
  const [createOpen, setCreateOpen] = useState(false)
  const [activeUser, setActiveUser] = useState<Record<string, unknown> | null>(null)

  const collections = useQuery({ queryKey: collectionKeys.list, queryFn: collectionsApi.list })
  const auth = useMemo(() => collections.data?.find((collection) => collection.type === 'Auth'), [collections.data])

  useBreadcrumbTail([])

  if (collections.isPending) {
    return (
      <div className="mr-page">
        <LoadingBlock rows={5} label="正在读取应用用户…" />
      </div>
    )
  }

  if (collections.isError) {
    return (
      <div className="mr-page">
        <ErrorState error={collections.error} title="集合读不到" onRetry={() => void collections.refetch()} />
      </div>
    )
  }

  return (
    <div className="mr-page">
      <header className="mr-access__head">
        <div className="mr-access__heading">
          <h1 className="mr-overview__title">用户与访问</h1>
          <p className="mr-overview__lede">谁可以进入应用，以及他们能对数据做什么。</p>
        </div>
        {tab === 'users' ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setActiveUser({})} disabled={!auth}>
            添加用户
          </Button>
        ) : null}
      </header>

      <nav className="mr-tabs mr-access__tabs" aria-label="用户与访问">
        {TABS.map((entry) => (
          <Button
            key={entry.key}
            type="text"
            className={`mr-tabs__item${entry.key === tab ? ' mr-tabs__item--active' : ''}`}
            onClick={() => navigate(entry.key === 'users' ? '/access' : `/access/${entry.key}`)}
          >
            {entry.label}
          </Button>
        ))}
      </nav>

      {!auth && tab !== 'rules' ? (
        <div className="mr-access__empty">
          <h2 className="mr-empty-state__title">还没有认证集合</h2>
          <p className="mr-empty-state__text">
            应用用户住在认证集合里。先创建一个认证集合，Modelry 会自动为它准备邮箱、密码与会话。
          </p>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            创建认证集合
          </Button>
        </div>
      ) : null}

      {auth && tab === 'users' ? (
        <UsersTab collection={auth} onOpen={(record) => setActiveUser(record)} />
      ) : null}
      {auth && tab === 'auth' ? <AuthTab collection={auth} /> : null}
      {/* 访问规则作用于任意集合，不要求项目里已经有认证集合。 */}
      {tab === 'rules' ? <RulesTab collections={collections.data ?? []} /> : null}

      <CreateCollectionDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false)
          void collections.refetch()
        }}
      />

      {auth && activeUser ? (
        <UserDrawer collection={auth} record={activeUser} onClose={() => setActiveUser(null)} />
      ) : null}
    </div>
  )
}

function UsersTab(props: { collection: CollectionSummary; onOpen: (record: Record<string, unknown>) => void }) {
  const [search, setSearch] = useState('')
  const users = useQuery({
    queryKey: ['app-user-records', props.collection.id],
    queryFn: () => recordsApi.list(props.collection.id, { limit: 100 }),
  })

  const rows = useMemo(() => {
    const data = users.data?.data ?? []
    const keyword = search.trim().toLowerCase()
    if (!keyword) {
      return data
    }
    return data.filter((record) =>
      ['email', 'name'].some((key) => String(record[key] ?? '').toLowerCase().includes(keyword)),
    )
  }, [search, users.data])

  const columns: TableColumnsType<Record<string, unknown>> = [
    {
      title: '用户',
      dataIndex: 'name',
      width: 180,
      render: (_value, record) => (
        <div className="mr-record-cell">
          <span className="mr-record-cell__title">{String(record.name ?? record.email ?? '')}</span>
          <span className="mr-record-cell__snippet">{String(record.id)}</span>
        </div>
      ),
    },
    {
      title: '邮箱',
      dataIndex: 'email',
      render: (value) => <span className="mr-mono">{String(value ?? '—')}</span>,
    },
    {
      title: '加入时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (value) => <span className="mr-mono mr-record-cell__time">{formatDateTime(String(value))}</span>,
    },
    {
      title: '操作',
      width: 100,
      render: (_value, record) => (
        <Button type="link" size="small" onClick={() => props.onOpen(record)}>
          查看详情
        </Button>
      ),
    },
  ]

  if (users.isPending) {
    return <LoadingBlock rows={4} />
  }
  if (users.isError) {
    return <ErrorState error={users.error} title="用户读不到" onRetry={() => void users.refetch()} />
  }

  return (
    <>
      <div className="mr-access__tools">
        <Input
          className="mr-records__search"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索姓名或邮箱…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <span className="mr-meta">认证集合 · {props.collection.name}</span>
      </div>

      <Table<Record<string, unknown>>
        rowKey="id"
        size="small"
        pagination={false}
        columns={columns}
        dataSource={rows}
        className="mr-records__table"
        locale={{ emptyText: '还没有应用用户。添加用户后，他们就能登录受保护的应用 API。' }}
      />

      <div className="mr-records__footer">
        <span>共 {rows.length} 位应用用户 · 全部已加载</span>
        <span className="mr-meta">邮箱密码认证</span>
      </div>

      <Notice>
        这里只管理当前本地项目的应用用户。应用用户不是工作台管理员，读取他人数据仍受访问规则约束。
      </Notice>
    </>
  )
}

function UserDrawer(props: { collection: CollectionSummary; record: Record<string, unknown>; onClose: () => void }) {
  const queryClient = useQueryClient()
  const recordId = String(props.record.id ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)

  const isNew = !props.record.id
  const sessions = useQuery({
    queryKey: appAuthKeys.sessions(props.collection.id, recordId),
    queryFn: () => appAuthApi.sessions(props.collection.id, recordId),
    enabled: !isNew && Boolean(recordId),
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['app-user-records', props.collection.id] })
    void queryClient.invalidateQueries({ queryKey: appAuthKeys.sessions(props.collection.id, recordId) })
  }

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const email = String(props.record.email ?? '')
      await appAuthApi.create(props.collection.id, { ...props.record, email }, password)
      setSaved(true)
      refresh()
      props.onClose()
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
    }
  }

  const resetPassword = async () => {
    setBusy(true)
    setError(null)
    try {
      await appAuthApi.setPassword(props.collection.id, recordId, password)
      setPassword('')
      setSaved(true)
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (sessionId: string) => {
    setBusy(true)
    try {
      await appAuthApi.revoke(props.collection.id, sessionId)
      refresh()
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      open
      onClose={props.onClose}
      width={480}
      rootClassName="mr-drawer"
      title={
        <div className="mr-drawer__title">
          <span className="mr-drawer__heading">{isNew ? '添加应用用户' : String(props.record.name ?? props.record.email ?? '用户')}</span>
          <span className="mr-drawer__subtitle">{isNew ? '创建后即可登录受保护的应用 API。' : `id · ${recordId}`}</span>
        </div>
      }
      footer={
        <div className="mr-drawer__footer">
          <span className="mr-meta">{isNew ? '尚未创建' : '会话由 Modelry 管理'}</span>
          <div className="mr-drawer__actions">
            <Button onClick={props.onClose}>关闭</Button>
            {isNew ? (
              <Button type="primary" loading={busy} onClick={() => void create()}>
                创建用户
              </Button>
            ) : null}
          </div>
        </div>
      }
    >
      {isNew ? (
        <>
          <Field label="邮箱" required>
            <Input
              className="mr-mono"
              value={String(props.record.email ?? '')}
              placeholder="user@example.test"
              onChange={(event) => Object.assign(props.record, { email: event.target.value })}
            />
          </Field>
          <Field label="姓名">
            <Input
              value={String(props.record.name ?? '')}
              onChange={(event) => Object.assign(props.record, { name: event.target.value })}
            />
          </Field>
        </>
      ) : (
        <>
          <dl className="mr-detail-list">
            <div className="mr-detail-list__item">
              <dt>邮箱</dt>
              <dd className="mr-mono">{String(props.record.email ?? '—')}</dd>
            </div>
            <div className="mr-detail-list__item">
              <dt>加入时间</dt>
              <dd className="mr-mono">{formatDateTime(String(props.record.createdAt ?? ''))}</dd>
            </div>
          </dl>

          <h3 className="mr-drawer__section">有效会话</h3>
          {sessions.isPending ? <LoadingBlock rows={2} /> : null}
          {sessions.data && sessions.data.length === 0 ? <p className="mr-muted-note">当前没有有效会话。</p> : null}
          <ul className="mr-session-list">
            {(sessions.data ?? []).map((session: ApplicationSession) => (
              <li key={session.id}>
                <div>
                  <span className="mr-mono">{session.id.slice(0, 12)}</span>
                  <span className="mr-meta">
                    {session.status} · 最近使用 {session.lastUsedAt ? formatMoment(session.lastUsedAt) : '—'} · 到期{' '}
                    {formatDateTime(session.expiresAt)}
                  </span>
                </div>
                <Button size="small" onClick={() => void revoke(session.id)} loading={busy}>
                  撤销
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}

      <Field label={isNew ? '初始密码' : '重设密码'} hint="至少 8 个字符，只保存在本地。">
        <Input.Password value={password} onChange={(event) => setPassword(event.target.value)} />
      </Field>
      {!isNew ? (
        <Button onClick={() => void resetPassword()} loading={busy} disabled={password.length < 8}>
          保存新密码
        </Button>
      ) : null}

      {saved ? <Notice tone="success">已保存。</Notice> : null}
      {error ? <Notice tone="danger">{errorMessage(error)}</Notice> : null}
    </Drawer>
  )
}

function AuthTab(props: { collection: CollectionSummary }) {
  const queryClient = useQueryClient()
  const config = useQuery({
    queryKey: appAuthKeys.config(props.collection.id),
    queryFn: () => appAuthApi.authentication(props.collection.id),
  })
  const [draft, setDraft] = useState<AuthConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState<string | null>(null)

  if (config.isPending) {
    return <LoadingBlock rows={4} />
  }
  if (config.isError) {
    return <ErrorState error={config.error} title="认证配置读不到" onRetry={() => void config.refetch()} />
  }

  const state = config.data!
  const current = draft ?? state.pending
  const update = (patch: Partial<AuthConfig>) => setDraft({ ...current, ...patch })

  const save = async (apply: boolean) => {
    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      await appAuthApi.saveAuthentication(props.collection.id, state.version, current)
      if (apply) {
        await appAuthApi.applyAuthentication(props.collection.id, state.version + 1)
        setSaved('已应用到认证配置')
      } else {
        setSaved('已保存，尚未应用')
      }
      setDraft(null)
      void queryClient.invalidateQueries({ queryKey: appAuthKeys.config(props.collection.id) })
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mr-auth-config">
      <div className="mr-auth-config__row">
        <div>
          <span className="mr-auth-config__label">邮箱密码登录</span>
          <span className="mr-meta">关闭后应用用户无法用邮箱密码登录。</span>
        </div>
        <Switch checked={current.emailPasswordEnabled} onChange={(checked) => update({ emailPasswordEnabled: checked })} />
      </div>

      <div className="mr-auth-config__row">
        <div>
          <span className="mr-auth-config__label">允许自助注册</span>
          <span className="mr-meta">开启后任何人都能通过应用 API 注册。</span>
        </div>
        <Switch checked={current.selfRegistration} onChange={(checked) => update({ selfRegistration: checked })} />
      </div>

      <Field label="会话有效期（天）">
        <InputNumber
          min={1}
          max={365}
          value={current.sessionDurationDays}
          onChange={(value) => update({ sessionDurationDays: Number(value ?? 7) })}
        />
      </Field>

      <Field label="邮箱验证">
        <Select
          value={current.emailVerification}
          options={[
            { value: 'off', label: '不验证' },
            { value: 'optional', label: '可选' },
            { value: 'required', label: '必须验证' },
          ]}
          onChange={(value: 'off' | 'optional' | 'required') => update({ emailVerification: value })}
        />
      </Field>

      <Notice tone="warning">
        改动先保存为待应用配置，应用后才会影响登录行为。当前已应用版本 v{state.version}。
      </Notice>

      <div className="mr-auth-config__actions">
        <Button onClick={() => void save(false)} loading={busy}>
          保存
        </Button>
        <Button type="primary" onClick={() => void save(true)} loading={busy}>
          保存并应用
        </Button>
      </div>

      {saved ? <Notice tone="success">{saved}</Notice> : null}
      {error ? <Notice tone="danger">{errorMessage(error)}</Notice> : null}
    </div>
  )
}

