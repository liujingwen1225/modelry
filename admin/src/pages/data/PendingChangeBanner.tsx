import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Button, Notice } from '@/ui'
import { PullRequestOutlined } from '@ant-design/icons'
import { collectionsApi, collectionKeys } from '@/api/collections'
import { errorMessage } from '@/api/client'
import { formatMoment } from '@/lib/format'

const RISK_LABELS: Record<string, string> = { safe: '安全', review: '需要确认', blocked: '被阻塞' }

/**
 * 待应用变更提示条（Figma 顶部黄色提醒）。
 *
 * 结构改动先进入待应用变更，用户确认后才会写入真实结构；
 * 这里只做最小闭环：查看差异、应用、放弃，全部走现有 Contract。
 */
export function PendingChangeBanner(props: { collectionId: string }) {
  const queryClient = useQueryClient()
  const { message } = App.useApp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [summary, setSummary] = useState<string | null>(null)

  const pending = useQuery({
    queryKey: collectionKeys.pending(props.collectionId),
    queryFn: () => collectionsApi.pendingChange(props.collectionId),
  })

  const change = pending.data
  if (!change || change.operations.length === 0) {
    return null
  }

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: collectionKeys.pending(props.collectionId) })
    void queryClient.invalidateQueries({ queryKey: collectionKeys.detail(props.collectionId) })
    void queryClient.invalidateQueries({ queryKey: collectionKeys.list })
  }

  const apply = async () => {
    setBusy(true)
    setError(null)
    try {
      const preview = await collectionsApi.preview(props.collectionId, change.version)
      setSummary(`${preview.impact.summary} · 风险 ${RISK_LABELS[preview.risk]}`)
      if (preview.risk === 'blocked') {
        throw new Error('当前变更被现有数据阻塞，请先处理预检里列出的前置条件。')
      }
      // 风险为 review 时契约要求显式确认；差异与风险已在上方提示条中展示。
      await collectionsApi.apply(props.collectionId, change.version, preview.risk === 'review')
      setSummary('变更已写入结构')
      // 应用后 pending 消失会让本组件立即卸载；全局反馈保证成功结果仍然可见。
      message.success('已应用，结构已更新')
      refresh()
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
    }
  }

  const discard = async () => {
    setBusy(true)
    setError(null)
    try {
      await collectionsApi.discard(props.collectionId, change.version)
      refresh()
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mr-pending">
      <div className="mr-pending__row">
        <PullRequestOutlined className="mr-pending__icon" />
        <span className="mr-pending__text">
          {change.operations.length} 项结构变更待应用 · 更新于 {formatMoment(change.updatedAt)}
        </span>
        <div className="mr-pending__actions">
          <Button size="small" type="text" onClick={() => void discard()} loading={busy}>
            放弃
          </Button>
          <Button size="small" type="primary" onClick={() => void apply()} loading={busy}>
            应用到结构
          </Button>
        </div>
      </div>
      {summary ? <span className="mr-pending__summary">{summary}</span> : null}
      {error ? <Notice tone="danger">{errorMessage(error)}</Notice> : null}
    </div>
  )
}
