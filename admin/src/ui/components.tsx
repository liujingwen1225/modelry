import type { ReactNode } from 'react'
import { Button, Flex, Skeleton, Tooltip } from 'antd'
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  CopyOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { ApiError, errorMessage } from '@/api/client'
import './ui.css'

/**
 * Figma 业务组件层。
 *
 * 这里只实现 Figma 特有的业务组合（页面标题、区块、状态标签、就地反馈、空态、错误态）；
 * 基础交互控件一律使用 Ant Design，并在 ui/index.ts 统一出口。
 */

export type PageHeaderProps = {
  title: ReactNode
  description?: ReactNode
  /** 标题右上方的时间、日期或计数。 */
  meta?: ReactNode
  extra?: ReactNode
  back?: { label: string; onClick: () => void }
}

export function PageHeader(props: PageHeaderProps) {
  return (
    <header className="mr-page-header">
      {props.back ? (
        <Button
          type="text"
          size="small"
          className="mr-page-header__back"
          icon={<ArrowLeftOutlined />}
          onClick={props.back.onClick}
        >
          {props.back.label}
        </Button>
      ) : null}
      <div className="mr-page-header__row">
        <div className="mr-page-header__text">
          <h1 className="mr-page-header__title">{props.title}</h1>
          {props.description ? <p className="mr-page-header__description">{props.description}</p> : null}
        </div>
        <div className="mr-page-header__aside">
          {props.meta ? <span className="mr-page-header__meta">{props.meta}</span> : null}
          {props.extra ? <Flex gap={8}>{props.extra}</Flex> : null}
        </div>
      </div>
    </header>
  )
}

export type SectionHeadingProps = {
  title: ReactNode
  meta?: ReactNode
  action?: ReactNode
  level?: 'section' | 'sub'
}

export function SectionHeading(props: SectionHeadingProps) {
  return (
    <div className={`mr-section-heading mr-section-heading--${props.level ?? 'section'}`}>
      <span className="mr-section-heading__title">{props.title}</span>
      <span className="mr-section-heading__meta">
        {props.meta}
        {props.action}
      </span>
    </div>
  )
}

export function Panel(props: { children: ReactNode; className?: string; padded?: boolean }) {
  return <section className={`mr-panel${props.padded === false ? ' mr-panel--flush' : ''} ${props.className ?? ''}`}>{props.children}</section>
}

export type NoticeTone = 'neutral' | 'success' | 'warning' | 'danger'

const NOTICE_ICON: Record<NoticeTone, ReactNode> = {
  neutral: <InfoCircleOutlined />,
  success: <CheckCircleOutlined />,
  warning: <WarningOutlined />,
  danger: <ExclamationCircleOutlined />,
}

