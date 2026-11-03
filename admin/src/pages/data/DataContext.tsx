import { createContext, useContext, type ReactNode } from 'react'
import type { CollectionSummary } from '@/api/collections'

/** 数据工作区的共享状态：集合列表、创建入口、刷新。 */
export type DataContextValue = {
  collections: CollectionSummary[]
  loading: boolean
  error: unknown
  refresh: () => void
  openCreate: () => void
  activeCollection?: CollectionSummary
}

const DataContext = createContext<DataContextValue | null>(null)

export function DataProvider(props: { value: DataContextValue; children: ReactNode }) {
  return <DataContext.Provider value={props.value}>{props.children}</DataContext.Provider>
}

export function useData(): DataContextValue {
  const value = useContext(DataContext)
  if (!value) {
    throw new Error('useData 必须在数据工作区内使用')
  }
  return value
}
