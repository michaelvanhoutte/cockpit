/**
 * Reading what Graph answers. Pure: every function takes an answer already
 * parsed and says what it holds, so each branch is provable without a mailbox
 * (tests/unit/bringing-in-messages.test.ts). Every quirk these encode is in the
 * package README.
 */

/** The category a message has to carry to become an Item, when the connection follows the category. Fixed, by decision. */
export const COCKPIT_CATEGORY = 'Cockpit';

/** The two marks a connection can follow: Outlook's flag for follow-up, or the category called Cockpit. */
export type Mark = 'flag' | 'category';

/** Reads a stored choice as a mark: anything but the category is the flag, which is the one offered to start. */
export function markOf(choice: string | null): Mark {
  return choice === 'category' ? 'category' : 'flag';
}

/**
 * The longest a title or a sender may be: the host stores a title as given and
 * caps it here (`TITLE_LENGTH` in the shared contract, which a connector
 * package may not import). A longer one is cut, never refused.
 */
export const TITLE_LENGTH = 200;

/** How long the text of an Item may be: the host's cap on a description. */
const DESCRIPTION_LENGTH = 60_000;

/** What an Item from a message with no subject is called - Outlook's own words for it. */
export const NO_SUBJECT = '(no subject)';

/** What Graph says of a message the connector looks at when listing: where it is and what marks it carries. */
export const LIST_FIELDS = 'id,parentFolderId,flag,categories,conversationId';

/** What a message is read for in full. */
export const READ_FIELDS = `${LIST_FIELDS},subject,from,body,webLink,receivedDateTime`;

/** The filter that asks Graph for messages carrying the mark - narrowing the listing, never trusted alone (`isMarked` decides). */
export function markFilter(mark: Mark): string {
  return mark === 'flag' ? `flag/flagStatus eq 'flagged'` : `categories/any(c:c eq '${COCKPIT_CATEGORY}')`;
}

interface GraphMessage {
  id?: unknown;
  conversationId?: unknown;
  isDraft?: unknown;
  bodyPreview?: unknown;
  parentFolderId?: unknown;
  flag?: { flagStatus?: unknown } | null;
  categories?: unknown;
  subject?: unknown;
  from?: { emailAddress?: { name?: unknown; address?: unknown } | null } | null;
  toRecipients?: unknown;
  ccRecipients?: unknown;
  body?: { contentType?: unknown; content?: unknown } | null;
  uniqueBody?: { contentType?: unknown; content?: unknown } | null;
  webLink?: unknown;
  receivedDateTime?: unknown;
}

/**
 * Whether a message, as Graph describes it, carries the mark: the flag set and
 * not complete, or the category called Cockpit - in any case, since Outlook
 * compares category names without regard to it.
 */
export function isMarked(message: unknown, mark: Mark): boolean {
  const { flag, categories } = (message ?? {}) as GraphMessage;
  if (mark === 'flag') return flag?.flagStatus === 'flagged';
  return (
    Array.isArray(categories) &&
    categories.some((one) => typeof one === 'string' && one.toLowerCase() === COCKPIT_CATEGORY.toLowerCase())
  );
}

/** What a flag is set to for an Item opened or closed in Cockpit: the flag alone, nothing else of the message. */
export function flagChange(open: boolean): { flag: { flagStatus: 'flagged' | 'complete' } } {
  return { flag: { flagStatus: open ? 'flagged' : 'complete' } };
}

/**
 * A message's categories as Graph answers `$select=categories`, with the
 * version they were read at (`@odata.etag`) - or null where the answer names
 * no list. `version` is null where Graph gave none, and then nothing can be
 * written conditionally.
 */
export function categoriesIn(answer: unknown): { categories: string[]; version: string | null } | null {
  const { categories, '@odata.etag': etag } = (answer ?? {}) as Record<string, unknown>;
  if (!Array.isArray(categories)) return null;
  return {
    categories: categories.filter((one): one is string => typeof one === 'string'),
    version: typeof etag === 'string' && etag ? etag : null,
  };
}

/**
 * The category list a message should carry for its Item to be open or closed:
 * Cockpit added, or taken off in whatever case it was written, and every other
 * category kept in its order - or null where the list already says so and
 * nothing is to be written.
 */
export function categoryChange(categories: readonly string[], open: boolean): string[] | null {
  const isCockpit = (one: string) => one.toLowerCase() === COCKPIT_CATEGORY.toLowerCase();
  const holds = categories.some(isCockpit);
  if (holds === open) return null;
  return open ? [...categories, COCKPIT_CATEGORY] : categories.filter((one) => !isCockpit(one));
}

