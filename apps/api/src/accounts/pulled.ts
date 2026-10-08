import { and, asc, eq, inArray, isNull, lte, min } from 'drizzle-orm';
import type { CompleteListing, EmittedItem, OpenStateWanted, SourceItem, SourceStateChange } from '@cockpit/connector-sdk';
import type { AccountDb } from './client.js';
import { GUEST_ACCOUNT_NAME } from './new-user.js';
import { noteTypeId, taskTypeId } from './changes.js';
import { runCommand } from './command-service.js';
import { listItemTypes } from './repo.js';
import { connectionFailures, connectorAccounts, items, pulledConnections, pulledLinks } from './schema.js';
import { confirmOpenStates, openStatesWaiting } from './pulled-open-state.js';
import { applySourceStateChange } from './source-state.js';
import { typeToBringInAs, typeToCaptureAs } from '../domain/item-types.js';
import { leaseFrom, nextCheckAfter, whatADeliveryDoes } from '../domain/pulled-checks.js';

/**
 * The store's half of checking a pulled connection through the generic host
 * ("Check a pulled connector on its cadence through the generic host", issue
 * 891): when each connection is due, which run holds it, and every call that
 * run makes - each synchronous, so no `await` falls between asking whether the
 * run still holds its connection and the write that answer allows.
 *
 * **Nothing here opens a credential.** The run's Worker does; the store hands
 * it the sealed bytes and takes sealed bytes back.
 *
 * `pulledIds` is which connectors are pulled - the registry's to say, and
 * never more values than there are connectors.
 */

/** A connection this store keeps checked, as a run is handed it. */
export interface PulledRunStarted {
  status: 'started';
  runId: string;
  connectorId: string;
  /** Who the connection is at the source, and whose Workspace - what the ids of the Items it files are derived from. */
  workspaceId: string;
  externalAccountKey: string;
}

export type PulledRunBegun = PulledRunStarted | { status: 'already running' | 'not queued' | 'disconnected' };

/**
 * Gives every pulled connection the account holds a check, due now where it
 * had none - what connecting arms - and answers when the earliest is due, or
 * null where the account holds no pulled connection. Never the guest's, whose
 * connections are demonstrations.
 */
export function schedulePulledChecks(
  db: AccountDb,
  accountName: string,
  pulledIds: readonly string[],
  now: Date,
): string | null {
  if (accountName === GUEST_ACCOUNT_NAME || pulledIds.length === 0) return null;
  const unscheduled = db
    .select({ id: connectorAccounts.id })
    .from(connectorAccounts)
    .leftJoin(pulledConnections, eq(pulledConnections.sourceAccountId, connectorAccounts.id))
    .where(
      and(
        eq(connectorAccounts.tenantId, accountName),
        inArray(connectorAccounts.connectorId, [...pulledIds]),
        isNull(pulledConnections.sourceAccountId),
      ),
    )
    .all();
  for (const { id } of unscheduled) {
    db.insert(pulledConnections)
      .values({ sourceAccountId: id, tenantId: accountName, dueAt: now.toISOString() })
      .onConflictDoNothing()
      .run();
  }
  return (
    db
      .select({ dueAt: min(pulledConnections.dueAt) })
      .from(pulledConnections)
      .innerJoin(connectorAccounts, eq(connectorAccounts.id, pulledConnections.sourceAccountId))
      .where(
        and(
          eq(pulledConnections.tenantId, accountName),
          eq(connectorAccounts.tenantId, accountName),
          inArray(connectorAccounts.connectorId, [...pulledIds]),
        ),
      )
      .get()?.dueAt ?? null
  );
}

/**
 * The connections whose check is due by `dueBy`, each marked queued and due
 * again when its lease would run out - so a message that never arrives is
 * queued again then rather than stopping the check.
 */
