import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Button, Dropdown, Empty, ErrorState, Input, LoadingBlock, Modal, Notice, Table } from '@/ui'
import type { TableColumnsType } from '@/ui'
import { EllipsisOutlined, LockOutlined, SearchOutlined } from '@ant-design/icons'
import type { Collection, Field } from '@/api/collections'
import { recordsApi, recordKeys, type RecordItem } from '@/api/records'
import { errorMessage } from '@/api/client'
import { formatDateTime } from '@/lib/format'
import { RecordDrawer } from './RecordDrawer'
import { RecordDetail } from './RecordDetail'
import { displayValue, recordSnippet, recordTitle } from './record-format'

/**
 * 记录工作面（Figma「数据 · notes 工作台」的记录标签）。
 *
 * 表格列由集合结构决定：第一列合并展示标题与摘要，其余字段按类型呈现。
 * 选中一行在右侧打开真实记录详情，可继续编辑或删除。
 */
export function RecordsTab(props: { collection: Collection }) {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState<RecordItem | undefined>(undefined)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<unknown>(null)

  const recordsQuery = useQuery({
    queryKey: recordKeys.list(props.collection.id),
    queryFn: () => recordsApi.list(props.collection.id, { limit: 100 }),
  })

  const records = recordsQuery.data?.data ?? []
  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) {
      return records
    }
    return records.filter((record) =>
      Object.values(record).some((value) => typeof value === 'string' && value.toLowerCase().includes(keyword)),
    )
  }, [records, search])

  const selected = filtered.find((record) => record.id === selectedId) ?? null

  // 标题栏的「新增记录」通过 ?new=1 打开抽屉，关闭后清掉参数，保持深链接干净。
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setEditing(undefined)
      setDrawerOpen(true)
      setSearchParams({}, { replace: true })
    }
  }, [searchParams, setSearchParams])

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: recordKeys.list(props.collection.id) })
    void queryClient.invalidateQueries({ queryKey: ['collections'] })
  }

  const remove = async (record: RecordItem) => {
    setDeleteError(null)
    try {
      await recordsApi.remove(props.collection.id, record.id)
      setSelectedId(null)
      refresh()
    } catch (cause) {
      setDeleteError(cause)
    }
  }

  const columns = useMemo(() => buildColumns(props.collection, setSelectedId, (record) => {
    setEditing(record)
    setDrawerOpen(true)
  }, (record) => {
    Modal.confirm({
      title: `删除这条记录？`,
      content: '删除后无法恢复，相关问题会记录在审计里。',
      okText: '永久删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => remove(record),
    })
  }), [props.collection])

  if (recordsQuery.isPending) {
    return (
      <div className="mr-collection__body">
        <LoadingBlock rows={6} label="正在读取记录…" />
      </div>
    )
  }

  if (recordsQuery.isError) {
    return (
      <div className="mr-collection__body">
        <ErrorState error={recordsQuery.error} title="记录读不到" onRetry={() => void recordsQuery.refetch()} />
      </div>
    )
  }

  return (
    <div className={`mr-records${selected ? ' mr-records--with-detail' : ''}`}>
      <div className="mr-records__main">
        <div className="mr-records__tools">
          <Input
            className="mr-records__search"
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索标题或内容…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <span className="mr-meta">{search ? `${filtered.length} 条匹配` : `${records.length} 条记录`}</span>
        </div>

        {records.length === 0 ? (
          <div className="mr-records__empty">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span>
                  还没有记录。
                  <Button type="link" onClick={() => setDrawerOpen(true)}>
                    添加第一条
                  </Button>
                </span>
              }
            />
          </div>
        ) : (
          <Table<RecordItem>
            rowKey="id"
            size="small"
            className="mr-records__table"
            columns={columns}
            dataSource={filtered}
            pagination={false}
            scroll={{ y: 'calc(100vh - 320px)' }}
            rowClassName={(record) => (record.id === selectedId ? 'mr-records__row--active' : '')}
            onRow={(record) => ({
              onClick: () => setSelectedId(record.id === selectedId ? null : record.id),
            })}
          />
        )}

        <div className="mr-records__footer">
          <span>
            {selectedId ? '已选 1 条' : '未选择'} · 共 {records.length} 条记录
          </span>
          <span className="mr-meta">{recordsQuery.data?.nextCursor ? '还有更多记录' : '全部已加载'}</span>
        </div>
        <span className="mr-records__hint">
          <LockOutlined /> 记录按集合的访问规则读取；未授权的身份看不到这些内容。
        </span>

        {deleteError ? <Notice tone="danger">{errorMessage(deleteError)}</Notice> : null}
      </div>

      {selected ? (
        <RecordDetail
          collection={props.collection}
          record={selected}
          onClose={() => setSelectedId(null)}
          onEdit={() => {
            setEditing(selected)
            setDrawerOpen(true)
          }}
          onDelete={() =>
            Modal.confirm({
              title: '删除这条记录？',
              content: '删除后无法恢复，相关问题会记录在审计里。',
              okText: '永久删除',
              okButtonProps: { danger: true },
              cancelText: '取消',
              onOk: () => remove(selected),
            })
          }
        />
      ) : null}

      <RecordDrawer
        open={drawerOpen}
        collection={props.collection}
        record={editing}
        onClose={() => setDrawerOpen(false)}
        onSaved={(record) => {
          setDrawerOpen(false)
          setSelectedId(record.id)
          refresh()
        }}
      />
    </div>
  )
}

function buildColumns(
  collection: Collection,
  onSelect: (id: string) => void,
  onEdit: (record: RecordItem) => void,
  onDelete: (record: RecordItem) => void,
): TableColumnsType<RecordItem> {
  const fields = collection.fields.filter((field) => !field.system)
  const [primary, secondary, ...rest] = fields
  const columns: TableColumnsType<RecordItem> = [
    {
      title: primary ? `${primary.name}${secondary ? ` / ${secondary.name}` : ''}` : '记录',
      dataIndex: primary?.name ?? 'id',
      render: (_value, record) => (
        <div className="mr-record-cell">
          <span className="mr-record-cell__title">{recordTitle(collection.fields, record, record.id)}</span>
          <span className="mr-record-cell__snippet">{recordSnippet(collection.fields, record)}</span>
        </div>
      ),
    },
  ]

  for (const field of rest.slice(0, 3)) {
    columns.push({
      title: field.name,
      dataIndex: field.name,
      width: field.type === 'text' ? 160 : 132,
      render: (_value, record) => <div className="mr-record-cell__value">{displayValue(field, record[field.name])}</div>,
    })
  }

  columns.push({
    title: 'created_at',
    dataIndex: 'createdAt',
    width: 132,
    render: (_value, record) => <span className="mr-mono mr-record-cell__time">{formatDateTime(record.createdAt).slice(5, 16)}</span>,
  })

  columns.push({
    title: '',
    width: 44,
    render: (_value, record) => (
      <Dropdown
        trigger={['click']}
        menu={{
          items: [
            { key: 'open', label: '打开详情', onClick: () => onSelect(record.id) },
            { key: 'edit', label: '编辑', onClick: () => onEdit(record) },
            { type: 'divider' },
            { key: 'delete', label: '删除', danger: true, onClick: () => onDelete(record) },
          ],
        }}
      >
        <Button type="text" size="small" icon={<EllipsisOutlined />} aria-label="记录操作" onClick={(event) => event.stopPropagation()} />
      </Dropdown>
    ),
  })

  return columns
}

export type { Field }
