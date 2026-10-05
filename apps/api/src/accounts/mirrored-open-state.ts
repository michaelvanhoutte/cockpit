import { and, eq, exists, isNotNull } from 'drizzle-orm';
import { GMAIL } from '@cockpit/shared';
import type { AccountDb } from './client.js';
import { connectorAccounts, gmailConversations } from './schema.js';

/**
 * What a person's change to an Item asks of a source that mirrors its open
 * state ("Take the Cockpit label off in Gmail when its task is done in
 * Cockpit", issue 728) - today Gmail's `Cockpit` label, which is on exactly
 * while the Item is open.
 *
 * **Wanted state, not an event**: the link records what Cockpit wants the
 * label to be until Gmail confirms it, written in the same transaction as the
 * Item, so a run that stops before pushing it leaves it waiting rather than
 * lost. Each check pushes every one still waiting before reading what Gmail
 * changed, and a change still waiting wins over Gmail's (`gmailChangeApplies`,
 * connectors/gmail.ts).
 */

type InATransaction = Parameters<Parameters<AccountDb['transaction']>[0]>[0];

/** Open is neither done nor dismissed: what the label stands for. */
export function isOpen(item: { completedAt: string | null; deletedAt: string | null }): boolean {
  return item.completedAt === null && item.deletedAt === null;
}

/**
 * Records the open state an Item has just moved to as wanted of its
 * conversation's label - where it moved at all, and only while its mailbox
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
              ),
            ),
        ),
      ),
    )
    .run();
}

/** A Gmail connection going takes whatever it had still to push with it. */
export function dropWhatWasWanted(tx: InATransaction, tenantId: string, workspaceId: string, mailboxKey: string): void {
  tx.update(gmailConversations)
    .set({ labelWanted: null })
    .where(
      and(
        eq(gmailConversations.tenantId, tenantId),
        eq(gmailConversations.workspaceId, workspaceId),
        eq(gmailConversations.mailboxKey, mailboxKey),
        isNotNull(gmailConversations.labelWanted),
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
