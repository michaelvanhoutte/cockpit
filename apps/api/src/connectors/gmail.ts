import type { JWTVerifyGetKey } from 'jose';
import { TITLE_LENGTH, cutTo } from '@cockpit/shared';
import { authorizationUrl, claimsFrom, normaliseAddress, type Attempt, type IssuerEndpoints } from '../auth/oidc.js';

/**
 * What connecting a Gmail account asks Google for, and what is believed and
 * kept of the answer ("Connect a Gmail account to a workspace, and disconnect
 * it", issue 724).
 *
 * Pure but for the signature check, handed in as `teams.ts` beside it takes
 * it, so every branch is provable at L1 (tests/unit/connectors/gmail.test.ts).
 */

/**
 * The permission to change mail, asked for from the first connection so
 * nobody has to connect again when taking the label off lands. Google offers
 * nothing narrower that can remove a label, so touching only `Cockpit` is
 * Cockpit's own rule rather than Google's.
 */
export const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';

/** `openid email` say whose mailbox it is; the rest is the mailbox. */
const SCOPES = `openid email ${GMAIL_MODIFY}`;

/** Why a Gmail connection was not believed - the log's words, never a person's. */
export type GmailRefusal =
  | 'the reply belongs to another connection'
  | 'the account could not be read'
  | 'Google gave no refresh token'
  | 'the permission to change mail was not granted';

export interface GmailAccount {
  /** Google's own name for the person, which never changes: what makes connecting it again a refresh. */
  readonly key: string;
  /** The address, which is what the row is called. */
  readonly address: string;
}

/**
 * Where Connect sends the browser: the sign-in's own address, asking through
 * Gmail's client for the permission to change mail and for a refresh token.
 *
 * `access_type=offline` is what gets a refresh token at all, and
 * `prompt=consent` is what gets one every time rather than only the first:
 * Google hands one out only when it asks, so an account connected before,
 * disconnected elsewhere and connected again would otherwise come back with
 * none. `select_account` beside it, because several accounts may be
 * connected and each has to be chosen.
 */
export async function gmailAuthorizationUrl(
  endpoints: IssuerEndpoints,
  clientId: string,
  redirectUri: string,
  attempt: Attempt,
): Promise<string> {
  const url = new URL(await authorizationUrl(endpoints, clientId, redirectUri, attempt));
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'select_account consent');
  return url.toString();
}

/**
 * Whose mailbox this is, from an identity token Google signed for this
 * connection - or why it would not be believed. Keyed on `sub` rather than
 * the address, which a Google account can change.
 */
export async function gmailAccountFrom(
  idToken: string,
  keys: JWTVerifyGetKey,
  expected: { issuer: string; clientId: string; nonce: string },
  now: Date,
): Promise<GmailAccount | GmailRefusal> {
  const claims = await claimsFrom(idToken, keys, expected, now);
  if (typeof claims === 'string') {
    return claims === 'the identity answers a different sign-in'
      ? 'the reply belongs to another connection'
      : 'the account could not be read';
  }
  const key = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  const address = typeof claims.email === 'string' ? normaliseAddress(claims.email) : '';
  if (!key || !address) return 'the account could not be read';
  return { key, address };
}

/**
 * What is sealed into the connection: the refresh token, and the hour-long
 * access token beside it with when it lapses, which the next slices refresh
 * and re-seal in the same place - and the mailbox's key, so disconnecting
 * can tell whether another Workspace still holds the same grant. Or why
 * there is nothing worth keeping.
 *
 * **No refresh token is a refusal**, because without one the connection
 * cannot outlive the hour. **The permission to change mail missing is one
 * too**: Google's consent screen lets each permission be unticked, and a
 * connection that cannot take the label off is not the one asked for.
 */
export function gmailCredentialFrom(
  asIssued: string,
  mailboxKey: string,
  now: Date,
): { credential: string } | GmailRefusal {
  let answer: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(asIssued);
    if (!parsed || typeof parsed !== 'object') return 'Google gave no refresh token';
    answer = parsed as Record<string, unknown>;
  } catch {
    return 'Google gave no refresh token';
  }
  const refreshToken = typeof answer.refresh_token === 'string' ? answer.refresh_token : '';
  if (!refreshToken) return 'Google gave no refresh token';
  const granted = typeof answer.scope === 'string' ? answer.scope.split(' ') : [];
  if (!granted.includes(GMAIL_MODIFY)) return 'the permission to change mail was not granted';

  const accessToken = typeof answer.access_token === 'string' ? answer.access_token : null;
  const expiresIn = typeof answer.expires_in === 'number' ? answer.expires_in : null;
  return {
    credential: JSON.stringify({
      mailboxKey,
      refreshToken,
      accessToken,
      accessTokenExpiresAt:
        accessToken && expiresIn !== null ? new Date(now.getTime() + expiresIn * 1000).toISOString() : null,
    }),
  };
}

