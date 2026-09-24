import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiClientError } from '../api/client';
import { fetchOwnerSession, logoutOwner, type OwnerSessionResponse } from './client';

export type OwnerSessionState =
  | { status: 'loading' }
  | { status: 'anonymous'; sessionExpired: boolean }
  | { status: 'authenticated'; session: OwnerSessionResponse }
  | { status: 'error'; error: unknown };

export type OwnerSessionContextValue = {
  state: OwnerSessionState;
  refresh: (signal?: AbortSignal) => Promise<OwnerSessionResponse | null>;
  logout: () => Promise<void>;
};

const OwnerSessionContext = createContext<OwnerSessionContextValue | null>(null);
const SESSION_MARKER = 'modelry-owner-session-active';

function sessionWasActive(): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_MARKER) === 'true';
  } catch {
    return false;
  }
}

function rememberActiveSession(active: boolean): void {
  try {
    if (active) window.sessionStorage.setItem(SESSION_MARKER, 'true');
    else window.sessionStorage.removeItem(SESSION_MARKER);
  } catch {
    // Session Storage 只用于提示界面；Runtime 才是 Session 的权威来源。
  }
}

export function OwnerSessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OwnerSessionState>({ status: 'loading' });

  const refresh = useCallback(async (signal?: AbortSignal): Promise<OwnerSessionResponse | null> => {
    setState({ status: 'loading' });
    try {
      const session = await fetchOwnerSession(signal);
      rememberActiveSession(true);
      setState({ status: 'authenticated', session });
      return session;
    } catch (error) {
      if (signal?.aborted) return null;
      if (error instanceof ApiClientError && error.status === 401) {
        setState({ status: 'anonymous', sessionExpired: sessionWasActive() });
        return null;
      }
      setState({ status: 'error', error });
      throw error;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (state.status !== 'authenticated') return;
    const expiry = Date.parse(state.session.expiresAt);
    if (!Number.isFinite(expiry)) return;
    const delay = Math.max(0, expiry - Date.now() + 250);
    const timer = window.setTimeout(() => { void refresh().catch(() => undefined); }, delay);
    return () => window.clearTimeout(timer);
  }, [refresh, state]);

  const logout = useCallback(async () => {
    try {
      await logoutOwner();
      rememberActiveSession(false);
      setState({ status: 'anonymous', sessionExpired: false });
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        rememberActiveSession(false);
        setState({ status: 'anonymous', sessionExpired: false });
        return;
      }
      setState({ status: 'error', error });
      throw error;
    }
  }, []);

  const value = useMemo(() => ({ state, refresh, logout }), [state, refresh, logout]);
  return <OwnerSessionContext.Provider value={value}>{children}</OwnerSessionContext.Provider>;
}

export function useOwnerSession(): OwnerSessionContextValue {
  const context = useContext(OwnerSessionContext);
  if (!context) throw new Error('useOwnerSession must be used inside OwnerSessionProvider.');
  return context;
}
