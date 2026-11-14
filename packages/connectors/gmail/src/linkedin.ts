/**
 * Gmail's side of reading a LinkedIn message email ("Follow the LinkedIn
 * conversation instead of the notification", issue 1711). What a LinkedIn
 * email says is read by `@cockpit/linkedin-mail`, which knows no mail provider
 * (issue 1775); this file only hands it a Gmail message as its sender, bodies
 * and time, and leaves out what Gmail says is nobody's turn: a draft, mail in
 * the bin or spam, mail sent from this mailbox.
 */

import {
  LINKEDIN_PREFIX,
  NOTIFICATION_SENDERS,
  linkedInMessageIn,
  type LinkedInMessage,
} from '@cockpit/linkedin-mail';
import {
  AWAY,
  DRAFT,
  SENT,
  decodedBody,
  headerOf,
  sentAt,
  type GmailConversationRead,
  type GmailMessage,
  type GmailPart,
} from './messages.js';

export { LINKEDIN_PREFIX };

/** What Gmail is asked for to find the LinkedIn message emails among a page of added mail: from either of LinkedIn's message senders. */
export const NOTIFICATION_SEARCH = `from:(${NOTIFICATION_SENDERS.join(' OR ')})`;

/** A message notification, read: whose conversation it is, where it is, and the turn it is. */
export type LinkedInNotification = LinkedInMessage;

/** Every text part of a message, decoded: the HTML ones first, since that is where LinkedIn puts its button. */
function textPartsOf(part: GmailPart | null | undefined): { plain: string[]; html: string[] } {
  const found = { plain: [] as string[], html: [] as string[] };
  const visit = (one: GmailPart | null | undefined) => {
    if (!one) return;
    const type = typeof one.mimeType === 'string' ? one.mimeType.toLowerCase() : '';
    if ((type === 'text/plain' || type === 'text/html') && typeof one.body?.data === 'string') {
      (type === 'text/html' ? found.html : found.plain).push(decodedBody(one.body.data));
    }
    if (Array.isArray(one.parts)) for (const child of one.parts as GmailPart[]) visit(child);
  };
  visit(part);
  return found;
}

/**
 * A message as `users.messages.get` with `format=full` (or one of a
 * conversation's) answers it, read as a LinkedIn message email - or null for
 * anything else: a draft, in the bin or spam, sent from this mailbox, or an
 * email the reader does not take for a LinkedIn message.
 */
export function linkedInNotificationIn(message: unknown): LinkedInNotification | null {
  const held = (message ?? null) as GmailMessage | null;
  if (!held || !Array.isArray(held.labelIds)) return null;
  const labels = held.labelIds as unknown[];
  if (labels.includes(DRAFT) || labels.includes(SENT) || labels.some((label) => AWAY.includes(label as string))) return null;
  return linkedInMessageIn({ from: headerOf(held.payload, 'From'), ...textPartsOf(held.payload), at: sentAt(held) });
}

/**
 * A Gmail conversation, as `threads.get` with `format=full` answers it, read as
 * the LinkedIn conversation its notifications are about - or null where it
 * holds none, so it is followed as the Gmail conversation it is.
 *
 * **The latest notification names the conversation**, and only the notifications
 * of that conversation count: how many there were, since when, and who it is
 * with. They are the notifications that came, not the messages that were sent,
 * so the form gives no count for it.
 */
export function linkedInConversationOf(answer: unknown): GmailConversationRead | null {
  const { messages } = (answer ?? {}) as { messages?: unknown };
  const notifications = (Array.isArray(messages) ? (messages as GmailMessage[]) : [])
    .map((message) => ({ at: sentAt(message), notification: linkedInNotificationIn(message) }))
    .filter((one): one is { at: number; notification: LinkedInNotification } => one.notification !== null)
    .sort((a, b) => a.at - b.at);
  const latest = notifications[notifications.length - 1]?.notification;
  if (!latest) return null;
  const same = notifications.filter((one) => one.notification.conversationId === latest.conversationId);
  return {
    id: latest.conversationId,
    link: latest.link,
    latest: latest.turn,
    messageCount: same.length,
    startedAt: same[0]!.notification.turn.at,
    withWhom: latest.turn.from,
  };
}