export function queueDuePulledChecks(
  db: AccountDb,
  accountName: string,
  pulledIds: readonly string[],
  dueBy: Date,
  now: Date,
): string[] {
  if (accountName === GUEST_ACCOUNT_NAME || pulledIds.length === 0) return [];
  const due = db
    .select({ id: pulledConnections.sourceAccountId })
    .from(pulledConnections)
    .innerJoin(connectorAccounts, eq(connectorAccounts.id, pulledConnections.sourceAccountId))
    .where(
      and(
        eq(pulledConnections.tenantId, accountName),
        eq(connectorAccounts.tenantId, accountName),
        inArray(connectorAccounts.connectorId, [...pulledIds]),
        lte(pulledConnections.dueAt, dueBy.toISOString()),
      ),
    )
    .orderBy(asc(pulledConnections.dueAt), asc(pulledConnections.sourceAccountId))
    .all()
    .map((row) => row.id);
  for (const id of due) {
    db.update(pulledConnections)
      .set({ queuedAt: now.toISOString(), dueAt: leaseFrom(now) })
      .where(and(eq(pulledConnections.tenantId, accountName), eq(pulledConnections.sourceAccountId, id)))
      .run();
  }
  return due;
}

/**
 * A delivered check: the run takes the connection's lease, or nothing happens
 * - one run at a time, and one run per queued check.
 */
export function beginPulledRun(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  now: Date,
): PulledRunBegun {
  const connection = connectionOf(db, accountName, sourceAccountId);
  const held = db
    .select({ queuedAt: pulledConnections.queuedAt, leaseUntil: pulledConnections.leaseUntil })
    .from(pulledConnections)
    .where(and(eq(pulledConnections.tenantId, accountName), eq(pulledConnections.sourceAccountId, sourceAccountId)))
    .get();
  if (!connection || !held) return { status: 'disconnected' };
  const does = whatADeliveryDoes(held, now);
  if (does !== 'run') return { status: does };
  const leaseUntil = leaseFrom(now);
  db.update(pulledConnections)
    .set({ queuedAt: null, runId, leaseUntil, dueAt: leaseUntil })
    .where(and(eq(pulledConnections.tenantId, accountName), eq(pulledConnections.sourceAccountId, sourceAccountId)))
    .run();
  return {
    status: 'started',
    runId,
    connectorId: connection.connectorId,
    workspaceId: connection.workspaceId,
    externalAccountKey: connection.externalAccountKey,
  };
}

/**
 * Whether this run still holds its connection: the connection is there and
 * no other run has taken it. Asked by every call that writes, in the same
 * synchronous step as the write.
 */
function runHolds(db: AccountDb, accountName: string, sourceAccountId: string, runId: string) {
  const connection = connectionOf(db, accountName, sourceAccountId);
  if (!connection) return null;
  const held = db
    .select({ runId: pulledConnections.runId, state: pulledConnections.state })
    .from(pulledConnections)
    .where(and(eq(pulledConnections.tenantId, accountName), eq(pulledConnections.sourceAccountId, sourceAccountId)))
    .get();
  return held?.runId === runId ? { ...connection, state: held.state } : null;
}

/** The connector's private state for this connection, or null before it saved any. */
export function pulledState(db: AccountDb, accountName: string, sourceAccountId: string, runId: string): unknown {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  return holds?.state == null ? null : JSON.parse(holds.state);
}

/** Saves the connector's private state, while the run still holds its connection. */
export function savePulledState(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  state: unknown,
): 'saved' | 'not this run' {
  if (!runHolds(db, accountName, sourceAccountId, runId)) return 'not this run';
  db.update(pulledConnections)
    .set({ state: state === undefined ? null : JSON.stringify(state) })
    .where(and(eq(pulledConnections.tenantId, accountName), eq(pulledConnections.sourceAccountId, sourceAccountId)))
    .run();
  return 'saved';
}

/** The connection's sealed credential, for the run's Worker to open - null once the run no longer holds it. */
export function pulledSealedCredential(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
): { sealedCredential: string; credentialNonce: string } | null {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  return holds ? { sealedCredential: holds.sealedCredential, credentialNonce: holds.credentialNonce } : null;
}

/**
 * Saves a credential the source rotated, only while the stored one is still
 * `was`, the one the run opened: a reconnect made meanwhile keeps its own.
 */
export function resealPulledCredential(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  was: { sealedCredential: string; credentialNonce: string },
  sealed: { sealedCredential: string; credentialNonce: string },
): 'saved' | 'not saved' {
  if (!runHolds(db, accountName, sourceAccountId, runId)) return 'not saved';
  const saved = db
    .update(connectorAccounts)
    .set({ encryptedCredential: sealed.sealedCredential, credentialNonce: sealed.credentialNonce })
    .where(
      and(
        eq(connectorAccounts.tenantId, accountName),
        eq(connectorAccounts.id, sourceAccountId),
        eq(connectorAccounts.encryptedCredential, was.sealedCredential),
        eq(connectorAccounts.credentialNonce, was.credentialNonce),
      ),
    )
    .returning({ id: connectorAccounts.id })
    .all();
  return saved.length > 0 ? 'saved' : 'not saved';
}