/** The id of the mailbox's Deleted Items folder, from `mailFolders/deleteditems` - or null where there is none. */
export function deletedItemsIn(answer: unknown): string | null {
  const { id } = (answer ?? {}) as { id?: unknown };
  return typeof id === 'string' && id ? id : null;
}

/**
 * One page of Graph's marked messages: the ids that carry the mark outside
 * Deleted Items, and where the next page is. A message in Deleted Items keeps
 * its flag and category, and no longer counts as marked.
 */
export function messagePage(
  answer: unknown,
  mark: Mark,
  deletedItems: string,
): {
  messageIds: string[];
  categories: Record<string, string[]>;
  conversations: Record<string, string>;
  nextLink: string | null;
} {
  const { value, '@odata.nextLink': nextLink } = (answer ?? {}) as Record<string, unknown>;
  const marked = (Array.isArray(value) ? (value as GraphMessage[]) : []).filter(
    (one) => typeof one?.id === 'string' && one.id && one.parentFolderId !== deletedItems && isMarked(one, mark),
  );
  return {
    messageIds: marked.map((one) => one.id as string),
    categories: Object.fromEntries(marked.map((one) => [one.id as string, categoryNames(one.categories)])),
    // A message Graph names no conversation for is its own: nothing else can be in it.
    conversations: Object.fromEntries(marked.map((one) => [one.id as string, conversationIdOf(one)])),
    nextLink: typeof nextLink === 'string' && nextLink ? nextLink : null,
  };
}

function conversationIdOf(message: GraphMessage): string {
  return typeof message.conversationId === 'string' && message.conversationId ? message.conversationId : `alone:${String(message.id)}`;
}

/** Every category name a message carries, as Graph lists them. */
function categoryNames(categories: unknown): string[] {
  return Array.isArray(categories) ? categories.filter((one): one is string => typeof one === 'string') : [];
}

/**
 * What a message's categories report as its Item's names: all of them, but
 * Cockpit left out where the connection follows that category, since it is
 * the mark rather than a name (issue 1146).
 */
export function namesOf(categories: readonly string[], mark: Mark): string[] {
  if (mark === 'flag') return [...categories];
  return categories.filter((one) => one.toLowerCase() !== COCKPIT_CATEGORY.toLowerCase());
}

/** What a message brings in as its Item. */
export interface OutlookMessage {
  readonly messageId: string;
  /** The subject, or what says there is none. */
  readonly title: string;
  /** The plain text of the message - never empty, the title standing in where it is. */
  readonly text: string;
  /** Who sent it: the name, or the address where it gives none. */
  readonly sender: string | null;
  /** Where Outlook on the web shows the message. */
  readonly link: string;
  readonly receivedAt: string | null;
  /** Every category it carries, the mark among them where it is one. */
  readonly categories: string[];
  /** The conversation it is in. */
  readonly conversationId: string;
}

/**
 * A message as Graph answers it in full, made into what its Item says - or
 * null for one that is not marked any more (it was unmarked or moved to
 * Deleted Items between the listing and this read), or has no id.
 */
export function messageFrom(answer: unknown, mark: Mark, deletedItems: string): OutlookMessage | null {
  const message = (answer ?? {}) as GraphMessage;
  if (typeof message.id !== 'string' || !message.id) return null;
  if (message.parentFolderId === deletedItems || !isMarked(message, mark)) return null;

  const title = cutTo(oneLine(typeof message.subject === 'string' ? message.subject : ''), TITLE_LENGTH) || NO_SUBJECT;
  const text = cutTo(bodyText(message.body).trim(), DESCRIPTION_LENGTH) || title;
  const received = typeof message.receivedDateTime === 'string' ? Date.parse(message.receivedDateTime) : NaN;
  return {
    messageId: message.id,
    title,
    text,
    sender: senderIn(message.from),
    link:
      typeof message.webLink === 'string' && message.webLink
        ? message.webLink
        : `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(message.id)}`,
    receivedAt: Number.isFinite(received) ? new Date(received).toISOString() : null,
    categories: categoryNames(message.categories),
    conversationId: conversationIdOf(message),
  };
}

/**
 * What one message adds to its conversation, as Graph answers
 * `GET /me/messages/{id}?$select=uniqueBody` (the part of the body that is
 * unique to the message): plain text, with any earlier email it still quotes
 * cut off (issue 1731). Null where the answer holds no body or no words, so the caller can
 * fall back on the message's preview.
 */
