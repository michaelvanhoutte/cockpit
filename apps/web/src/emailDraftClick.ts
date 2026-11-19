import type { QueryClient } from '@tanstack/react-query';
import { phoneAddress, uuidv7, type Conversation, type DeclaredPhoneLinks, type Mailbox } from '@cockpit/shared';
import { DraftRefused, makeADraft } from './api/drafts';
import { LAST_USED_KEY } from './emailDraft';
import { followedConversationId } from './itemSource';
import { phoneLinksOnThisDevice } from './phoneDevice';

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
 * Where the draft opens: the address the server returned, except on a phone
 * (decided now, at the tap) where the source declares its phone address - the
 * conversation a reply is in, and the Drafts folder for anything else, since a
 * new message has no conversation until Gmail names one ("Open a Gmail Item at
 * its email on a phone", issue 1837).
 */
function where(link: string, mailbox: Mailbox, followed: Conversation | undefined, declared: DeclaredPhoneLinks): string {
  const phone = phoneLinksOnThisDevice(declared);
  return (phone && phoneAddress(phone, mailbox.connectorId, link, followed?.source === mailbox.connectorId ? followedConversationId(followed) : null)) || link;
}

/**
 * The draft asked for and the tab opened at the click pointed at it; refused,
 * the tab closes and the reason is answered. The Workspace is read again
 * either way, so the row draws what the server holds.
 */
export async function makeTheDraft(
  queryClient: QueryClient | undefined,
  {
    workspaceId,
    itemId,
    mailbox,
    label,
    followed,
    phoneLinks,
  }: {
    workspaceId: string;
    itemId: string;
    mailbox: Mailbox;
    label: string;
    followed?: Conversation | undefined;
    phoneLinks?: DeclaredPhoneLinks;
  },
  tab: Window | null,
  claude?: { points: string },
): Promise<string | null> {
  try {
    const link = await makeADraft(workspaceId, itemId, {
      clickId: uuidv7(),
      sourceAccountId: mailbox.sourceAccountId,
      ...(claude ? { withClaude: true, points: claude.points } : {}),
    });
    rememberMailbox(workspaceId, mailbox.sourceAccountId);
    const opensAt = where(link, mailbox, followed, phoneLinks);
    if (tab) tab.location.href = opensAt;
    else window.open(opensAt, '_blank', 'noopener');
    await queryClient?.invalidateQueries({ queryKey: ['snapshot', workspaceId] });
    return null;
  } catch (failure) {
    tab?.close();
    await queryClient?.invalidateQueries({ queryKey: ['snapshot', workspaceId] });
    const why = failure instanceof Error ? failure.message : "Couldn't make the draft";
    // Said back as it was only where the server put it back: the source would
    // not make the draft after the click was logged. A refusal changed nothing,
    // and anything else may have stopped after the click was logged, leaving it
    // In progress (issue 1720).
    const putBack = failure instanceof DraftRefused && failure.putBack;
    return putBack ? `“${label}” is back as it was. ${why}` : `“${label}”: ${why}`;
  }
}
