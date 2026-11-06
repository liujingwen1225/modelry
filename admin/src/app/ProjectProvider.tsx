import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { overviewApi, overviewKeys, type OverviewSnapshot } from '@/api/overview'
import { runtimeApi, runtimeKeys, projectNameFromPath, runtimeOrigin, runtimePort, type RuntimeStatus, type StorageStatus } from '@/api/runtime'
import { projectPreferencesApi, settingsKeys } from '@/api/settings'

/**
 * 全局工作区上下文：项目名、运行时健康、变更计数。
 *
 * 这些是导航与页眉都要用的稳定事实；页面不要各自再算一遍。
 * 所有字段都来自真实 Go API，读不到时降级为中性文案而不是编造值。
 */
export type ProjectContextValue = {
  name: string
  port: string
  origin: string
  runtime?: RuntimeStatus
  storage?: StorageStatus
  overview?: OverviewSnapshot
  pendingChanges: number
  needsReview: number
  healthy: boolean
  dataRoot?: string
}

const ProjectContext = createContext<ProjectContextValue | null>(null)

export function ProjectProvider(props: { children: ReactNode }) {
  const runtime = useQuery({ queryKey: runtimeKeys.status, queryFn: runtimeApi.status, staleTime: 30_000 })
  const storage = useQuery({ queryKey: runtimeKeys.storage, queryFn: runtimeApi.storage, staleTime: 30_000 })
  const overview = useQuery({ queryKey: overviewKeys.snapshot, queryFn: overviewApi.read, staleTime: 15_000 })
  // 项目名称来自「设置 · 基本设置」的真实偏好；未命名时回退到数据目录名。
  const preferences = useQuery({ queryKey: settingsKeys.preferences, queryFn: projectPreferencesApi.get, staleTime: 15_000 })

  const value = useMemo<ProjectContextValue>(() => {
    const changes = overview.data?.changes
    const preferredName = preferences.data?.projectName?.trim()
    return {
      name: preferredName || projectNameFromPath(storage.data?.localStorage.path),
      port: runtimePort(),
      origin: runtimeOrigin(),
      runtime: runtime.data,
      storage: storage.data,
      overview: overview.data,
      pendingChanges: changes?.pendingCount ?? 0,
      needsReview: changes?.needsReviewCount ?? 0,
      healthy: runtime.data?.state === 'ready' && storage.data?.database.state !== 'error',
      dataRoot: storage.data?.localStorage.path,
    }
  }, [overview.data, runtime.data, storage.data, preferences.data])

  return <ProjectContext.Provider value={value}>{props.children}</ProjectContext.Provider>
}

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext)
  if (!value) {
    throw new Error('useProject 必须在 ProjectProvider 内使用')
  }
  return value
}
