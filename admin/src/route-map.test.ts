import { describe, expect, it } from 'vitest';
import { mapLegacyPath } from './route-map';

// Spec 0001 §15：旧路径映射实现为独立纯函数模块，并配套覆盖每一行的单元测试。
// 新版 canonical：/、/collections*、/api*、/events*、/schedules、/changes、/access、
// /activity*、/settings*、/mcp。

function mapped(pathname: string, search = ''): string {
  const result = mapLegacyPath(pathname, search);
  if (result === null) return pathname + (search || '');
  return `${result.pathname}${result.search}`;
}

describe('route map — 不映射的路径', () => {
  it('keeps the root path untouched', () => {
    expect(mapLegacyPath('/')).toBeNull();
  });

  it('never remaps login or logout', () => {
    expect(mapLegacyPath('/login', '?returnTo=%2Fchanges')).toBeNull();
    expect(mapLegacyPath('/logout')).toBeNull();
  });

  it('keeps canonical navigation paths untouched', () => {
    for (const path of [
      '/api',
      '/api/requests/req_1',
      '/events',
      '/events/hooks/ext_1',
      '/schedules',
      '/changes',
      '/access',
      '/activity',
      '/activity/audit/audit_1',
      '/agent',
      '/settings',
      '/settings/runtime',
      '/settings/storage',
      '/settings/mail',
      '/settings/secrets',
      '/settings/data',
      '/settings/backups',
    ]) {
      expect(mapLegacyPath(path), path).toBeNull();
    }
  });

  it('keeps collection list, create and workspace deep links unchanged', () => {
    expect(mapLegacyPath('/collections')).toBeNull();
    expect(mapLegacyPath('/collections/new')).toBeNull();
    expect(mapLegacyPath('/collections/c_1')).toBeNull();
    expect(mapLegacyPath('/collections/c_1/model')).toBeNull();
    expect(mapLegacyPath('/collections/c_1/access')).toBeNull();
    expect(mapLegacyPath('/collections/c_1/api', '?tab=realtime')).toBeNull();
  });

  it('returns null for unknown paths', () => {
    expect(mapLegacyPath('/nope')).toBeNull();
    expect(mapLegacyPath('/collections/c_1/unknown')).toBeNull();
    expect(mapLegacyPath('/extensions/a/b')).toBeNull();
    expect(mapLegacyPath('/settings/storage/extra')).toBeNull();
    expect(mapLegacyPath('/connect/nope')).toBeNull();
    expect(mapLegacyPath('/automations/nope')).toBeNull();
    expect(mapLegacyPath('/health/extra')).toBeNull();
  });
});

it('旧 MCP 链接保留会话及其他查询参数', () => {
  expect(mapped('/mcp', '?session=ags_1&tab=old')).toBe('/agent?tab=mcp&session=ags_1');
});

describe('route map — /connect → API 工作区', () => {
  it('maps bare /connect and /connect/api to the endpoints tab', () => {
    expect(mapped('/connect')).toBe('/api?tab=endpoints');
    expect(mapped('/connect/api')).toBe('/api?tab=endpoints');
    expect(mapped('/connect/api', '?collection=c_1')).toBe('/api?tab=endpoints&collection=c_1');
  });

  it('maps SDK and contract deep links to the OpenAPI tab', () => {
    expect(mapped('/connect/sdk')).toBe('/api?tab=openapi');
    expect(mapped('/settings/developer')).toBe('/api?tab=openapi');
    expect(mapped('/settings/developer', '?q=sdk')).toBe('/api?tab=openapi&q=sdk');
  });

  it('maps MCP deep links to the MCP guide', () => {
    expect(mapped('/connect/mcp')).toBe('/agent?tab=mcp');
    expect(mapped('/settings/mcp')).toBe('/agent?tab=mcp');
  });
});

describe('route map — /extensions → Hooks & Events / Hooks', () => {
  it('maps the list and detail', () => {
    expect(mapped('/extensions')).toBe('/events?tab=hooks');
    expect(mapped('/extensions/ext_9')).toBe('/events/hooks/ext_9');
    expect(mapped('/extensions/ext_9', '?tab=runs')).toBe('/events/hooks/ext_9?tab=runs');
  });

  it('encodes the extension id', () => {
    expect(mapped('/extensions/ext%2F9')).toBe('/events/hooks/ext%252F9');
  });

  it('collapses the bare Hooks list path onto its tab', () => {
    // 裸 `/events/hooks` 是 Hooks 列表的历史写法，必须落到同一个工作面而不是 404。
    expect(mapped('/events/hooks')).toBe('/events?tab=hooks');
    expect(mapped('/events/hooks', '?q=mail')).toBe('/events?tab=hooks&q=mail');
    expect(mapLegacyPath('/events/hooks/ext_9')).toBeNull();
  });
});

