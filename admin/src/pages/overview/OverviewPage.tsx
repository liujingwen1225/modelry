import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import {
  ArrowRightOutlined,
  CheckCircleFilled,
  CodeOutlined,
  ExclamationCircleOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  TableOutlined,
} from '@ant-design/icons'
import { Button } from '@/ui'
import { ErrorState, LoadingBlock, Notice, SectionHeading, StatusTag } from '@/ui'
import { auditApi, auditKeys } from '@/api/audit'
import type { AuditRecord } from '@/api/audit'
import type { OverviewSnapshot, RecentCollection } from '@/api/overview'
import { useProject } from '@/app/ProjectProvider'
import { useBreadcrumbTail } from '@/app/BreadcrumbContext'
import { auditActorLabel, auditTitle, auditResourceLabel } from '@/lib/audit-text'
import { attachName, formatCount, formatLongDate, formatMoment } from '@/lib/format'
import { EmptyProjectView } from './EmptyProjectView'
import './overview.css'

/**
 * 概览 · 继续工作（Figma #15:10749）。
 *
 * 数据来自 /overview 聚合与 /audit；空项目状态复用同一路由，对应「首次进入 · 空项目」画板。
 * 没有真实数据时给出可执行的下一步，不摆放示例内容。
 */
export function OverviewPage() {
  useBreadcrumbTail([])
  const navigate = useNavigate()
  const project = useProject()
  const snapshot = project.overview

  const audit = useQuery({
    queryKey: auditKeys.list(6),
    queryFn: () => auditApi.list({ limit: 6 }),
    enabled: Boolean(snapshot),
    staleTime: 15_000,
  })

  if (!snapshot) {
    if (project.runtime?.state && project.runtime.state !== 'ready') {
      return (
        <div className="mr-page">
          <ErrorState
            error={new Error(project.runtime.database.message ?? '本地实例还在启动，请稍后重试。')}
            title="本地实例尚未就绪"
            onRetry={() => window.location.reload()}
          />
        </div>
      )
    }
    return (
      <div className="mr-page">
        <LoadingBlock rows={6} label="正在读取本地项目…" />
      </div>
    )
  }

  if (snapshot.collections?.count === 0) {
    return <EmptyProjectView snapshot={snapshot} />
  }

  return (
    <div className="mr-page">
      <header className="mr-overview__heading">
        <div className="mr-overview__heading-text">
          <h1 className="mr-overview__title">继续工作</h1>
          <p className="mr-overview__lede">{attachName(project.name, '的工作现场，一切从这里接着。')}</p>
        </div>
        <span className="mr-overview__date">{formatLongDate()}</span>
      </header>

      <HealthStrip healthy={project.healthy} port={project.port} storage={project.storage?.localStorage.state} />

      <ResumeSection recent={snapshot.collections?.recent?.[0]} onOpen={(id) => navigate(`/data/${id}`)} onBrowse={() => navigate('/data')} />

      <div className="mr-overview__split">
        <RecentSection
          records={audit.data?.data ?? []}
          loading={audit.isPending}
          failed={audit.isError}
          onOpenAll={() => navigate('/changes')}
          onRetry={() => void audit.refetch()}
        />
        <AttentionSection snapshot={snapshot} navigate={navigate} />
      </div>

      <div className="mr-overview__divider" />

      <section className="mr-overview__next">
        <SectionHeading title="下一步" />
        <div className="mr-next-actions">
          <QuickAction
            icon={<PlusOutlined />}
            title="创建集合"
            description="定义应用里的下一种数据"
            onClick={() => navigate('/data')}
          />
          <QuickAction
            icon={<CodeOutlined />}
            title={`使用 ${snapshot.collections?.recent?.[0]?.name ?? '集合'} API`}
            description="复制本地请求，开始连接应用"
            onClick={() => navigate('/developer')}
          />
          <QuickAction
            icon={<SafetyCertificateOutlined />}
            title="验证访问"
            description="确认不同身份能看见什么"
            onClick={() => navigate('/access')}
          />
        </div>
      </section>

      <footer className="mr-page__footnote">
        <span>本地项目 · 数据保存在你的设备上</span>
        <span>单实例 / 单项目{releaseVersion(project.runtime?.version)}</span>
      </footer>
    </div>
  )
}

