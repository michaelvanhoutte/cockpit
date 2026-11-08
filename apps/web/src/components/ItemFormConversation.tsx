import { useQueryClient } from '@tanstack/react-query';
import { conversationOf, itemLabel, type Conversation, type Item, type Mailbox } from '@cockpit/shared';
import { conversationSourceName } from '../conversationLine';
import { draftBeingStarted, emailEntryFor, emailFromItem, lastMailboxIn, useDraftStarting } from '../emailDraft';
import type { SourceNames } from '../itemSource';
import { useUndo } from '../undo';
import { ConversationSection } from './ConversationSection';
import { EmailButton } from './EmailButton';

/**
 * The Item form's conversation part: the conversation the Item follows ("Show
 * the conversation an Item follows in its form", issue 1706) with **Reply…**,
 * or **Email…** where it follows none ("Email… makes a Gmail draft the Item then
 * follows", issue 1708), *Draft started* from the click on. Fetched the first
 * time a form is opened, apart from the initial bundle; nothing where the Item
 * follows no conversation and no mailbox can start one.
 */
export function ItemFormConversation({
  item,
  itemId,
  workspaceId,
  conversations,
  mailboxes,
  sourceNames,
}: {
  item: Item | undefined;
  itemId: string;
  workspaceId: string;
  conversations: readonly Conversation[] | undefined;
  mailboxes: readonly Mailbox[] | undefined;
  sourceNames: SourceNames;
}) {
  const queryClient = useQueryClient();
  const offerToUndo = useUndo();
  const draftingAt = useDraftStarting(itemId);
  const held = conversationOf(conversations, itemId);
  /** The conversation the section draws: *Draft started* from a click on *Email…* or *Reply…* on. */
  const shown = draftingAt && !held?.draftStarted ? draftBeingStarted(itemId, draftingAt, held) : held;
  /** *Email…* or *Reply…*, where a mailbox of the Workspace can make the draft. */
  const entry = item && !item.completedAt ? emailEntryFor(held, mailboxes, lastMailboxIn(workspaceId)) : null;
  const emailWith = (mailbox: Mailbox) => {
    if (item) void emailFromItem(queryClient, { workspaceId, itemId, mailbox, label: itemLabel(item) }, offerToUndo);
  };
  if (shown) {
    return (
      <ConversationSection
        conversation={shown}
        sourceName={conversationSourceName(shown, sourceNames)}
        now={Date.now()}
        // Reply… in a followed conversation, or Email… again on one a click
        // left starting, which only a new draft mends.
        reply={entry && held && <EmailButton entry={entry} onEmail={emailWith} />}
      />
    );
  }
  // An Item following nothing offers Email… where the section would be.
  return entry ? (
    <div className="flex justify-end">
      <EmailButton entry={entry} onEmail={emailWith} />
    </div>
  ) : null;
}
