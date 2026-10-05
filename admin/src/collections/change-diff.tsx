import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import type { PreviewTranslate } from './preview-copy';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function changeSummary(change: Record<string, unknown>, t: PreviewTranslate) {
  const kind = change.kind === 'index' ? 'index' : change.kind === 'relation' ? 'relation' : 'field';
  const action = change.action === 'add' ? 'add' : change.action === 'remove' ? 'remove' : 'update';
  const name = change.name ?? record(change.after).name ?? record(change.before).name ?? t('changes.savedItem');
  return `${t(`changes.diffActions.${action}`)}${t('changes.diffSummarySeparator')}${t(`changes.diffKinds.${kind}`)} ${String(name)}`;
}

const properties = ['name', 'type', 'required', 'unique', 'description', 'default', 'validation', 'relation', 'fields'] as const;

// 比较产品属性，忽略系统生成的 ID；省略的约束与 false 表达相同语义。
function propertyValue(value: Record<string, unknown>, property: string): unknown {
  if (property === 'required' || property === 'unique') return value[property] === true;
  return value[property];
}

export function ChangeDiff({ changes }: { changes: Array<Record<string, unknown>> }) {
  const { t } = useI18n();
  function display(value: unknown, property: string): string {
    if (value === undefined || value === '') return t('changes.noValue');
    if (typeof value === 'boolean') return t(value ? 'changes.enabled' : 'changes.disabled');
    if (property === 'type' && ['text', 'number', 'boolean', 'dateTime', 'json', 'relation', 'file', 'files'].includes(String(value))) return t(`schema.fieldTypes.${value}` as TranslationKey);
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  return <div className="flex min-w-0 flex-col gap-4" data-change-diff>{changes.map((change, index) => {
    const before = record(change.before);
    const after = record(change.after);
    const rows = properties.filter((property) => {
      if (!(property in before) && !(property in after)) return false;
      return change.action !== 'update' || JSON.stringify(propertyValue(before, property)) !== JSON.stringify(propertyValue(after, property));
    });
    return <section className="min-w-0 border-b pb-4 last:border-b-0 last:pb-0" key={index}>
      <h4 className="mb-2 text-sm font-semibold">{changeSummary(change, t)}</h4>
      {rows.length > 0 ? <Table className="table-fixed text-xs">
        <TableHeader><TableRow><TableHead className="w-1/4">{t('changes.property')}</TableHead><TableHead>{t('changes.before')}</TableHead><TableHead>{t('changes.after')}</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map((property) => <TableRow key={property}>
          <TableCell className="whitespace-normal break-words text-muted-foreground">{t(`changes.properties.${property}`)}</TableCell>
          <TableCell className="whitespace-pre-wrap break-words">{change.action === 'add' ? '—' : display(propertyValue(before, property), property)}</TableCell>
          <TableCell className="whitespace-pre-wrap break-words font-medium">{change.action === 'remove' ? '—' : display(propertyValue(after, property), property)}</TableCell>
        </TableRow>)}</TableBody>
      </Table> : <p className="text-xs text-muted-foreground">{t('changes.comparisonUnavailable')}</p>}
    </section>;
  })}</div>;
}