export function uniqueTextOf(answer: unknown): string | null {
  const { uniqueBody } = (answer ?? {}) as GraphMessage;
  if (typeof uniqueBody?.content !== 'string') return null;
  return withoutQuotedText(bodyText(uniqueBody).trim()).trim() || null;
}

/**
 * The words a draft holds above any earlier email it quotes ("Mail follow-up: a
 * Claude draft looks like any other and cannot be redone…", issue 1732): its
 * `uniqueBody` as text, whole - nothing cut, so words added anywhere in it
 * count. Null where Graph answers no unique body.
 */
export function draftWordsOf(answer: unknown): string | null {
  const { uniqueBody } = (answer ?? {}) as GraphMessage;
  return typeof uniqueBody?.content === 'string' ? bodyText(uniqueBody) : null;
}

/** The name in a From, or its address where it gives none. */
function senderIn(from: GraphMessage['from']): string | null {
  const { name, address } = from?.emailAddress ?? {};
  const who = oneLine(typeof name === 'string' && name.trim() ? name : typeof address === 'string' ? address : '');
  return who ? cutTo(who, TITLE_LENGTH) : null;
}

/** A body as plain text: as it came where it is text, with its tags taken out where it is HTML. */
function bodyText(body: GraphMessage['body']): string {
  const content = typeof body?.content === 'string' ? body.content : '';
  if (typeof body?.contentType === 'string' && body.contentType.toLowerCase() === 'html') return plainTextOf(content);
  return content.replace(/\r\n?/g, '\n');
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

/**
 * Where an earlier email quoted below a reply starts: a line of underscores
 * (Outlook's separator), a `From:`/`Van:` header followed by its
 * `Sent:`/`Verzonden:`, Gmail's `On … wrote:` / `Op … schreef …:`, or a line
 * starting `>`. Each holds in text already on one line, as Graph's
 * `bodyPreview` is, but the `>` line, which only a line can start.
 */
const QUOTE_STARTS: readonly RegExp[] = [
  /_{10,}/,
  /\b(?:From|Van):[\s\S]{0,300}?\b(?:Sent|Verzonden):/,
  /\bOn\s[\s\S]{1,200}?\swrote:/,
  /\bOp\s[\s\S]{1,200}?\sschreef\s[\s\S]{0,100}?:/,
  /^[ \t]*>/m,
];

/**
 * A message's text up to where it quotes an earlier email (`QUOTE_STARTS`) -
 * what the message itself adds, as its excerpt shows it ("Conversation
 * follow-up: Open, previews, drafts and Check now misbehave on real Gmail and
 * Outlook mailboxes", issue 1720). A message that is nothing but a quote is
 * kept whole, so the row still says something.
 */
export function withoutQuotedText(text: string): string {
  let at = text.length;
  for (const start of QUOTE_STARTS) {
    const found = start.exec(text);
    if (found && found.index < at) at = found.index;
  }
  return text.slice(0, at).trim() || text;
}

export function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim();
}

/**
 * The first `limit` characters, without splitting one in half: a character
 * outside the BMP is two code units, and a cut between them leaves a lone
 * surrogate that renders as a replacement box.
 */
export function cutTo(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const lead = text.charCodeAt(limit - 1);
  return text.slice(0, lead >= 0xd800 && lead <= 0xdbff ? limit - 1 : limit);
}

/**
 * **A conversation an Item follows is filed under `conversation:` and its id.**
 * An Item made of one flagged message before conversations were followed is
 * filed under that message's id, which a prefix tells from it: those keep
 * working as they did and never follow anything.
 */
export const CONVERSATION_PREFIX = 'conversation:';

export function conversationKey(conversationId: string): string {
  return `${CONVERSATION_PREFIX}${conversationId}`;
}

/** The conversation an Item's source id names, or null for an Item made of one message. */
export function conversationIdIn(sourceId: string): string | null {
  return sourceId.startsWith(CONVERSATION_PREFIX) ? sourceId.slice(CONVERSATION_PREFIX.length) : null;
}

/**
 * What is asked of a message to place it in a conversation, or to report it as
 * a turn of one: its To and Cc among it, which say who else is on it (issue
 * 1760). Bcc is not asked: a copy received never names it.
 */
export const TURN_FIELDS =
  'id,conversationId,parentFolderId,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,isDraft,webLink,flag';

