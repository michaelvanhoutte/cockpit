/**
 * Reading a LinkedIn message notification ("Follow the LinkedIn conversation
 * instead of the notification", issue 1711). LinkedIn has no connector of its
 * own, so the Gmail connector knows its notification emails: one that names a
 * LinkedIn conversation is a turn of that conversation, theirs, and an Item
 * starred from one follows the conversation on LinkedIn instead of the email.
 *
 * Pure, as the rest of the package's readers are. **Tolerant by design**, since
 * LinkedIn's email format is not ours to fix: the link may be LinkedIn's own
 * address or a LinkedIn redirect that carries it, in any part of the message;
 * anything that does not resolve to a LinkedIn messaging thread is plain mail.
 * Nothing is fetched to resolve a redirect: only the address is read.
 *
 * **Only a `https://www.linkedin.com/messaging/` address is ever kept**, built
 * from the thread's id, so a tracking token in the email never leaves it and a
 * lookalike host never becomes a link (the design's trust lens).
 */

import {
  AWAY,
  DRAFT,
  EXCERPT_LENGTH,
  SENT,
  cutTo,
  decodedBody,
  headerOf,
  oneLine,
  plainTextOf,
  senderIn,
  sentAt,
  type GmailConversationRead,
  type GmailMessage,
  type GmailPart,
  type GmailTurn,
} from './messages.js';

/**
 * What the id of a LinkedIn conversation starts with, so it can never be taken
 * for a Gmail thread, and the row can name it (`LINKEDIN_CONVERSATION_PREFIX`
 * in the shared contract, which a connector package may not import: the host's
 * L2 test pins the two together).
 */
export const LINKEDIN_PREFIX = 'linkedin:';

/**
 * The address LinkedIn sends a message notification from: the only sender whose
 * mail is read in full to find a turn, whichever language it is in.
 */
export const NOTIFICATION_SENDER = 'messages-noreply@linkedin.com';

/** What Gmail is asked for to find the notifications among a page of added mail. */
export const NOTIFICATION_SEARCH = `from:${NOTIFICATION_SENDER}`;

/** A message notification, read: whose conversation it is, where it is, and the turn it is. */
export interface LinkedInNotification {
  /** `linkedin:` and LinkedIn's own thread id. */
  readonly conversationId: string;
  /** `https://www.linkedin.com/messaging/thread/<id>/`, and nothing LinkedIn tracked the email with. */
  readonly link: string;
  /** Always theirs: what the person answers on LinkedIn is never seen. */
  readonly turn: GmailTurn;
}

/** Whether a host is LinkedIn's: `linkedin.com` or a subdomain of it, never one that only ends in the same letters. */
function isLinkedIn(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'linkedin.com' || host.endsWith('.linkedin.com');
}

/** What LinkedIn's thread ids are made of: letters, digits and the few signs a base64 id carries, never starting with one, so `.` and `..` are no id. */
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9_=.-]{0,199}$/;

