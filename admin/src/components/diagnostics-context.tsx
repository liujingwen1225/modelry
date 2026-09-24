import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiClientError } from '../api/client';
import { fetchRuntimeStatus, fetchStorageStatus, type RuntimeStatus, type StorageStatus } from '../api/status';
import { useOwnerSession } from '../auth/owner-session';

type Resource<T> =
  | { state: 'loading'; value?: T; error?: undefined }
  | { state: 'ready'; value: T; error?: undefined }
  | { state: 'error'; value?: T; error: ApiClientError | Error };

type Diagnostics = {
  runtime: Resource<RuntimeStatus>;
  storage: Resource<StorageStatus>;
  refresh: () => void;
};

const DiagnosticsContext = createContext<Diagnostics | null>(null);

export function DiagnosticsProvider({ children }: { children: React.ReactNode }) {
  const { state: ownerSession } = useOwnerSession();
  const [generation, setGeneration] = useState(0);
  const [runtime, setRuntime] = useState<Resource<RuntimeStatus>>({ state: 'loading' });
  const [storage, setStorage] = useState<Resource<StorageStatus>>({ state: 'loading' });

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    if (ownerSession.status === 'loading') return;
    const controller = new AbortController();
    setRuntime((previous) => ({ state: 'loading', value: previous.value }));
    setStorage((previous) => ({ state: 'loading', value: previous.value }));

    void fetchRuntimeStatus(controller.signal).then(
      (value) => setRuntime({ state: 'ready', value }),
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setRuntime({ state: 'error', error: error instanceof Error ? error : new Error('Request failed') });
        }
      },
    );

    void fetchStorageStatus(controller.signal).then(
      (value) => setStorage({ state: 'ready', value }),
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setStorage({ state: 'error', error: error instanceof Error ? error : new Error('Request failed') });
        }
      },
    );

    return () => controller.abort();
  }, [generation, ownerSession.status]);

  const value = useMemo(() => ({ runtime, storage, refresh }), [runtime, storage, refresh]);
  return <DiagnosticsContext.Provider value={value}>{children}</DiagnosticsContext.Provider>;
}

export function useDiagnostics(): Diagnostics {
  const context = useContext(DiagnosticsContext);
  if (!context) throw new Error('useDiagnostics must be used inside DiagnosticsProvider.');
  return context;
}

export function errorFromResource(resource: Resource<unknown>): ApiClientError | null {
  return resource.state === 'error' && resource.error instanceof ApiClientError ? resource.error : null;
}
