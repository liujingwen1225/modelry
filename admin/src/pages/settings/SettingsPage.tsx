import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CloudServerOutlined,
  ExclamationCircleOutlined,
  LockOutlined,
  ReloadOutlined,
  SaveOutlined,
  SettingOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import {
  App,
  Button,
  Descriptions,
  ErrorState,
  Field,
  Input,
  InputNumber,
  LoadingBlock,
  Mono,
  Notice,
  PageHeader,
  Panel,
  SectionHeading,
  Segmented,
  StateBlock,
  StatusTag,
  Table,
  Tag,
  Typography,
  type NoticeTone,
  type StatusTone,
  type TableColumnsType,
} from '@/ui'
import { ApiError, errorMessage } from '@/api/client'
import {
  settingsApi,
  settingsKeys,
  type Setting,
  type SettingsUpdate,
  type SettingSource,
} from '@/api/settings'
import {
  runtimeApi,
  runtimeKeys,
  dataDirectoryLabel,
  projectNameFromPath,
  type Health,
} from '@/api/runtime'
import { formatBytes, formatDateTime, formatMoment } from '@/lib/format'
import { BasicSettingsPanel } from './BasicSettingsPanel'
import './settings.css'

/**
 * 画板 22「设置 · 本地项目」。
 *
 * 两个就地任务标签都连接真实 API：
 *  1. 「基本设置」：GET/PUT /project-preferences 的项目名称、说明、语言、外观与保存反馈；
 *  2. 「本地运行与存储」：复用 /runtime/status、/storage/status 与 /settings 的真实设置项。
 *
 * 不新增 Figma 没有的配置菜单；「数据目录」一律脱敏，不暴露绝对路径。
 */

/** 后端 health.state 的色调映射；未知状态按中性处理，绝不误判为健康。 */
function healthTone(state?: string): StatusTone {
  const value = (state ?? '').toLowerCase()
  if (value === 'ready' || value === 'ok' || value === 'healthy') return 'success'
  if (value === 'error' || value === 'failed' || value === 'down' || value === 'unavailable') return 'danger'
  if (value === 'degraded' || value === 'warning' || value === 'warn' || value === 'starting') return 'warning'
  return 'neutral'
}

function isHealthy(state?: string): boolean {
  const value = (state ?? '').toLowerCase()
  return value === 'ready' || value === 'ok' || value === 'healthy'
}

/** Notice 的 tone 不含 action，把健康色调收敛到 Notice 可用集合。 */
function healthNoticeTone(state?: string): NoticeTone {
  const tone = healthTone(state)
  return tone === 'action' ? 'neutral' : tone
}

function sourceLabel(source: SettingSource): string {
  switch (source) {
    case 'flag':
      return '启动参数（flag）'
    case 'project':
      return '项目配置'
    case 'default':
      return '默认值'
    default:
      return String(source)
  }
}

function toNumber(value: string | number): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 附件目录脱敏：dataDirectoryLabel 在路径缺少 .modelry 段时会回退成原始绝对路径，
 * 这里只允许展示以 ./ 开头的相对标签，其余一律隐藏，绝不把用户绝对路径放到界面上。
 */
function maskedDataDir(path?: string): string {
  if (!path) return '—'
  const label = dataDirectoryLabel(path)
  return label.startsWith('./') ? label : '（路径已隐藏）'
}

/** 401 / 403 的真实反馈文案，供读取与保存两处复用。 */
function permissionHint(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  if (error.status === 401) return '登录状态已失效，请重新登录后重试。'
  if (error.status === 403) return '当前身份无权访问本地项目设置。'
  return null
}

type RuntimeRow = { key: string; label: string; value: ReactNode }
type HealthIssue = { label: string; health: Health }
type Feedback = { tone: NoticeTone; text: string }

/** 健康状态标签：直接显示后端原始 state，颜色由状态推导。 */
function HealthValue(props: { health: Health }) {
  return <StatusTag tone={healthTone(props.health.state)}>{props.health.state || '未知'}</StatusTag>
}