/** 只有形如 v0.1.0 的构建版本才展示；开发构建的 dev 标记对用户没有意义。 */
function releaseVersion(version?: string): string {
  return version && /^v\d/.test(version) ? ` · ${version}` : ''
}

function HealthStrip(props: { healthy: boolean; port: string; storage?: string }) {
  const healthy = props.healthy
  return (
    <div className={`mr-health${healthy ? '' : ' mr-health--warn'}`}>
      <div className="mr-health__state">
        {healthy ? <CheckCircleFilled className="mr-health__icon" /> : <ExclamationCircleOutlined className="mr-health__icon" />}
        <span className="mr-health__title">{healthy ? '本地实例可用' : '本地实例需要注意'}</span>
        <span className="mr-health__detail">{healthy ? '数据与 API 正常响应' : '部分能力暂时不可用，请查看设置'}</span>
      </div>
      <div className="mr-health__meta">
        <span className="mr-mono">localhost:{props.port}</span>
        <span>SQLite · {props.storage === 'ready' ? '本地存储' : '存储状态未知'}</span>
        <span>单实例 / 单项目</span>
      </div>
    </div>
  )
}

function resumeStatus(collection?: RecentCollection) {
  switch (collection?.pendingChangeStatus) {
    case 'needsReview':
      return <StatusTag tone="warning">待审阅</StatusTag>
    case 'ready':
      return <StatusTag tone="warning">待应用</StatusTag>
    case 'failed':
      return <StatusTag tone="danger">变更失败</StatusTag>
    default:
      return null
  }
}

function resumeDescription(collection: RecentCollection): string {
  switch (collection.pendingChangeStatus) {
    case 'needsReview':
      return '结构变更正在等待审阅，确认并应用后才会生效。'
    case 'ready':
      return '结构变更已就绪，应用后新结构才会生效。'
    case 'failed':
      return '上一次结构变更没有应用成功，需要处理后重新应用。'
    default:
      return `结构与访问规则已同步，可以继续维护 ${collection.name} 的记录。`
  }
}

function ResumeSection(props: { recent?: RecentCollection; onOpen: (id: string) => void; onBrowse: () => void }) {
  const recent = props.recent
  return (
    <section className="mr-resume">
      <SectionHeading title="上次工作" meta={recent ? formatMoment(recent.updatedAt) : undefined} />
      {recent ? (
        <div className="mr-resume__card">
          <span className="mr-resume__emblem" aria-hidden>
            <TableOutlined />
          </span>
          <div className="mr-resume__context">
            <div className="mr-resume__name-row">
              <span className="mr-resume__name">{recent.name}</span>
              {resumeStatus(recent)}
            </div>
            <p className="mr-resume__description">{resumeDescription(recent)}</p>
            <span className="mr-resume__meta">
              记录 {formatCount(recent.recordCount)} · 字段 {formatCount(recent.fieldCount)} · 关系 {formatCount(recent.relationCount)} · API
            </span>
          </div>
          <Button type="primary" icon={<ArrowRightOutlined />} onClick={() => props.onOpen(recent.id)}>
            继续配置
          </Button>
        </div>
      ) : (
        <div className="mr-resume__card mr-resume__card--empty">
          <div className="mr-resume__context">
            <p className="mr-resume__description">还没有可以接着做的集合。</p>
            <span className="mr-resume__meta">先定义一种数据，再添加第一条记录。</span>
          </div>
          <Button type="primary" onClick={props.onBrowse}>
            打开数据
          </Button>
        </div>
      )}
    </section>
  )
}

