import { SourceError, type DraftFound, type DraftMade, type DraftWaiting, type DraftWanted, type OnDemandHost } from '@cockpit/connector-sdk';
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
import { DRAFT, SENT, conversationLink, headerOf, sentAt, type GmailMessage } from './messages.js';

/**
 * *Email…* and *Reply…* ("Email… makes a Gmail draft the Item then follows",
 * issue 1708): a draft made in the mailbox while the person waits, with
 * `users.drafts.create` under the modify grant the connection already holds
 * (https://developers.google.com/gmail/api/reference/rest/v1/users.drafts/create).
 *
 * - **A new conversation's draft** has the Item's title as its subject and no
 *   recipient.
 * - **A reply's** is in the followed conversation, as Gmail threads one: its
 *   thread id, `In-Reply-To` and `References` naming the latest message, and
 *   that message's subject behind *Re:*. It is addressed as Gmail's own Reply
 *   addresses it: to whom the latest message was from, or to whom it was sent
 *   where it was yours.
 *
 * **Made once, never retried here**: a draft made twice is two drafts in a real
 * mailbox, which nothing can take back.
 */

/**
 * The calls one draft may spend: a refresh, the mailbox's address where no run
 * has saved it yet, the conversation read for a reply, and the draft itself.
 */
const CALLS_PER_DRAFT = 4;

/** The headers a reply is built from, all a metadata read of the conversation is asked for. */
const REPLY_HEADERS = ['Subject', 'Message-ID', 'References', 'From', 'To', 'Reply-To'];

export async function makeGmailDraft(host: OnDemandHost, config: GmailConnectorConfig, wanted: DraftWanted): Promise<DraftMade> {
  try {
    const credential = credentialIn(await host.getCredentials());
    if (!credential) throw new SignInLost(SIGN_IN_UNREADABLE);
    const mailbox = new Mailbox(host, config, credential, { left: CALLS_PER_DRAFT });
    const address = await addressOf(host, mailbox);
    let reply: ReplyTo | null = null;
    if (wanted.replyIn !== null) {
      const query = new URLSearchParams({ format: 'metadata' });
      for (const name of REPLY_HEADERS) query.append('metadataHeaders', name);
      reply = replyToLatestIn(await mailbox.get(`threads/${encodeURIComponent(wanted.replyIn)}?${query}`));
      if (!reply) throw new SourceError('the conversation is no longer in Gmail');
    }
    const raw = rawDraft(reply ?? { subject: wanted.subject, to: null, inReplyTo: null, references: null });
    const answer = await mailbox.post('drafts', { message: { raw, ...(wanted.replyIn !== null ? { threadId: wanted.replyIn } : {}) } });
    const made = draftIn(answer);
    if (!made) throw new SourceError('Gmail answered without the draft it made');
    return {
      draftId: made.id,
      conversationId: made.threadId,
      draftLink: draftLink(address, made.threadId, made.id),
      // The message replied to, or the draft itself where it starts the
      // conversation: never the conversation's id, which is its first message's.
      conversationLink: conversationLink(reply?.latestId ?? made.messageId, address),
    };
  } catch (error) {
    throw inTheirWords(error);
  }
}

/** The mailbox's address, which a link names: as the last run saved it, or asked of Gmail. */
async function addressOf(host: OnDemandHost, mailbox: Mailbox): Promise<string> {
  const saved = (await host.getState()) as { address?: unknown } | null;
  if (typeof saved?.address === 'string' && saved.address) return saved.address;
  const profile = (await mailbox.get('profile')) as { emailAddress?: unknown } | null;
  return typeof profile?.emailAddress === 'string' ? profile.emailAddress : '';
}

/** What a draft says before its body: the subject, and for a reply whom it goes to and which message it answers. */
interface ReplyTo {
  subject: string;
  to: string | null;
  inReplyTo: string | null;
  references: string | null;
  /** Gmail's id of the message replied to, which the conversation's link names until the draft is sent. */
  latestId?: string;
}

/**
 * How a reply to the conversation's latest message is addressed, from a
 * metadata read of it - or null for one with no message left. A draft or a
 * message in the bin is not what is replied to.
 */
