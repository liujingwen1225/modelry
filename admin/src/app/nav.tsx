import type { ReactNode } from 'react'
import {
  AppstoreOutlined,
  BranchesOutlined,
  CodeOutlined,
  DatabaseOutlined,
  PullRequestOutlined,
  SettingOutlined,
} from '@ant-design/icons'

/**
 * 导航只表达产品分区。按 0011 第 8 节的信息架构决策，
 * 用户功能以认证集合为主体，「用户与访问」不再是一级入口。
 *
 * 四个主要入口、开发者快捷说明、分隔线后的变更入口，以及底部的设置与本地运行时信息。
 */
export type SectionId = 'overview' | 'data' | 'logic' | 'developer' | 'changes'

export type NavEntry = {
  id: SectionId
  path: string
  label: string
  icon: ReactNode
}

export const PRIMARY_NAV: NavEntry[] = [
  { id: 'overview', path: '/', label: '概览', icon: <AppstoreOutlined /> },
  { id: 'data', path: '/data', label: '数据', icon: <DatabaseOutlined /> },
  { id: 'logic', path: '/logic', label: '业务逻辑', icon: <BranchesOutlined /> },
  { id: 'developer', path: '/developer', label: '开发与连接', icon: <CodeOutlined /> },
]

export const REVIEW_NAV: NavEntry = {
  id: 'changes',
  path: '/changes',
  label: '待审阅变更',
  icon: <PullRequestOutlined />,
}

export const SETTINGS_NAV: NavEntry = {
  id: 'changes',
  path: '/settings',
  label: '设置',
  icon: <SettingOutlined />,
}

/** 当前路径属于哪个主要分区；用于高亮唯一入口。 */
export function sectionOfPath(pathname: string): SectionId {
  if (pathname === '/' || pathname.startsWith('/overview')) {
    return 'overview'
  }
  if (pathname.startsWith('/data')) {
    return 'data'
  }
  // /access 只作为旧链接重定向壳，命中时高亮「数据」分区。
  if (pathname.startsWith('/access')) {
    return 'data'
  }
  if (pathname.startsWith('/logic')) {
    return 'logic'
  }
  if (pathname.startsWith('/developer')) {
    return 'developer'
  }
  if (pathname.startsWith('/changes') || pathname.startsWith('/ai')) {
    return 'changes'
  }
  return 'overview'
}

/** 顶部面包屑第二段的中文名；详情页由页面自行追加。 */
export function sectionLabelOf(pathname: string): string {
  if (pathname.startsWith('/data')) return '数据'
  if (pathname.startsWith('/access')) return '数据'
  if (pathname.startsWith('/logic')) return '业务逻辑'
  if (pathname.startsWith('/developer')) return '开发与连接'
  if (pathname.startsWith('/changes')) return '待审阅变更'
  if (pathname.startsWith('/ai')) return 'AI 协作'
  if (pathname.startsWith('/settings')) return '设置'
  return '概览'
}
