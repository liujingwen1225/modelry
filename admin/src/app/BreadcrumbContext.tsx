import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

/**
 * 页眉面包屑的尾部片段由当前页面提供。
 *
 * 一级分区来自路由（app/nav.tsx）；详情页通过 useBreadcrumbTail 追加实体名，
 * 这样刷新深链接时面包屑仍然正确，而不是只依赖跳转时携带的状态。
 */
type BreadcrumbState = {
  tail: string[]
  setTail: (tail: string[]) => void
}

const BreadcrumbContext = createContext<BreadcrumbState | null>(null)

export function BreadcrumbProvider(props: { children: ReactNode }) {
  const [tail, setTail] = useState<string[]>([])
  const value = useMemo(() => ({ tail, setTail }), [tail])
  return <BreadcrumbContext.Provider value={value}>{props.children}</BreadcrumbContext.Provider>
}

/** 页面声明自己在面包屑中的层级；传空数组表示停留在分区根页面。 */
export function useBreadcrumbTail(tail: Array<string | undefined | null | false>) {
  const setTail = useContext(BreadcrumbContext)?.setTail
  const key = JSON.stringify(tail.filter(Boolean))

  useEffect(() => {
    if (!setTail) {
      return
    }
    setTail(JSON.parse(key) as string[])
    return () => setTail([])
  }, [key, setTail])
}

export function useBreadcrumbTailValue(): string[] {
  return useContext(BreadcrumbContext)?.tail ?? []
}
