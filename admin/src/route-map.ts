// Spec 0001 §15 — legacy deep-link route mapping.
//
// 纯函数路由映射模块：把旧信息架构的稳定深链接映射到新版「业务优先」导航
// （WORKSPACE / BUILD / OPERATE / SYSTEM），保留 resource identity 与 query/hash 上下文。
// 该模块不依赖任何页面组件，属于重建的首批交付；每一行映射由 route-map.test.ts 锁定。
//
// 新版 canonical 路径：
//   /                                  总览
//   /collections[/new|/:collectionId[/model|/access|/api]]   集合
//   /api[?tab=endpoints|playground|openapi|logs]             API 工作区
//   /api/requests/:requestId                                  请求详情
//   /events[?tab=hooks|webhooks|triggers|deliveries]         Hooks & Events
//   /events/hooks/:extensionId                                Hook 详情
//   /schedules[?tab=jobs|history]                            定时任务
//   /changes[?tab=pending|history|drift]                     变更
//   /access[?tab=administrators|auth|tokens]                 访问与认证
//   /activity[?source=audit|facts]                           活动记录
//   /activity/audit/:auditRecordId                           审计详情
//   /settings[/runtime|/storage|/mail|/secrets|/data|/backups]  系统设置
//   /mcp                                                      MCP 接入说明（不占一级菜单）
//
// 映射语义：
// - 返回 null 表示该路径不需要映射（已经是 canonical 路径或未知路径，交给路由表/404 处理）。
// - `/login` 与 `/logout` 永不映射，登录前 returnTo 由 auth 模块自行解析。
// - 已被 canonical 路径吸收的 query 参数（`tab`、`view`、`source`）在映射时被消费，
//   其余 query/hash 原样保留。

export type MappedRoute = {
  pathname: string;
  search: string;
};

// 旧 `/automations?tab=*` 的目标。定时任务已从 Hooks & Events 拆成独立一级入口，
// 因此 jobs 进入 `/schedules`，其余进入 `/events`。
const legacyAutomationTabTargets: Record<string, string> = {
  hooks: '/events',
  webhooks: '/events',
  eventHooks: '/events',
  deliveries: '/events',
  jobs: '/schedules',
};

// 旧 `/automations/<segment>` 路径段到新目标的映射。
const legacyAutomationSegments: Record<string, string> = {
  hooks: '/events',
  webhooks: '/events',
  triggers: '/events',
  deliveries: '/events',
  schedules: '/schedules',
};

// 旧 `/automations/<segment>` 的 tab 值。
const legacyAutomationSegmentTabs: Record<string, string> = {
  hooks: 'hooks',
  webhooks: 'webhooks',
  triggers: 'triggers',
  deliveries: 'deliveries',
  schedules: 'jobs',
};

function normalizePathname(pathname: string): string {
  if (pathname.length <= 1) return '/';
  return pathname.replace(/\/+$/, '') || '/';
}

// withTab 在保留其它 query 的前提下设置 `tab`；`tab` 放在最前，
// 让映射结果稳定可断言，也便于人工阅读分享出去的链接。
function withTab(search: string, tab: string | null): string {
  const params = new URLSearchParams(search);
  params.delete('tab');
  const kept = params.toString();
  if (tab === null) return kept ? `?${kept}` : '';
  return kept ? `?tab=${tab}&${kept}` : `?tab=${tab}`;
}

// withQuery 在保留其它 query 的前提下覆盖若干参数。
function withQuery(search: string, values: Record<string, string | null>): string {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(values)) {
    params.delete(key);
    if (value !== null) params.set(key, value);
  }
  const kept = params.toString();
  return kept ? `?${kept}` : '';
}

