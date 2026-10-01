import type { ControlPlanePermission } from '../auth/client';

// Control Plane 的 fail closed 语义在 Admin Shell 中复现一次，供侧栏导航、
// 设置分节导航与命令面板共用（spec 0001 §3.4 / §11.2）。
// 没有显式 operation 的入口只对 Owner 可见；服务端仍是授权权威。

export type ControlPlaneRole = 'owner' | 'administrator' | undefined;

const readOnlyControlPlaneOperations = new Set([
  'runtime.read', 'storage.read', 'collections.read', 'records.read', 'files.read', 'schema.read',
  'accessRules.read', 'authentication.read', 'users.read', 'sessions.read', 'serviceAccounts.read',
  'apiKeys.read', 'requests.read', 'audit.read', 'administrators.read', 'mail.read',
  // #27/#28 新增的只读操作必须与后端 readOnly preset 保持一致。
  'activity.read', 'drift.read', 'policy.simulate', 'settings.read', 'records.export',
]);

export function allowsOperation(role: ControlPlaneRole, permission: ControlPlanePermission | undefined, operation: string): boolean {
  if (role === undefined || role === 'owner') return true;
  if (!permission) return false;
  switch (permission.preset) {
    case 'fullAccess': return true;
    case 'readOnly': return readOnlyControlPlaneOperations.has(operation);
    case 'custom': return (permission.customOperations ?? []).includes(operation);
    default: return false;
  }
}

export function canSeeNavigationItem(role: ControlPlaneRole, permission: ControlPlanePermission | undefined, item: { operation?: string }): boolean {
  if (item.operation === undefined) return role === undefined || role === 'owner';
  return allowsOperation(role, permission, item.operation);
}
