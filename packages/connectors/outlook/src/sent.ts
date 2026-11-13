import { SourceError, type OnDemandHost, type SentEmail } from '@cockpit/connector-sdk';
import { credentialIn } from './credential.js';
import {
  Changed,
  Mailbox,
  NotAnswering,
  OutOfCalls,
  Refused,
  SIGN_IN_UNREADABLE,
  SignInLost,
  type OutlookConnectorConfig,
} from './graph.js';
import { NO_SUBJECT, TITLE_LENGTH, cutTo, oneLine, withoutQuotedText } from './messages.js';

/**
 * *Follow a sent email…* ("Follow a sent email… in Capture", issue 1710): the
 * newest emails in Sent Items, read while the person waits and changing nothing.
 * One call to the well-known folder `sentitems`, newest `sentDateTime` first
 * (https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0),
 * asking only for the fields a listing and the Item it starts need.
 */

/** The calls one listing may spend: a refresh and the read. */
const CALLS_PER_LISTING = 3;

/** How many times the limit the list asks for, since several of the newest may be one conversation's. */
const OVER_FETCH = 3;

/** The longest an excerpt is: as a turn's, the first lines. */
const EXCERPT_LENGTH = 280;

const LISTED_FIELDS = 'id,conversationId,subject,toRecipients,sentDateTime,bodyPreview,webLink,isDraft';

export async function listOutlookSent(host: OnDemandHost, config: OutlookConnectorConfig, limit: number): Promise<SentEmail[]> {
  try {
    const credential = credentialIn(await host.getCredentials());
    if (!credential) throw new SignInLost(SIGN_IN_UNREADABLE);
    const mailbox = new Mailbox(host, config, credential, { left: CALLS_PER_LISTING });
    const answer = await mailbox.get(
      `mailFolders/sentitems/messages?$top=${limit * OVER_FETCH}&$orderby=${encodeURIComponent('sentDateTime desc')}&$select=${LISTED_FIELDS}`,
    );
    return sentEmailsIn(answer, limit);
  } catch (error) {
    throw inTheirWords(error);
  }
}

/** The emails a page of Sent Items holds, newest first, at most `limit`: a draft or a message with no conversation or time is no email sent. */
export function sentEmailsIn(answer: unknown, limit: number): SentEmail[] {
  const { value } = (answer ?? {}) as { value?: unknown };
  const emails: SentEmail[] = [];
  for (const one of Array.isArray(value) ? (value as unknown[]) : []) {
    const message = (one ?? {}) as Record<string, unknown>;
    const at = typeof message.sentDateTime === 'string' ? Date.parse(message.sentDateTime) : Number.NaN;
    if (message.isDraft === true || typeof message.conversationId !== 'string' || !message.conversationId || !Number.isFinite(at)) continue;
    emails.push({
      conversationId: message.conversationId,
      subject: cutTo(oneLine(typeof message.subject === 'string' ? message.subject : ''), TITLE_LENGTH) || NO_SUBJECT,
      to: recipientsIn(message.toRecipients),
      sentAt: new Date(at).toISOString(),
      link:
        typeof message.webLink === 'string' && message.webLink
          ? message.webLink
          : `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(String(message.id ?? ''))}`,
      excerpt: cutTo(oneLine(withoutQuotedText(typeof message.bodyPreview === 'string' ? message.bodyPreview : '')), EXCERPT_LENGTH),
    });
  }
  // Newest first, then the newest of each conversation: one written in four times is listed once.
  const newest = emails.sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
  return newest.filter((one, at) => newest.findIndex((other) => other.conversationId === one.conversationId) === at).slice(0, limit);
}

/** Whom a message went to: each recipient's name, else the address, joined by commas; null where it names nobody. */
export function recipientsIn(recipients: unknown): string | null {
  const names = (Array.isArray(recipients) ? (recipients as unknown[]) : [])
    .map((one) => {
      const { name, address } = ((one as { emailAddress?: unknown } | null)?.emailAddress ?? {}) as { name?: unknown; address?: unknown };
      const called = typeof name === 'string' ? oneLine(name) : '';
      return called || (typeof address === 'string' ? oneLine(address) : '');
    })
    .filter(Boolean);
  return names.length > 0 ? cutTo(names.join(', '), TITLE_LENGTH) : null;
}

/** Why the list was not read, in words for the person - never the request's address. */
function inTheirWords(error: unknown): Error {
  if (error instanceof SignInLost) return new SourceError(error.message);
  if (error instanceof Refused) return new SourceError(`Outlook refused the request (${error.status})`, error.status);
  if (error instanceof Changed || error instanceof NotAnswering) {
    return new SourceError('Outlook did not answer. Try again in a moment.', error.status);
  }
  if (error instanceof OutOfCalls) return new SourceError('Outlook could not be asked this time. Try again in a moment.');
  if (error instanceof SourceError) return error;
  return new SourceError('Outlook could not list the sent emails');
}
