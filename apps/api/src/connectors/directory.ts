import { and, desc, eq } from 'drizzle-orm';
import type { Env } from '../env.js';
import { createDb } from '../db/client.js';
import { connectorDirectory } from '../db/schema.js';

/**
 * Which account and Workspace a source's own name for somebody points at
 * ("Save a Teams message to Cockpit", issue 486).
 *
 * **The problem this exists for**: one inbound address receives a saved message
 * for every connected account of a source at once, and nothing in the delivery
 * says which stored connection it is for. The connection itself lives in the
 * account's own store, which cannot be searched without knowing the account -
 * so this is the index, in the register, where a question asked before any
 * account is known has to live (`src/db/schema.ts`).
 *
 * **A hint, never the authority.** Nothing here is believed on its own: a row
 * says where to go and ask, and the account's own store is what says the
 * connection is still there (`resolveConnection`, `push-host.ts`). That is what
 * makes a row left behind by a disconnect harmless rather than a way into
 * somebody's Workspace.
 */

/** Where a connected account at a source lives. */
export interface ConnectionPointer {
  readonly accountName: string;
  readonly workspaceId: string;
}

/** A pointer as it was read, carrying what makes it the row that was read. */
export interface ConnectionAsRead extends ConnectionPointer {
  readonly connectedAt: string;
}

/**
 * Records where a connection now lives, or moves the one already there.
 *
 * Named at the same four columns the store's own uniqueness is named at, so
 * connecting the same account again refreshes this row exactly as it refreshes
 * that one rather than leaving a second.
 */
export async function rememberConnection(
  env: Env,
  pointer: ConnectionPointer,
  connectorId: string,
  externalAccountKey: string,
  connectedAt: string,
): Promise<void> {
  await createDb(env.DB)
    .insert(connectorDirectory)
    .values({
      connectorId,
      externalAccountKey,
      accountId: pointer.accountName,
      workspaceId: pointer.workspaceId,
      connectedAt,
    })
    .onConflictDoUpdate({
      target: [
        connectorDirectory.connectorId,
        connectorDirectory.externalAccountKey,
        connectorDirectory.accountId,
        connectorDirectory.workspaceId,
      ],
      set: { connectedAt },
    })
    .run();
}

/**
 * Every Workspace that has connected this account at this source, most recently
 * connected first.
 *
 * **Most recent first is the rule for the ordinary ambiguity**: the same
 * Microsoft account can be connected to two Workspaces, and a message action
 * offers nobody a choice of where to file - so a save lands in the Workspace
 * that connected it last, and connecting it somewhere else moves where saves
 * land. Every row is still answered rather than only the first, because the
 * caller confirms each against its own store and a stale one must not hide a
 * live one behind it.
 *
 * **The Workspace's own id breaks a tie**, two connects landing in the same
 * millisecond being a state that can really arrive: without it the order among
 * equal timestamps is SQLite's scan order, so which Workspace a save lands in
 * would be undefined exactly where the rule above is what decides it.
 */
export async function connectionsFor(
  env: Env,
  connectorId: string,
  externalAccountKey: string,
): Promise<ConnectionAsRead[]> {
  const rows = await createDb(env.DB)
    .select({
      accountName: connectorDirectory.accountId,
      workspaceId: connectorDirectory.workspaceId,
      connectedAt: connectorDirectory.connectedAt,
    })
    .from(connectorDirectory)
    .where(
      and(
        eq(connectorDirectory.connectorId, connectorId),
        eq(connectorDirectory.externalAccountKey, externalAccountKey),
      ),
    )
    .orderBy(desc(connectorDirectory.connectedAt), desc(connectorDirectory.workspaceId))
    .all();
  return rows;
}

/**
 * Forgets a row the account's own store no longer agrees with - a connection
 * that has been disconnected, or a Workspace that has gone.
 *
 * Swept as it is found rather than on the way out of a disconnect, because a
 * disconnect knows the connection's id and not the source's own key for it,
 * and because a row that is wrong has to be harmless whatever failed to tidy
 * it up.
 *
 * **Only the row that was read**, which is what `connectedAt` in the condition
 * is for: connecting again writes the same four key columns with a new
 * `connected_at`, so a sweep that matched on the key alone would delete the row
 * a reconnect had just put there while this push was deciding - leaving a live
 * connection no save can find, and nothing anywhere saying so.
 */
export async function forgetConnection(
  env: Env,
  pointer: ConnectionAsRead,
  connectorId: string,
  externalAccountKey: string,
): Promise<void> {
  await createDb(env.DB)
    .delete(connectorDirectory)
    .where(
      and(
        eq(connectorDirectory.connectorId, connectorId),
        eq(connectorDirectory.externalAccountKey, externalAccountKey),
        eq(connectorDirectory.accountId, pointer.accountName),
        eq(connectorDirectory.workspaceId, pointer.workspaceId),
        eq(connectorDirectory.connectedAt, pointer.connectedAt),
      ),
    )
    .run();
}