export function replyToLatestIn(answer: unknown): ReplyTo | null {
  const { messages } = (answer ?? {}) as { messages?: unknown };
  const held = (Array.isArray(messages) ? (messages as GmailMessage[]) : []).filter(
    (message) => Array.isArray(message?.labelIds) && !message.labelIds.includes(DRAFT) && !message.labelIds.includes('TRASH'),
  );
  if (held.length === 0) return null;
  const newestFirst = [...held].sort((a, b) => sentAt(b) - sentAt(a));
  const latest = newestFirst[0]!;
  // The latest message's subject, or the newest one that has a subject at all.
  const subject = newestFirst.map((one) => oneHeader(headerOf(one.payload, 'Subject'))).find(Boolean) ?? '';
  const messageId = oneHeader(headerOf(latest.payload, 'Message-ID'));
  const references = oneHeader(headerOf(latest.payload, 'References'));
  const yours = (latest.labelIds as unknown[]).includes(SENT);
  const to = yours
    ? oneHeader(headerOf(latest.payload, 'To'))
    : (oneHeader(headerOf(latest.payload, 'Reply-To')) ?? oneHeader(headerOf(latest.payload, 'From')));
  return {
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`.trim(),
    to,
    inReplyTo: messageId,
    references: messageId ? [references, messageId].filter(Boolean).join(' ') : references,
    ...(typeof latest.id === 'string' && latest.id ? { latestId: latest.id } : {}),
  };
}

/** A header's value on one line, so nothing it holds can start a header of its own; null where empty. */
function oneHeader(value: string | null): string | null {
  const flat = (value ?? '').replace(/[\r\n]+/g, ' ').trim();
  return flat || null;
}

/**
 * The draft as RFC 2822 text in Gmail's URL-safe base64, which `raw` takes:
 * its headers, an empty plain-text body, and a subject outside ASCII encoded
 * as RFC 2047 says. Gmail adds the From.
 */
export function rawDraft(draft: ReplyTo): string {
  const lines = [
    ...(draft.to ? [`To: ${draft.to}`] : []),
    `Subject: ${encodedWord(oneHeader(draft.subject) ?? '')}`,
    ...(draft.inReplyTo ? [`In-Reply-To: ${draft.inReplyTo}`] : []),
    // One message id a line, so a long conversation's stays inside RFC 5322's 998.
    ...(draft.references ? [`References: ${draft.references.split(/\s+/).filter(Boolean).join('\r\n ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    '',
  ];
  return base64url(lines.join('\r\n'));
}

/**
 * A header value as it may be sent: as it is in ASCII, else UTF-8 encoded
 * words of at most 45 bytes each, one a line, so none passes RFC 2047's 75
 * characters and a long title no line's 998. A character is never split.
 */
function encodedWord(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let word = '';
  for (const character of value) {
    if (word && new TextEncoder().encode(word + character).length > 45) {
      words.push(word);
      word = '';
    }
    word += character;
  }
  if (word) words.push(word);
  return words.map((one) => `=?UTF-8?B?${base64(one)}?=`).join('\r\n ');
}

function base64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64url(text: string): string {
  return base64(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The draft `users.drafts.create` answers: its id, and its message's id and conversation - or null where it holds none. */
export function draftIn(answer: unknown): { id: string; messageId: string; threadId: string } | null {
  const { id, message } = (answer ?? {}) as { id?: unknown; message?: { id?: unknown; threadId?: unknown } };
  if (typeof id !== 'string' || !id || typeof message?.id !== 'string' || typeof message.threadId !== 'string') return null;
  return { id, messageId: message.id, threadId: message.threadId };
}

/**
 * Where Gmail opens one draft, in the connected mailbox: `#drafts?compose=`
 * with the code Gmail's own address bar shows for it. Gmail does not document
 * that code; a real mailbox's decodes to `f:<conversation id in decimal>|msg-a:<draft id>+msg-a:<draft id>`,
 * written in base64 and then in Gmail's own alphabet of consonants, and a link
 * built that way from the API's ids opened the draft ("Conversation follow-up:
 * Open, previews, drafts and Check now misbehave on real Gmail and Outlook
 * mailboxes", issue 1720). Should Gmail change the code, the link would open a
 * blank message over the Drafts folder, as a code Gmail did not make did before.
 * A conversation id that is not hexadecimal, as Gmail's always are, gets the
 * Drafts folder, the draft at its top.
 */
export function draftLink(mailboxAddress: string, conversationId: string, draftId: string): string {
  const drafts = `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailboxAddress)}#drafts`;
  if (!/^[0-9a-f]+$/i.test(conversationId)) return drafts;
  const named = `f:${BigInt(`0x${conversationId}`)}|msg-a:${draftId}+msg-a:${draftId}`;
  return `${drafts}?compose=${inGmailsAlphabet(btoa(named).replace(/=+$/, ''))}`;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CONSONANTS = 'BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz';

/** Base64 text rewritten in Gmail's consonants: the same number, its digits read in base 64 and written in base 40. */
function inGmailsAlphabet(base64: string): string {
  let number = 0n;
  for (const digit of base64) number = number * 64n + BigInt(BASE64.indexOf(digit));
  let out = '';
  for (; number > 0n; number /= 40n) out = CONSONANTS[Number(number % 40n)] + out;
  return out;
}

/**
 * The calls one look for a draft may spend: a refresh, the draft, the mailbox's
 * address where no run has saved it yet, and the conversation where the draft
 * is no longer there.
 */
const CALLS_PER_LOOK = 4;

/**
 * What became of a draft *Email…* made (issue 1720), told as the draft watch
 * tells it (`#checkDrafts`, sync.ts): still there unsent, and where it opens;
 * sent, its conversation holding a message sent from this mailbox since
 * `after`; or null for one Gmail no longer has, or has in the bin - which
 * counts as deleted unsent (`draftStillThere`).
 */
export async function findGmailDraft(host: OnDemandHost, config: GmailConnectorConfig, draft: DraftWaiting): Promise<DraftFound | null> {
  try {
    const credential = credentialIn(await host.getCredentials());
    if (!credential) throw new SignInLost(SIGN_IN_UNREADABLE);
    const mailbox = new Mailbox(host, config, credential, { left: CALLS_PER_LOOK });
    const answer = await mailbox.get(`drafts/${encodeURIComponent(draft.draftId)}?format=minimal`);
    const messageId = draftStillThere(answer);
    if (messageId !== null) return { draftLink: draftLink(await addressOf(host, mailbox), draft.conversationId, draft.draftId) };
    const thread = await mailbox.get(`threads/${encodeURIComponent(draft.conversationId)}?format=minimal`);
    return thread !== null && latestSentSince(thread, draft.after) !== null ? { sent: true } : null;
  } catch (error) {
    throw inTheirWords(error, 'Gmail could not look for the draft');
  }
}

/**
 * The id of a draft's message as `users.drafts.get` answers it, while it is a
 * draft outside the bin - or null for one gone (a 404, read as null), or in
 * the bin, which Gmail keeps until the bin is emptied and which counts as
 * deleted unsent.
 */
export function draftStillThere(answer: unknown): string | null {
  const message = (answer as { message?: { id?: unknown; labelIds?: unknown } } | null)?.message;
  if (typeof message?.id !== 'string' || !message.id) return null;
  const labels = Array.isArray(message.labelIds) ? (message.labelIds as unknown[]) : [];
  return labels.includes('TRASH') ? null : message.id;
}

/**
 * Why the draft was not made, in words for the person: what they can do about a
 * lost sign-in, and Gmail's status otherwise - never the request's address.
 */
function inTheirWords(error: unknown, otherwise = 'Gmail could not make the draft'): Error {
  if (error instanceof SignInLost) return new SourceError(error.message);
  if (error instanceof ChangeRefused) return new SourceError(`Gmail refused the draft (${error.status})`, error.status);
  if (error instanceof NotAnswering) return new SourceError('Gmail did not answer. Try again in a moment.', error.status);
  if (error instanceof OutOfCalls) return new SourceError('Gmail could not be asked this time. Try again in a moment.');
  if (error instanceof SourceError) return error;
  return new SourceError(otherwise);
}

/**
 * Whether a conversation, as `threads.get` answers it, holds a message sent
 * from this mailbox after `after` - every one where `after` is null: what tells
 * a draft sent, whose turn a check reads, from one deleted unsent.
 */
export function sentSince(answer: unknown, after: string | null): boolean {
  return latestSentSince(answer, after) !== null;
}

/** The id of the newest message sent from this mailbox after `after` in a conversation as `threads.get` answers it, or null. */
export function latestSentSince(answer: unknown, after: string | null): string | null {
  const { messages } = (answer ?? {}) as { messages?: unknown };
  const since = after === null ? Number.NEGATIVE_INFINITY : Date.parse(after);
  const sent = (Array.isArray(messages) ? (messages as GmailMessage[]) : []).filter(
    (message) =>
      typeof message?.id === 'string' &&
      Array.isArray(message.labelIds) &&
      message.labelIds.includes(SENT) &&
      !message.labelIds.includes(DRAFT) &&
      sentAt(message) > since,
  );
  const latest = sent.sort((a, b) => sentAt(b) - sentAt(a))[0];
  return typeof latest?.id === 'string' ? latest.id : null;
}