/** 单个 Setting 的真实元信息：value / source / restartRequired / bounds 全部来自后端。 */
function SettingMeta(props: { setting: Setting }) {
  return (
    <Typography.Text type="secondary" className="mr-settings__meta">
      当前生效值 <Mono>{String(props.setting.value)}</Mono>
      {' · 来源 '}
      <Tag>{sourceLabel(props.setting.source)}</Tag>
      {' · '}
      {props.setting.restartRequired ? (
        <StatusTag tone="warning">重启后生效</StatusTag>
      ) : (
        <StatusTag tone="success">即时生效</StatusTag>
      )}
      {' · 取值范围 '}
      <Mono>{props.setting.bounds || '—'}</Mono>
    </Typography.Text>
  )
}

export function SettingsPage() {
  const queryClient = useQueryClient()
  const { message } = App.useApp()

  const settings = useQuery({ queryKey: settingsKeys.detail, queryFn: settingsApi.get })
  // 与 ProjectProvider 共用同一查询键，避免重复请求；页面本身不依赖 Provider 上下文。
  const runtime = useQuery({ queryKey: runtimeKeys.status, queryFn: runtimeApi.status, staleTime: 30_000 })
  const storage = useQuery({ queryKey: runtimeKeys.storage, queryFn: runtimeApi.storage, staleTime: 30_000 })

  const data = settings.data?.data
  const rt = runtime.data
  const st = storage.data

  // 表单草稿只覆盖两个可编辑设置；draftBase 记录草稿基于哪个 revision，避免覆盖未保存的编辑。
  const [listenDraft, setListenDraft] = useState('')
  const [retentionDraft, setRetentionDraft] = useState<number | null>(null)
  const [draftBase, setDraftBase] = useState<number | null>(null)
  const [dirty, setDirty] = useState(false)
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [saveError, setSaveError] = useState<unknown>(null)
  const [section, setSection] = useState<'basic' | 'runtime'>('basic')

  // 服务端数据到达或 revision 变化时把草稿同步到最新生效值；有未保存编辑时保留用户输入。
  useEffect(() => {
    if (!data) return
    if (draftBase === data.revision) return
    if (dirty) return
    setListenDraft(String(data.listenAddress.value ?? ''))
    setRetentionDraft(toNumber(data.requestRetentionDays.value))
    setDraftBase(data.revision)
  }, [data, draftBase, dirty])

  const listenEditable = Boolean(data && data.listenAddress.source !== 'flag')
  const retentionEditable = Boolean(data && data.requestRetentionDays.source !== 'flag')
  const editableCount = Number(listenEditable) + Number(retentionEditable)

  // 前端按已核实契约做轻量校验；后端仍是唯一权威，任何 422 都原样展示。
  const listenError = useMemo(() => {
    const value = listenDraft.trim()
    if (!value) return '监听地址不能为空'
    if (!/^.+:\d{1,5}$/.test(value)) return '格式应为 host:port'
    const port = Number(value.slice(value.lastIndexOf(':') + 1))
    if (!Number.isInteger(port) || port < 0 || port > 65535) return '端口需在 0–65535 之间'
    return null
  }, [listenDraft])

  const retentionError = useMemo(() => {
    if (retentionDraft === null || !Number.isFinite(retentionDraft)) return '请输入保留天数'
    if (!Number.isInteger(retentionDraft)) return '需为整数天数'
    if (retentionDraft < 1 || retentionDraft > 3650) return '需在 1–3650 天之间'
    return null
  }, [retentionDraft])

  const clientErrors = [
    listenEditable && listenError ? `监听地址：${listenError}` : null,
    retentionEditable && retentionError ? `请求保留天数：${retentionError}` : null,
  ].filter((item): item is string => Boolean(item))

  const save = useMutation({
    mutationFn: (body: SettingsUpdate) => settingsApi.update(body),
    onSuccess: async (result) => {
      setDirty(false)
      setSubmitAttempted(false)
      setSaveError(null)
      const text = `设置已保存（修订 ${result.data.revision}）。`
      setFeedback({ tone: 'success', text })
      message.success(text)
      // 用真实 GET 刷新缓存；effect 会按新 revision 把草稿同步到最新生效值。
      await queryClient.invalidateQueries({ queryKey: settingsKeys.detail })
    },
    onError: (error: unknown) => {
      setFeedback(null)
      setSaveError(error)
      message.error(`保存失败：${errorMessage(error)}`)
    },
  })

  const submit = () => {
    if (!data) return
    setSubmitAttempted(true)
    setSaveError(null)
    setFeedback(null)
    if (clientErrors.length > 0) return
    save.mutate({
      expectedRevision: data.revision,
      listenAddress: listenEditable ? listenDraft.trim() : String(data.listenAddress.value),
      requestRetentionDays: retentionEditable ? Number(retentionDraft) : Number(data.requestRetentionDays.value),
    })
  }

  const resetDraft = () => {
    if (!data) return
    setListenDraft(String(data.listenAddress.value ?? ''))
    setRetentionDraft(toNumber(data.requestRetentionDays.value))
    setDraftBase(data.revision)
    setDirty(false)
    setSubmitAttempted(false)
    setSaveError(null)
    setFeedback(null)
  }

  /** 409 / 版本被外部改动后的恢复动作：重新 GET 最新设置并按新 revision 重置草稿。 */
  const reloadLatest = async () => {
    await settings.refetch()
    setDirty(false)
    setSubmitAttempted(false)
    setSaveError(null)
    setFeedback({ tone: 'neutral', text: '已重新读取最新设置，请确认后再保存。' })
  }

  // 保存失败分类：全部基于 ApiError 的真实 status / code，不臆测。
  const saveApiError = saveError instanceof ApiError ? saveError : undefined
  const isConflict = Boolean(saveApiError && (saveApiError.status === 409 || saveApiError.code === 'CONFLICT'))
  const isValidation = Boolean(saveApiError && (saveApiError.status === 422 || saveApiError.code === 'VALIDATION_FAILED'))
  const isForbidden = permissionHint(saveError) !== null
  const hasGenericError = Boolean(saveError) && !isConflict && !isValidation && !isForbidden

  const staleWhileDirty = Boolean(data && draftBase !== null && data.revision !== draftBase && dirty)
  const needsRestart = Boolean(data && (data.listenAddress.restartRequired || data.requestRetentionDays.restartRequired))

  // 「本地运行与存储」面板：Descriptions 放运行时元信息，Table 复刻画板「数据表格」（配置 / 当前值）。
  const runtimeColumns: TableColumnsType<RuntimeRow> = [
    { title: '配置', dataIndex: 'label', key: 'label', width: '42%' },
    { title: '当前值', key: 'value', render: (_value, row) => row.value },
  ]

  const descItems: Array<{ key: string; label: ReactNode; children: ReactNode }> = []
  if (rt) {
    descItems.push(
      { key: 'state', label: '运行状态', children: <StatusTag tone={healthTone(rt.state)}>{rt.state || '未知'}</StatusTag> },
      { key: 'version', label: '版本', children: <Mono>{rt.version || '—'}</Mono> },
      { key: 'observedAt', label: '观察时间', children: <Mono>{formatDateTime(rt.observedAt)}</Mono> },
      { key: 'projectSource', label: '项目来源', children: <Mono>{rt.projectSource || '—'}</Mono> },
      { key: 'projectName', label: '项目名称', children: <Mono>{projectNameFromPath(st?.localStorage.path)}</Mono> },
      { key: 'runtimeDb', label: '运行时·数据库', children: <StatusTag tone={healthTone(rt.database.state)}>{rt.database.state || '未知'}</StatusTag> },
      { key: 'runtimeLocal', label: '运行时·本地存储', children: <StatusTag tone={healthTone(rt.localStorage.state)}>{rt.localStorage.state || '未知'}</StatusTag> },
    )
  }
  if (data) {
    descItems.push({ key: 'listenSource', label: '监听地址来源', children: <Tag>{sourceLabel(data.listenAddress.source)}</Tag> })
  }

  const runtimeRows: RuntimeRow[] = []
  if (data) {
    runtimeRows.push({ key: 'listen', label: '访问地址', value: <Mono>{String(data.listenAddress.value)}</Mono> })
  }
  if (st) {
    runtimeRows.push(
      { key: 'database', label: '数据库', value: <HealthValue health={st.database} /> },
      { key: 'localStorage', label: '本地存储', value: <HealthValue health={st.localStorage} /> },
      { key: 'fileStorage', label: '文件存储', value: <HealthValue health={st.fileStorage} /> },
      {
        key: 'provider',
        label: '当前 provider',
        value: <Mono>{st.fileStorage.activeProvider || st.fileStorage.provider || st.localStorage.provider || '—'}</Mono>,
      },
      {
        key: 'size',
        label: '数据库大小',
        value: st.databaseSizeBytes != null ? <Mono>{formatBytes(st.databaseSizeBytes)}</Mono> : '—',
      },
      { key: 'dir', label: '附件目录', value: <Mono>{maskedDataDir(st.localStorage.path)}</Mono> },
    )
  }

  // 健康异常：用 Notice 展示后端真实 message 与 hint（恢复路径）。
  const healthIssues: HealthIssue[] = []
  if (rt && !isHealthy(rt.state)) {
    healthIssues.push({ label: '本地运行时', health: { state: rt.state, message: rt.database.message, hint: rt.database.hint } })
  }
  if (st) {
    if (!isHealthy(st.database.state)) healthIssues.push({ label: '数据库', health: st.database })
    if (!isHealthy(st.localStorage.state)) healthIssues.push({ label: '本地存储', health: st.localStorage })
    if (!isHealthy(st.fileStorage.state)) healthIssues.push({ label: '文件存储', health: st.fileStorage })
  } else if (rt) {
    if (!isHealthy(rt.database.state)) healthIssues.push({ label: '数据库', health: rt.database })
    if (!isHealthy(rt.localStorage.state)) healthIssues.push({ label: '本地存储', health: rt.localStorage })
  }

  const reloadButton = (
    <Button size="small" icon={<ReloadOutlined />} onClick={() => void reloadLatest()}>
      重新读取最新设置
    </Button>
  )

  /** 「设置项」区块内容：加载 / 错误 / 无权限 / 只读 / 可编辑 的真实反馈。 */
  const renderSettingsContent = (): ReactNode => {
    if (settings.isPending) return <LoadingBlock rows={5} label="正在读取本地项目设置…" />
    if (settings.isError) {
      return (
        <>
          {permissionHint(settings.error) ? <Notice tone="danger">{permissionHint(settings.error)}</Notice> : null}
          <ErrorState
            error={settings.error}
            title={permissionHint(settings.error) ? '没有读取设置的权限' : '设置暂时读不到'}
            onRetry={() => void settings.refetch()}
            retryLabel="重新读取"
          />
        </>
      )
    }
    if (!data) {
      return <StateBlock tone="neutral" title="暂无设置数据" description="后端没有返回设置内容，请稍后重试。" />
    }

    return (
      <>
        {feedback ? <Notice tone={feedback.tone}>{feedback.text}</Notice> : null}

        {staleWhileDirty ? (
          <Notice tone="warning" extra={reloadButton}>
            设置已在别处更新（当前修订 {data.revision}，草稿基于修订 {draftBase}）。直接保存可能冲突，请重新读取最新设置。
          </Notice>
        ) : null}

        {isConflict ? (
          <Notice tone="warning" extra={reloadButton}>
            保存未生效：设置已被其他操作更新（expectedRevision 不匹配，409 CONFLICT）。请重新读取最新设置后再修改，避免覆盖他人改动。
          </Notice>
        ) : null}

        {isValidation ? (
          <Notice tone="danger" icon={<ExclamationCircleOutlined />}>
            后端校验未通过（{saveApiError?.code || 'VALIDATION_FAILED'}）：{errorMessage(saveError)}
            {saveApiError?.requestId ? ` · 请求 ID ${saveApiError.requestId}` : ''}
          </Notice>
        ) : null}

        {isForbidden ? (
          <Notice tone="danger" icon={<LockOutlined />}>
            {permissionHint(saveError)} {errorMessage(saveError)}
          </Notice>
        ) : null}

        {hasGenericError ? <Notice tone="danger">保存失败：{errorMessage(saveError)}</Notice> : null}

        {needsRestart ? (
          <Notice tone="warning" icon={<SyncOutlined />}>
            有设置需要重启本地实例后才会生效：当前页面显示的是已保存值，重启前运行时仍沿用旧配置。
          </Notice>
        ) : null}

        {editableCount === 0 ? (
          <StateBlock
            tone="neutral"
            eyebrow="只读状态"
            icon={<LockOutlined />}
            title="没有可编辑的设置"
            description="两项设置均由启动参数（flag）覆盖，界面不可编辑。请在启动参数中调整后重启本地实例。"
          />
        ) : (
          <>
            <Field
              label="监听地址"
              required={listenEditable}
              hint={`host:port（端口 0–65535） · 后端范围 ${data.listenAddress.bounds || '—'}`}
              error={submitAttempted && listenEditable ? listenError ?? undefined : undefined}
            >
              <Input
                value={listenDraft}
                disabled={!listenEditable || save.isPending}
                onChange={(event) => {
                  setListenDraft(event.target.value)
                  setDirty(true)
                  setFeedback(null)
                }}
              />
            </Field>
            <SettingMeta setting={data.listenAddress} />
            {data.listenAddress.source === 'flag' ? (
              <Notice tone="warning" icon={<LockOutlined />}>
                监听地址由启动参数（flag）覆盖，界面不可编辑。要修改请在启动参数中调整并重启本地实例。
              </Notice>
            ) : null}

            <div className="mr-settings__divider" />

            <Field
              label="请求保留天数"
              required={retentionEditable}
              hint={`请求日志保留天数 · 后端范围 ${data.requestRetentionDays.bounds || '—'}`}
              error={submitAttempted && retentionEditable ? retentionError ?? undefined : undefined}
            >
              <InputNumber
                value={retentionDraft}
                min={1}
                max={3650}
                step={1}
                precision={0}
                disabled={!retentionEditable || save.isPending}
                onChange={(value) => {
                  setRetentionDraft(value === null ? null : Number(value))
                  setDirty(true)
                  setFeedback(null)
                }}
              />
            </Field>
            <SettingMeta setting={data.requestRetentionDays} />
            {data.requestRetentionDays.source === 'flag' ? (
              <Notice tone="warning" icon={<LockOutlined />}>
                请求保留天数由启动参数（flag）覆盖，界面不可编辑。要修改请在启动参数中调整并重启本地实例。
              </Notice>
            ) : null}

            <div className="mr-settings__savebar">
              <span className="mr-settings__saved">
                {data.updatedAt ? `上次保存 ${formatMoment(data.updatedAt)}` : '尚无保存记录'} · 修订 {data.revision}
              </span>
              <div className="mr-settings__actions">
                <Button disabled={save.isPending || !dirty} onClick={resetDraft}>
                  取消
                </Button>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={save.isPending}
                  disabled={editableCount === 0 || save.isPending}
                  onClick={submit}
                >
                  保存设置
                </Button>
              </div>
            </div>
          </>
        )}
      </>
    )
  }

  return (
    <div className="mr-page mr-settings">
      <PageHeader
        title="设置"
        description="本项目的本地配置。一个实例对应一个项目，数据始终保存在你的设备上。"
        meta={data?.updatedAt ? `上次保存 ${formatMoment(data.updatedAt)}` : undefined}
      />

      <div className="mr-settings__tabs">
        <Segmented
          value={section}
          onChange={(value) => setSection(value as 'basic' | 'runtime')}
          options={[
            { value: 'basic', label: '基本设置' },
            { value: 'runtime', label: '本地运行与存储' },
          ]}
        />
      </div>

      <div className="mr-settings__grid">
        {/* 左：画板「项目设置表单」位置；两个标签各自连接真实 API */}
        <section className="mr-settings__main">
          <Panel className="mr-settings__panel">
            <SectionHeading
              title={
                <span>
                  <SettingOutlined className="mr-settings__heading-icon" />{' '}
                  {section === 'basic' ? '基本设置' : '设置项'}
                </span>
              }
              meta={section === 'runtime' && data ? `修订 ${data.revision}` : undefined}
            />
            <div className="mr-settings__body">
              {section === 'basic' ? <BasicSettingsPanel /> : renderSettingsContent()}
            </div>
          </Panel>
        </section>

        {/* 右：本地运行与存储（画板「本地实例说明」390px 信息面板） */}
        <aside className="mr-settings__aside">
          <Panel className="mr-settings__panel">
            <SectionHeading
              title={
                <span>
                  <CloudServerOutlined className="mr-settings__heading-icon" /> 本地运行与存储
                </span>
              }
              meta={rt ? <StatusTag tone={healthTone(rt.state)}>{rt.state || '未知'}</StatusTag> : undefined}
            />

            {runtime.isError ? (
              <Notice
                tone="danger"
                extra={
                  <Button size="small" onClick={() => void runtime.refetch()}>
                    重试
                  </Button>
                }
              >
                运行时状态读取失败：{errorMessage(runtime.error)}
              </Notice>
            ) : null}
            {storage.isError ? (
              <Notice
                tone="danger"
                extra={
                  <Button size="small" onClick={() => void storage.refetch()}>
                    重试
                  </Button>
                }
              >
                存储状态读取失败：{errorMessage(storage.error)}
              </Notice>
            ) : null}

            {runtime.isPending && !rt ? (
              <LoadingBlock rows={4} label="正在读取运行时状态…" />
            ) : rt ? (
              <Descriptions bordered size="small" column={1} items={descItems} className="mr-settings__desc" />
            ) : !runtime.isError ? (
              <Notice tone="neutral">运行时状态暂时不可用。</Notice>
            ) : null}

            {storage.isPending && !st ? (
              <LoadingBlock rows={4} label="正在读取存储状态…" />
            ) : st ? (
              <Table<RuntimeRow>
                rowKey="key"
                size="small"
                pagination={false}
                columns={runtimeColumns}
                dataSource={runtimeRows}
                className="mr-settings__table"
                locale={{ emptyText: '暂无存储状态数据' }}
              />
            ) : !storage.isError ? (
              <Notice tone="neutral">存储状态暂时不可用。</Notice>
            ) : null}

            {healthIssues.length > 0 ? (
              <div className="mr-settings__health">
                {healthIssues.map((item) => (
                  <Notice key={item.label} tone={healthNoticeTone(item.health.state)}>
                    <strong>{item.label}</strong>：{item.health.state}
                    {item.health.message ? ` · ${item.health.message}` : ''}
                    {item.health.hint ? `。恢复路径：${item.health.hint}` : ''}
                  </Notice>
                ))}
              </div>
            ) : null}

            <div className="mr-settings__notes">
              <p>停止本地进程后 API 将不可用；重新运行同一程序并使用原数据目录，可继续使用已有数据。</p>
              <div className="mr-settings__divider" />
              <strong>保留你的本地数据</strong>
              <p>复制数据目录前先停止实例，数据库与附件目录需要一并保留。这里不会自动上传或同步你的数据。</p>
            </div>
          </Panel>
        </aside>
      </div>

      <footer className="mr-settings__footnote">
        <span>本地项目 · 数据保存在你的设备上</span>
        <span>设置与运行信息均来自本地实例</span>
      </footer>
    </div>
  )
}
