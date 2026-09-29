// Spec 0001 §15 — legacy deep-link route mapping.
//
// 纯函数路由映射模块：把旧信息架构的稳定深链接映射到新版导航，
// 保留 resource identity 与 query/hash 上下文。该模块不依赖任何页面组件，
// 属于重建的首批交付；每一行映射由 route-map.test.ts 锁定。
//
// 映射语义：
// - 返回 null 表示该路径不需要映射（已经是新路径或未知路径，交给路由表/404 处理）。
// - `/login` 与 `/logout` 永不映射，登录前 returnTo 由 auth 模块自行解析。
// - `/automations`（无 tab）由路由表的 index redirect 处理，这里只映射 `?tab=` 变体。

export type MappedRoute = {
  pathname: string;
  search: string;
};

// 旧 `/automations?tab=*` 与新 Automations 子页的对应关系（R1 已对照
// admin/src/automation/pages.tsx 的 Tab 类型逐项确认）。
const legacyAutomationTabPaths: Record<string, string> = {
  webhooks: '/automations/webhooks',
  eventHooks: '/automations/triggers',
  jobs: '/automations/schedules',
  deliveries: '/automations/deliveries',
};

function normalizePathname(pathname: string): string {
  if (pathname.length <= 1) return '/';
  return pathname.replace(/\/+$/, '') || '/';
}

function isSingleSegment(segments: string[], name: string): boolean {
  return segments.length === 1 && segments[0] === name;
}

export function mapLegacyPath(pathname: string, search = ''): MappedRoute | null {
  const clean = normalizePathname(pathname);
  if (clean === '/') return null;
  const segments = clean.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  switch (segments[0]) {
    case 'login':
    case 'logout':
    case 'requests':
    case 'changes':
    case 'activity':
    case 'connect':
    case 'health':
      return null;

    case 'extensions': {
      // /extensions → /automations/hooks；/extensions/:extensionId → /automations/hooks/:extensionId
      if (segments.length === 1) return { pathname: '/automations/hooks', search };
      if (segments.length === 2 && segments[1]) return { pathname: `/automations/hooks/${encodeURIComponent(segments[1])}`, search };
      return null;
    }

    case 'automations': {
      if (segments.length > 1) return null; // 已是新路径
      const params = new URLSearchParams(search);
      const tab = params.get('tab');
      params.delete('tab');
      const target = legacyAutomationTabPaths[tab ?? ''] ?? '/automations/hooks';
      const kept = params.toString();
      return { pathname: target, search: kept ? `?${kept}` : '' };
    }

    case 'access': {
      // /access 保持不变；/access/audit[/:auditRecordId] → /activity/audit[/:auditRecordId]
      if (segments.length >= 2 && segments[1] === 'audit') {
        if (segments.length === 2) return { pathname: '/activity/audit', search };
        if (segments.length === 3 && segments[2]) return { pathname: `/activity/audit/${encodeURIComponent(segments[2])}`, search };
      }
      return null;
    }

    case 'administrators': {
      if (isSingleSegment(segments, 'administrators')) return { pathname: '/access/administrators', search };
      return null;
    }

    case 'secrets': {
      if (isSingleSegment(segments, 'secrets')) return { pathname: '/settings/secrets', search };
      return null;
    }

    case 'settings': {
      if (segments.length === 1) return null; // /settings 保持不变
      if (segments.length > 2) return null;
      switch (segments[1]) {
        case 'portability': // /settings/portability → /settings/backups（既有别名继续收敛）
          return { pathname: '/settings/backups', search };
        case 'developer': // /settings/developer → Connect / SDK & Contract
          return { pathname: '/connect/sdk', search };
        case 'mcp': // /settings/mcp → Connect / MCP
          return { pathname: '/connect/mcp', search };
        case 'drift': // /settings/drift → Model health
          return { pathname: '/health', search };
        // /settings/runtime|storage|mail|data|backups 在新 IA 中路径不变。
        default:
          return null;
      }
    }

    case 'api': {
      // /api → Connect / API
      if (isSingleSegment(segments, 'api')) return { pathname: '/connect/api', search };
      return null;
    }

    case 'collections': {
      // /collections、/collections/new、/collections/:collectionId[/api] 保持不变。
      // /collections/:collectionId/schema → model；/collections/:collectionId/security → access。
      if (segments.length === 3 && segments[1] && segments[2] === 'schema') {
        return { pathname: `/collections/${encodeURIComponent(segments[1])}/model`, search };
      }
      if (segments.length === 3 && segments[1] && segments[2] === 'security') {
        return { pathname: `/collections/${encodeURIComponent(segments[1])}/access`, search };
      }
      return null;
    }

    default:
      return null;
  }
}