/** 就地上下文反馈：Figma「上下文反馈」与状态基线中的进度条式提示。 */
export function Notice(props: {
  tone?: NoticeTone
  icon?: ReactNode
  children: ReactNode
  extra?: ReactNode
  className?: string
}) {
  const tone = props.tone ?? 'neutral'
  return (
    <div className={`mr-notice mr-notice--${tone} ${props.className ?? ''}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="mr-notice__icon">{props.icon ?? NOTICE_ICON[tone]}</span>
      <div className="mr-notice__body">{props.children}</div>
      {props.extra ? <div className="mr-notice__extra">{props.extra}</div> : null}
    </div>
  )
}

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'action'

/** Figma 状态标记：2px 7px 内边距、4px 圆角、11px 字号。 */
export function StatusTag(props: { tone?: StatusTone; children: ReactNode; title?: string }) {
  return (
    <span className={`mr-status mr-status--${props.tone ?? 'neutral'}`} title={props.title}>
      {props.children}
    </span>
  )
}

export function Field(props: { label: ReactNode; hint?: ReactNode; error?: ReactNode; required?: boolean; children: ReactNode; className?: string }) {
  // 用 <label> 包住标签与控件：点击标签即聚焦控件，读屏与测试都能按名称找到输入框。
  return (
    <div className={`mr-field ${props.className ?? ''}`}>
      <label className="mr-field__control">
        <span className="mr-field__label">
          {props.label}
          {props.required ? <span className="mr-field__required">*</span> : null}
        </span>
        {props.children}
      </label>
      {props.error ? <span className="mr-field__error">{props.error}</span> : props.hint ? <span className="mr-field__hint">{props.hint}</span> : null}
    </div>
  )
}

/** 空 / 加载 / 成功 / 错误 的独立状态块，对应状态基线画板的四个示例。 */
export function StateBlock(props: {
  tone?: 'neutral' | 'success' | 'danger'
  eyebrow?: ReactNode
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className={`mr-state-block mr-state-block--${props.tone ?? 'neutral'}`}>
      {props.eyebrow ? <span className="mr-state-block__eyebrow">{props.eyebrow}</span> : null}
      {props.icon ? <span className="mr-state-block__icon">{props.icon}</span> : null}
      <span className="mr-state-block__title">{props.title}</span>
      {props.description ? <span className="mr-state-block__description">{props.description}</span> : null}
      {props.children}
      {props.actions ? <div className="mr-state-block__actions">{props.actions}</div> : null}
    </div>
  )
}

export function LoadingBlock(props: { rows?: number; label?: string }) {
  return (
    <div className="mr-loading" aria-live="polite" aria-busy>
      {props.label ? <span className="mr-loading__label">{props.label}</span> : null}
      <Skeleton active title={false} paragraph={{ rows: props.rows ?? 4, width: ['92%', '80%', '86%', '64%'] }} />
    </div>
  )
}

/** 可恢复错误：说明发生了什么、给出下一步，并保留请求 ID 便于排错。 */
export function ErrorState(props: {
  error: unknown
  title?: string
  onRetry?: () => void
  retryLabel?: string
  secondary?: ReactNode
}) {
  const detail = props.error instanceof ApiError ? props.error : undefined
  return (
    <StateBlock
      tone="danger"
      eyebrow="可恢复错误"
      icon={<ExclamationCircleOutlined />}
      title={props.title ?? '暂时无法完成'}
      description={errorMessage(props.error)}
      actions={
        <>
          {props.onRetry ? (
            <Button onClick={props.onRetry} size="small">
              {props.retryLabel ?? '重试'}
            </Button>
          ) : null}
          {props.secondary}
        </>
      }
    >
      {detail?.requestId ? <span className="mr-mono mr-state-block__detail">请求 ID · {detail.requestId}</span> : null}
    </StateBlock>
  )
}

export function Mono(props: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span className={`mr-mono ${props.className ?? ''}`} title={props.title}>
      {props.children}
    </span>
  )
}

export function Meta(props: { children: ReactNode; className?: string }) {
  return <span className={`mr-meta ${props.className ?? ''}`}>{props.children}</span>
}

export function CodeBlock(props: { code: string; label?: string; maxHeight?: number; copyable?: boolean }) {
  return (
    <div className="mr-code">
      <div className="mr-code__bar">
        <span className="mr-code__label">{props.label ?? 'text'}</span>
        {props.copyable === false ? null : (
          <Tooltip title="复制">
            <Button
              size="small"
              type="text"
              icon={<CopyOutlined />}
              aria-label="复制内容"
              onClick={() => void navigator.clipboard?.writeText(props.code)}
            />
          </Tooltip>
        )}
      </div>
      <pre className="mr-code__pre" style={props.maxHeight ? { maxHeight: props.maxHeight } : undefined}>
        <code>{props.code}</code>
      </pre>
    </div>
  )
}

/** 键值对列表：用于属性面板与技术详情，值默认等宽。 */
export function DetailList(props: { items: Array<{ label: ReactNode; value: ReactNode; mono?: boolean } | null> }) {
  return (
    <dl className="mr-detail-list">
      {props.items.filter(Boolean).map((item, index) => (
        <div className="mr-detail-list__item" key={index}>
          <dt>{item?.label}</dt>
          <dd className={item?.mono === false ? undefined : 'mr-mono'}>{item?.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  )
}
