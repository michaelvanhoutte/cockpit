/**
 * Reading what Gmail answers, and writing the one change Cockpit makes. Pure:
 * every function takes an answer already parsed and says what it holds, so each
 * branch is provable without a mailbox (tests/unit/reading-gmail.test.ts).
 * Every quirk these encode is in the package README.
 */

/** The label a conversation has to carry to become an Item, when the connection follows the label. Fixed, by decision. */
export const COCKPIT_LABEL = 'Cockpit';

/**
 * Gmail's own label for a starred message, which is what Outlook's flag for
 * follow-up sets - the label a connection following the star reads its
 * history by.
 */
export const STARRED = 'STARRED';

/**
 * Gmail's own labels for mail on its way out: in the bin, or marked spam. A
 * labelled message there keeps the label, and no longer counts as labelled.
 */
const AWAY: readonly string[] = ['TRASH', 'SPAM'];

/**
 * The longest a title or a sender may be: the host stores a title as given
 * and caps it here (`TITLE_LENGTH` in the shared contract, which a connector
 * package may not import). A longer one is cut, never refused.
 */
export const TITLE_LENGTH = 200;

/** How long the text of an Item may be: the host's cap on a description. */
const DESCRIPTION_LENGTH = 60_000;

/** What an Item from a conversation with no subject is called - Gmail's own words for it. */
export const NO_SUBJECT = '(no subject)';

/**
 * The id of the mailbox's label called Cockpit, from Gmail's list of labels -
 * or null where there is none. Gmail keeps label names unique whatever their
 * case, so `cockpit` is the same label.
 */
export function cockpitLabelIn(answer: unknown): string | null {
  const labels = (answer as { labels?: unknown } | null)?.labels;
  if (!Array.isArray(labels)) return null;
  for (const label of labels as unknown[]) {
    const { id, name } = (label ?? {}) as Record<string, unknown>;
    if (typeof id === 'string' && typeof name === 'string' && name.toLowerCase() === COCKPIT_LABEL.toLowerCase()) {
      return id;
    }
  }
  return null;
}

