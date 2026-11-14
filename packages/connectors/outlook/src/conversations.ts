import type { ConnectorHost, ConversationRead } from '@cockpit/connector-sdk';
import { OutOfCalls, type Mailbox } from './graph.js';
import {
  TURN_FIELDS,
  addressesOfYours,
  asYours,
  deletedItemsIn,
  othersOn,
  sendFromAddresses,
  turnPage,
  type MailTurn,
} from './messages.js';

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

/**
 * Every message of one conversation that was sent or received outside Deleted
 * Items, a page at a time, each yours where it sits in Sent Items or was sent
 * from an address of yours: one the conversation shows you sending from, one in
 * `sendFrom`, or the alias (issue 1760).
 */
export async function conversationMessages(
  mailbox: Mailbox,
  conversationId: string,
  folders: Folders,
  alias: string | null = null,
  sendFrom: Iterable<string> = [],
): Promise<MailTurn[]> {
  const turns: MailTurn[] = [];
  let next: string | null =
    `messages?$filter=${encodeURIComponent(`conversationId eq '${conversationId.replace(/'/g, "''")}'`)}&$select=${TURN_FIELDS}&$top=${TURN_PAGE_SIZE}`;
  while (next) {
    const page = turnPage(await mailbox.get(next), folders);
    turns.push(...page.turns);
    next = page.nextLink;
  }
  return asYours(turns, addressesOfYours(alias, [...sendFrom, ...sendFromAddresses(turns)]));
}

/**
 * Where a conversation stands, from its messages: null when nothing in it is a
 * message that was sent. Says whether anyone but you is on it (issue 1760),
 * reading the messages as `conversationMessages` read them, against the same
 * addresses of yours.
 */
export function standingOf(
  turns: readonly MailTurn[],
  conversationId: string,
  alias: string | null = null,
  sendFrom: Iterable<string> = [],
): ConversationRead | null {
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
    othersOnIt: othersOn(byTime, addressesOfYours(alias, [...sendFrom, ...sendFromAddresses(byTime)])),
  };
}

/**
 * Reports, as turns, the messages received since `since` in the conversations
 * followed - one read of the mailbox, every folder. Returns where the next run
 * starts: the time of the last message reported when the calls ran out, else a
 * little before this run began. Paged on the cursor, oldest first.
 *
 * Each message is yours where it sits in Sent Items or was sent from an
 * address of yours - `sendFrom`, the senders this read finds in Sent Items, or
 * the alias - and says whether anyone but you is on it, as its own sender, To
 * and Cc show (issue 1760). Answers too every address it learned you send from,
 * for the next run to start with.
 */
export async function reportTurnsSince(
  host: ConnectorHost,
  mailbox: Mailbox,
  folders: Folders,
  followed: ReadonlySet<string>,
  since: string,
  runStart: Date,
  alias: string | null = null,
  sendFrom: Iterable<string> = [],
): Promise<{ next: string; moreToDo: boolean; sendFrom: string[] }> {
  let cursor = since;
  const learned = new Set(sendFrom);
  const filter = encodeURIComponent(`receivedDateTime ge ${since}`);
  let next: string | null = `messages?$filter=${filter}&$orderby=receivedDateTime&$select=${TURN_FIELDS}&$top=${TURN_PAGE_SIZE}`;
  try {
    while (next) {
      const page = turnPage(await mailbox.get(next), folders);
      for (const address of sendFromAddresses(page.turns)) learned.add(address);
      const yours = addressesOfYours(alias, learned);
      for (const turn of asYours(page.turns, yours)) {
        if (followed.has(turn.conversationId)) {
          await host.reportTurn({
            conversationId: turn.conversationId,
            messageId: turn.messageId,
            by: turn.by,
            from: turn.from,
            at: turn.at,
            excerpt: turn.excerpt,
            // The conversation's link moves to the newest message, which Open then shows (issue 1720).
            ...(turn.link ? { link: turn.link } : {}),
            othersOnIt: othersOn([turn], yours),
          });
        }
        cursor = turn.at;
      }
      next = page.nextLink;
    }
  } catch (error) {
    if (error instanceof OutOfCalls) return { next: cursor, moreToDo: true, sendFrom: [...learned] };
    throw error;
  }
  return { next: new Date(runStart.getTime() - OVERLAP_MS).toISOString(), moreToDo: false, sendFrom: [...learned] };
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
