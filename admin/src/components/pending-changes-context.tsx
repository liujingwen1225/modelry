import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { listAllChanges, type ChangeListItem, type PendingChange } from '../collections/client';

// Spec 0001 §6.5：Model 页保存一次本地编辑后，操作成为 durable pending change。
// Shell 的 Changes 入口必须原地反映同一个事实（`N pending changes`），
// 因此这里持有跨页面的 pending 概览：Shell 首次加载时从 /changes 取一次，
// 页面保存 / 应用 / 丢弃后通过 report() 立即覆盖缓存，不引入新的后端接口。

export type PendingChangeSummary = {
  changeSetId: string;
  collectionId: string;
  version: number;
  status: PendingChange['status'];
  operationCount: number;
};

export function toPendingChangeSummary(pending: PendingChange): PendingChangeSummary {
  return {
    changeSetId: pending.changeSetId,
    collectionId: pending.collectionId,
    version: pending.version,
    status: pending.status,
    operationCount: pending.operations.length,
  };
}

export function isPendingChange(item: ChangeListItem): item is PendingChange {
  return Array.isArray((item as PendingChange).operations) && typeof (item as PendingChange).changeSetId === 'string';
}

type PendingChangesValue = {
  status: 'loading' | 'ready' | 'error';
  summaries: PendingChangeSummary[];
  byCollection: Record<string, PendingChangeSummary>;
  /** 全项目待应用操作总数（Shell 徽标与 Changes 入口共享同一数字）。 */
  pendingOperations: number;
  /** 需要关注的变更集数量：needsReview 或 failed。 */
  needsAttention: number;
  refresh: () => void;
  /** 页面拿到权威 PendingChange（含 null = 无待应用变更）后立即同步 Shell。 */
  report: (pending: PendingChange | null) => void;
};

// 页面在测试或独立挂载时可能没有 Shell 提供者；此时返回空概览并让 report
// 成为 no-op，页面自身的权威数据与错误处理不受影响。
const noPendingChanges: PendingChangesValue = {
  status: 'ready',
  summaries: [],
  byCollection: {},
  pendingOperations: 0,
  needsAttention: 0,
  refresh: () => undefined,
  report: () => undefined,
};

const PendingChangesContext = createContext<PendingChangesValue>(noPendingChanges);

function summarize(items: ChangeListItem[]): PendingChangeSummary[] {
  return items.filter(isPendingChange).map(toPendingChangeSummary);
}

export function PendingChangesProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [summaries, setSummaries] = useState<PendingChangeSummary[]>([]);
  const [generation, setGeneration] = useState(0);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void listAllChanges(controller.signal).then((items) => {
      if (controller.signal.aborted) return;
      setSummaries(summarize(Array.isArray(items) ? items : []));
      setStatus('ready');
    }).catch(() => {
      if (controller.signal.aborted) return;
      // 概览失败不影响任何页面的真实数据；Shell 保持无徽标并留给页面报错。
      setStatus('error');
    });
    return () => controller.abort();
  }, [generation]);

  const report = useCallback((pending: PendingChange | null) => {
    setSummaries((current) => {
      const others = current.filter((item) => item.collectionId !== pending?.collectionId);
      return pending ? [...others, toPendingChangeSummary(pending)] : others;
    });
    setStatus('ready');
  }, []);

  const value = useMemo<PendingChangesValue>(() => ({
    status,
    summaries,
    byCollection: Object.fromEntries(summaries.map((summary) => [summary.collectionId, summary])),
    pendingOperations: summaries.reduce((total, summary) => total + summary.operationCount, 0),
    needsAttention: summaries.filter((summary) => summary.status !== 'ready').length,
    refresh,
    report,
  }), [refresh, report, status, summaries]);

  return <PendingChangesContext.Provider value={value}>{children}</PendingChangesContext.Provider>;
}

export function usePendingChanges(): PendingChangesValue {
  return useContext(PendingChangesContext);
}