/** One page of Gmail's marked conversations: their ids, and where the next page starts. */
export function conversationPage(answer: unknown): { threadIds: string[]; nextPageToken: string | null } {
  const { threads, nextPageToken } = (answer ?? {}) as Record<string, unknown>;
  const threadIds = Array.isArray(threads)
    ? (threads as unknown[])
        .map((thread) => (thread as { id?: unknown } | null)?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  return { threadIds, nextPageToken: typeof nextPageToken === 'string' && nextPageToken ? nextPageToken : null };
}

/** One page of what changed in a mailbox since a history position. */
export interface HistoryPage {
  /** The conversations that gained the mark on this page, and kept it to its end - oldest first. */
  readonly gained: string[];
  /**
   * Every conversation whose mark this page may have put on or taken off -
   * the mark added or removed, a marked message trashed, untrashed or deleted
   * for good - oldest first. Only a read of the conversation says which, since
   * the mark belongs to each message and the page sees some.
   */
  readonly changed: string[];
  readonly nextPageToken: string | null;
  /** The mailbox's position as of this answer: where the next read starts from once every page is done. */
  readonly historyId: string | null;
}

interface HistoryEntry {
  message?: { threadId?: unknown; labelIds?: unknown } | null;
  labelIds?: unknown;
}

/**
 * One page of `users.history.list`, read for the conversations that gained the
 * mark: a label added to a message, or a message arriving already marked - by
 * hand or by a filter.
 *
 * **A reply changes nothing**, since labels belong to messages and a reply
 * arrives without the one its conversation carries; a reply that does arrive
 * marked names a conversation the host finds already known. A mark added and
 * taken off again within the page is nothing new.
 *
 * **And for the conversations it may have closed or reopened**: the mark taken
 * off or put back, a marked message moved to or out of the bin or spam, or
 * deleted for good - each read by the caller to see where it now stands.
 */
export function historyPage(answer: unknown, markId: string): HistoryPage {
  const { history, nextPageToken, historyId } = (answer ?? {}) as Record<string, unknown>;
  const gained = new Set<string>();
  const changed = new Set<string>();
  const carries = (labels: unknown) => Array.isArray(labels) && labels.includes(markId);
  const movesAway = (labels: unknown) =>
    Array.isArray(labels) && labels.some((label) => label === markId || AWAY.includes(label as string));
  const threadOf = (entry: HistoryEntry): string | null => {
    const threadId = entry?.message?.threadId;
    return typeof threadId === 'string' && threadId ? threadId : null;
  };
  for (const record of Array.isArray(history) ? (history as Record<string, unknown>[]) : []) {
    const entries = (key: string) => (Array.isArray(record?.[key]) ? (record[key] as HistoryEntry[]) : []);
    for (const added of entries('messagesAdded')) {
      const threadId = threadOf(added);
      if (threadId && carries(added.message?.labelIds)) {
        gained.add(threadId);
        changed.add(threadId);
      }
    }
    for (const added of entries('labelsAdded')) {
      const threadId = threadOf(added);
      if (threadId && carries(added.labelIds)) gained.add(threadId);
      if (threadId && movesAway(added.labelIds)) changed.add(threadId);
    }
    for (const removed of entries('labelsRemoved')) {
      const threadId = threadOf(removed);
      if (threadId && carries(removed.labelIds)) gained.delete(threadId);
      if (threadId && movesAway(removed.labelIds)) changed.add(threadId);
    }
    for (const deleted of entries('messagesDeleted')) {
      const threadId = threadOf(deleted);
      if (threadId) changed.add(threadId);
    }
  }
  return {
    gained: [...gained],
    changed: [...changed],
    nextPageToken: typeof nextPageToken === 'string' && nextPageToken ? nextPageToken : null,
    historyId: typeof historyId === 'string' || typeof historyId === 'number' ? String(historyId) : null,
  };
}

/**
 * Whether a conversation, as `threads.get` answers it, still has a message
 * carrying the mark - and not in the bin or spam, which Gmail's own listing of
 * marked conversations leaves out too.
 */
export function stillMarked(answer: unknown, markId: string): boolean {
  const { messages } = (answer ?? {}) as { messages?: unknown };
  return (
    Array.isArray(messages) &&
    (messages as GmailMessage[]).some(
      (message) =>
        Array.isArray(message?.labelIds) &&
        message.labelIds.includes(markId) &&
        !message.labelIds.some((label) => AWAY.includes(label as string)),
    )
  );
}

/**
 * What Gmail refusing a label change with an error other than 401 or 404
 * means for it: `later` where Gmail is only holding the mailbox back - 408,
 * 429, a 403 for a rate limit, and any 5xx - and `never` for any other, which
 * asking again will not change. A `never` is given up on rather than retried,
 * so one conversation Gmail will not relabel cannot hold up the rest.
 */
export function labelChangeRefusal(status: number, answer: unknown): 'later' | 'never' {
  if (status >= 500 || status === 408 || status === 429) return 'later';
  if (status !== 403) return 'never';
  const errors = (answer as { error?: { errors?: { reason?: unknown }[] } } | null)?.error?.errors;
  const rateLimited = Array.isArray(errors) && errors.some((one) => RATE_LIMITS.has(String(one?.reason)));
  return rateLimited ? 'later' : 'never';
}

/** The reasons Gmail gives a 403 that only means "not so fast". */
const RATE_LIMITS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded']);

/** The change to one conversation's labels that puts the mark on or takes it off - and touches no other. */
export function labelChange(markId: string, wanted: boolean): { addLabelIds: string[] } | { removeLabelIds: string[] } {
  return wanted ? { addLabelIds: [markId] } : { removeLabelIds: [markId] };
}

/** What a conversation brings in as its Item. */
export interface GmailConversation {
  readonly threadId: string;
  /** The subject, or what says there is none. */
  readonly title: string;
  /** The plain text of the most recent marked message - never empty, the subject standing in where it is. */
  readonly text: string;
  /** Who sent that message: the name in its From, or the address where it gives none. */
  readonly sender: string | null;
  /** Where Gmail shows the conversation, in the connected mailbox. */
  readonly link: string;
  /** When that message arrived. */
  readonly sentAt: string | null;
}

interface GmailPart {
  mimeType?: unknown;
  headers?: unknown;
  body?: { data?: unknown } | null;
  parts?: unknown;
}

interface GmailMessage {
  labelIds?: unknown;
  internalDate?: unknown;
  payload?: GmailPart | null;
}

/**
 * A conversation as Gmail's `threads.get` answers it, made into what its Item
 * says - or null for an answer with no message in it.
 *
 * **The most recent message carrying the mark** is the one read, since marking
 * a conversation marks the messages it holds then, and a reply after it does
 * not carry the label; the last message stands in where none does. Its text is
 * the plain-text part, or the HTML one with the tags taken out where that is
 * all there is.
 */
export function conversationFrom(answer: unknown, markId: string, mailboxAddress: string): GmailConversation | null {
  const { id, messages } = (answer ?? {}) as { id?: unknown; messages?: unknown };
  if (typeof id !== 'string' || !id || !Array.isArray(messages) || messages.length === 0) return null;
  const all = messages as GmailMessage[];
  const marked = all.filter((message) => Array.isArray(message?.labelIds) && message.labelIds.includes(markId));
  const message = (marked.length > 0 ? marked : all).reduce((latest, one) =>
    sentAt(one) >= sentAt(latest) ? one : latest,
  );

  const subject = oneLine(headerOf(message.payload, 'Subject') ?? '');
  const title = cutTo(subject, TITLE_LENGTH) || NO_SUBJECT;
  const text = cutTo(textOf(message.payload).trim(), DESCRIPTION_LENGTH) || title;
  const at = sentAt(message);
  return {
    threadId: id,
    title,
    text,
    sender: senderIn(headerOf(message.payload, 'From')),
    link: `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailboxAddress)}#all/${encodeURIComponent(id)}`,
    sentAt: at > 0 ? new Date(at).toISOString() : null,
  };
}

function sentAt(message: GmailMessage): number {
  const at = Number(message?.internalDate);
  return Number.isFinite(at) ? at : 0;
}

function headerOf(part: GmailPart | null | undefined, name: string): string | null {
  if (!Array.isArray(part?.headers)) return null;
  for (const header of part.headers as unknown[]) {
    const { name: called, value } = (header ?? {}) as Record<string, unknown>;
    if (typeof called === 'string' && called.toLowerCase() === name.toLowerCase() && typeof value === 'string') {
      return value;
    }
  }
  return null;
}

/**
 * Who a From header names: `Anna Peeters <anna@example.com>` is Anna Peeters,
 * a bare address is itself, and quotes around a name are not part of it.
 */
export function senderIn(from: string | null): string | null {
  if (!from) return null;
  const named = /^\s*(.*?)\s*<([^>]*)>\s*$/.exec(from);
  const name = named ? named[1]!.replace(/^"(.*)"$/, '$1').trim() : '';
  const who = oneLine(name || (named ? named[2]! : from));
  return who ? cutTo(who, TITLE_LENGTH) : null;
}

/** The message's text: its first plain-text part, else its first HTML part with the tags taken out. */
function textOf(payload: GmailPart | null | undefined): string {
  const plain = firstPart(payload, 'text/plain');
  if (plain !== null) return plain.replace(/\r\n?/g, '\n');
  const html = firstPart(payload, 'text/html');
  return html === null ? '' : plainTextOf(html);
}

function firstPart(part: GmailPart | null | undefined, mimeType: string): string | null {
  if (!part) return null;
  if (typeof part.mimeType === 'string' && part.mimeType.toLowerCase() === mimeType && typeof part.body?.data === 'string') {
    return decodedBody(part.body.data);
  }
  if (!Array.isArray(part.parts)) return null;
  for (const child of part.parts as GmailPart[]) {
    const found = firstPart(child, mimeType);
    if (found !== null) return found;
  }
  return null;
}

/**
 * A body as Gmail sends it: UTF-8, base64 in its URL-safe alphabet - or
 * nothing where it cannot be read, so one malformed message is brought in
 * under its subject rather than stopping every conversation after it.
 */
function decodedBody(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return '';
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * HTML as the words it shows: what is not shown (styles, scripts, comments)
 * goes, the breaks between blocks become line breaks, every other tag goes,
 * and the commonest entities are read back into what they stand for.
 */
export function plainTextOf(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, entity: string) => {
      if (entity[0] === '#') {
        const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[entity.toLowerCase()] ?? whole;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim();
}

/**
 * The first `limit` characters, without splitting one in half: a character
 * outside the BMP is two code units, and a cut between them leaves a lone
 * surrogate that renders as a replacement box.
 */
function cutTo(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const lead = text.charCodeAt(limit - 1);
  return text.slice(0, lead >= 0xd800 && lead <= 0xdbff ? limit - 1 : limit);
}
