import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LocaleProvider } from '../i18n/i18n';
import { ChangeDiff } from './change-diff';

describe('变更属性对比', async () => {
  it('明确展示新增和删除的产品属性，保留类型与空值语义', async () => {
    render(<LocaleProvider><ChangeDiff changes={[
      { kind: 'field', action: 'add', name: 'count', after: { name: 'count', type: 'number', default: 0 } },
      { kind: 'field', action: 'remove', name: 'old', before: { name: 'old', type: 'text', unique: true } },
    ]} /></LocaleProvider>);
    expect(await screen.findByRole('heading', { name: 'Add field count' })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: 'Type — Number' })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: 'Default value — 0' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Remove field old' })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: 'Unique Yes —' })).toBeInTheDocument();
  });
  it('缺少历史快照时说明限制，不根据当前模型编造前后值', async () => {
    render(<LocaleProvider><ChangeDiff changes={[{ kind: 'index', action: 'update', name: 'lookup' }]} /></LocaleProvider>);
    expect(await screen.findByRole('heading', { name: 'Update index lookup' })).toBeInTheDocument();
    expect(screen.getByText('This history entry does not include before and after properties for comparison.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