function RecentSection(props: {
  records: AuditRecord[]
  loading: boolean
  failed: boolean
  onOpenAll: () => void
  onRetry: () => void
}) {
  return (
    <section className="mr-recent">
      <SectionHeading
        title="最近发生"
        action={
          <Button type="link" size="small" className="mr-inline-link" onClick={props.onOpenAll}>
            查看全部 →
          </Button>
        }
      />
      <div className="mr-divider-line" />
      {props.loading ? <LoadingBlock rows={4} label="正在读取最近操作…" /> : null}
      {props.failed ? <Notice tone="danger">最近操作暂时读不到，可稍后重试。</Notice> : null}
      {!props.loading && !props.failed && props.records.length === 0 ? (
        <p className="mr-muted-note">还没有记录到操作。创建集合或修改记录后会出现在这里。</p>
      ) : null}
      <ul className="mr-recent__list">
        {props.records.map((record) => (
          <li className="mr-recent__item" key={record.id}>
            <span className="mr-recent__symbol" aria-hidden>
              {record.result === 'failure' ? <ExclamationCircleOutlined /> : <TableOutlined />}
            </span>
            <div className="mr-recent__text">
              <span className="mr-recent__title">{auditTitle(record)}</span>
              <span className="mr-recent__detail">
                {auditActorLabel(record)} · {auditResourceLabel(record.resource.kind)}
              </span>
            </div>
            <span className="mr-recent__time">{formatMoment(record.time)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

type Attention = {
  key: string
  tag: string
  title: string
  detail: string
  action: string
  path: string
}

function attentionItems(snapshot: OverviewSnapshot): Attention[] {
  const items: Attention[] = []
  const requests = snapshot.requests
  if (requests && requests.serverErrorCount > 0) {
    items.push({
      key: 'server-errors',
      tag: '5xx',
      title: `${formatCount(requests.serverErrorCount)} 次请求返回服务端错误`,
      detail: `最近 ${Math.round(requests.windowSeconds / 60)} 分钟内 · 应用侧调用没有得到结果。`,
      action: '查看请求日志 →',
      path: '/developer',
    })
  }
  if (requests && requests.clientErrorCount > 0) {
    items.push({
      key: 'client-errors',
      tag: '4xx',
      title: `${formatCount(requests.clientErrorCount)} 次请求被拒绝`,
      detail: `最近 ${Math.round(requests.windowSeconds / 60)} 分钟内 · 可能是身份或访问规则拦住了调用。`,
      action: '验证访问规则 →',
      path: '/access',
    })
  }
  if (snapshot.events && snapshot.events.failedDeliveryCount > 0) {
    items.push({
      key: 'failed-deliveries',
      tag: '失败',
      title: `${formatCount(snapshot.events.failedDeliveryCount)} 次投递没有成功`,
      detail: 'Webhook 或事件钩子的投递失败，历史记录仍保留，可以重试。',
      action: '查看执行记录 →',
      path: '/logic',
    })
  }
  if (snapshot.changes && snapshot.changes.failedCount > 0) {
    items.push({
      key: 'failed-changes',
      tag: '失败',
      title: `${formatCount(snapshot.changes.failedCount)} 项变更处于失败状态`,
      detail: '失败的结构变更需要修正后重新应用。',
      action: '打开变更中心 →',
      path: '/changes',
    })
  }
  return items
}

function AttentionSection(props: { snapshot: OverviewSnapshot; navigate: (path: string) => void }) {
  const items = attentionItems(props.snapshot)
  return (
    <section className="mr-attention">
      <SectionHeading title="需要处理" meta={items.length > 0 ? `${items.length} 项` : undefined} />
      <div className="mr-divider-line" />
      {items.length === 0 ? (
        <p className="mr-muted-note">没有需要立即处理的问题。请求、投递和变更都处于正常状态。</p>
      ) : (
        <ul className="mr-attention__list">
          {items.map((item) => (
            <li className="mr-attention__item" key={item.key}>
              <div className="mr-attention__head">
                <StatusTag tone="danger">{item.tag}</StatusTag>
                <span className="mr-attention__title">{item.title}</span>
              </div>
              <p className="mr-attention__detail">{item.detail}</p>
              <Button type="link" size="small" className="mr-inline-link" onClick={() => props.navigate(item.path)}>
                {item.action}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function QuickAction(props: { icon: ReactNode; title: string; description: string; onClick: () => void }) {
  return (
    <Button type="text" className="mr-quick-action" onClick={props.onClick}>
      <span className="mr-quick-action__icon">{props.icon}</span>
      <span className="mr-quick-action__text">
        <span className="mr-quick-action__title">{props.title}</span>
        <span className="mr-quick-action__description">{props.description}</span>
      </span>
      <ArrowRightOutlined className="mr-quick-action__arrow" />
    </Button>
  )
}

// 让页面在概览请求失败时也能给出可恢复路径，而不是空白内容。
export function OverviewErrorFallback(props: { error: unknown; onRetry: () => void }) {
  return (
    <div className="mr-page">
      <ErrorState error={props.error} onRetry={props.onRetry} title="概览暂时读不到" />
    </div>
  )
}
