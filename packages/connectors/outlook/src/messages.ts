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
export const LIST_FIELDS = 'id,parentFolderId,flag,categories';

/** What a message is read for in full. */
export const READ_FIELDS = `${LIST_FIELDS},subject,from,body,webLink,receivedDateTime`;

/** The filter that asks Graph for messages carrying the mark - narrowing the listing, never trusted alone (`isMarked` decides). */
export function markFilter(mark: Mark): string {
  return mark === 'flag' ? `flag/flagStatus eq 'flagged'` : `categories/any(c:c eq '${COCKPIT_CATEGORY}')`;
}

interface GraphMessage {
  id?: unknown;
  parentFolderId?: unknown;
  flag?: { flagStatus?: unknown } | null;
  categories?: unknown;
  subject?: unknown;
  from?: { emailAddress?: { name?: unknown; address?: unknown } | null } | null;
  body?: { contentType?: unknown; content?: unknown } | null;
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
): { messageIds: string[]; nextLink: string | null } {
  const { value, '@odata.nextLink': nextLink } = (answer ?? {}) as Record<string, unknown>;
  const messageIds = (Array.isArray(value) ? (value as GraphMessage[]) : [])
    .filter((one) => typeof one?.id === 'string' && one.id && one.parentFolderId !== deletedItems && isMarked(one, mark))
    .map((one) => one.id as string);
  return { messageIds, nextLink: typeof nextLink === 'string' && nextLink ? nextLink : null };
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
  };
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
