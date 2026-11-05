import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Button, Dropdown, ErrorState, LoadingBlock, StatusTag } from '@/ui'
import type { MenuProps } from '@/ui'
import { DeleteOutlined, MoreOutlined, PlusOutlined } from '@ant-design/icons'
import { collectionsApi, collectionKeys } from '@/api/collections'
import { useBreadcrumbTail } from '@/app/BreadcrumbContext'
import { RecordsTab } from './RecordsTab'
import { SchemaTab } from './SchemaTab'
import { ApiTab } from './ApiTab'
import { PendingChangeBanner } from './PendingChangeBanner'
import { DeleteCollectionModal } from './DeleteCollectionModal'
import { FileFieldConfig } from './FileFieldConfig'

const TABS = [
  { key: 'records', label: '记录' },
  { key: 'schema', label: '结构' },
  { key: 'access', label: '访问规则' },
  { key: 'api', label: 'API' },
] as const

export type CollectionTab = (typeof TABS)[number]['key']

/**
 * 集合工作面：集合标题、就地任务标签与当前标签页内容。
 *
 * 标签页走路由（/data/:id/:tab），因此刷新、深链接和浏览器后退都保持同一上下文。
 */
export function CollectionPane() {
  const params = useParams<{ collectionId: string; tab?: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const collectionId = params.collectionId ?? ''
  const tab = (params.tab ?? 'records') as CollectionTab

  const collectionQuery = useQuery({
    queryKey: collectionKeys.detail(collectionId),
    queryFn: () => collectionsApi.get(collectionId),
    enabled: Boolean(collectionId),
  })

  const activeFileField = collectionQuery.data?.fields.find(
    (field) =>
      field.id === searchParams.get('field') && (field.type === 'file' || field.type === 'files'),
  )

  useBreadcrumbTail([collectionQuery.data?.name, activeFileField?.name])

  if (collectionQuery.isPending) {
    return (
      <div className="mr-page">
        <LoadingBlock rows={5} label="正在读取集合…" />
      </div>
    )
  }

  if (collectionQuery.isError) {
    return (
      <div className="mr-page">
        <ErrorState error={collectionQuery.error} title="集合读不到" onRetry={() => void collectionQuery.refetch()} />
      </div>
    )
  }

  const collection = collectionQuery.data

  const collectionMenu: MenuProps = {
    items: [
      {
        key: 'delete',
        danger: true,
        icon: <DeleteOutlined />,
        label: '删除集合',
      },
    ],
    onClick: ({ key }) => {
      if (key === 'delete') setDeleteOpen(true)
    },
  }

  return (
    <>
      <header className="mr-collection__header">
        <div className="mr-collection__title">
          <div className="mr-collection__identity">
            <h1 className="mr-collection__name">{collection.name}</h1>
            {collection.description ? <span className="mr-collection__description">{collection.description}</span> : null}
            <StatusTag>{collection.type === 'Auth' ? '认证集合' : '普通集合'}</StatusTag>
          </div>
          {tab === 'records' ? (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => navigate(`/data/${collectionId}/records?new=1`)}
            >
              新增记录
            </Button>
          ) : null}
          {tab === 'schema' ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate(`/data/${collectionId}/schema?add=1`)}>
              添加字段
            </Button>
          ) : null}
          <Dropdown menu={collectionMenu} trigger={['click']}>
            <Button type="text" aria-label="集合操作" icon={<MoreOutlined />} />
          </Dropdown>
        </div>

        <nav className="mr-tabs" aria-label="集合工作面">
          {TABS.map((entry) => (
            <Button
              key={entry.key}
              type="text"
              className={`mr-tabs__item${entry.key === tab ? ' mr-tabs__item--active' : ''}`}
              onClick={() => navigate(`/data/${collectionId}/${entry.key}`)}
            >
              {entry.label}
            </Button>
          ))}
        </nav>
      </header>

      <PendingChangeBanner collectionId={collectionId} />

      {tab === 'records' ? <RecordsTab collection={collection} /> : null}
      {tab === 'schema' && activeFileField ? <FileFieldConfig collection={collection} field={activeFileField} /> : null}
      {tab === 'schema' && !activeFileField ? <SchemaTab collection={collection} /> : null}
      {tab === 'api' ? <ApiTab collection={collection} /> : null}
      {tab === 'access' ? (
        <div className="mr-collection__body">
          <p className="mr-muted-note">访问规则随「用户与访问」一起交付，当前使用创建集合时的默认私人规则。</p>
        </div>
      ) : null}

      <DeleteCollectionModal
        open={deleteOpen}
        collectionId={collection.id}
        collectionName={collection.name}
        onClose={() => setDeleteOpen(false)}
      />
    </>
  )
}
