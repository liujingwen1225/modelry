import { describe, expect, it } from 'vitest';
import { mapLegacyPath } from './route-map';

// Spec 0001 §15：旧路径映射实现为独立纯函数模块，并配套覆盖每一行的单元测试。

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

  it('keeps already-new paths untouched', () => {
    expect(mapLegacyPath('/automations/hooks')).toBeNull();
    expect(mapLegacyPath('/automations/webhooks')).toBeNull();
    expect(mapLegacyPath('/automations/triggers')).toBeNull();
    expect(mapLegacyPath('/automations/schedules')).toBeNull();
    expect(mapLegacyPath('/automations/deliveries')).toBeNull();
    expect(mapLegacyPath('/connect/api')).toBeNull();
    expect(mapLegacyPath('/connect/sdk')).toBeNull();
    expect(mapLegacyPath('/connect/mcp')).toBeNull();
    expect(mapLegacyPath('/activity/audit')).toBeNull();
    expect(mapLegacyPath('/activity/audit/audit_1')).toBeNull();
    expect(mapLegacyPath('/access/administrators')).toBeNull();
    expect(mapLegacyPath('/settings/secrets')).toBeNull();
    expect(mapLegacyPath('/health')).toBeNull();
  });

  it('keeps requests, changes, activity, access, settings unchanged', () => {
    expect(mapLegacyPath('/requests/req_1')).toBeNull();
    expect(mapLegacyPath('/changes')).toBeNull();
    expect(mapLegacyPath('/activity')).toBeNull();
    expect(mapLegacyPath('/access')).toBeNull();
    expect(mapLegacyPath('/settings')).toBeNull();
    expect(mapLegacyPath('/settings/runtime')).toBeNull();
    expect(mapLegacyPath('/settings/storage')).toBeNull();
    expect(mapLegacyPath('/settings/mail')).toBeNull();
    expect(mapLegacyPath('/settings/data')).toBeNull();
    expect(mapLegacyPath('/settings/backups')).toBeNull();
  });

  it('keeps collection list, create and api deep links unchanged', () => {
    expect(mapLegacyPath('/collections')).toBeNull();
    expect(mapLegacyPath('/collections/new')).toBeNull();
    expect(mapLegacyPath('/collections/c_1')).toBeNull();
    expect(mapLegacyPath('/collections/c_1/api', '?tab=realtime')).toBeNull();
  });

  it('returns null for unknown paths', () => {
    expect(mapLegacyPath('/nope')).toBeNull();
    expect(mapLegacyPath('/collections/c_1/unknown')).toBeNull();
    expect(mapLegacyPath('/extensions/a/b')).toBeNull();
    expect(mapLegacyPath('/settings/storage/extra')).toBeNull();
  });
});

describe('route map — /extensions → Automations / Hooks', () => {
  it('maps the list', () => {
    expect(mapped('/extensions')).toBe('/automations/hooks');
  });

  it('maps the detail with extension id', () => {
    expect(mapped('/extensions/ext_9')).toBe('/automations/hooks/ext_9');
  });
});

describe('route map — /automations?tab= 路径子导航', () => {
  it('maps tab=webhooks', () => {
    expect(mapped('/automations', '?tab=webhooks')).toBe('/automations/webhooks');
  });

  it('maps tab=eventHooks to triggers', () => {
    expect(mapped('/automations', '?tab=eventHooks')).toBe('/automations/triggers');
  });

  it('maps tab=jobs to schedules', () => {
    expect(mapped('/automations', '?tab=jobs')).toBe('/automations/schedules');
  });

  it('maps tab=deliveries and keeps sibling params', () => {
    expect(mapped('/automations', '?tab=deliveries&deliveryId=dl_1&source=test')).toBe(
      '/automations/deliveries?deliveryId=dl_1&source=test',
    );
  });

  it('falls back to hooks for unknown tab values', () => {
    expect(mapped('/automations', '?tab=legacy')).toBe('/automations/hooks');
  });

  it('redirects bare /automations to the hooks subpage', () => {
    expect(mapped('/automations')).toBe('/automations/hooks');
  });
});

describe('route map — audit 与管理员', () => {
  it('maps /access/audit to /activity/audit', () => {
    expect(mapped('/access/audit', '?actor=sa_1')).toBe('/activity/audit?actor=sa_1');
  });

  it('maps /access/audit/:auditRecordId with the record id', () => {
    expect(mapped('/access/audit/audit_7')).toBe('/activity/audit/audit_7');
  });

  it('maps /administrators to /access/administrators', () => {
    expect(mapped('/administrators')).toBe('/access/administrators');
  });
});

describe('route map — Settings 与 Connect', () => {
  it('maps /secrets to /settings/secrets', () => {
    expect(mapped('/secrets')).toBe('/settings/secrets');
  });

  it('keeps the /settings/portability alias converging on /settings/backups', () => {
    expect(mapped('/settings/portability')).toBe('/settings/backups');
  });

  it('maps /settings/developer to /connect/sdk', () => {
    expect(mapped('/settings/developer')).toBe('/connect/sdk');
  });

  it('maps /settings/mcp to /connect/mcp', () => {
    expect(mapped('/settings/mcp')).toBe('/connect/mcp');
  });

  it('maps /settings/drift to /health', () => {
    expect(mapped('/settings/drift')).toBe('/health');
  });

  it('maps /api to /connect/api', () => {
    expect(mapped('/api', '?q=records')).toBe('/connect/api?q=records');
  });
});

describe('route map — Collection 工作区', () => {
  it('maps schema to model', () => {
    expect(mapped('/collections/c_1/schema', '?field=title')).toBe('/collections/c_1/model?field=title');
  });

  it('maps security to access', () => {
    expect(mapped('/collections/c_1/security')).toBe('/collections/c_1/access');
  });
});

describe('route map — 输入归一化', () => {
  it('strips trailing slashes', () => {
    expect(mapped('/extensions/')).toBe('/automations/hooks');
    expect(mapped('/settings/drift///')).toBe('/health');
  });

  it('preserves search verbatim for pass-through mappings', () => {
    expect(mapped('/access/audit/audit_2', '?actor=admin&page=2')).toBe('/activity/audit/audit_2?actor=admin&page=2');
  });
});
