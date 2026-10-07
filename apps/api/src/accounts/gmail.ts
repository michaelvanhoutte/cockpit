import { and, asc, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import { GMAIL, type GmailMark } from '@cockpit/shared';
import type { AccountDb } from './client.js';
import { GUEST_ACCOUNT_NAME } from '../auth/register.js';
import { noteTypeId, taskTypeId } from './changes.js';
import { runCommand } from './command-service.js';
import { listItemTypes } from './repo.js';
import { connectionFailures, connectorAccounts, gmailChecks, gmailConversations, items } from './schema.js';
import { isOpen } from './mirrored-open-state.js';
import { applySourceStateChange } from './source-state.js';
import { inGroupsOf } from '../domain/attachments.js';
import { typeToBringInAs } from '../domain/item-types.js';
import type { GmailCheckHost, GmailConnectionToCheck } from '../connectors/gmail-check.js';
import type { OpenStateWanted } from '@cockpit/connector-sdk';
import { gmailChangeApplies } from '../connectors/gmail.js';

/**
 * What checking an account's Gmail connections reads and writes of its store
 * ("Bring in the conversations already labelled Cockpit as tasks", issue
 * 725) - the store's half of `GmailCheckHost`, every call synchronous so no
 * `await` can fall between a read and the write it decides.
 */

/** How many conversations one lookup names, under SQLite's own limit on bound values. */
const LOOKUP_GROUP = 90;

export function gmailCheckHost(db: AccountDb, accountName: string): GmailCheckHost {
  // Asked in the same synchronous step as a write: the run awaited Gmail
  // since it read the connections, and a disconnect may have landed.
  const stillConnected = (sourceAccountId: string) =>
    db
      .select({ id: connectorAccounts.id })
      .from(connectorAccounts)
      .where(and(eq(connectorAccounts.tenantId, accountName), eq(connectorAccounts.id, sourceAccountId)))
      .get() !== undefined;
  /** The full reconcile the connection is on, named by when it started - null before its first. */
  const listingOf = (sourceAccountId: string) =>
    db
      .select({ startedAt: gmailChecks.startedAt })
      .from(gmailChecks)
      .where(and(eq(gmailChecks.tenantId, accountName), eq(gmailChecks.sourceAccountId, sourceAccountId)))
      .get()?.startedAt ?? null;
  /**
   * The links this connection's mailbox made in its Workspace, under the mark
   * it follows: those under the other are left as they are (issue 822).
   */
  const linksOf = (connection: { workspaceId: string; mailboxKey: string; follows: GmailMark }) =>
    and(
      eq(gmailConversations.tenantId, accountName),
      eq(gmailConversations.workspaceId, connection.workspaceId),
      eq(gmailConversations.mailboxKey, connection.mailboxKey),
      eq(gmailConversations.mark, connection.follows),
    );
  /**
   * Nothing waiting for Gmail on this conversation any more - only while it
   * still wants what was pushed, since a person changing the Item again while
   * Gmail was being asked has a change of their own waiting. False where the
   * connection has gone since the run read it.
   */
  const stopWaiting = (connection: GmailConnectionToCheck, pushed: OpenStateWanted) => {
    if (!stillConnected(connection.id)) return false;
    db.update(gmailConversations)
      .set({ labelWanted: null })
      .where(
        and(
          linksOf(connection),
          eq(gmailConversations.threadId, pushed.sourceId),
          eq(gmailConversations.labelWanted, pushed.open),
        ),
      )
      .run();
    return true;
  };

  const connectionsHeld = (): GmailConnectionToCheck[] =>
    db
      .select({
        id: connectorAccounts.id,
        workspaceId: connectorAccounts.workspaceId,
        mailboxKey: connectorAccounts.externalAccountKey,
        address: connectorAccounts.displayName,
        follows: connectorAccounts.follows,
        sealedCredential: connectorAccounts.encryptedCredential,
        credentialNonce: connectorAccounts.credentialNonce,
      })
      .from(connectorAccounts)
      .where(and(eq(connectorAccounts.tenantId, accountName), eq(connectorAccounts.connectorId, GMAIL)))
      .orderBy(asc(connectorAccounts.connectedAt), asc(connectorAccounts.id))
      .all()
      .map(({ sealedCredential, credentialNonce, ...connection }) => ({
        ...connection,
        sealed: { sealedCredential, credentialNonce },
      }));

  return {
    accountName,

    // None for the guest, whose rows are demonstrations (`holdsGmailConnection`).
    connections: () =>
      accountName === GUEST_ACCOUNT_NAME ? [] : connectionsHeld(),

    progress: (sourceAccountId) =>
      db
        .select({
          historyId: gmailChecks.historyId,
          pageToken: gmailChecks.pageToken,
          startedAt: gmailChecks.startedAt,
          listedAt: gmailChecks.listedAt,
        })
        .from(gmailChecks)
        .where(and(eq(gmailChecks.tenantId, accountName), eq(gmailChecks.sourceAccountId, sourceAccountId)))
        .get() ?? null,

    startListing: (sourceAccountId, historyId, at) => {
      db.insert(gmailChecks)
        .values({ sourceAccountId, tenantId: accountName, historyId, pageToken: null, startedAt: at, listedAt: null })
        .onConflictDoUpdate({
          target: gmailChecks.sourceAccountId,
          set: { historyId, pageToken: null, startedAt: at, listedAt: null },
        })
        .run();
    },

    pageListed: (sourceAccountId, nextPageToken, at) => {
      db.update(gmailChecks)
        .set(nextPageToken ? { pageToken: nextPageToken } : { pageToken: null, listedAt: at })
        .where(and(eq(gmailChecks.tenantId, accountName), eq(gmailChecks.sourceAccountId, sourceAccountId)))
        .run();
    },

    historyPageRead: (sourceAccountId, historyId, nextPageToken) => {
      // Only while the listing is complete: one the nightly sweep started
      // meanwhile owns the page token, and a history page's would misdirect it.
      db.update(gmailChecks)
        .set({ historyId, pageToken: nextPageToken })
        .where(
          and(
            eq(gmailChecks.tenantId, accountName),
            eq(gmailChecks.sourceAccountId, sourceAccountId),
            isNotNull(gmailChecks.listedAt),
          ),
        )
        .run();
    },

    alreadyBroughtIn: (workspaceId, mailboxKey, threadIds) => {
      const known = new Set<string>();
      for (const group of inGroupsOf(threadIds, LOOKUP_GROUP)) {
        for (const row of db
          .select({ threadId: gmailConversations.threadId })
          .from(gmailConversations)
          .where(
            and(
              eq(gmailConversations.tenantId, accountName),
              eq(gmailConversations.workspaceId, workspaceId),
              eq(gmailConversations.mailboxKey, mailboxKey),
              inArray(gmailConversations.threadId, group),
            ),
          )
          .all()) {
          known.add(row.threadId);
        }
      }
      return known;
    },

    bringIn: (connection, conversation, ids, at) => {
      if (!stillConnected(connection.id)) return 'disconnected';
      const type = typeToBringInAs(listItemTypes(db, accountName), taskTypeId(accountName), noteTypeId(accountName));
      if (!type) throw new Error(`account ${accountName} has no type to bring a conversation in as`);
      // Through `capture_item`, the one command every front door captures
      // through, under ids named by the conversation: a run that stopped
      // between the capture and the link below captures again as a replay
      // the store ignores, rather than as a second Item.
      runCommand(db, accountName, 'capture_item', {
        commandId: ids.commandId,
        issuedAt: at,
        workspaceId: connection.workspaceId,
        itemId: ids.itemId,
        title: conversation.title,
        message: conversation.text,
        typeId: type.id,
        capturedFrom: {
          source: 'mail',
          sourceId: conversation.threadId,
          sourceLink: conversation.link,
          ...(conversation.sender ? { sender: conversation.sender } : {}),
          ...(conversation.sentAt ? { sourceTimestamp: conversation.sentAt } : {}),
        },
      });
      // The link, not the capture, says whether the Item is new to this run: a
      // capture replayed after a stop before its link still owes the Item its
      // clean-up, which the stopped run never queued.
      const linked = db
        .insert(gmailConversations)
        .values({
          tenantId: accountName,
          workspaceId: connection.workspaceId,
          mailboxKey: connection.mailboxKey,
          threadId: conversation.threadId,
          itemId: ids.itemId,
          labelWanted: null,
          linkedAt: at,
          mark: connection.follows,
          // Read labelled just now, so found by the reconcile under way - or
          // by the last one, for one brought in from history after it.
          listedIn: listingOf(connection.id),
        })
        .onConflictDoNothing()
        .returning({ itemId: gmailConversations.itemId })
        .all();
      return linked.length > 0 ? 'linked' : 'already linked';
    },

    sourceChanged: (connection, threadIds, change, at) => {
      if (!stillConnected(connection.id)) return 'disconnected';
      const listing = change === 'reopened' ? listingOf(connection.id) : null;
      let changed = 0;
      for (const group of inGroupsOf(threadIds, LOOKUP_GROUP)) {
        const links = db
          .select({
            itemId: gmailConversations.itemId,
            labelWanted: gmailConversations.labelWanted,
            completedAt: items.completedAt,
            deletedAt: items.deletedAt,
          })
          .from(gmailConversations)
          .innerJoin(items, and(eq(items.tenantId, accountName), eq(items.id, gmailConversations.itemId)))
          .where(and(linksOf(connection), inArray(gmailConversations.threadId, group)))
          .all();
        for (const link of links) {
          // A change of Cockpit's still waiting for Gmail wins (issue 728).
          const applies = gmailChangeApplies(
            { labelWanted: link.labelWanted, open: isOpen(link) },
            change === 'reopened',
          );
          if (applies && applySourceStateChange(db, accountName, link.itemId, applies, at) === 'changed') changed += 1;
        }
        if (listing !== null) {
          db.update(gmailConversations)
            .set({ listedIn: listing })
            .where(and(linksOf(connection), inArray(gmailConversations.threadId, group)))
            .run();
        }
      }
      return changed;
    },

    unconfirmed: (connection, limit) => {
      const progress = db
        .select({ startedAt: gmailChecks.startedAt, listedAt: gmailChecks.listedAt })
        .from(gmailChecks)
        .where(and(eq(gmailChecks.tenantId, accountName), eq(gmailChecks.sourceAccountId, connection.id)))
        .get();
      if (!progress?.listedAt) return [];
      return db
        .select({ threadId: gmailConversations.threadId })
        .from(gmailConversations)
        .innerJoin(items, and(eq(items.tenantId, accountName), eq(items.id, gmailConversations.itemId)))
        .where(
          and(
            linksOf(connection),
            or(isNull(gmailConversations.listedIn), ne(gmailConversations.listedIn, progress.startedAt)),
            // Open: a dismissed Item's label is off too (issue 728), and
            // closing it again would change nothing and read it every run.
            isNull(items.completedAt),
            isNull(items.deletedAt),
          ),
        )
        .orderBy(asc(gmailConversations.linkedAt), asc(gmailConversations.threadId))
        .limit(limit)
        .all()
        .map((row) => row.threadId);
    },

    waitingForGmail: (connection, limit) =>
      db
        .select({ threadId: gmailConversations.threadId, labelWanted: gmailConversations.labelWanted })
        .from(gmailConversations)
        .where(and(linksOf(connection), isNotNull(gmailConversations.labelWanted)))
        .orderBy(asc(gmailConversations.linkedAt), asc(gmailConversations.threadId))
        .limit(limit)
        .all()
        .map((row) => ({ sourceId: row.threadId, open: row.labelWanted === true })),

    gmailConfirmed: (connection, confirmed) => (stopWaiting(connection, confirmed) ? 'confirmed' : 'disconnected'),

    gmailRefused: (connection, refused) => (stopWaiting(connection, refused) ? 'dropped' : 'disconnected'),

    reseal: (sourceAccountId, was, sealed) =>
      db
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
        .all().length > 0,

    checked: (sourceAccountId, at) => {
      db.transaction((tx) => {
        tx.update(connectorAccounts)
          .set({ lastTestedAt: at })
          .where(and(eq(connectorAccounts.tenantId, accountName), eq(connectorAccounts.id, sourceAccountId)))
          .run();
        tx.delete(connectionFailures).where(eq(connectionFailures.sourceAccountId, sourceAccountId)).run();
      });
    },

    failing: (sourceAccountId, reason, at) => {
      db.insert(connectionFailures)
        .values({ sourceAccountId, tenantId: accountName, reason, failedAt: at })
        .onConflictDoUpdate({ target: connectionFailures.sourceAccountId, set: { reason, failedAt: at } })
        .run();
    },
  };
}

/**
 * The nightly sweep ("Close a Gmail task when its label comes off, and reopen
 * it when it goes back", issue 727): every connection whose full reconcile is
 * complete starts another from its first page, which corrects whatever the
 * history missed. One still going is left to finish.
 *
 * **The history position is kept**, so once the listing is done the history
 * is read from where it was: whatever changed while the listing ran is read
 * again, and reading it again changes nothing that is already so.
 */
export function sweepGmailNightly(db: AccountDb, accountName: string, at: string): void {
  db.update(gmailChecks)
    .set({ pageToken: null, startedAt: at, listedAt: null })
    .where(and(eq(gmailChecks.tenantId, accountName), isNotNull(gmailChecks.listedAt)))
    .run();
}

/**
 * Whether the account holds any Gmail connection - what keeps its alarm armed.
 *
 * **Never the guest account, by its identity** ("Seed Gmail and Teams in the
 * guest demo", issue 773): its Gmail rows are seeded demonstrations with a
 * placeholder credential, so arming a check on them - or re-arming it each
 * night - would ask Google about a mailbox that does not exist and mark the
 * row failing. Every path that checks Gmail asks this first (the alarm, the
 * nightly re-arming, the sweep), and `connections` above answers none for the
 * guest as well, so a check that runs anyway reads nothing.
 */
export function holdsGmailConnection(db: AccountDb, accountName: string): boolean {
  if (accountName === GUEST_ACCOUNT_NAME) return false;
  return (
    db
      .select({ id: connectorAccounts.id })
      .from(connectorAccounts)
      .where(and(eq(connectorAccounts.tenantId, accountName), eq(connectorAccounts.connectorId, GMAIL)))
      .limit(1)
      .get() !== undefined
  );
}
