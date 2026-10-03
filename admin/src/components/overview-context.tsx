import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { fetchOverview, type OverviewSnapshot } from '../overview/client';
import { useOwnerSession } from '../auth/owner-session';
import { allowsOperation } from './permissions';

// Spec 0001 §3.4 / §5：侧栏计数与总览必须使用同一份实时事实，
// 否则同一个页面会出现两个不同数字。这里在 Shell 内取一次快照并共享；
// 失败时保留上一次成功值（如果有）并把状态暴露给调用方，让界面显示 Unavailable 而不是 0。
//
// `/overview` 由 `runtime.read` 控制（internal/permissions/controlplane.go）；
// 没有该权限的管理员（例如自定义 collections.read）不应该发起这个请求，
// 否则每次导航都会产生一个无意义的 403，计数也只会显示 Unavailable。

export type OverviewResource =
  | { state: 'loading'; value?: OverviewSnapshot; error?: undefined }
  | { state: 'ready'; value: OverviewSnapshot; error?: undefined }
  | { state: 'error'; value?: OverviewSnapshot; error: Error };

type OverviewContextValue = {
  overview: OverviewResource;
  refresh: () => void;
};

const OverviewContext = createContext<OverviewContextValue | null>(null);

export function OverviewProvider({ children }: { children: React.ReactNode }) {
  const { state: session } = useOwnerSession();
  const allowed = session.status === 'authenticated'
    ? allowsOperation(session.session.role, session.session.permission, 'runtime.read')
    : false;
  const [generation, setGeneration] = useState(0);
  const [overview, setOverview] = useState<OverviewResource>({ state: 'loading' });
  // 保存最近一次成功值，供失败时继续展示"最近已知事实"。
  const latest = useRef<OverviewSnapshot | undefined>(undefined);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    if (!allowed) {
      // 无权限时不请求、也不谎报数字：计数与卡片保持 Unavailable。
      setOverview({ state: 'error', error: new Error('Overview requires runtime.read.') });
      return;
    }
    const controller = new AbortController();
    setOverview((previous) => ({ state: 'loading', value: previous.value }));
    void fetchOverview(controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        latest.current = value;
        setOverview({ state: 'ready', value });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const next: OverviewResource = {
          state: 'error',
          error: error instanceof Error ? error : new Error('Overview request failed'),
        };
        if (latest.current) next.value = latest.current;
        setOverview(next);
      },
    );
    return () => controller.abort();
  }, [allowed, generation]);

  const value = useMemo(() => ({ overview, refresh }), [overview, refresh]);
  return <OverviewContext.Provider value={value}>{children}</OverviewContext.Provider>;
}

export function useOverview(): OverviewContextValue {
  const context = useContext(OverviewContext);
  if (!context) throw new Error('useOverview must be used inside OverviewProvider.');
  return context;
}
