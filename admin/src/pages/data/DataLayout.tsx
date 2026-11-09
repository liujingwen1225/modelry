import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Outlet, useNavigate, useParams } from 'react-router-dom'
import { Button, ErrorState, LoadingBlock } from '@/ui'
import { useBreadcrumbTail } from '@/app/BreadcrumbContext'
import { PlusOutlined, TableOutlined, TeamOutlined } from '@ant-design/icons'
import { collectionsApi, collectionKeys } from '@/api/collections'
import { CreateCollectionDrawer } from './CreateCollectionDrawer'
import { DataProvider } from './DataContext'
import './data.css'

/**
 * 数据工作区外壳：154px 集合栏 + 集合工作面。
 *
 * 对应 Figma「数据 · notes 工作台」的三层结构（主导航 / 集合栏 / 集合内容）。
 * 集合列表与计数来自真实 API，选中项由路由决定，刷新后仍停留在同一集合。
 */
export function DataLayout() {
  const navigate = useNavigate()
  const params = useParams<{ collectionId?: string }>()
  const [createOpen, setCreateOpen] = useState(false)

  const query = useQuery({ queryKey: collectionKeys.list, queryFn: collectionsApi.list })
  const collections = query.data ?? []
  const activeId = params.collectionId ?? collections[0]?.id

  useBreadcrumbTail([])

  return (
    <DataProvider
      value={{
        collections,
        loading: query.isPending,
        error: query.error,
        refresh: () => void query.refetch(),
        openCreate: () => setCreateOpen(true),
        activeCollection: collections.find((collection) => collection.id === activeId),
      }}
    >
      <div className="mr-data">
        <aside className="mr-rail" aria-label="集合列表">
          <div className="mr-rail__head">
            <span className="mr-rail__title">集合</span>
            <Button
              type="text"
              size="small"
              className="mr-rail__add"
              aria-label="创建集合"
              icon={<PlusOutlined />}
              onClick={() => setCreateOpen(true)}
            />
          </div>

          {query.isPending ? <LoadingBlock rows={3} /> : null}
          {query.isError ? (
            <ErrorState error={query.error} title="集合列表读不到" onRetry={() => void query.refetch()} />
          ) : null}

          <nav className="mr-rail__list" aria-label="集合">
            {collections.map((collection) => (
              <Button
                key={collection.id}
                type="text"
                className={`mr-rail__item${collection.id === activeId ? ' mr-rail__item--active' : ''}`}
                onClick={() => navigate(`/data/${collection.id}`)}
              >
                {collection.type === 'Auth' ? (
                  <TeamOutlined className="mr-rail__icon" aria-label="认证集合" />
                ) : (
                  <TableOutlined className="mr-rail__icon" />
                )}
                <span className="mr-rail__name">{collection.name}</span>
                <span className="mr-rail__count">{collection.recordCount}</span>
              </Button>
            ))}
          </nav>

          <div className="mr-rail__spacer" />
          <span className="mr-rail__footnote">{collections.length} 个集合 · SQLite</span>
        </aside>

        <section className="mr-collection">
          <Outlet />
        </section>
      </div>

      <CreateCollectionDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(collection) => {
          setCreateOpen(false)
          void query.refetch()
          navigate(`/data/${collection.id}`)
        }}
      />
    </DataProvider>
  )
}
