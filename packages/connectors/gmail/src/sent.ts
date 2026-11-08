import { SourceError, type OnDemandHost, type SentEmail } from '@cockpit/connector-sdk';
import { credentialIn } from './credential.js';
import {
  ChangeRefused,
  Mailbox,
  NotAnswering,
  OutOfCalls,
  SIGN_IN_UNREADABLE,
  SignInLost,
  type GmailConnectorConfig,
} from './mailbox.js';
import { EXCERPT_LENGTH, NO_SUBJECT, SENT, TITLE_LENGTH, conversationLink, cutTo, headerOf, oneLine, sentAt, type GmailMessage } from './messages.js';

/**
 * *Follow a sent email…* ("Follow a sent email… in Capture", issue 1710): the
 * newest emails sent from the mailbox, read while the person waits and changing
 * nothing. `users.messages.list` with the Sent label answers their ids newest
 * first
 * (https://developers.google.com/gmail/api/reference/rest/v1/users.messages/list),
 * and each is read once in `metadata` format for its conversation, subject,
 * recipients, time and snippet
 * (https://developers.google.com/gmail/api/reference/rest/v1/users.messages/get).
 */

/**
 * The calls one listing may spend: a refresh, the mailbox's address where no
 * run has saved it yet, the list, and one read for each of up to ten emails.
 */
const CALLS_PER_LISTING = 14;

/** The headers a listing is built from. */
const LISTED_HEADERS = ['Subject', 'To'];

export async function listGmailSent(host: OnDemandHost, config: GmailConnectorConfig, limit: number): Promise<SentEmail[]> {
  try {
    const credential = credentialIn(await host.getCredentials());
    if (!credential) throw new SignInLost(SIGN_IN_UNREADABLE);
    const mailbox = new Mailbox(host, config, credential, { left: CALLS_PER_LISTING });
    const saved = (await host.getState()) as { address?: unknown } | null;
    // Asked first, one by one: the first call settles the access token the reads then share.
    const ids = sentIds(await mailbox.get(`messages?labelIds=${SENT}&maxResults=${limit}`), limit);
    if (ids.length === 0) return [];
    const address =
      typeof saved?.address === 'string' && saved.address
        ? saved.address
        : (((await mailbox.get('profile')) as { emailAddress?: unknown } | null)?.emailAddress ?? '');
    const query = new URLSearchParams({ format: 'metadata' });
    for (const name of LISTED_HEADERS) query.append('metadataHeaders', name);
    const read = await Promise.all(ids.map((id) => mailbox.get(`messages/${encodeURIComponent(id)}?${query}`)));
    return read
      .map((answer) => sentEmailIn(answer, typeof address === 'string' ? address : ''))
      .filter((one): one is SentEmail => one !== null)
      .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
  } catch (error) {
    throw inTheirWords(error);
  }
}

/** The ids of the emails `users.messages.list` answers, in its order, at most `limit`. */
export function sentIds(answer: unknown, limit: number): string[] {
  const { messages } = (answer ?? {}) as { messages?: unknown };
  const ids: string[] = [];
  for (const one of Array.isArray(messages) ? (messages as unknown[]) : []) {
    const { id } = (one ?? {}) as { id?: unknown };
    if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, limit);
}

/**
 * One listed email from a metadata read of it, or null for one that is gone, a
 * draft, in the bin or without a conversation or time: nothing a person sent
 * and can follow.
 */
export function sentEmailIn(answer: unknown, mailboxAddress: string): SentEmail | null {
  const message = answer as GmailMessage & { snippet?: unknown };
  if (!message || typeof message.id !== 'string' || typeof message.threadId !== 'string' || !message.threadId) return null;
  const labels = Array.isArray(message.labelIds) ? (message.labelIds as unknown[]) : [];
  if (!labels.includes(SENT) || labels.includes('DRAFT') || labels.includes('TRASH')) return null;
  const at = sentAt(message);
  if (at <= 0) return null;
  const subject = cutTo(oneLine(headerOf(message.payload, 'Subject') ?? ''), TITLE_LENGTH) || NO_SUBJECT;
  const to = recipientsIn(headerOf(message.payload, 'To'));
  return {
    conversationId: message.threadId,
    subject,
    to,
    sentAt: new Date(at).toISOString(),
    link: conversationLink(message.threadId, mailboxAddress),
    excerpt: cutTo(oneLine(unescaped(typeof message.snippet === 'string' ? message.snippet : '')), EXCERPT_LENGTH),
  };
}

/**
 * Whom a To header names, as a person reads it: `"Steven Noels" <s@example.com>`
 * is Steven Noels, a bare address is itself, joined by commas. Null where empty.
 */
export function recipientsIn(header: string | null): string | null {
  if (!header) return null;
  const names = header
    // A comma inside quotes is part of a name, not a separator.
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((one) => {
      const named = /^\s*(.*?)\s*<([^>]*)>\s*$/.exec(one);
      const name = named ? named[1]!.replace(/^"(.*)"$/, '$1').trim() : '';
      return oneLine(name || (named ? named[2]! : one));
    })
    .filter(Boolean);
  return names.length > 0 ? cutTo(names.join(', '), TITLE_LENGTH) : null;
}

/** A snippet comes HTML-escaped. */
function unescaped(snippet: string): string {
  return snippet
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Why the list was not read, in words for the person - never the request's address. */
function inTheirWords(error: unknown): Error {
  if (error instanceof SignInLost) return new SourceError(error.message);
  if (error instanceof ChangeRefused) return new SourceError(`Gmail refused the request (${error.status})`, error.status);
  if (error instanceof NotAnswering) return new SourceError('Gmail did not answer. Try again in a moment.', error.status);
  if (error instanceof OutOfCalls) return new SourceError('Gmail could not be asked this time. Try again in a moment.');
  if (error instanceof SourceError) return error;
  return new SourceError('Gmail could not list the sent emails');
}
