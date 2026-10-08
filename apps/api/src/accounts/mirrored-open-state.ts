import { and, eq, exists, isNotNull, ne } from 'drizzle-orm';
import type { GmailMark } from '@cockpit/shared';
import { GMAIL } from '../domain/named-sources.js';
import type { AccountDb } from './client.js';
import { connectorAccounts, gmailConversations } from './schema.js';

/**
 * What a person's change to an Item asks of a source that mirrors its open
 * state ("Take the Cockpit label off in Gmail when its task is done in
 * Cockpit", issue 728) - today the mark a Gmail connection follows, the
 * `Cockpit` label or the star ("Keep a starred Gmail task in step with its
 * star, both ways", issue 823), which is on exactly while the Item is open.
 *
 * **Wanted state, not an event**: the link records what Cockpit wants the
 * mark to be until Gmail confirms it, written in the same transaction as the
 * Item, so a run that stops before pushing it leaves it waiting rather than
 * lost. Each check pushes every one still waiting before reading what Gmail
 * changed, and a change still waiting wins over Gmail's (`gmailChangeApplies`,
 * connectors/gmail.ts).
 */

type InATransaction = Parameters<Parameters<AccountDb['transaction']>[0]>[0];

/** Open is neither done nor dismissed: what the label or the star stands for. */
export function isOpen(item: { completedAt: string | null; deletedAt: string | null }): boolean {
  return item.completedAt === null && item.deletedAt === null;
}

/**
 * Records the open state an Item has just moved to as wanted of its
 * conversation's mark - where it moved at all, and only while its mailbox
 * is still connected to the Item's Workspace, since disconnecting stops the
 * mirroring.
 */
export function wantOpenStateMirrored(
  tx: InATransaction,
  tenantId: string,
  before: { id: string; completedAt: string | null; deletedAt: string | null },
  after: { completedAt: string | null; deletedAt: string | null },
): void {
  const open = isOpen(after);
  if (isOpen(before) === open) return;
  tx.update(gmailConversations)
    .set({ labelWanted: open })
    .where(
      and(
        eq(gmailConversations.tenantId, tenantId),
        eq(gmailConversations.itemId, before.id),
        exists(
          tx
            .select({ id: connectorAccounts.id })
            .from(connectorAccounts)
            .where(
              and(
                eq(connectorAccounts.tenantId, tenantId),
                eq(connectorAccounts.connectorId, GMAIL),
                eq(connectorAccounts.workspaceId, gmailConversations.workspaceId),
                eq(connectorAccounts.externalAccountKey, gmailConversations.mailboxKey),
                // Only under the mark the connection follows now (issue 822):
                // the label or the star, whichever brought the Item in.
                eq(connectorAccounts.follows, gmailConversations.mark),
              ),
            ),
        ),
      ),
    )
    .run();
}

/**
 * A Gmail connection going takes whatever it had still to push with it - and
 * one connected again under another mark, whatever it had to push under the
 * mark it no longer follows (`kept`).
 */
export function dropWhatWasWanted(
  tx: InATransaction,
  tenantId: string,
  workspaceId: string,
  mailboxKey: string,
  kept?: GmailMark,
): void {
  tx.update(gmailConversations)
    .set({ labelWanted: null })
    .where(
      and(
        eq(gmailConversations.tenantId, tenantId),
        eq(gmailConversations.workspaceId, workspaceId),
        eq(gmailConversations.mailboxKey, mailboxKey),
        isNotNull(gmailConversations.labelWanted),
        kept ? ne(gmailConversations.mark, kept) : undefined,
      ),
    )
    .run();
}

/** Whether the Item's conversation has a change waiting to reach Gmail - what brings the check forward. */
export function labelChangeWaiting(db: AccountDb, tenantId: string, itemId: string): boolean {
  return (
    db
      .select({ itemId: gmailConversations.itemId })
      .from(gmailConversations)
      .where(
        and(
          eq(gmailConversations.tenantId, tenantId),
          eq(gmailConversations.itemId, itemId),
          isNotNull(gmailConversations.labelWanted),
        ),
      )
      .get() !== undefined
  );
}