/** The messaging address's path, direct or through LinkedIn's `comm` tracking prefix. */
const THREAD_PATH = /^\/(?:comm\/)?messaging\/thread\/([^/?#]+)/i;

/** How many redirects deep an address is looked into: LinkedIn wraps its links once, sometimes twice. */
const REDIRECTS_FOLLOWED = 2;

/**
 * The id of the LinkedIn conversation an address leads to - directly, or
 * through a LinkedIn redirect that carries it - or null for any other address.
 * A redirect off LinkedIn's own hosts is not looked into.
 */
export function linkedInThreadOf(address: string, depth = 0): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !isLinkedIn(url.hostname)) return null;
  const direct = THREAD_PATH.exec(url.pathname);
  if (direct) {
    let id: string;
    try {
      id = decodeURIComponent(direct[1]!);
    } catch {
      return null;
    }
    return THREAD_ID.test(id) ? id : null;
  }
  if (depth >= REDIRECTS_FOLLOWED) return null;
  for (const value of url.searchParams.values()) {
    if (!/^https?:\/\//i.test(value)) continue;
    const found = linkedInThreadOf(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Where LinkedIn shows a conversation, from its thread id alone. */
function messagingLink(threadId: string): string {
  return `https://www.linkedin.com/messaging/thread/${encodeURIComponent(threadId).replace(/%3D/g, '=')}/`;
}

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

/** The first address in the message's bodies that leads to a LinkedIn conversation, as the id of that conversation. */
function threadIn(bodies: readonly string[]): string | null {
  for (const body of bodies) {
    for (const found of body.matchAll(/https?:\/\/[^\s"'<>\])]+/gi)) {
      const id = linkedInThreadOf(found[0].replace(/&amp;/gi, '&').replace(/[.,;]+$/, ''));
      if (id) return id;
    }
  }
  return null;
}

/** What LinkedIn adds to the name it sends from: *Steven Noels via LinkedIn*. */
const VIA_LINKEDIN = /\s+via\s+LinkedIn$/i;

/** Who sent the notification, as LinkedIn names them: the name before *via LinkedIn*, or nobody where there is only an address. */
function senderOf(from: string | null): string | null {
  const named = senderIn(from);
  if (!named || named.includes('@')) return null;
  return named.replace(VIA_LINKEDIN, '').trim() || null;
}

/** The lines where a notification's message ends and LinkedIn's own buttons and footer begin, in English and Dutch. */
const MESSAGE_ENDS = /^(?:view (?:the )?(?:full )?(?:message|conversation)|reply|bekijk (?:het )?(?:bericht|gesprek)|beantwoord(?:en)?)\b/i;

/** A line that is only an address, or a button's label carrying one. */
const ONLY_AN_ADDRESS = /^\[?\s*https?:\/\/\S+\s*\]?$/i;

/**
 * The first lines of what was written, out of a notification's text: after the
 * sender's name, up to the button that opens the message.
 */
function excerptOf(parts: { plain: string[]; html: string[] }, name: string | null): string {
  const text = parts.plain[0] ?? (parts.html[0] === undefined ? '' : plainTextOf(parts.html[0]));
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const end = lines.findIndex((line) => MESSAGE_ENDS.test(line));
  const body = (end === -1 ? lines : lines.slice(0, end)).filter((line) => !ONLY_AN_ADDRESS.test(line));
  if (name && body[0]?.toLowerCase() === name.toLowerCase()) body.shift();
  return cutTo(oneLine(body.join(' ')), EXCERPT_LENGTH);
}

/**
 * A message as `users.messages.get` with `format=full` (or one of a
 * conversation's) answers it, read as a LinkedIn message notification - or null
 * for anything else: not from LinkedIn, a draft, in the bin or spam, sent from
 * this mailbox, naming no LinkedIn conversation (a connection request, a job
 * alert), or naming a time of nobody's.
 */
export function linkedInNotificationIn(message: unknown): LinkedInNotification | null {
  const held = (message ?? null) as GmailMessage | null;
  if (!held || !Array.isArray(held.labelIds)) return null;
  const labels = held.labelIds as unknown[];
  if (labels.includes(DRAFT) || labels.includes(SENT) || labels.some((label) => AWAY.includes(label as string))) return null;
  const from = headerOf(held.payload, 'From');
  const address = /<([^>]*)>\s*$/.exec(from ?? '')?.[1] ?? from ?? '';
  const domain = address.trim().toLowerCase().split('@')[1];
  if (!domain || !isLinkedIn(domain)) return null;
  const at = sentAt(held);
  if (at <= 0) return null;
  const parts = textPartsOf(held.payload);
  const threadId = threadIn([...parts.html, ...parts.plain]);
  if (!threadId) return null;
  const name = senderOf(from);
  return {
    conversationId: `${LINKEDIN_PREFIX}${threadId}`,
    link: messagingLink(threadId),
    turn: { by: 'them', from: name, at: new Date(at).toISOString(), excerpt: excerptOf(parts, name) },
  };
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
