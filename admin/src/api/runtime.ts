import { api } from './client'

/**
 * 运行时诊断：只读取真实 Go 运行时暴露的事实，不猜测端口、版本或存储状态。
 * /runtime/status 与 /storage/status 允许匿名读取；存储路径只对已认证 Owner 返回。
 */
export type Health = {
  state: string
  message?: string
  hint?: string
}

export type RuntimeStatus = {
  state: string
  observedAt: string
  database: Health
  localStorage: Health
  projectSource?: string
  version?: string
}

export type StorageStatus = {
  database: Health
  localStorage: Health & { provider?: string; path?: string }
  fileStorage: Health & { provider?: string; activeProvider?: string }
  databaseSizeBytes?: number
}

export const runtimeApi = {
  status: () => api.get<RuntimeStatus>('/admin/api/v1/runtime/status'),
  storage: () => api.get<StorageStatus>('/admin/api/v1/storage/status'),
}

export const runtimeKeys = {
  status: ['runtime-status'] as const,
  storage: ['storage-status'] as const,
}

/**
 * 项目名来自本地项目目录名。
 *
 * 存储状态返回的是托管目录（`<项目根>/.modelry/files`），
 * 因此取 `.modelry` 之前的一段作为项目名；没有托管段时退回上一级目录。
 * 读不到路径时使用中性名称，不编造项目名。
 */
export function projectNameFromPath(path?: string): string {
  if (!path) {
    return '本地项目'
  }
  const segments = path.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean)
  const managedAt = segments.lastIndexOf('.modelry')
  const candidate = managedAt > 0 ? segments[managedAt - 1] : segments[segments.length - 2]
  if (!candidate || candidate === '.' || candidate === '..') {
    return '本地项目'
  }
  return candidate
}

/** 面向界面的数据目录：只显示项目内的相对位置，不暴露完整绝对路径。 */
export function dataDirectoryLabel(path?: string): string {
  if (!path) {
    return './.modelry/'
  }
  const segments = path.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean)
  const managedAt = segments.lastIndexOf('.modelry')
  if (managedAt >= 0) {
    return `./${segments.slice(managedAt).join('/')}/`
  }
  return path
}

export function runtimePort(): string {
  return window.location.port || (window.location.protocol === 'https:' ? '443' : '80')
}

export function runtimeOrigin(): string {
  return window.location.origin
}
