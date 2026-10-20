import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { CommandResult } from '@cockpit/shared';
import { createChangeQueue } from '../changeQueue';
import { refuseWhileOffline } from '../offline';
import { sendCommand } from './client';

/**
 * The browser's own "Leave site?" warning. Armed while a change is unanswered,
 * so closing the tab cannot silently lose what the saving sign says is still
 * being saved.
 */
const keepThePage = (event: BeforeUnloadEvent) => {
  event.preventDefault();
};

/**
 * This tab's changes (`changeQueue.ts`). One per tab, in memory: a second tab
 * has its own queue and its own saving sign.
 *
 * **Offline is checked when a change is sent, not only when it joins**, so one
 * found offline while others wait behind it sends every one of them back with
 * "You're working offline" instead of leaving them to a connection that is gone.
 */
export const changes = createChangeQueue({
  send: async (change, signal): Promise<CommandResult> => {
    refuseWhileOffline();
    return sendCommand(change.name, change.payload as never, signal);
  },
  ...(typeof window === 'undefined'
    ? {}
    : {
        leaveGuard: {
          arm: () => window.addEventListener('beforeunload', keepThePage),
          disarm: () => window.removeEventListener('beforeunload', keepThePage),
        },
      }),
});

/** How many of this tab's changes are waiting to be sent or out unanswered: what the saving sign counts. */
export function useUnansweredChanges(): number {
  return useSyncExternalStore(changes.subscribe, changes.unanswered, changes.unanswered);
}

/**
 * When each Workspace's read in flight began, on the queue's clock. A read
 * lands in the held copy as one success event, and whether the changes it
 * outlives are in it depends on when it *began*.
 */
const readsBegunAt = new Map<string, number>();

/** A Workspace read is starting. */
export function readOfWorkspaceBegins(workspaceId: string): void {
  readsBegunAt.set(workspaceId, changes.readStarted());
}

const watched = new WeakSet<QueryClient>();

/**
 * Tells the queue each time a Workspace read lands in the held copy, so the
 * changes it covers stop being drawn over it. Done from the cache's own event
 * rather than from the read itself, so the held copy and the list of drawn
 * changes move in the same step and nothing is drawn without the change in
 * between.
 */
export function watchWorkspaceReads(client: QueryClient): void {
  if (watched.has(client)) return;
  watched.add(client);
  client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
    const [kind, workspaceId] = event.query.queryKey;
    if (kind !== 'snapshot' || typeof workspaceId !== 'string') return;
    const begunAt = readsBegunAt.get(workspaceId);
    if (begunAt !== undefined) changes.readLanded(workspaceId, begunAt);
  });
}
