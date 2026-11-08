import type { ConnectorHost, ConversationRead } from '@cockpit/connector-sdk';
import { OutOfCalls, type Mailbox } from './graph.js';
import { TURN_FIELDS, deletedItemsIn, turnPage, type MailTurn } from './messages.js';

/**
 * Following an Outlook conversation ("Outlook follows the flagged conversation
 * as Gmail does", issue 1707). The connector only says who wrote; the host
 * decides what that does to the Item.
 *
 * **What Microsoft Graph documents, and what this relies on** (the spike that
 * was to confirm it was skipped, so the unverified part is named):
 *
 * - `GET /me/messages` lists "the messages in the signed-in user's mailbox
 *   (including the Deleted Items and Clutter folders)", so one read covers
 *   every folder, Sent Items among them.
 *   https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0
 * - `$orderby` is allowed with `$filter` only on a property that is also in the
 *   filter, first; so the read is `$filter=receivedDateTime ge T` with
 *   `$orderby=receivedDateTime` (same page).
 * - **The field is `receivedDateTime`, not `createdDateTime`**: the message
 *   resource documents `createdDateTime` as when the message was created
 *   (https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0),
 *   which for a reply is when its draft was started, possibly long before it
 *   was sent, so a cursor that had passed that time would never see it. Graph
 *   does not document what `receivedDateTime` is for a message in Sent Items;
 *   Exchange stamps it with the time of sending. **That is not proved against
 *   a real mailbox**; the contract suite is where a recorded answer settles it.
 * - A message's `conversationId` is filterable with `eq`, which is how one
 *   conversation is read whole.
 */

/** How far back a complete read of recent mail starts again, so a message stamped a little late is still seen; the host ignores a message it was told of twice. */
export const OVERLAP_MS = 5 * 60_000;

/** How many messages of a read Graph is asked for at a time. */
export const TURN_PAGE_SIZE = 100;

export interface Folders {
  readonly sentItems: string;
  readonly deletedItems: string;
}

/** The ids of Sent Items and Deleted Items, which tell yours from theirs and leave out what is binned. */
export async function foldersOf(mailbox: Mailbox, deletedItems?: string): Promise<Folders> {
  const sent = deletedItemsIn(await mailbox.get('mailFolders/sentitems?$select=id'));
  if (!sent) throw new Error('Microsoft gave no Sent Items folder for this mailbox');
  const deleted = deletedItems ?? deletedItemsIn(await mailbox.get('mailFolders/deleteditems?$select=id'));
  if (!deleted) throw new Error('Microsoft gave no Deleted Items folder for this mailbox');
  return { sentItems: sent, deletedItems: deleted };
}

/** One conversation read whole: where it stands, and which of its messages carry the flag. */
export interface ConversationState {
  readonly read: ConversationRead | null;
  readonly flagged: string[];
}

/** Every message of one conversation, a page at a time. */
export async function conversationMessages(mailbox: Mailbox, conversationId: string, folders: Folders): Promise<{ turns: MailTurn[]; flaggedIds: string[] }> {
  const turns: MailTurn[] = [];
  const flaggedIds: string[] = [];
  let next: string | null =
    `messages?$filter=${encodeURIComponent(`conversationId eq '${conversationId.replace(/'/g, "''")}'`)}&$select=${TURN_FIELDS}&$top=${TURN_PAGE_SIZE}`;
  while (next) {
    const answer = await mailbox.get(next);
    // Flagged anywhere counts for Done, even in Deleted Items; only sent mail outside it is a turn.
    const everything = (answer as { value?: { id?: string; flag?: { flagStatus?: string } }[] } | null)?.value ?? [];
    for (const one of everything) if (one.flag?.flagStatus === 'flagged' && typeof one.id === 'string') flaggedIds.push(one.id);
    const page = turnPage(answer, folders);
    turns.push(...page.turns);
    next = page.nextLink;
  }
  return { turns, flaggedIds };
}

/** Where a conversation stands, from its messages: null when nothing in it is a message that was sent. */
export function standingOf(turns: readonly MailTurn[], conversationId: string): ConversationRead | null {
  if (turns.length === 0) return null;
  const byTime = [...turns].sort((one, other) => Date.parse(one.at) - Date.parse(other.at));
  const latest = byTime[byTime.length - 1]!;
  const lastFromThem = [...byTime].reverse().find((one) => one.by === 'them');
  return {
    id: conversationId,
    link: latest.link ?? `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(latest.messageId)}`,
    latest: { by: latest.by, from: latest.from, at: latest.at, excerpt: latest.excerpt },
    messageCount: byTime.length,
    startedAt: byTime[0]!.at,
    withWhom: lastFromThem?.from ?? null,
  };
}

/**
 * Reports, as turns, the messages received since `since` in the conversations
 * followed - one read of the mailbox, every folder. Returns where the next run
 * starts: the time of the last message reported when the calls ran out, else a
 * little before this run began. Paged on the cursor, oldest first.
 */
export async function reportTurnsSince(
  host: ConnectorHost,
  mailbox: Mailbox,
  folders: Folders,
  followed: ReadonlySet<string>,
  since: string,
  runStart: Date,
): Promise<{ next: string; moreToDo: boolean }> {
  let cursor = since;
  const filter = encodeURIComponent(`receivedDateTime ge ${since}`);
  let next: string | null = `messages?$filter=${filter}&$orderby=receivedDateTime&$select=${TURN_FIELDS}&$top=${TURN_PAGE_SIZE}`;
  try {
    while (next) {
      const page = turnPage(await mailbox.get(next), folders);
      for (const turn of page.turns) {
        if (followed.has(turn.conversationId)) {
          await host.reportTurn({
            conversationId: turn.conversationId,
            messageId: turn.messageId,
            by: turn.by,
            from: turn.from,
            at: turn.at,
            excerpt: turn.excerpt,
          });
        }
        cursor = turn.at;
      }
      next = page.nextLink;
    }
  } catch (error) {
    if (error instanceof OutOfCalls) return { next: cursor, moreToDo: true };
    throw error;
  }
  return { next: new Date(runStart.getTime() - OVERLAP_MS).toISOString(), moreToDo: false };
}

/** The ids of the messages in a conversation that carry the flag, wherever they are: the ones Done has to complete. */
export async function flaggedIn(mailbox: Mailbox, conversationId: string): Promise<string[]> {
  const ids: string[] = [];
  let next: string | null =
    `messages?$filter=${encodeURIComponent(`conversationId eq '${conversationId.replace(/'/g, "''")}'`)}&$select=id,flag&$top=${TURN_PAGE_SIZE}`;
  while (next) {
    const answer = (await mailbox.get(next)) as { value?: { id?: unknown; flag?: { flagStatus?: unknown } }[]; '@odata.nextLink'?: unknown } | null;
    for (const one of answer?.value ?? []) {
      if (one.flag?.flagStatus === 'flagged' && typeof one.id === 'string') ids.push(one.id);
    }
    const link = answer?.['@odata.nextLink'];
    next = typeof link === 'string' && link ? link : null;
  }
  return ids;
}
