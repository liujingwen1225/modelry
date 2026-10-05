import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const ActionSlot = createContext<HTMLDivElement | null | undefined>(undefined);

// 工作面操作保留原组件的状态和事件，统一显示到导航右侧。
export function WorkspaceToolbar({ navigation, children }: { navigation: ReactNode; children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return <ActionSlot.Provider value={target}>
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-h-12 min-w-0 flex-wrap items-center justify-between gap-3 border-b pb-2" data-workspace-toolbar>
        <div className="min-w-0 flex-1">{navigation}</div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2" ref={setTarget} />
      </div>
      {children}
    </div>
  </ActionSlot.Provider>;
}

export function WorkspaceActions({ children }: { children: ReactNode }) {
  const target = useContext(ActionSlot);
  if (target === undefined) return <>{children}</>;
  return target ? createPortal(children, target) : null;
}
