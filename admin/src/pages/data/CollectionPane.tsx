import { useEffect, useState } from 'react'
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
import { UsersTab, UserDrawer, AuthTab } from './UserTabs'
import { useData } from './DataContext'
import { RulesTab } from '@/pages/access/RulesTab'

const TABS = [
  { key: 'users', label: '用户' },
  { key: 'auth', label: '认证' },
  { key: 'records', label: '记录' },
  { key: 'schema', label: '结构' },
  { key: 'access', label: '访问规则' },
  { key: 'api', label: 'API' },
] as const

export type CollectionTab = (typeof TABS)[number]['key']

/** 认证集合是用户功能主体；普通集合保持数据工作面的四个标签（0011 第 8 节）。 */
const AUTH_TABS: CollectionTab[] = ['users', 'auth', 'schema', 'access', 'api']
const NORMAL_TABS: CollectionTab[] = ['records', 'schema', 'access', 'api']

/**
 * 集合工作面：集合标题、就地任务标签与当前标签页内容。
 *
 * 标签页走路由（/data/:id/:tab），因此刷新、深链接和浏览器后退都保持同一上下文。
 * 认证集合默认落在「用户」，普通集合默认落在「记录」；不适用的标签重定向回默认值。
 */
export function CollectionPane() {
  const params = useParams<{ collectionId: string; tab?: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { collections } = useData()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [activeUser, setActiveUser] = useState<Record<string, unknown> | null>(null)
  const collectionId = params.collectionId ?? ''

  const collectionQuery = useQuery({
    queryKey: collectionKeys.detail(collectionId),
    queryFn: () => collectionsApi.get(collectionId),
    enabled: Boolean(collectionId),
  })

  const isAuth = collectionQuery.data?.type === 'Auth'
  const defaultTab: CollectionTab = isAuth ? 'users' : 'records'
  const tab = (params.tab ?? defaultTab) as CollectionTab
  const visibleTabs = isAuth ? AUTH_TABS : NORMAL_TABS

  // 旧深链接（/data/:authId/records、/access/* 重定向）落到不存在的标签时，回到该类型的默认工作面。
  useEffect(() => {
    if (!collectionQuery.data || visibleTabs.includes(tab)) return
    navigate(`/data/${collectionId}/${defaultTab}`, { replace: true })
  }, [collectionQuery.data, visibleTabs, tab, defaultTab, collectionId, navigate])

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
            <StatusTag>{isAuth ? '认证集合' : '普通集合'}</StatusTag>
          </div>
          {tab === 'users' ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setActiveUser({})}>
              添加用户
            </Button>
          ) : null}
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
          {visibleTabs.map((key) => (
            <Button
              key={key}
              type="text"
              className={`mr-tabs__item${key === tab ? ' mr-tabs__item--active' : ''}`}
              onClick={() => navigate(`/data/${collectionId}/${key}`)}
            >
              {TABS.find((entry) => entry.key === key)?.label}
            </Button>
          ))}
        </nav>
      </header>

      <PendingChangeBanner collectionId={collectionId} />

      {tab === 'users' && isAuth ? <UsersTab collection={collection} fields={collection.fields} onOpen={setActiveUser} /> : null}
      {tab === 'auth' && isAuth ? <AuthTab collection={collection} fields={collection.fields} /> : null}
      {tab === 'records' ? <RecordsTab collection={collection} /> : null}
      {tab === 'schema' && activeFileField ? <FileFieldConfig collection={collection} field={activeFileField} /> : null}
      {tab === 'schema' && !activeFileField ? <SchemaTab collection={collection} /> : null}
      {tab === 'api' ? <ApiTab collection={collection} /> : null}
      {tab === 'access' ? <RulesTab collections={collections} activeId={collectionId} /> : null}

      <DeleteCollectionModal
        open={deleteOpen}
        collectionId={collection.id}
        collectionName={collection.name}
        onClose={() => setDeleteOpen(false)}
      />
      {activeUser ? (
        <UserDrawer collection={collection} fields={collection.fields} record={activeUser} onClose={() => setActiveUser(null)} />
      ) : null}
    </>
  )
}
