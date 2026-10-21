import type { QueryClient } from '@tanstack/react-query';
import { ACCOUNT_WIDE } from '@cockpit/shared';
import type { ServerEvent, WorkspaceSnapshot } from '@cockpit/shared';
import { changes } from './changes';

/**
 * When the tab reads a Workspace again ("Read a Workspace once after your
 * changes, and never restart a read in progress", issue 1332).
 *
 * Rules about not reading what the tab need not and not throwing away a read
 * already on its way:
 *
 * 1. **After its own changes, once, when its queue empties** - not once per
 *    change. A burst of five reads once, after the fifth is answered.
 * 2. **An announcement of a change the tab stored itself is skipped.** The
 *    answer carries the stamp the announcement will (`commandResultSchema`'s
 *    `at`), so "is this mine" is a comparison, never a guess: while a read is
 *    owed for a change stored at or after the announced time, that read will
 *    hold it, and one on its way that began after the answer says so when it
 *    lands (`upTo`).
 * 3. **Nothing cancels a read in progress.** What arrives meanwhile - an
 *    announcement, or a change answered - is read once more after it lands,
 *    unless the read that landed already holds it.
 * 4. **A Workspace this tab has deleted is not read** ("Show a Workspace
 *    rename, colour, delete or reorder the moment you make it", issue 1365),
 *    answered or not.
 *
 * Every uncertainty reads, as the app did before: an announcement or answer
 * without a stamp (an older Worker) is never skipped.
 */

/** Stands for the time of a change that gave none: later than any stamp, so a read is always owed. */
const UNTIMED = '~';

/**
 * Reads owed for this tab's own changes, by Workspace ('' for every one), each with
 * the newest stamp the server gave them ('' where it gave none).
 */
const owed = new Map<string, string>();
let owedTo: QueryClient;

// The last change answered, or refused, is the moment the queue is empty.
changes.subscribe(readWhatIsOwed);

/**
 * This tab changed something and the server has answered: the snapshots under
 * `workspaceId` ('' for every Workspace) are owed a read, made once the queue has
 * emptied. `stamp` is the time the answer gave the change (`commandResultSchema`'s
 * `at`), if it gave one.
 */
export function readAfterOwnChange(client: QueryClient, workspaceId: string, stamp = ''): void {
  // The queue sends in order, so the latest answer is the newest stamp - or none, which covers nothing.
  owed.set(workspaceId, stamp);
  owedTo = client;
  readWhatIsOwed();
}

function readWhatIsOwed(): void {
  if (changes.unanswered() > 0) return;
  for (const [workspaceId, stamp] of owed) read(owedTo, workspaceId, stamp || UNTIMED, false);
  owed.clear();
}

/**
 * Reads the snapshots under `key`, never in place of a read in flight: that is
 * left to land, and followed by one more unless what it holds is at least
 * `upTo`. However many wait on one read, they find the one more already started
 * and join it.
 *
 * **`marked`** says the copy is out of date - another device changed something.
 * A read for this tab's own changes does not mark it: they are drawn over the
 * held copy until it lands, so a filing made meanwhile can be built on it
 * without waiting. A copy nothing is showing is marked either way, so the next
 * to ask reads it.
 */
function read(client: QueryClient, workspaceId: string, upTo: string, marked: boolean): void {
  const queryKey = workspaceId === '' ? ['snapshot'] : ['snapshot', workspaceId];
  for (const query of client.getQueryCache().findAll({ queryKey })) {
    // A Workspace deleted here is gone whether or not the server has said so yet: a read would find nothing.
    if (changes.deleting(String(query.queryKey[1]))) continue;
    const filters = { queryKey: query.queryKey, exact: true };
    const alongside = { cancelRefetch: false };
    const flying = query.state.fetchStatus === 'fetching';
    // Marked only when the copy is out of date or nothing shows it; a read for
    // this tab's own changes leaves a showing copy usable meanwhile, the one
    // more read included.
    const start = () => {
      if (marked || !query.isActive()) void client.invalidateQueries(filters, alongside);
      else void client.refetchQueries(filters, alongside);
    };
    start();
    if (flying) {
      const andOneMore = () => {
        if (upTo > ((query.state.data as WorkspaceSnapshot | undefined)?.upTo ?? '')) start();
      };
      void query.promise?.then(andOneMore, andOneMore);
    }
  }
}

/**
 * The server announced a change. Reads what it names, unless this tab already
 * holds it.
 *
 * **Held already** when the copy's `upTo` and the announced `at` - both the
 * account store's stamps, so they compare (`workspaceSnapshotSchema`) - say so;
 * or **about to be**, when a read is owed for a change of this tab's own stored
 * at or after it, which begins after that answer and so holds everything stored
 * up to it. **Every uncertainty reads**: a workspace with nothing cached, an
 * announcement without a time, a copy from before `upTo` existed, an answer
 * without a stamp - what the app does without this.
 */
export function readForAnnouncement(client: QueryClient, event: Exclude<ServerEvent, { type: 'remembered_sentences_changed' }>): void {
  const at = event.type === 'snapshot_invalidated' ? event.at : undefined;
  const workspaceId = event.workspaceId === ACCOUNT_WIDE ? '' : event.workspaceId;
  if (at) {
    // For every Workspace, held only where every copy holds it.
    const held = client.getQueryCache().findAll({ queryKey: workspaceId ? ['snapshot', workspaceId] : ['snapshot'] });
    const holds = held.length > 0 && held.every((query) => ((query.state.data as WorkspaceSnapshot | undefined)?.upTo ?? '') >= at);
    // Owed for this Workspace, or for every one; nothing owed, or an answer without a stamp, is '' and covers nothing.
    if (holds || (owed.get(event.workspaceId) ?? '') >= at || (owed.get('') ?? '') >= at) return;
  }
  read(client, workspaceId, at ?? UNTIMED, true);
}
