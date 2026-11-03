import { api } from './client'

/** 应用用户与认证配置。应用用户身份与管理面管理员完全分离。 */
export type ApplicationSession = {
  id: string
  createdAt: string
  expiresAt: string
  status: string
  lastUsedAt?: string
}

export type AuthConfig = {
  emailPasswordEnabled: boolean
  selfRegistration: boolean
  sessionDurationDays: number
  emailVerification: 'off' | 'optional' | 'required'
}

export type AuthConfigState = {
  applied: AuthConfig
  pending: AuthConfig
  version: number
}

export type ApplicationUser = {
  recordId: string
  email: string
}

export const appAuthApi = {
  /** 应用用户就是 Auth 集合里的记录：创建、改密与会话走 appauth，资料读记录。 */
  list: (collectionId: string) =>
    api.get<{ data: ApplicationUser[]; nextCursor?: string }>(`/admin/api/v1/collections/${collectionId}/users`),

  create: (collectionId: string, profile: Record<string, unknown>, password: string) =>
    api.post<{ data: Record<string, unknown> }>(`/admin/api/v1/collections/${collectionId}/users`, { profile, password }),

  setPassword: (collectionId: string, recordId: string, password: string) =>
    api.put<void>(`/admin/api/v1/collections/${collectionId}/users/${recordId}/password`, { password }),

  sessions: (collectionId: string, recordId: string) =>
    api
      .get<{ data: ApplicationSession[] }>(`/admin/api/v1/collections/${collectionId}/users/${recordId}/sessions`)
      .then((response) => response.data),

  revoke: (collectionId: string, sessionId: string) =>
    api.post<void>(`/admin/api/v1/collections/${collectionId}/sessions/${sessionId}/revoke`),

  revokeAll: (collectionId: string, recordId: string) =>
    api.post<void>(`/admin/api/v1/collections/${collectionId}/users/${recordId}/sessions/revoke-all`),

  authentication: (collectionId: string) =>
    api
      .get<{ data: AuthConfigState }>(`/admin/api/v1/collections/${collectionId}/authentication`)
      .then((response) => response.data),

  saveAuthentication: (collectionId: string, expectedVersion: number, configuration: AuthConfig) =>
    api
      .put<{ data: AuthConfigState }>(`/admin/api/v1/collections/${collectionId}/authentication`, {
        expectedVersion,
        configuration,
      })
      .then((response) => response.data),

  applyAuthentication: (collectionId: string, expectedVersion: number) =>
    api.post(`/admin/api/v1/collections/${collectionId}/authentication/apply`, { expectedVersion }),

  discardAuthentication: (collectionId: string, expectedVersion: number) =>
    api.post(`/admin/api/v1/collections/${collectionId}/authentication/discard`, { expectedVersion }),
}

export const appAuthKeys = {
  users: (collectionId: string) => ['app-users', collectionId] as const,
  sessions: (collectionId: string, recordId: string) => ['app-sessions', collectionId, recordId] as const,
  config: (collectionId: string) => ['auth-config', collectionId] as const,
}
