import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Drawer, ErrorState, Field, Input, InputNumber, LoadingBlock, Notice, Select, Switch, Table } from '@/ui'
import type { TableColumnsType } from '@/ui'
import { SearchOutlined } from '@ant-design/icons'
import type { Field as SchemaField } from '@/api/collections'
import { recordsApi } from '@/api/records'
import { appAuthApi, appAuthKeys, type ApplicationSession, type AuthConfig } from '@/api/appauth'
import { errorMessage } from '@/api/client'
import { formatDateTime, formatMoment } from '@/lib/format'
import '@/pages/access/access.css'

/**
 * 认证集合的用户功能工作面（Figma 画板 8 / 9 / 10）。
 *
 * 原本住在独立的「用户与访问」页；按 0011 第 8 节的信息架构决策，
 * 用户与认证收进认证集合页，作为集合的就地标签复用。
 * 应用用户是认证集合的记录，密码与会话由 appauth 管理；
 * 管理面管理员与应用用户完全分离。
 *
 * 用户档案字段来自该集合的 Applied Model，不能硬编码 name / displayName：
 * 后端会按真实字段校验 profile，用户名是建集合时自己定义的。
 */
type AuthCollectionRef = { id: string; name: string; fields?: SchemaField[] }

/** 系统字段与 email 由 appauth 管理，其余是用户可填的档案字段。 */
function profileFields(fields: SchemaField[] = []): SchemaField[] {
  return fields.filter((field) => !field.system && field.name !== 'email')
}

export function UsersTab(props: {
  collection: AuthCollectionRef
  fields: SchemaField[]
  onOpen: (record: Record<string, unknown>) => void
}) {
  const [search, setSearch] = useState('')
  const users = useQuery({
    queryKey: ['app-user-records', props.collection.id],
    queryFn: () => recordsApi.list(props.collection.id, { limit: 100 }),
  })

  const customFields = profileFields(props.fields)
  const primary = customFields[0]?.name

  const rows = useMemo(() => {
    const data = users.data?.data ?? []
    const keyword = search.trim().toLowerCase()
    if (!keyword) {
      return data
    }
    return data.filter((record) =>
      ['email', ...customFields.map((field) => field.name)].some((key) =>
        String(record[key] ?? '').toLowerCase().includes(keyword),
      ),
    )
  }, [search, users.data, customFields])

  const columns: TableColumnsType<Record<string, unknown>> = [
    {
      title: primary ?? '用户',
      dataIndex: primary ?? 'email',
      width: 180,
      render: (_value, record) => (
        <div className="mr-record-cell">
          <span className="mr-record-cell__title">
            {String((primary ? record[primary] : undefined) ?? record.email ?? '')}
          </span>
          <span className="mr-record-cell__snippet">{String(record.id)}</span>
        </div>
      ),
    },
    ...customFields.slice(1).map((field) => ({
      title: field.name,
      dataIndex: field.name,
      render: (value: unknown) => <span className="mr-mono">{String(value ?? '—')}</span>,
    })),
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

export function UserDrawer(props: {
  collection: AuthCollectionRef
  fields: SchemaField[]
  record: Record<string, unknown>
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const recordId = String(props.record.id ?? '')
  const customFields = profileFields(props.fields)
  const [email, setEmail] = useState(String(props.record.email ?? ''))
  const [values, setValues] = useState<Record<string, string>>({})
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
    // 档案字段必须来自集合的 Applied Model；required 字段不能留空。
    const missing = customFields.filter((field) => field.required && !values[field.name]?.trim())
    if (!email.trim() || missing.length > 0) {
      setError(new Error(`请填写邮箱${missing.length ? `与 ${missing.map((field) => field.name).join('、')}` : ''}。`))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const profile: Record<string, unknown> = { email: email.trim() }
      for (const [key, value] of Object.entries(values)) {
        if (value.trim()) profile[key] = value
      }
      await appAuthApi.create(props.collection.id, profile, password)
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

  const displayName = String((primaryName(customFields) ? props.record[primaryName(customFields)!] : '') ?? props.record.email ?? '用户')

  return (
    <Drawer
      open
      onClose={props.onClose}
      width={480}
      rootClassName="mr-drawer"
      title={
        <div className="mr-drawer__title">
          <span className="mr-drawer__heading">{isNew ? '添加应用用户' : displayName}</span>
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
              value={email}
              placeholder="user@example.test"
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          {customFields.map((field) => (
            <Field key={field.name} label={field.name} required={Boolean(field.required)}>
              <Input
                value={values[field.name] ?? ''}
                placeholder={`填写 ${field.name}`}
                onChange={(event) => setValues((previous) => ({ ...previous, [field.name]: event.target.value }))}
              />
            </Field>
          ))}
          {customFields.length === 0 ? (
            <Notice>这个认证集合没有自定义档案字段，创建用户只需要邮箱与初始密码。</Notice>
          ) : null}
        </>
      ) : (
        <>
          <dl className="mr-detail-list">
            <div className="mr-detail-list__item">
              <dt>邮箱</dt>
              <dd className="mr-mono">{String(props.record.email ?? '—')}</dd>
            </div>
            {customFields.map((field) => (
              <div className="mr-detail-list__item" key={field.name}>
                <dt>{field.name}</dt>
                <dd className="mr-mono">{String(props.record[field.name] ?? '—')}</dd>
              </div>
            ))}
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

function primaryName(fields: SchemaField[]): string | undefined {
  return fields[0]?.name
}

export function AuthTab(props: { collection: AuthCollectionRef; fields?: SchemaField[] }) {
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
      // SaveConfiguration 在配置没变化时不产生 pending；此时不能调用 apply（后端会 404）。
      // apply 的 expectedVersion 必须用 save 返回的 version，而不是本地推测值。
      const savedState = await appAuthApi.saveAuthentication(props.collection.id, state.version, current)
      const hasPending = JSON.stringify(savedState.pending) !== JSON.stringify(savedState.applied)
      if (apply) {
        if (!hasPending) {
          setSaved('配置没有变化，当前已应用版本即为最新')
        } else {
          await appAuthApi.applyAuthentication(props.collection.id, savedState.version)
          setSaved('已应用到认证配置')
        }
      } else {
        setSaved(hasPending ? '已保存，尚未应用' : '配置没有变化，无需保存')
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