export function mapLegacyPath(pathname: string, search = ''): MappedRoute | null {
  const clean = normalizePathname(pathname);
  if (clean === '/') return null;
  const segments = clean.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  switch (segments[0]) {
    case 'login':
    case 'logout':
    case 'changes':
    case 'events':
    case 'schedules':
    case 'mcp':
      // `/changes`、`/events`、`/schedules`、`/mcp` 已是 canonical；
      // `/changes?view=` 与 `/events/hooks` 这两种历史形式由下方收敛。
      if (segments[0] === 'changes' && segments.length === 1) {
        const params = new URLSearchParams(search);
        const view = params.get('view');
        if (view === null) return null;
        params.delete('view');
        const tab = view === 'applied' || view === 'history' ? 'history' : 'pending';
        return { pathname: '/changes', search: withTab(`?${params.toString()}`, tab) };
      }
      // Hooks 列表在 `/events?tab=hooks`；裸 `/events/hooks` 是它的历史写法。
      if (segments[0] === 'events' && segments.length === 2 && segments[1] === 'hooks') {
        return { pathname: '/events', search: withTab(search, 'hooks') };
      }
      return null;

    case 'collections': {
      // 集合列表、新建与工作区深链接保持不变；历史子页 `schema` / `security`
      // 收敛到新的 `model` / `access`（spec 0001 §15），否则服务端写入的
      // deep link（drift 修复入口、Activity fact）会落到 404。
      if (segments.length === 3 && segments[1] && segments[2] === 'schema') {
        return { pathname: `/collections/${encodeURIComponent(segments[1])}/model`, search };
      }
      if (segments.length === 3 && segments[1] && segments[2] === 'security') {
        return { pathname: `/collections/${encodeURIComponent(segments[1])}/access`, search };
      }
      return null;
    }

    case 'api':
      // `/api` 是新的 API 工作区 canonical 路径；旧的 `/api?tab=realtime` 只属于集合级 API，
      // 这里交给页面把未知 tab 归一到 endpoints。
      return null;

    case 'connect': {
      if (segments.length === 1) return { pathname: '/api', search: withTab(search, 'endpoints') };
      if (segments.length === 2 && segments[1] === 'api') return { pathname: '/api', search: withTab(search, 'endpoints') };
      if (segments.length === 2 && segments[1] === 'sdk') return { pathname: '/api', search: withTab(search, 'openapi') };
      if (segments.length === 2 && segments[1] === 'mcp') return { pathname: '/mcp', search };
      return null;
    }

    case 'extensions': {
      // /extensions → Hooks & Events / Hooks；/extensions/:extensionId → 对应 Hook 详情。
      if (segments.length === 1) return { pathname: '/events', search: withTab(search, 'hooks') };
      if (segments.length === 2 && segments[1]) return { pathname: `/events/hooks/${encodeURIComponent(segments[1])}`, search };
      return null;
    }

    case 'automations': {
      if (segments.length === 1) {
        const params = new URLSearchParams(search);
        const tab = params.get('tab');
        params.delete('tab');
        const kept = params.toString();
        const target = legacyAutomationTabTargets[tab ?? ''] ?? '/events';
        const targetTab = tab && legacyAutomationTabTargets[tab] ? (target === '/schedules' ? 'jobs' : tab === 'eventHooks' ? 'triggers' : tab) : 'hooks';
        return { pathname: target, search: kept ? `?tab=${targetTab}&${kept}` : `?tab=${targetTab}` };
      }
      const segment = segments[1] ?? '';
      const target = legacyAutomationSegments[segment];
      if (!target) return null;
      const tab = legacyAutomationSegmentTabs[segment] ?? null;
      if (segments.length === 2) return { pathname: target, search: withTab(search, tab) };
      // /automations/hooks/:extensionId → /events/hooks/:extensionId
      if (segment === 'hooks' && segments.length === 3 && segments[2]) {
        return { pathname: `/events/hooks/${encodeURIComponent(segments[2])}`, search };
      }
      return null;
    }

    case 'requests': {
      if (segments.length === 1) return { pathname: '/api', search: withTab(search, 'logs') };
      if (segments.length === 2 && segments[1]) return { pathname: `/api/requests/${encodeURIComponent(segments[1])}`, search };
      return null;
    }

    case 'health': {
      if (segments.length !== 1) return null;
      return { pathname: '/changes', search: withTab(search, 'drift') };
    }

    case 'access': {
      // 裸 /access 是 canonical（页面默认「管理员」Tab）；旧 /access/administrators 别名收敛到同一工作面。
      if (segments.length === 1) return null;
      if (segments[1] === 'administrators' && segments.length === 2) {
        return { pathname: '/access', search: withTab(search, 'administrators') };
      }
      if (segments[1] === 'audit') {
        if (segments.length === 2) return { pathname: '/activity', search: withQuery(search, { source: 'audit' }) };
        if (segments.length === 3 && segments[2]) return { pathname: `/activity/audit/${encodeURIComponent(segments[2])}`, search };
      }
      return null;
    }

    case 'administrators': {
      if (segments.length === 1) return { pathname: '/access', search: withTab(search, 'administrators') };
      return null;
    }

    case 'secrets': {
      if (segments.length === 1) return { pathname: '/settings/secrets', search };
      return null;
    }

    case 'settings': {
      if (segments.length === 1) return null;
      if (segments.length > 2) return null;
      switch (segments[1]) {
        case 'portability': // /settings/portability → Settings / 备份与恢复
          return { pathname: '/settings/backups', search };
        case 'developer': // /settings/developer → API 工作区 / OpenAPI
          return { pathname: '/api', search: withTab(search, 'openapi') };
        case 'mcp': // /settings/mcp → MCP 接入说明
          return { pathname: '/mcp', search };
        case 'drift': // /settings/drift → 变更 / 结构漂移
          return { pathname: '/changes', search: withTab(search, 'drift') };
        // /settings/runtime|storage|mail|secrets|data|backups 在新 IA 中路径不变。
        default:
          return null;
      }
    }

    case 'activity': {
      // /activity 与 /activity/audit/:id 已是 canonical；裸 /activity/audit 收敛到审计筛选。
      if (segments.length === 2 && segments[1] === 'audit') {
        return { pathname: '/activity', search: withQuery(search, { source: 'audit' }) };
      }
      return null;
    }

    default:
      return null;
  }
}
