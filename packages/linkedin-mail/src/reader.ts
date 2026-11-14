/**
 * Reading a LinkedIn message email ("Follow the LinkedIn conversation instead
 * of the notification", issue 1711; moved out of the Gmail connector so both
 * mail connectors read it, issue 1775). LinkedIn has no connector of its own:
 * an email that names a LinkedIn conversation is a turn of that conversation,
 * theirs, whichever mailbox it reached.
 *
 * Pure, and it knows no mail provider: a message arrives as its sender, its
 * bodies and its time, and the connector that holds it does the rest (drafts,
 * the bin, who sent it from this mailbox). **Tolerant by design**, since
 * LinkedIn's email format is not ours to fix: the link may be LinkedIn's own
 * address, its `comm` tracking address or a LinkedIn redirect that carries
 * either, in any part of the message; anything that does not resolve to a
 * LinkedIn messaging thread is plain mail. Nothing is fetched to resolve a
 * redirect: only the address is read.
 *
 * **Only a `https://www.linkedin.com/messaging/` address is ever kept**, built
 * from the thread's id, so the tracking and the sign-in token (`otpToken`) an
 * email's link carries never leave it, and a lookalike host never becomes a link.
 */

/**
 * What the id of a LinkedIn conversation starts with, so it can never be taken
 * for a mail thread, and the row can name it (`LINKEDIN_CONVERSATION_PREFIX`
 * in the shared contract, which this package may not import: the host's L2
 * test pins the two together).
 */
export const LINKEDIN_PREFIX = 'linkedin:';

/**
 * The addresses LinkedIn sends a message email from: the direct notification,
 * and the digest ("Frederik just messaged you"). Only their mail is read in
 * full to find a turn, whichever language it is in.
 */
export const NOTIFICATION_SENDERS: readonly string[] = ['messages-noreply@linkedin.com', 'messaging-digest-noreply@linkedin.com'];

/** One mail as the reader takes it, from any provider. */
export interface LinkedInMail {
  /** The From header as written: `Name via LinkedIn <address>`, or a bare address. */
  readonly from: string | null;
  /** The decoded text parts, in the order the message holds them. */
  readonly plain: readonly string[];
  /** The decoded HTML parts, in the order the message holds them. */
  readonly html: readonly string[];
  /** When it was sent, in milliseconds since 1970; 0 or less where nobody knows. */
  readonly at: number;
}

/** What a message email says: they wrote, when, who and the first lines. */
export interface LinkedInTurn {
  /** Always theirs: what the person answers on LinkedIn is never seen. */
  readonly by: 'them';
  readonly from: string | null;
  readonly at: string;
  readonly excerpt: string;
}

/** A message email, read: whose conversation it is, where it is, and the turn it is. */
export interface LinkedInMessage {
  /** `linkedin:` and LinkedIn's own thread id. */
  readonly conversationId: string;
  /** `https://www.linkedin.com/messaging/thread/<id>/`, and nothing LinkedIn tracked the email with. */
  readonly link: string;
  readonly turn: LinkedInTurn;
}

/** Whether a host is LinkedIn's: `linkedin.com` or a subdomain of it, never one that only ends in the same letters. */
export function isLinkedInAddress(hostname: string): boolean {
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
  if (url.protocol !== 'https:' || !isLinkedInAddress(url.hostname)) return null;
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

/** The first address in the bodies that leads to a LinkedIn conversation, as the id of that conversation. */
function threadIn(bodies: readonly string[]): string | null {
  for (const body of bodies) {
    for (const found of body.matchAll(/https?:\/\/[^\s"'<>\])]+/gi)) {
      const id = linkedInThreadOf(found[0].replace(/&amp;/gi, '&').replace(/[.,;]+$/, ''));
      if (id) return id;
    }
  }
  return null;
}

/** How long a name or an excerpt may be, as the connectors cut them. */
const NAME_LENGTH = 200;
const EXCERPT_LENGTH = 280;

function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim();
}

/** The first `limit` characters, without splitting a character outside the BMP in half. */
function cutTo(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const lead = text.charCodeAt(limit - 1);
  return text.slice(0, lead >= 0xd800 && lead <= 0xdbff ? limit - 1 : limit);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** HTML as the words it shows: unshown parts go, block ends become line breaks, tags go, common entities are read back. */
function plainTextOf(html: string): string {
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

/** What LinkedIn adds to the name it sends from: *Steven Noels via LinkedIn*. */
const VIA_LINKEDIN = /\s+via\s+LinkedIn$/i;

/** Who sent the email, as LinkedIn names them: the name before *via LinkedIn*, or nobody where there is only an address. */
function senderOf(from: string | null): string | null {
  if (!from) return null;
  const named = /^\s*(.*?)\s*<([^>]*)>\s*$/.exec(from);
  const name = named ? named[1]!.replace(/^"(.*)"$/, '$1').trim() : '';
  const who = oneLine(name || (named ? named[2]! : from));
  const shown = who ? cutTo(who, NAME_LENGTH) : null;
  if (!shown || shown.includes('@')) return null;
  return shown.replace(VIA_LINKEDIN, '').trim() || null;
}

/** The lines where a message ends and LinkedIn's own buttons and footer begin, in English and Dutch. */
const MESSAGE_ENDS = /^(?:view (?:the )?(?:full )?(?:message|conversation)|reply|bekijk (?:het )?(?:bericht|gesprek)|beantwoord(?:en)?)\b/i;

/** A line that is only an address, or a button's label carrying one. */
const ONLY_AN_ADDRESS = /^\[?\s*https?:\/\/\S+\s*\]?$/i;

/** The first lines of what was written: after the sender's name, up to the button that opens the message. */
function excerptOf(mail: LinkedInMail, name: string | null): string {
  const text = mail.plain[0] ?? (mail.html[0] === undefined ? '' : plainTextOf(mail.html[0]));
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
 * A mail read as a LinkedIn message email - or null for anything else: not from
 * a `linkedin.com` address, naming no LinkedIn conversation (a connection
 * request, a job alert), or naming a time of nobody's.
 */
export function linkedInMessageIn(mail: LinkedInMail): LinkedInMessage | null {
  const from = mail.from;
  const address = /<([^>]*)>\s*$/.exec(from ?? '')?.[1] ?? from ?? '';
  const domain = address.trim().toLowerCase().split('@')[1];
  if (!domain || !isLinkedInAddress(domain)) return null;
  if (!(mail.at > 0)) return null;
  const threadId = threadIn([...mail.html, ...mail.plain]);
  if (!threadId) return null;
  const name = senderOf(from);
  return {
    conversationId: `${LINKEDIN_PREFIX}${threadId}`,
    link: messagingLink(threadId),
    turn: { by: 'them', from: name, at: new Date(mail.at).toISOString(), excerpt: excerptOf(mail, name) },
  };
}