/**
 * Files what the connector read as an Item of the connection's Workspace,
 * once per source id - through `capture_item`, the one command every front
 * door captures through, under ids the caller derived from the connection and
 * the source id, so a run that stops after the capture and before the link
 * captures again as a replay the store ignores.
 *
 * Answers `disconnected` where the run no longer holds its connection, and
 * files nothing.
 */
export function filePulledItem(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  item: SourceItem & { sourceId: string },
  ids: { itemId: string; commandId: string },
  at: string,
  arrivesAs: 'note' | 'task' = 'note',
): EmittedItem | 'disconnected' {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  if (!holds) return 'disconnected';
  if (linkOf(db, accountName, holds, item.sourceId)) return 'already-known';
  const types = listItemTypes(db, accountName);
  const type =
    arrivesAs === 'task'
      ? typeToBringInAs(types, taskTypeId(accountName), noteTypeId(accountName))
      : typeToCaptureAs(types, noteTypeId(accountName));
  if (!type) throw new Error(`account ${accountName} has no type to capture a pulled item as`);
  const message = item.capturedMessage ?? item.title;
  if (!message) throw new Error('a pulled item carries neither a message nor a title');
  runCommand(db, accountName, 'capture_item', {
    commandId: ids.commandId,
    issuedAt: at,
    workspaceId: holds.workspaceId,
    itemId: ids.itemId,
    message,
    // A Note stays untitled; a Task takes the source's title, or the one cut from its message.
    ...(arrivesAs === 'task' && item.title ? { title: item.title } : {}),
    typeId: type.id,
    capturedFrom: {
      source: item.source,
      sourceId: item.sourceId,
      ...(item.sourceLink ? { sourceLink: item.sourceLink } : {}),
      ...(item.sender ? { sender: item.sender } : {}),
      ...(item.sourceTimestamp ? { sourceTimestamp: item.sourceTimestamp } : {}),
    },
  });
  db.insert(pulledLinks)
    .values({
      tenantId: accountName,
      workspaceId: holds.workspaceId,
      connectorId: holds.connectorId,
      externalAccountKey: holds.externalAccountKey,
      sourceId: item.sourceId,
      itemId: ids.itemId,
      linkedAt: at,
      choice: item.choice ?? null,
    })
    .onConflictDoNothing()
    .run();
  return 'filed';
}

/**
 * Closes, as a `resolved` change would, each Item still open that this
 * connection filed under the listing's choice and the listing did not see -
 * through `applySourceStateChange`, the path a source's own `resolved` takes
 * ("Close a pulled connector's Items its complete listing no longer sees",
 * issue 938). Left alone: a link filed under another choice or none, one with
 * an open state still waiting for the source (as in `applyPulledSourceChange`),
 * and an Item already done or dismissed.
 *
 * Reads every open Item's link of the choice and compares in memory rather than binding
 * the listing into a statement, so a listing as long as the source has no
 * limit of parameters to meet. Answers how many it closed.
 */
export function closePulledItemsNotListed(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  listing: CompleteListing,
  observedAt: string,
): number | 'disconnected' {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  if (!holds) return 'disconnected';
  const seen = new Set(listing.sourceIds);
  const candidates = db
    .select({ sourceId: pulledLinks.sourceId, itemId: pulledLinks.itemId })
    .from(pulledLinks)
    .innerJoin(items, and(eq(items.tenantId, accountName), eq(items.id, pulledLinks.itemId)))
    .where(
      and(
        eq(pulledLinks.tenantId, accountName),
        eq(pulledLinks.workspaceId, holds.workspaceId),
        eq(pulledLinks.connectorId, holds.connectorId),
        eq(pulledLinks.externalAccountKey, holds.externalAccountKey),
        eq(pulledLinks.choice, listing.choice),
        isNull(pulledLinks.openWanted),
        // Open, as `isOpen` has it: neither done nor dismissed.
        isNull(items.completedAt),
        isNull(items.deletedAt),
      ),
    )
    .all();
  let closed = 0;
  for (const { sourceId, itemId } of candidates) {
    if (seen.has(sourceId)) continue;
    if (applySourceStateChange(db, accountName, itemId, 'resolved', observedAt) === 'changed') closed += 1;
  }
  return closed;
}

