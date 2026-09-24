import { useOutletContext } from 'react-router-dom';
import type { Collection, PendingChange } from './client';

export type CollectionWorkspaceContext = {
  collection: Collection;
  pendingChange: PendingChange | null;
  refreshCollection: () => Promise<void>;
  refreshPendingChange: () => Promise<PendingChange | null>;
};

export function useCollectionWorkspace(): CollectionWorkspaceContext {
  return useOutletContext<CollectionWorkspaceContext>();
}
