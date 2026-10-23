import { useMemo, useSyncExternalStore } from 'react';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { CommandResult } from '@cockpit/shared';
import type { Drawn, Requested } from '../drawnAhead';
import { refuseWhileOffline } from '../offline';
import { changes } from './changes';
import type { CommandArgs } from './queries';

/**
 * What a window needs to draw a list of its own with the tab's unanswered changes
 * laid over it ("Show a change made in Settings the moment you make it", issue
 * 1356): the connections, the remembered sentences, the connected apps and the
 * users. A list is told apart by its query key, which is also the scope its
 * changes are given in the queue (`changeQueue.ts`).
 *
 * **Imported by the windows' chunks only**, never by anything the initial bundle
 * reaches (`bundle:budget`): the queue is the part every change shares, and this
 * is the part only a window's list needs.
 *
 * Per list: its `queryFn` says when a read begins (`readBegins`), the window
 * draws what it reads with `useDrawnOver`, and a change joins the queue with
 * `changeList` or - where it is a request of its own and not a command -
 * `requestToChangeList`. **The list is read once the queue has emptied**, never
 * waited for, and a read in flight is left to land and followed by one more
 * (`snapshotReads.ts` does the same for a Workspace).
 */

/** What a read of the list under this key is, to the queue. */
const scopeOf = (key: QueryKey) => JSON.stringify(key);

/** When each read in flight began, on the queue's clock, by scope. */
const begunAt = new Map<string, number>();

const watched = new WeakSet<QueryClient>();

/**
 * Tells the queue each time a read of a list lands, so the changes it covers stop
 * being drawn over it - the rule a Workspace's own read follows
 * (`watchWorkspaceReads`, `changes.ts`). Done from the cache's own event so the
 * held copy and the changes drawn over it move in the same step.
 */
function watchReads(client: QueryClient): void {
  if (watched.has(client)) return;
  watched.add(client);
  client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
    const scope = scopeOf(event.query.queryKey);
    const at = begunAt.get(scope);
    if (at !== undefined) changes.readLanded(scope, at);
  });
}

/**
 * A read of the list under `key` is starting: called from its `queryFn`, since
 * whether a change is in a read depends on when the read *began*.
 */
export function readBegins(client: QueryClient, key: QueryKey): void {
  watchReads(client);
  begunAt.set(scopeOf(key), changes.readStarted());
}

/**
 * The list as the window draws it: what the server sent with this tab's changes
 * to it laid over by `over`, handed to the query as its `select`. The held list
 * is never written to, so a read in flight cannot flip the screen back.
 */
export function useDrawnOver<L>(over: (list: L, changes: readonly Drawn[]) => L): (held: L) => L {
  const version = useSyncExternalStore(changes.subscribe, changes.version, changes.version);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (held: L) => changes.drawnList(held, over), [version, over]);
}

/** The reads owed once the queue has emptied, by scope: the list, and whatever else the change also moved. */
const owed = new Map<string, { client: QueryClient; keys: Map<string, QueryKey> }>();

changes.subscribe(readWhatIsOwed);

function owe(client: QueryClient, key: QueryKey, alsoRead: readonly QueryKey[]): void {
  const keys = owed.get(scopeOf(key))?.keys ?? new Map<string, QueryKey>();
  for (const one of [key, ...alsoRead]) keys.set(scopeOf(one), one);
  owed.set(scopeOf(key), { client, keys });
}

function readWhatIsOwed(): void {
  if (changes.unanswered() > 0) return;
  const reads = [...owed.values()];
  owed.clear();
  for (const { client, keys } of reads) keys.forEach((key) => read(client, key));
}

/**
 * Reads the list under `key`, never in place of a read in flight: that one is
 * left to land, and followed by one more, since it may have begun before the
 * answer. A list nothing is showing is marked out of date and read when it is
 * next shown.
 */
function read(client: QueryClient, key: QueryKey): void {
  const filters = { queryKey: key, exact: true };
  const query = client.getQueryCache().find(filters);
  if (!query) {
    // A list nothing holds (its window closed before the answer) has no read to wait for: its changes are not drawn over anything.
    changes.readLanded(scopeOf(key), changes.readStarted());
    return;
  }
  const alongside = { cancelRefetch: false };
  const start = () => void (query.isActive() ? client.refetchQueries(filters, alongside) : client.invalidateQueries(filters, alongside));
  const flying = query.state.fetchStatus === 'fetching';
  start();
  if (flying) void query.promise?.then(start, start);
}

function join(
  client: QueryClient,
  key: QueryKey,
  change: CommandArgs | Requested,
  request?: (signal: AbortSignal) => Promise<CommandResult>,
  alsoRead: readonly QueryKey[] = [],
  alsoDrawnOn: readonly string[] = [],
): Promise<CommandResult> {
  return changes.enqueue(
    change,
    () => {
      owe(client, key, alsoRead);
      readWhatIsOwed();
    },
    scopeOf(key),
    request,
    alsoDrawnOn,
  );
}

/**
 * Sends a command that changes the list under `key`. It joins the tab's queue and
 * is drawn at once; it settles with the server's answer, or its refusal, which the
 * caller says. `alsoRead` are lists the change also moved, read with the list once the
 * queue has emptied. `alsoDrawnOn` are the Workspaces whose snapshot the change is drawn
 * over as well (`drawnAhead.ts`): it is drawn until their reads have landed too.
 */
export async function changeList(
  client: QueryClient,
  key: QueryKey,
  change: CommandArgs,
  alsoRead: readonly QueryKey[] = [],
  alsoDrawnOn: readonly string[] = [],
): Promise<CommandResult> {
  refuseWhileOffline();
  return join(client, key, change, undefined, alsoRead, alsoDrawnOn);
}

/**
 * Sends a change that is a request of its own and not a command, and hands back
 * what the request answered. `alsoRead` are lists the change also moved, read with
 * the list once the queue has emptied.
 */
export async function requestToChangeList<R>(
  client: QueryClient,
  key: QueryKey,
  change: Requested,
  request: (signal: AbortSignal) => Promise<R>,
  alsoRead: readonly QueryKey[] = [],
): Promise<R> {
  refuseWhileOffline();
  let answer!: R;
  await join(
    client,
    key,
    change,
    async (signal) => {
      // Checked as it is sent, as the queue does for a command.
      refuseWhileOffline();
      answer = await request(signal);
      return { ok: true, applied: true };
    },
    alsoRead,
  );
  return answer;
}