/**
 * Applies a source-state change to the Item this connection filed for that
 * source id; one it never filed, or a run that no longer holds its connection,
 * changes nothing. `removed` is not applied yet (`source-state.ts`).
 */
export function applyPulledSourceChange(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  change: SourceStateChange,
): 'changed' | 'unchanged' | 'disconnected' {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  if (!holds) return 'disconnected';
  if (change.change === 'removed') return 'unchanged';
  const link = linkOf(db, accountName, holds, change.sourceId);
  if (!link) return 'unchanged';
  // What a person changed and the source has not yet heard wins over what the
  // source says: the connector is handed it before the next read (issue 893).
  if (link.openWanted !== null) return 'unchanged';
  return applySourceStateChange(db, accountName, link.itemId, change.change, change.observedAt);
}

/**
 * The open states a person set in Cockpit that the connection's source has not
 * confirmed - what the run hands the connector before it reads (issue 893).
 * Nothing once the run no longer holds its connection.
 */
export function pulledOpenStatesWaiting(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
): OpenStateWanted[] {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  return holds ? openStatesWaiting(db, accountName, holds) : [];
}

/** Clears the open states the connector confirmed, while the run still holds its connection (issue 893). */
export function confirmPulledOpenStates(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  confirmed: readonly OpenStateWanted[],
): 'confirmed' | 'not this run' {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  if (!holds) return 'not this run';
  confirmOpenStates(db, accountName, holds, confirmed);
  return 'confirmed';
}

/**
 * Ends a run: its lease goes, the next check is due five minutes on, and the
 * connection's row says why it failed - or, for a run that worked, when it
 * was last checked and nothing about failing. A run that no longer holds its
 * connection ends nothing, since another has it or it has gone.
 */
export function endPulledRun(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  failing: string | null,
  now: Date,
): void {
  if (!runHolds(db, accountName, sourceAccountId, runId)) return;
  const at = now.toISOString();
  db.transaction((tx) => {
    tx.update(pulledConnections)
      .set({ runId: null, leaseUntil: null, dueAt: nextCheckAfter(now) })
      .where(and(eq(pulledConnections.tenantId, accountName), eq(pulledConnections.sourceAccountId, sourceAccountId)))
      .run();
    if (failing === null) {
      tx.update(connectorAccounts)
        .set({ lastTestedAt: at })
        .where(and(eq(connectorAccounts.tenantId, accountName), eq(connectorAccounts.id, sourceAccountId)))
        .run();
      tx.delete(connectionFailures).where(eq(connectionFailures.sourceAccountId, sourceAccountId)).run();
    } else {
      tx.insert(connectionFailures)
        .values({ sourceAccountId, tenantId: accountName, reason: failing, failedAt: at })
        .onConflictDoUpdate({ target: connectionFailures.sourceAccountId, set: { reason: failing, failedAt: at } })
        .run();
    }
  });
}

function connectionOf(db: AccountDb, accountName: string, sourceAccountId: string) {
  return db
    .select({
      connectorId: connectorAccounts.connectorId,
      workspaceId: connectorAccounts.workspaceId,
      externalAccountKey: connectorAccounts.externalAccountKey,
      sealedCredential: connectorAccounts.encryptedCredential,
      credentialNonce: connectorAccounts.credentialNonce,
    })
    .from(connectorAccounts)
    .where(and(eq(connectorAccounts.tenantId, accountName), eq(connectorAccounts.id, sourceAccountId)))
    .get();
}

function linkOf(
  db: AccountDb,
  accountName: string,
  connection: { workspaceId: string; connectorId: string; externalAccountKey: string },
  sourceId: string,
) {
  return db
    .select({ itemId: pulledLinks.itemId, openWanted: pulledLinks.openWanted })
    .from(pulledLinks)
    .where(
      and(
        eq(pulledLinks.tenantId, accountName),
        eq(pulledLinks.workspaceId, connection.workspaceId),
        eq(pulledLinks.connectorId, connection.connectorId),
        eq(pulledLinks.externalAccountKey, connection.externalAccountKey),
        eq(pulledLinks.sourceId, sourceId),
      ),
    )
    .get();
}
