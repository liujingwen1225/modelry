import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { ApiError } from '@/api/client'
import { ErrorState, Spin } from '@/ui'
import { useAdminSession, useBootstrapStatus } from './hooks'

function FullPageSpin(props: { tip: string }) {
  return (
    <div className="mr-auth">
      <Spin tip={props.tip} size="large">
        <div style={{ width: 200, height: 60 }} />
      </Spin>
    </div>
  )
}

/**
 * 管理面统一入口守卫：先判断是否仍需首次设置，再判断是否已登录。
 *
 * 首次设置页与登录页不在 Figma 产品画板内，但缺少它们就无法安全进入管理面，
 * 因此保留为最小必要页面，且复用同一套设计变量。
 */
export function RequireAdmin(props: { children: ReactNode }) {
  const bootstrap = useBootstrapStatus()
  const session = useAdminSession()

  if (bootstrap.isPending || session.isPending) {
    return <FullPageSpin tip="正在连接本地实例" />
  }

  if (bootstrap.isError) {
    return (
      <div className="mr-auth">
        <div className="mr-auth__panel">
          <ErrorState error={bootstrap.error} onRetry={() => void bootstrap.refetch()} title="无法读取首次设置状态" />
        </div>
      </div>
    )
  }

  if (bootstrap.data?.state === 'required') {
    return <Navigate to="/setup" replace />
  }

  if (session.isError) {
    if (session.error instanceof ApiError && session.error.status === 401) {
      return <Navigate to="/login" replace />
    }
    return (
      <div className="mr-auth">
        <div className="mr-auth__panel">
          <ErrorState error={session.error} onRetry={() => void session.refetch()} title="无法确认管理员身份" />
        </div>
      </div>
    )
  }

  return <>{props.children}</>
}
