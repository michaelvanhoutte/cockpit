import type { QueryClient } from '@tanstack/react-query';
import { uuidv7, type Mailbox } from '@cockpit/shared';
import { DraftRefused, makeADraft } from './api/drafts';
import { LAST_USED_KEY } from './emailDraft';

/**
 * The part of a click on *Email…* or *Reply…* that waits on the server ("Email…
 * makes a Gmail draft the Item then follows", issue 1708), in a chunk of its
 * own fetched on the first click, so the row menu that offers the entry costs
 * the initial bundle almost nothing. The tab is opened before this loads
 * (`emailFromItem`), while the click still allows it.
 */

function rememberMailbox(workspaceId: string, sourceAccountId: string): void {
  try {
    const held = JSON.parse(localStorage.getItem(LAST_USED_KEY) ?? '{}') as Record<string, unknown>;
    localStorage.setItem(LAST_USED_KEY, JSON.stringify({ ...held, [workspaceId]: sourceAccountId }));
  } catch {
    // Not remembered: the next question offers the mailboxes in their own order.
  }
}

/**
 * The draft asked for and the tab opened at the click pointed at it; refused,
 * the tab closes and the reason is answered. The Workspace is read again
 * either way, so the row draws what the server holds.
 */
export async function makeTheDraft(
  queryClient: QueryClient | undefined,
  { workspaceId, itemId, mailbox, label }: { workspaceId: string; itemId: string; mailbox: Mailbox; label: string },
  tab: Window | null,
): Promise<string | null> {
  try {
    const link = await makeADraft(workspaceId, itemId, { clickId: uuidv7(), sourceAccountId: mailbox.sourceAccountId });
    rememberMailbox(workspaceId, mailbox.sourceAccountId);
    if (tab) tab.location.href = link;
    else window.open(link, '_blank', 'noopener');
    await queryClient?.invalidateQueries({ queryKey: ['snapshot', workspaceId] });
    return null;
  } catch (failure) {
    tab?.close();
    await queryClient?.invalidateQueries({ queryKey: ['snapshot', workspaceId] });
    const why = failure instanceof Error ? failure.message : "Couldn't make the draft";
    // Refused, or the source would not: the Item has its status back. Anything
    // else may have stopped after the click was logged, leaving it In progress.
    const putBack = failure instanceof DraftRefused && (failure.status < 500 || failure.status === 502);
    return putBack ? `“${label}” is back as it was. ${why}` : `“${label}”: ${why}`;
  }
}
