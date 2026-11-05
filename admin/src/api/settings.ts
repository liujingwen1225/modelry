import { api } from './client'

/**
 * 画板 22「设置 · 本地项目」的可编辑设置。
 *
 * 已核实的后端契约（只使用这两个端点，不猜测其它端点）：
 *   GET  /admin/api/v1/settings  → { data: Settings }（不允许带 query）
 *   PUT  /admin/api/v1/settings  → { data: Settings }
 *
 * 运行时状态与存储状态不在本文件重复定义：@/api/runtime.ts 已经封装好了
 * GET /admin/api/v1/runtime/status 与 GET /admin/api/v1/storage/status
 * （runtimeApi.status / runtimeApi.storage / runtimeKeys），页面直接复用。
 */

/** source=flag 表示该值被启动参数覆盖，界面不可编辑。 */
export type SettingSource = 'flag' | 'project' | 'default'

/** 单个设置项：value 可能是字符串或数字；bounds 是后端给出的真实取值范围描述。 */
export type Setting = {
  value: string | number
  source: SettingSource
  restartRequired: boolean
  bounds: string
}

export type Settings = {
  listenAddress: Setting
  requestRetentionDays: Setting
  /** 乐观并发版本号：PUT 必须带上，不匹配时后端返回 409 CONFLICT。 */
  revision: number
  updatedAt: string
}

/** PUT 请求体：expectedRevision 用于并发控制；两个值都按契约原样提交。 */
export type SettingsUpdate = {
  expectedRevision: number
  listenAddress: string
  requestRetentionDays: number
}

export const settingsApi = {
  get: () => api.get<{ data: Settings }>('/admin/api/v1/settings'),
  update: (body: SettingsUpdate) => api.put<{ data: Settings }>('/admin/api/v1/settings', body),
}

/** 画板 22「基本设置」标签：项目级展示偏好，与 Runtime Settings 分离。 */
export type ProjectPreferences = {
  projectName: string
  projectDescription: string
  locale: 'zh-CN' | 'en-US'
  appearance: 'light' | 'dark' | 'system'
  saveFeedback: boolean
  revision: number
  updatedAt: string
}

export type ProjectPreferencesUpdate = {
  expectedRevision: number
  projectName: string
  projectDescription: string
  locale: ProjectPreferences['locale']
  appearance: ProjectPreferences['appearance']
  saveFeedback: boolean
}

export const projectPreferencesApi = {
  get: () =>
    api.get<{ data: ProjectPreferences }>('/admin/api/v1/project-preferences').then((response) => response.data),
  update: (body: ProjectPreferencesUpdate) =>
    api.put<{ data: ProjectPreferences }>('/admin/api/v1/project-preferences', body).then((response) => response.data),
}

export const settingsKeys = {
  detail: ['settings'] as const,
  preferences: ['project-preferences'] as const,
}
