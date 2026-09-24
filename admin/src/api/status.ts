import { getJson } from './client';

export type HealthState = 'ready' | 'degraded' | 'unavailable' | 'unknown';
export type RuntimeState = 'starting' | 'ready' | 'degraded' | 'unavailable' | 'stopping';

export type HealthSnapshot = {
  state: HealthState;
  message?: string;
  hint?: string;
};

export type LocalStorageSnapshot = HealthSnapshot & {
  provider: 'Local';
  path?: string;
};

export type RuntimeStatus = {
  state: RuntimeState;
  observedAt: string;
  database: HealthSnapshot;
  localStorage: HealthSnapshot;
  projectSource?: string;
  version?: string;
};

export type StorageStatus = {
  database: HealthSnapshot;
  localStorage: LocalStorageSnapshot;
};

export function fetchRuntimeStatus(signal?: AbortSignal): Promise<RuntimeStatus> {
  return getJson<RuntimeStatus>('/admin/api/v1/runtime/status', signal);
}

export function fetchStorageStatus(signal?: AbortSignal): Promise<StorageStatus> {
  return getJson<StorageStatus>('/admin/api/v1/storage/status', signal);
}