/** What a sealed Gmail credential holds, once opened. */
export interface GmailCredential {
  readonly mailboxKey: string | null;
  readonly refreshToken: string;
  readonly accessToken: string | null;
  readonly accessTokenExpiresAt: string | null;
}

/** An opened Gmail credential read back, or null for one holding no refresh token. */
export function gmailCredentialIn(credential: string): GmailCredential | null {
  try {
    const parsed: unknown = JSON.parse(credential);
    if (!parsed || typeof parsed !== 'object') return null;
    const held = parsed as Record<string, unknown>;
    if (typeof held.refreshToken !== 'string' || !held.refreshToken) return null;
    const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
    return {
      mailboxKey: text(held.mailboxKey),
      refreshToken: held.refreshToken,
      accessToken: text(held.accessToken),
      accessTokenExpiresAt: text(held.accessTokenExpiresAt),
    };
  } catch {
    return null;
  }
}

/**
 * How long before it lapses an access token is no longer used: a check that
 * starts on a token with seconds left would have it refused halfway.
 */
const ACCESS_TOKEN_MARGIN_MS = 60_000;

/** The cached access token where it will last the check, or null where it has to be refreshed first. */
export function usableAccessToken(credential: GmailCredential, now: Date): string | null {
  if (!credential.accessToken || !credential.accessTokenExpiresAt) return null;
  const lapses = Date.parse(credential.accessTokenExpiresAt);
  return Number.isFinite(lapses) && lapses - ACCESS_TOKEN_MARGIN_MS > now.getTime() ? credential.accessToken : null;
}

/**
 * The credential after Google answered a refresh: the new access token and
 * when it lapses, beside the refresh token it was refreshed with - Google
 * does not rotate it, and keeps it where the answer carries none. Null for an
 * answer holding no access token.
 */
export function credentialRefreshed(
  credential: GmailCredential,
  answer: unknown,
  now: Date,
): GmailCredential | null {
  if (!answer || typeof answer !== 'object') return null;
  const { access_token: accessToken, expires_in: expiresIn, refresh_token: refreshToken } = answer as Record<
    string,
    unknown
  >;
  if (typeof accessToken !== 'string' || !accessToken) return null;
  const lasts = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 3600;
  return {
    mailboxKey: credential.mailboxKey,
    refreshToken: typeof refreshToken === 'string' && refreshToken ? refreshToken : credential.refreshToken,
    accessToken,
    accessTokenExpiresAt: new Date(now.getTime() + lasts * 1000).toISOString(),
  };
}

/** The label a conversation has to carry to become an Item. Fixed, by decision (issue 722). */
export const COCKPIT_LABEL = 'Cockpit';

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

/** One page of Gmail's labelled conversations: their ids, and where the next page starts. */
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
  /** The conversations that gained the label on this page, and kept it to its end - oldest first. */
  readonly gained: string[];
  /**
   * Every conversation whose label this page may have put on or taken off -
   * the label added or removed, a labelled message trashed, untrashed or
   * deleted for good - oldest first. Only a read of the conversation says
   * which, since the label belongs to each message and the page sees some.
   */
  readonly changed: string[];
  readonly nextPageToken: string | null;
  /** The mailbox's position as of this answer: where the next check reads from once every page is done. */
  readonly historyId: string | null;
}

interface HistoryEntry {
  message?: { threadId?: unknown; labelIds?: unknown } | null;
  labelIds?: unknown;
}

/**
 * One page of `users.history.list`, read for the conversations that gained the
 * label ("Bring in a conversation within five minutes of labelling it
 * Cockpit", issue 726): a label added to a message, or a message arriving
 * already labelled - by hand or by a filter.
 *
 * **A reply changes nothing**, since labels belong to messages and a reply
 * arrives without the one its conversation carries; a reply that does arrive
 * labelled names a conversation the caller finds already brought in. A label
 * added and taken off again within the page is nothing new.
 *
 * **And for the conversations it may have closed or reopened** ("Close a
 * Gmail task when its label comes off, and reopen it when it goes back",
 * issue 727): the label taken off or put back, a labelled message moved to or
 * out of the bin or spam, or deleted for good - each read by the caller to
 * see where it now stands.
 */