/** One message of a conversation or of the mailbox's recent mail, as a turn would carry it. */
export interface MailTurn {
  readonly messageId: string;
  readonly conversationId: string;
  /** Yours where it sits in Sent Items or its sender is an address of yours (`asYours`); theirs otherwise. */
  readonly by: 'you' | 'them';
  readonly from: string | null;
  readonly at: string;
  readonly excerpt: string;
  readonly link: string | null;
  /** Whether it sits in Sent Items. */
  readonly inSentItems: boolean;
  /** Its sender's address as compared (`addressKey`), or null where it names none. */
  readonly fromAddress: string | null;
  /** The addresses it was sent To and Cc, as compared. */
  readonly recipients: readonly string[];
}

/** An address as compared: trimmed, and without regard to case, as mail delivers it. */
export function addressKey(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * The addresses the mailbox sends from that these messages show: the sender of
 * each one in Sent Items (issue 1760). Learned from the mail, so no permission
 * beyond reading it is needed; a conversation you never sent from teaches none.
 */
export function sendFromAddresses(turns: readonly MailTurn[]): string[] {
  return [...new Set(turns.flatMap((one) => (one.inSentItems && one.fromAddress ? [one.fromAddress] : [])))];
}

/** The addresses that count as you: those the mailbox sends from, and your Cockpit alias where one is set. */
export function addressesOfYours(alias: string | null, sendFrom: Iterable<string>): Set<string> {
  const yours = new Set([...sendFrom].map(addressKey));
  if (alias && alias.trim()) yours.add(addressKey(alias));
  return yours;
}

/**
 * The messages with who wrote each read again (issue 1760): **yours where it
 * sits in Sent Items, or was sent from an address of yours**, so the alias's
 * copy of a mail you sent, delivered to your Inbox, is yours too; theirs
 * otherwise. Pure.
 */
export function asYours(turns: readonly MailTurn[], yours: ReadonlySet<string>): MailTurn[] {
  return turns.map((one) => {
    const by = one.inSentItems || (one.fromAddress !== null && yours.has(one.fromAddress)) ? 'you' : 'them';
    return by === one.by ? one : { ...one, by };
  });
}

/**
 * Whether anyone but you is on these messages: a sender, To or Cc recipient
 * whose address is not among yours (issue 1760). A mail to your alias alone is
 * then a note; Bcc'ing the alias leaves it off the recipients, so the others
 * named are on it. Pure.
 */
export function othersOn(turns: readonly MailTurn[], yours: ReadonlySet<string>): boolean {
  return turns.some((one) =>
    [...(one.fromAddress === null ? [] : [one.fromAddress]), ...one.recipients].some((address) => !yours.has(address)),
  );
}

/** The addresses in a To or Cc list, as compared. */
function addressesIn(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((one: { emailAddress?: { address?: unknown } | null } | null) => {
    const address = one?.emailAddress?.address;
    return typeof address === 'string' && address.trim() ? [addressKey(address)] : [];
  });
}

/**
 * One page of messages read for their turns: those that are sent (not drafts)
 * and not in Deleted Items, with `by` = `you` for Sent Items - which `asYours`
 * reads again once the addresses of yours are known. Pure.
 */
export function turnPage(
  answer: unknown,
  folders: { sentItems: string; deletedItems: string },
): { turns: MailTurn[]; nextLink: string | null } {
  const { value, '@odata.nextLink': nextLink } = (answer ?? {}) as Record<string, unknown>;
  const turns: MailTurn[] = [];
  for (const one of Array.isArray(value) ? (value as GraphMessage[]) : []) {
    if (typeof one?.id !== 'string' || !one.id || one.isDraft === true || one.parentFolderId === folders.deletedItems) continue;
    const at = typeof one.receivedDateTime === 'string' ? Date.parse(one.receivedDateTime) : NaN;
    if (!Number.isFinite(at)) continue;
    const inSent = one.parentFolderId === folders.sentItems;
    const address = one.from?.emailAddress?.address;
    turns.push({
      messageId: one.id,
      conversationId: conversationIdOf(one),
      by: inSent ? 'you' : 'them',
      from: senderIn(one.from),
      at: new Date(at).toISOString(),
      excerpt: cutTo(oneLine(withoutQuotedText(typeof one.bodyPreview === 'string' ? one.bodyPreview : '')), 280),
      link: typeof one.webLink === 'string' && one.webLink ? one.webLink : null,
      inSentItems: inSent,
      fromAddress: typeof address === 'string' && address.trim() ? addressKey(address) : null,
      recipients: [...addressesIn(one.toRecipients), ...addressesIn(one.ccRecipients)],
    });
  }
  return { turns, nextLink: typeof nextLink === 'string' && nextLink ? nextLink : null };
}
