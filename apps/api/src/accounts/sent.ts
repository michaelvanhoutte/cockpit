import { and, eq } from 'drizzle-orm';
import type { AccountDb } from './client.js';
import { DraftRefusedError, SourceAccountNotFoundError, runCommand } from './command-service.js';
import { followedBy } from './pulled.js';
import { getItem, getSourceAccount } from './repo.js';
import { connectorAccounts, pulledConnections } from './schema.js';

/**
 * The store's half of *Follow a sent email…* ("Follow a sent email… in
 * Capture", issue 1710). Listing the newest sent mail is the Worker's, since
 * only it opens a credential and calls a connector; the store gives it the
 * sealed credential and, when a sent email is picked, makes the Item that
 * follows its conversation.
 */

/** What the Worker needs to ask one connection's source for its sent mail. */
export interface ListingAsk {
  connectorId: string;
  externalAccountKey: string;
  choice: string | null;
  displayName: string;
  sealedCredential: string;
  credentialNonce: string;
  /** The connector's private state as its last check saved it, for it to read. */
  state: unknown;
}

/** The connection of this Workspace named, with its sealed credential and saved state. */
export function listingAsk(db: AccountDb, accountName: string, workspaceId: string, sourceAccountId: string): ListingAsk {
  const connection = getSourceAccount(db, accountName, sourceAccountId);
  if (!connection || connection.workspaceId !== workspaceId || connection.externalAccountKey === null) {
    throw new SourceAccountNotFoundError(sourceAccountId);
  }
  const held = db
    .select({
      displayName: connectorAccounts.displayName,
      sealedCredential: connectorAccounts.encryptedCredential,
      credentialNonce: connectorAccounts.credentialNonce,
    })
    .from(connectorAccounts)
    .where(and(eq(connectorAccounts.tenantId, accountName), eq(connectorAccounts.id, sourceAccountId)))
    .get()!;
  const state = db
    .select({ state: pulledConnections.state })
    .from(pulledConnections)
    .where(and(eq(pulledConnections.tenantId, accountName), eq(pulledConnections.sourceAccountId, sourceAccountId)))
    .get()?.state;
  return {
    connectorId: connection.connectorId,
    externalAccountKey: connection.externalAccountKey,
    choice: connection.choice,
    ...held,
    state: state == null ? null : JSON.parse(state),
  };
}

/** A sent email picked: what the list showed, and the ids this pick's changes are logged under. */
export interface SentPick {
  workspaceId: string;
  sourceAccountId: string;
  /** Derived from the connection and the conversation, so a pick sent twice is one Item. */
  itemId: string;
  captureId: string;
  followId: string;
  conversationId: string;
  subject: string;
  to: string | null;
  sentAt: string;
  link: string;
  excerpt: string;
  /** Whether the Workspace was chosen, as Capture's Where has it. */
  decided: boolean;
  /** The Panels *File on* chose. */
  panelIds: readonly string[];
}

/** Refused: the Item an earlier pick made for this conversation was finished or dismissed. */
export const SENT_ITEM_FINISHED =
  'The item made from this conversation is finished or dismissed. Reopen it, or follow a different conversation.';

/**
 * Makes the Item that follows a sent email's conversation: `capture_item`
 * (filed as *File on* files a capture) and `follow_conversation` with the sent
 * email as its latest message, in one transaction, which is what makes the
 * Item Waiting for reply, titled with the subject. **A conversation an open
 * Item already follows answers that Item** and makes none; the same pick sent
 * twice finds its own Item by its derived id.
 */
export function followSentEmail(
  db: AccountDb,
  accountName: string,
  pick: SentPick,
  at: string,
): { itemId: string; made: boolean } {
  const connection = getSourceAccount(db, accountName, pick.sourceAccountId);
  if (!connection || connection.workspaceId !== pick.workspaceId || connection.externalAccountKey === null) {
    throw new SourceAccountNotFoundError(pick.sourceAccountId);
  }
  return db.transaction(() => {
    const holds = {
      workspaceId: connection.workspaceId,
      connectorId: connection.connectorId,
      externalAccountKey: connection.externalAccountKey!,
    };
    const following = followedBy(db, accountName, holds, pick.conversationId).get();
    if (following) return { itemId: following.itemId, made: false };

    const earlier = getItem(db, accountName, pick.itemId);
    if (earlier) {
      // Made by this pick sent before; open, it is answered as it stands.
      if (earlier.completedAt === null && earlier.deletedAt === null) return { itemId: earlier.id, made: false };
      throw new DraftRefusedError(SENT_ITEM_FINISHED);
    }

    runCommand(db, accountName, 'capture_item', {
      commandId: pick.captureId,
      issuedAt: at,
      workspaceId: pick.workspaceId,
      itemId: pick.itemId,
      message: pick.subject,
      workspaceDecided: pick.decided,
      ...(pick.panelIds.length > 0 ? { panelIds: [...pick.panelIds] } : {}),
    });
    runCommand(db, accountName, 'follow_conversation', {
      commandId: pick.followId,
      issuedAt: at,
      workspaceId: pick.workspaceId,
      itemId: pick.itemId,
      connectorId: holds.connectorId,
      externalAccountKey: holds.externalAccountKey,
      conversationId: pick.conversationId,
      link: pick.link,
      // Your own sent mail is your turn: the Item waits for the reply.
      latest: { by: 'you', from: null, at: pick.sentAt, excerpt: pick.excerpt },
      messageCount: 1,
      startedAt: pick.sentAt,
      withWhom: pick.to,
      connectionDays: connection.dueInDays,
    });
    return { itemId: pick.itemId, made: true };
  });
}