export function historyPage(answer: unknown, labelId: string): HistoryPage {
  const { history, nextPageToken, historyId } = (answer ?? {}) as Record<string, unknown>;
  const gained = new Set<string>();
  const changed = new Set<string>();
  const carries = (labels: unknown) => Array.isArray(labels) && labels.includes(labelId);
  const movesAway = (labels: unknown) =>
    Array.isArray(labels) && labels.some((label) => label === labelId || AWAY.includes(label as string));
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
 * Gmail's own labels for mail on its way out: in the bin, or marked spam. A
 * labelled message there keeps the label, and no longer counts as labelled.
 */
const AWAY: readonly string[] = ['TRASH', 'SPAM'];

/**
 * Whether a conversation, as `threads.get` answers it, still has a message
 * carrying the label - and not in the bin or spam, which Gmail's own listing
 * of labelled conversations leaves out too.
 */
export function stillLabelled(answer: unknown, labelId: string): boolean {
  const { messages } = (answer ?? {}) as { messages?: unknown };
  return (
    Array.isArray(messages) &&
    (messages as GmailMessage[]).some(
      (message) =>
        Array.isArray(message?.labelIds) &&
        message.labelIds.includes(labelId) &&
        !message.labelIds.some((label) => AWAY.includes(label as string)),
    )
  );
}

/**
 * What Gmail's say on a conversation does to its Item ("Take the Cockpit
 * label off in Gmail when its task is done in Cockpit", issue 728): marks it
 * done where the label is off, opens it where the label is on - but only
 * where that disagrees with the Item and Cockpit has no change of its own
 * still waiting to reach Gmail.
 *
 * **A change waiting wins**, since Gmail's history carries no time for a
 * label change and so cannot say which came later; the push then puts Gmail
 * back in step. **One that agrees is nothing**, which is what makes Cockpit's
 * own label writes come back from the history as no-ops rather than a loop.
 */
export function gmailChangeApplies(
  link: { readonly labelWanted: boolean | null; readonly open: boolean },
  labelled: boolean,
): 'resolved' | 'reopened' | null {
  if (link.labelWanted !== null) return null;
  if (labelled === link.open) return null;
  return labelled ? 'reopened' : 'resolved';
}

/** The change to one conversation's labels that puts the label on or takes it off - and touches no other. */
export function labelChange(labelId: string, wanted: boolean): { addLabelIds: string[] } | { removeLabelIds: string[] } {
  return wanted ? { addLabelIds: [labelId] } : { removeLabelIds: [labelId] };
}

/** What a conversation brings in as its Item. */
export interface GmailConversation {
  readonly threadId: string;
  /** The subject, or what says there is none. */
  readonly title: string;
  /** The plain text of the most recent labelled message - never empty, the subject standing in where it is. */
  readonly text: string;
  /** Who sent that message: the name in its From, or the address where it gives none. */
  readonly sender: string | null;
  /** Where Gmail shows the conversation, in the connected mailbox. */
  readonly link: string;
  /** When that message arrived. */
  readonly sentAt: string | null;
}

/** What an Item from a conversation with no subject is called - Gmail's own words for it. */
export const NO_SUBJECT = '(no subject)';

/** How long a description may be, as `itemDescriptionSchema` caps it. */
const DESCRIPTION_LENGTH = 60_000;

/** How long a title or a sender may be. */
const LINE_LENGTH = TITLE_LENGTH;

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
 * says ("Bring in the conversations already labelled Cockpit as tasks", issue
 * 725) - or null for an answer with no message in it.
 *
 * **The most recent message carrying the label** is the one read, since
 * labelling a conversation labels the messages it holds then, and a reply
 * after it does not carry the label; the last message stands in where none
 * does. Its text is the plain-text part, or the HTML one with the tags taken
 * out where that is all there is.
 */
export function conversationFrom(
  answer: unknown,
  labelId: string,
  mailboxAddress: string,
): GmailConversation | null {
  const { id, messages } = (answer ?? {}) as { id?: unknown; messages?: unknown };
  if (typeof id !== 'string' || !id || !Array.isArray(messages) || messages.length === 0) return null;
  const all = messages as GmailMessage[];
  const labelled = all.filter((message) => Array.isArray(message?.labelIds) && message.labelIds.includes(labelId));
  const message = (labelled.length > 0 ? labelled : all).reduce((latest, one) =>
    sentAt(one) >= sentAt(latest) ? one : latest,
  );

  const subject = oneLine(headerOf(message.payload, 'Subject') ?? '');
  const title = cutTo(subject, LINE_LENGTH) || NO_SUBJECT;
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
  return who ? cutTo(who, LINE_LENGTH) : null;
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
 * The refresh token inside a sealed-and-opened Gmail credential, and the
 * mailbox it is for - null for a credential holding no token, and a null
 * key for one sealed without it.
 */
export function revocableIn(credential: string): { refreshToken: string; mailboxKey: string | null } | null {
  try {
    const parsed: unknown = JSON.parse(credential);
    if (!parsed || typeof parsed !== 'object') return null;
    const { refreshToken, mailboxKey } = parsed as Record<string, unknown>;
    if (typeof refreshToken !== 'string' || !refreshToken) return null;
    return { refreshToken, mailboxKey: typeof mailboxKey === 'string' && mailboxKey ? mailboxKey : null };
  } catch {
    return null;
  }
}
