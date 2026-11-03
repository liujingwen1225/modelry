import { api } from './client'

/** 管理面身份：Owner 或 Administrator 会话。应用用户身份与这里完全分离。 */
export type BootstrapStatus = { state: 'required' | 'closed' }

export type AdminOwner = { id: string; email: string }

export type AdminPermission = {
  preset: string
  customPermissionVersion?: number
  customOperations?: string[]
}

export type AdminSession = {
  owner: AdminOwner
  expiresAt: string
  role: string
  permission: AdminPermission
}

export type LoginResult = {
  owner: AdminOwner
  session: { expiresAt: string }
  role: string
  permission: AdminPermission
}

export const sessionApi = {
  bootstrapStatus: () => api.get<BootstrapStatus>('/admin/api/v1/bootstrap/status'),
  createOwner: (email: string, password: string) =>
    api.post<LoginResult>('/admin/api/v1/bootstrap/owner', { email, password }),
  login: (email: string, password: string) => api.post<LoginResult>('/admin/api/v1/auth/login', { email, password }),
  current: () => api.get<AdminSession>('/admin/api/v1/auth/session'),
  logout: () => api.post<void>('/admin/api/v1/auth/logout'),
}

export const sessionKeys = {
  bootstrap: ['bootstrap-status'] as const,
  current: ['admin-session'] as const,
}
