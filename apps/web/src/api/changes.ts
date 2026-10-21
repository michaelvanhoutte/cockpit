import type { QueryClient } from '@tanstack/react-query';
import type { CommandResult, WorkspaceSnapshot } from '@cockpit/shared';
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

/**
 * When each read in flight began, on the queue's clock: a Workspace's by its
 * id, the list of Workspaces' by `''`. A read lands in the held copy as one
 * success event, and whether the changes it outlives are in it depends on when
 * it *began*.
 */
const readsBegunAt = new Map<string, number>();

/** A Workspace read is starting, or - with `null` - a read of the list of them. */
export function readOfWorkspaceBegins(workspaceId: string | null): void {
  readsBegunAt.set(workspaceId ?? '', changes.readStarted());
}

const watched = new WeakSet<QueryClient>();

/**
 * Tells the queue each time a Workspace read, or a read of the list of them,
 * lands in the held copy, so the changes it covers stop being drawn over it.
 * Done from the cache's own event rather than from the read itself, so the held
 * copy and the list of drawn changes move in the same step and nothing is drawn
 * without the change in between.
 */
export function watchWorkspaceReads(client: QueryClient): void {
  if (watched.has(client)) return;
  watched.add(client);
  client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
    const [kind, workspaceId] = event.query.queryKey;
    const scope = kind === 'workspaces' ? null : kind === 'snapshot' && typeof workspaceId === 'string' ? workspaceId : undefined;
    if (scope === undefined) return;
    const begunAt = readsBegunAt.get(scope ?? '');
    if (begunAt !== undefined) {
      // The list holds no stamp, so only when its read began covers a change.
      changes.readLanded(scope, begunAt, (event.query.state.data as WorkspaceSnapshot | undefined)?.upTo);
    }
  });
}
