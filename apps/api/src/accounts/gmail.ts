import { and, asc, eq, inArray } from 'drizzle-orm';
import { GMAIL } from '@cockpit/shared';
import type { AccountDb } from './client.js';
import { noteTypeId, taskTypeId } from './changes.js';
import { runCommand } from './command-service.js';
import { listItemTypes } from './repo.js';
import { connectionFailures, connectorAccounts, gmailChecks, gmailConversations } from './schema.js';
import { inGroupsOf } from '../domain/attachments.js';
import { typeToBringInAs } from '../domain/item-types.js';
import type { GmailCheckHost } from '../connectors/gmail-check.js';

/**
 * What checking an account's Gmail connections reads and writes of its store
 * ("Bring in the conversations already labelled Cockpit as tasks", issue
 * 725) - the store's half of `GmailCheckHost`, every call synchronous so no
 * `await` can fall between a read and the write it decides.
 */

/** How many conversations one lookup names, under SQLite's own limit on bound values. */
const LOOKUP_GROUP = 90;

export function gmailCheckHost(db: AccountDb, accountName: string): GmailCheckHost {
  return {
    accountName,

    connections: () =>
      db
        .select({
          id: connectorAccounts.id,
          workspaceId: connectorAccounts.workspaceId,
          mailboxKey: connectorAccounts.externalAccountKey,
          address: connectorAccounts.displayName,
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
        })),

    progress: (sourceAccountId) =>
      db
        .select({ historyId: gmailChecks.historyId, pageToken: gmailChecks.pageToken, listedAt: gmailChecks.listedAt })
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
      const type = typeToBringInAs(listItemTypes(db, accountName), taskTypeId(accountName), noteTypeId(accountName));
      if (!type) throw new Error(`account ${accountName} has no type to bring a conversation in as`);
      // Through `capture_item`, the one command every front door captures
      // through, under ids named by the conversation: a run that stopped
      // between the capture and the link below captures again as a replay
      // the store ignores, rather than as a second Item.
      const { applied } = runCommand(db, accountName, 'capture_item', {
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
      db.insert(gmailConversations)
        .values({
          tenantId: accountName,
          workspaceId: connection.workspaceId,
          mailboxKey: connection.mailboxKey,
          threadId: conversation.threadId,
          itemId: ids.itemId,
          labelWanted: null,
          linkedAt: at,
        })
        .onConflictDoNothing()
        .run();
      return applied;
    },

    reseal: (sourceAccountId, sealed) => {
      db.update(connectorAccounts)
        .set({ encryptedCredential: sealed.sealedCredential, credentialNonce: sealed.credentialNonce })
        .where(and(eq(connectorAccounts.tenantId, accountName), eq(connectorAccounts.id, sourceAccountId)))
        .run();
    },

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

/** Whether the account holds any Gmail connection - what keeps its alarm armed. */
export function holdsGmailConnection(db: AccountDb, accountName: string): boolean {
  return (
    db
      .select({ id: connectorAccounts.id })
      .from(connectorAccounts)
      .where(and(eq(connectorAccounts.tenantId, accountName), eq(connectorAccounts.connectorId, GMAIL)))
      .limit(1)
      .get() !== undefined
  );
}
