import { useQuery } from '@tanstack/react-query'
import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import { ErrorState, LoadingBlock } from '@/ui'
import { collectionsApi, collectionKeys } from '@/api/collections'

/**
 * 旧「用户与访问」入口的兼容重定向（0011 第 8 节）。
 *
 * 独立一级页已取消，用户功能以认证集合为主体。这里保留 /access 路由，
 * 让旧深链接、概览快捷入口与记录详情链接都能落到正确的集合标签：
 *   /access、/access/users → /data/:authId/users
 *   /access/auth          → /data/:authId/auth
 *   /access/rules         → /data/:authId/access
 * 带 ?collectionId= 时优先采用该集合；没有认证集合时回数据页引导创建。
 */
export function AccessPage() {
  const params = useParams<{ tab?: string }>()
  const [searchParams] = useSearchParams()
  const collections = useQuery({ queryKey: collectionKeys.list, queryFn: collectionsApi.list })

  if (collections.isPending) {
    return (
      <div className="mr-page">
        <LoadingBlock rows={4} label="正在定位认证集合…" />
      </div>
    )
  }
  if (collections.isError) {
    return (
      <div className="mr-page">
        <ErrorState error={collections.error} title="集合读不到" onRetry={() => void collections.refetch()} />
      </div>
    )
  }

  const list = collections.data ?? []
  const requested = searchParams.get('collectionId')
  const target =
    (requested ? list.find((item) => item.id === requested) : undefined) ??
    list.find((item) => item.type === 'Auth') ??
    list[0]
  if (!target) {
    return <Navigate to="/data" replace />
  }

  const requestedTab =
    params.tab === 'auth' ? 'auth' : params.tab === 'rules' ? 'access' : params.tab === 'users' ? 'users' : 'users'
  // 「用户 / 认证」只属于认证集合；普通集合回落到记录或访问规则。
  const tab = target.type === 'Auth' ? requestedTab : requestedTab === 'access' ? 'access' : 'records'

  return <Navigate to={`/data/${target.id}/${tab}`} replace />
}