describe('route map — /automations → Hooks & Events 与定时任务', () => {
  it('maps the legacy tab query to the new tab', () => {
    expect(mapped('/automations', '?tab=hooks')).toBe('/events?tab=hooks');
    expect(mapped('/automations', '?tab=webhooks')).toBe('/events?tab=webhooks');
    expect(mapped('/automations', '?tab=eventHooks')).toBe('/events?tab=triggers');
    expect(mapped('/automations', '?tab=deliveries')).toBe('/events?tab=deliveries');
    expect(mapped('/automations', '?tab=jobs')).toBe('/schedules?tab=jobs');
  });

  it('keeps other query context while consuming the legacy tab', () => {
    expect(mapped('/automations', '?tab=deliveries&deliveryId=dl_1&source=test')).toBe('/events?tab=deliveries&deliveryId=dl_1&source=test');
    expect(mapped('/automations', '?tab=jobs&create=1')).toBe('/schedules?tab=jobs&create=1');
  });

  it('defaults a bare or unknown legacy tab to Hooks', () => {
    expect(mapped('/automations')).toBe('/events?tab=hooks');
    expect(mapped('/automations', '?tab=legacy')).toBe('/events?tab=hooks');
  });

  it('maps the historical path segments', () => {
    expect(mapped('/automations/hooks')).toBe('/events?tab=hooks');
    expect(mapped('/automations/webhooks')).toBe('/events?tab=webhooks');
    expect(mapped('/automations/triggers')).toBe('/events?tab=triggers');
    expect(mapped('/automations/deliveries')).toBe('/events?tab=deliveries');
    expect(mapped('/automations/deliveries', '?deliveryId=dl_1')).toBe('/events?tab=deliveries&deliveryId=dl_1');
    expect(mapped('/automations/schedules')).toBe('/schedules?tab=jobs');
    expect(mapped('/automations/hooks/ext_9')).toBe('/events/hooks/ext_9');
  });
});

describe('route map — /requests → API 工作区 / 请求日志', () => {
  it('maps the list to the logs tab', () => {
    expect(mapped('/requests')).toBe('/api?tab=logs');
    expect(mapped('/requests', '?search=req_1&filter=status+eq+403')).toBe('/api?tab=logs&search=req_1&filter=status+eq+403');
  });

  it('maps request detail to the same Request Detail', () => {
    expect(mapped('/requests/req_12345678')).toBe('/api/requests/req_12345678');
    expect(mapped('/requests/req_12345678', '?from=%2Fapi%3Ftab%3Dlogs')).toBe('/api/requests/req_12345678?from=%2Fapi%3Ftab%3Dlogs');
  });
});

describe('route map — /health 与 /settings/drift → 变更 / 结构漂移', () => {
  it('maps both drift entry points', () => {
    expect(mapped('/health')).toBe('/changes?tab=drift');
    expect(mapped('/settings/drift')).toBe('/changes?tab=drift');
    expect(mapped('/settings/drift', '?q=posts')).toBe('/changes?tab=drift&q=posts');
  });
});

describe('route map — /changes?view → 变更 tab', () => {
  it('maps legacy view values onto the new tab', () => {
    expect(mapped('/changes', '?view=pending')).toBe('/changes?tab=pending');
    expect(mapped('/changes', '?view=applied')).toBe('/changes?tab=history');
    expect(mapped('/changes', '?view=history')).toBe('/changes?tab=history');
    expect(mapped('/changes', '?view=all')).toBe('/changes?tab=pending');
  });

  it('keeps other query context while consuming view', () => {
    expect(mapped('/changes', '?q=posts&view=pending')).toBe('/changes?tab=pending&q=posts');
  });

  it('leaves an explicit tab untouched', () => {
    expect(mapLegacyPath('/changes', '?tab=drift')).toBeNull();
  });
});

describe('route map — 访问与认证与活动记录', () => {
  it('maps administrators into the access tabs', () => {
    expect(mapped('/administrators')).toBe('/access?tab=administrators');
    expect(mapped('/access/administrators')).toBe('/access?tab=administrators');
    // 裸 /access 是 canonical：页面默认「管理员」Tab，不需要重写。
    expect(mapLegacyPath('/access')).toBeNull();
  });

  it('maps audit deep links into 活动记录', () => {
    expect(mapped('/access/audit')).toBe('/activity?source=audit');
    expect(mapped('/activity/audit')).toBe('/activity?source=audit');
    expect(mapped('/activity/audit', '?action=serviceAccount.created')).toBe('/activity?action=serviceAccount.created&source=audit');
    expect(mapped('/access/audit/audit_1')).toBe('/activity/audit/audit_1');
    expect(mapped('/access/audit/audit_1', '?from=%2Factivity')).toBe('/activity/audit/audit_1?from=%2Factivity');
  });
});

describe('route map — Secrets 与集合子页', () => {
  it('maps the legacy Secrets path', () => {
    expect(mapped('/secrets')).toBe('/settings/secrets');
    expect(mapped('/secrets', '?q=provider')).toBe('/settings/secrets?q=provider');
  });

  it('maps collection schema and security sub-pages', () => {
    expect(mapped('/collections/c_1/schema')).toBe('/collections/c_1/model');
    expect(mapped('/collections/c_1/security')).toBe('/collections/c_1/access');
    expect(mapped('/collections/c_1/schema', '?view=relations')).toBe('/collections/c_1/model?view=relations');
  });

  it('maps the portability alias to Backup & restore', () => {
    expect(mapped('/settings/portability')).toBe('/settings/backups');
  });
});

describe('route map — 尾斜杠与重复斜杠', () => {
  it('normalizes trailing slashes before mapping', () => {
    expect(mapped('/extensions/')).toBe('/events?tab=hooks');
    expect(mapped('/settings/drift///')).toBe('/changes?tab=drift');
    expect(mapped('/requests/')).toBe('/api?tab=logs');
  });
});
