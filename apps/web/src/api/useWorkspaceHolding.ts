import { useCallback, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WorkspaceSnapshot } from '@cockpit/shared';

/**
 * The Workspace this tab holds a copy of that has the Item ("Open a captured
 * Item's form from the Captured line", issue 1639): the page's own first, then
 * each other Workspace read in this tab. Undefined where none does.
 *
 * **Looks only at copies already held**, so it never causes a read: an Item in
 * a Workspace this tab has not read is not found here, and the form falls back
 * to the page's Workspace as it always did. Re-answered as copies arrive.
 */
export function useWorkspaceHolding(itemId: string | undefined, pageWorkspaceId: string | undefined): string | undefined {
  const cache = useQueryClient().getQueryCache();
  const subscribe = useCallback((changed: () => void) => cache.subscribe(changed), [cache]);
  const read = useCallback((): string | undefined => {
    if (!itemId) return undefined;
    const held = cache
      .findAll({ queryKey: ['snapshot'] })
      .filter((query) => (query.state.data as WorkspaceSnapshot | undefined)?.items.some((item) => item.id === itemId));
    const workspaceIds = held.map((query) => query.queryKey[1]).filter((id): id is string => typeof id === 'string');
    if (pageWorkspaceId && workspaceIds.includes(pageWorkspaceId)) return pageWorkspaceId;
    return workspaceIds[0];
  }, [cache, itemId, pageWorkspaceId]);
  return useSyncExternalStore(subscribe, read, read);
}
