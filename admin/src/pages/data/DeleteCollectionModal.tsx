import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { App, Button, Field, Input, Modal, Notice, Table } from '@/ui'
import type { TableColumnsType } from '@/ui'
import { WarningOutlined } from '@ant-design/icons'
import { collectionKeys, collectionsApi } from '@/api/collections'
import { recordKeys, recordsApi } from '@/api/records'
import { errorMessage } from '@/api/client'
import { useData } from './DataContext'

type ImpactRow = {
  key: string
  resource: string
  result: string
}

/**
 * Figma「数据 · 删除集合确认」。
 *
 * 所有影响数字都来自真实 API（集合列表计数、记录、待应用变更），
 * 删除请求带集合名称确认，成功后刷新集合与记录查询并回到数据首页。
 */
export function DeleteCollectionModal(props: {
  open: boolean
  collectionId: string
  collectionName: string
  onClose: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { message } = App.useApp()
  const { collections } = useData()
  const [confirmName, setConfirmName] = useState('')

  const recordQuery = useQuery({
    queryKey: recordKeys.list(props.collectionId),
    queryFn: () => recordsApi.list(props.collectionId, { limit: 1 }),
    enabled: props.open,
  })
  const pendingQuery = useQuery({
    queryKey: collectionKeys.pending(props.collectionId),
    queryFn: () => collectionsApi.pendingChange(props.collectionId),
    enabled: props.open,
  })

  const summary = collections.find((item) => item.id === props.collectionId)
  const recordCount = summary?.recordCount ?? 0
  const otherCollections = collections.filter((item) => item.id !== props.collectionId)
  const firstName = useMemo(() => {
    const record = recordQuery.data?.data[0]
    if (!record) return null
    for (const [key, value] of Object.entries(record)) {
      if (['id', 'createdAt', 'updatedAt'].includes(key)) continue
      if (typeof value === 'string' && value.trim()) return value
    }
    return null
  }, [recordQuery.data])

  const matched = confirmName.trim().toLowerCase() === props.collectionName.toLowerCase()

  const removal = useMutation({
    mutationFn: () => collectionsApi.remove(props.collectionId, props.collectionName),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: collectionKeys.list }),
        queryClient.invalidateQueries({ queryKey: recordKeys.list(props.collectionId) }),
      ])
      setConfirmName('')
      props.onClose()
      message.success(
        `已永久删除 ${result.name}：${result.deletedRecords} 条记录、${result.discardedChanges} 个待应用变更、${result.revokedSessions} 个有效会话。`,
      )
      navigate('/data')
    },
    onError: (error: unknown) => {
      message.error(`删除失败：${errorMessage(error)}`)
    },
  })

  const rows: ImpactRow[] = [
    { key: 'records', resource: `${props.collectionName} · ${recordCount} 条记录`, result: '永久删除' },
    { key: 'schema', resource: `${props.collectionName} 的字段、索引与访问规则`, result: '一并删除' },
    { key: 'api', resource: `${props.collectionName} API 与引用它的业务逻辑`, result: '将无法正常使用' },
    {
      key: 'others',
      resource: otherCollections.length
        ? `${otherCollections.slice(0, 3).map((item) => item.name).join(' · ')} 等 ${otherCollections.length} 个集合`
        : '没有其它集合',
      result: '不删除关联集合',
    },
  ]

  const columns: TableColumnsType<ImpactRow> = [
    { title: '影响资源', dataIndex: 'resource', key: 'resource', width: '72%' },
    { title: '结果', dataIndex: 'result', key: 'result' },
  ]

  const handleClose = () => {
    if (removal.isPending) return
    setConfirmName('')
    props.onClose()
  }

  return (
    <Modal
      open={props.open}
      onCancel={handleClose}
      footer={null}
      width={560}
      centered
      maskClosable={!removal.isPending}
      className="mr-delete-modal"
      destroyOnHidden
      title={null}
    >
      <div className="mr-delete-modal__content">
        <div className="mr-delete-modal__heading">
          <WarningOutlined className="mr-delete-modal__heading-icon" />
          <h2>永久删除 {props.collectionName}？</h2>
        </div>

        <p className="mr-delete-modal__description">
          这会永久删除 {props.collectionName} 集合、结构和全部 {recordCount} 条记录
          {firstName ? `，包括「${firstName}」` : ''}。数据不会进入回收站。
        </p>

        <Table<ImpactRow>
          className="mr-delete-modal__table"
          columns={columns}
          dataSource={rows}
          pagination={false}
          size="small"
          showHeader
          rowKey="key"
        />

        <Notice tone="danger">
          依赖提醒：删除后引用 {props.collectionName} 的业务逻辑与 API 将无法正常工作
          {pendingQuery.data ? '，当前待应用变更会一并丢弃' : ''}
          {summary?.pendingChangeStatus ? `（${summary.pendingChangeStatus}）` : ''}。请先停用相关逻辑并保留需要的数据。
        </Notice>

        <Field
          label={`输入集合名称 ${props.collectionName} 以确认`}
          hint={
            <span className={matched ? 'mr-delete-modal__hint--ok' : ''}>
              {matched
                ? '名称匹配。确认后无法恢复，请先自行保留需要的数据。'
                : `名称不匹配。请输入 ${props.collectionName} 后才能永久删除。`}
            </span>
          }
        >
          <Input
            aria-label="确认集合名称"
            className="mr-delete-modal__input"
            value={confirmName}
            autoComplete="off"
            disabled={removal.isPending}
            onChange={(event) => setConfirmName(event.target.value)}
            onPressEnter={() => {
              if (matched && !removal.isPending) removal.mutate()
            }}
          />
        </Field>

        <p className="mr-delete-modal__cancel-note">取消会关闭此确认框，现有集合和所有记录保持不变。</p>

        <div className="mr-delete-modal__footer">
          <span>不可撤销</span>
          <div className="mr-delete-modal__actions">
            <Button onClick={handleClose} disabled={removal.isPending}>
              取消
            </Button>
            <Button type="primary" danger disabled={!matched || removal.isPending} loading={removal.isPending} onClick={() => removal.mutate()}>
              永久删除集合
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
