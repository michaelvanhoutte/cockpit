import {
  SourceError,
  type ConnectorHost,
  type DraftFound,
  type DraftLook,
  type DraftMade,
  type DraftRewrite,
  type DraftWaiting,
  type DraftWanted,
  type MessageForReply,
  type OnDemandHost,
  type ReplyReadLimits,
} from '@cockpit/connector-sdk';
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
import { conversationMessages, foldersOf, type Folders } from './conversations.js';
import { TITLE_LENGTH, cutTo, deletedItemsIn, draftWordsOf, oneLine, plainTextOf, uniqueTextOf, type MailTurn } from './messages.js';

/**
 * *Email…* and *Reply…* ("Email… makes an Outlook draft the Item then follows",
 * issue 1709): a draft made in the mailbox while the person waits, under the
 * Mail.ReadWrite grant the connection already holds.
 *
 * - **A new conversation's draft** is `POST /me/messages` with the Item's title
 *   as its subject and no recipient
 *   (https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0).
 * - **A reply** is `POST /me/messages/{id}/createReply` on the conversation's
 *   latest message that is sent or received and not binned: Graph addresses it
 *   and puts it in the conversation
 *   (https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0).
 *
 * Both answer the draft with its `id`, `conversationId` and `webLink`, which
 * opens it in Outlook on the web. **Made once, never retried here.**
 *
 * **A draft handed a body** (Claude's, issue 1731): a new draft carries it as
 * its plain-text body. A reply's `createReply` takes no request body in the
 * documentation as it stands, so the reply is made as above and its body is then
 * updated
 * (https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0:
 * `body` is "updatable only if isDraft = true"), the words put above the earlier
 * email Outlook quotes in it, as Outlook's own Reply puts the person's.
 */

/**
 * The calls one draft may spend: a refresh, the two folders and a page or two
 * of the conversation for a reply, and the draft itself.
 */
const CALLS_PER_DRAFT = 8;

export async function makeOutlookDraft(host: OnDemandHost, config: OutlookConnectorConfig, wanted: DraftWanted): Promise<DraftMade> {
  try {
    const credential = credentialIn(await host.getCredentials());
    if (!credential) throw new SignInLost(SIGN_IN_UNREADABLE);
    const mailbox = new Mailbox(host, config, credential, { left: CALLS_PER_DRAFT });
    const text = wanted.body;
    let answer: unknown;
    if (wanted.replyIn === null) {
      const subject = cutTo(oneLine(wanted.subject), TITLE_LENGTH);
      answer = await mailbox.post('messages', { subject, body: { contentType: 'text', content: text ?? '' } });
    } else {
      const latest = await latestIn(mailbox, wanted.replyIn);
      if (!latest) throw new SourceError('the conversation is no longer in Outlook');
      answer = await mailbox.post(`messages/${encodeURIComponent(latest)}/createReply`, {});
      if (answer === null) throw new SourceError('the conversation is no longer in Outlook');
    }
    const made = draftIn(answer);
    if (!made) throw new SourceError('Outlook answered without the draft it made');
    if (wanted.replyIn !== null && text !== undefined) {
      const updated = await mailbox.patch(`messages/${encodeURIComponent(made.id)}`, { body: replyBody(answer, text) });
      if (updated === null) throw new SourceError('the draft is no longer in Outlook');
    }
    return {
      draftId: made.id,
      conversationId: made.conversationId,
      draftLink: made.link,
      conversationLink: made.link,
    };
  } catch (error) {
    throw inTheirWords(error);
  }
}

/** The calls one read of a conversation for a reply may spend: a refresh, the two folders, a page or two of the conversation, and one read of each message. */
const CALLS_PER_READ = 20;

/** The message bodies read at once. */
const READS_AT_ONCE = 3;

/**
 * The newest `limits.messages` messages of a conversation, oldest first, each
 * as its own words (issue 1731): who sent it, when, and the part of its body
 * that is unique to it (`uniqueBody`, read as text) without any earlier email it
 * still quotes, cut to `limits.characters`. A draft or a message in Deleted Items
 * is not part of what is answered. Changes nothing in the mailbox.
 *
 * The conversation is listed with the light fields first and the bodies read
 * only for the messages kept, so a long conversation's bodies are never all
 * fetched
 * (https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0,
 * https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0).
 */
export async function readOutlookConversationForReply(
  host: OnDemandHost,
  config: OutlookConnectorConfig,
  conversationId: string,
  limits: ReplyReadLimits,
): Promise<MessageForReply[]> {
  try {
    const credential = credentialIn(await host.getCredentials());
    if (!credential) throw new SignInLost(SIGN_IN_UNREADABLE);
    const mailbox = new Mailbox(host, config, credential, { left: CALLS_PER_READ });
    const whole = await conversationMessages(mailbox, conversationId, await foldersOf(mailbox));
    if (whole.length === 0) throw new SourceError('the conversation is no longer in Outlook');
    const newest = [...whole].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-limits.messages);
    const read: MessageForReply[] = [];
    // A few at a time: Outlook allows an app about four requests at once to one mailbox.
    for (let from = 0; from < newest.length; from += READS_AT_ONCE) {
      read.push(
        ...(await Promise.all(
          newest.slice(from, from + READS_AT_ONCE).map(async (turn): Promise<MessageForReply> => {
            const body = await mailbox.get(`messages/${encodeURIComponent(turn.messageId)}?$select=id,uniqueBody`, { bodyAsText: true });
            // A message gone since the listing, or sent with no body, is told by its preview.
            const text = uniqueTextOf(body) ?? turn.excerpt;
            return { by: turn.by, from: turn.from, at: turn.at, text: cutTo(text, limits.characters) };
          }),
        )),
      );
    }
    return read;
  } catch (error) {
    throw inTheirWords(error, 'Outlook could not be read for the reply');
  }
}

/**
 * The body a reply draft is updated to: the words above the earlier email the
 * draft Graph made quotes, in the format that draft holds (HTML as Outlook
 * stores it, else text), or the words alone where the draft holds no body.
 */
export function replyBody(draft: unknown, words: string): { contentType: 'text' | 'html'; content: string } {
  const { body } = (draft ?? {}) as { body?: { contentType?: unknown; content?: unknown } | null };
  const quoted = typeof body?.content === 'string' ? body.content : '';
  if (typeof body?.contentType === 'string' && body.contentType.toLowerCase() === 'html' && quoted) {
    const at = insideBody(quoted);
    return { contentType: 'html', content: `${quoted.slice(0, at)}${htmlLines(words)}<div><br></div>${quoted.slice(at)}` };
  }
  return { contentType: 'text', content: quoted ? `${words}\n\n${quoted}` : words };
}

/** Words as HTML, a block for each line and an empty one for a blank line, as Outlook writes typed text. */
function htmlLines(words: string): string {
  return words
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line ? `<div>${escapeHtml(line)}</div>` : '<div><br></div>'))
    .join('');
}

/** Where what an HTML body shows begins: just inside its `<body>`, or at the start where it has none. */
function insideBody(html: string): number {
  const open = /<body\b[^>]*>/i.exec(html);
  return open ? open.index + open[0].length : 0;
}

/** The calls one rewrite may spend: a refresh, the draft as it is, and the draft updated. */
const CALLS_PER_REWRITE = 3;

/**
 * Claude's unsent draft written again in place ("Mail follow-up: a Claude draft
 * looks like any other and cannot be redone…", issue 1732): its body read as
 * Outlook stores it and updated with `PATCH /me/messages/{id}`, the same draft
 * and the same `webLink`
 * (https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0:
 * `body` is "updatable only if isDraft = true"; read with
 * https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0).
 * Only the words `was` at the top of the body are replaced (`wordsReplaced`),
 * the earlier email Outlook quotes under them kept as it is. Conditional on the
 * version read (`If-Match`), so a save made in between is never overwritten:
 * that, or words not found where they go, is `changed`.
 */
export async function rewriteOutlookDraft(
  host: OnDemandHost,
  config: OutlookConnectorConfig,
  draft: DraftWaiting,
  rewrite: DraftRewrite,
): Promise<'rewritten' | 'changed'> {
  try {
    const credential = credentialIn(await host.getCredentials());
    if (!credential) throw new SignInLost(SIGN_IN_UNREADABLE);
    const mailbox = new Mailbox(host, config, credential, { left: CALLS_PER_REWRITE });
    const path = `messages/${encodeURIComponent(draft.draftId)}`;
    const read = (await mailbox.get(`${path}?$select=id,isDraft,body`)) as { isDraft?: unknown; body?: unknown; '@odata.etag'?: unknown } | null;
    if (read?.isDraft !== true) throw new SourceError('the draft is no longer in Outlook');
    const body = wordsReplaced(read.body, rewrite.was, rewrite.body);
    if (!body) return 'changed';
    const version = typeof read['@odata.etag'] === 'string' && read['@odata.etag'] ? read['@odata.etag'] : undefined;
    try {
      const updated = await mailbox.patch(path, { body }, version ? { ifMatch: version } : {});
      if (updated === null) throw new SourceError('the draft is no longer in Outlook');
    } catch (error) {
      if (error instanceof Changed) return 'changed';
      throw error;
    }
    return 'rewritten';
  } catch (error) {
    throw inTheirWords(error, 'Outlook could not write the draft again');
  }
}

/**
 * A draft's body with the words at its top, `was`, replaced by `words`, in the
 * format it is stored in: HTML keeps everything after the words - the gap and
 * the earlier email Outlook quotes - byte for byte; text keeps what follows a
 * blank line. Null where the body does not start with `was` (spacing aside)
 * ending at a break, so the words are not where they go.
 */
export function wordsReplaced(body: unknown, was: string, words: string): { contentType: 'text' | 'html'; content: string } | null {
  const { contentType, content } = (body ?? {}) as { contentType?: unknown; content?: unknown };
  if (typeof content !== 'string') return null;
  const html = typeof contentType === 'string' && contentType.toLowerCase() === 'html';
  const start = html ? insideBody(content) : 0;
  const end = html ? endOfWordsInHtml(content, start, was) : endOfWordsInText(content, was);
  if (end === null) return null;
  const rest = content.slice(end);
  if (html) {
    const gap = /^\s*(<\/(body|html)\b|$)/i.test(rest) ? '' : '<div><br></div>';
    return { contentType: 'html', content: `${content.slice(0, start)}${htmlLines(words)}${gap}${rest}` };
  }
  const after = rest.replace(/^\s+/, '');
  return { contentType: 'text', content: after ? `${words}\n\n${after}` : words };
}

/** What a run of spacing reads as, for words compared spacing aside. */
const SPACING = /\s/;

/** Where `was` ends at the start of a text body - at a line break or the end - or null. */
function endOfWordsInText(content: string, was: string): number | null {
  const end = endOfWords([...content].map((char) => ({ shows: char, length: char.length })), 0, was);
  if (end === null) return null;
  return /^(\s*$|[^\S\n]*\r?\n)/.test(content.slice(end)) ? end : null;
}

/**
 * Where `was` ends in an HTML body from `start`, with the closing tags, line
 * breaks and empty blocks that follow it - or null where the body does not
 * start with it, or it runs on into more words.
 */
function endOfWordsInHtml(content: string, start: number, was: string): number | null {
  const pieces: { shows: string; length: number }[] = [];
  const token = /<!--[\s\S]*?-->|<(style|script|head)\b[\s\S]*?<\/\1\s*>|<[^>]*>|&(#x[0-9a-f]+|#[0-9]+|[a-z]+);|[\s\S]/gi;
  token.lastIndex = start;
  for (let found = token.exec(content); found; found = token.exec(content)) pieces.push({ shows: shownBy(found[0]), length: found[0].length });
  let end = endOfWords(pieces, start, was);
  if (end === null) return null;
  // Blank lines only: an empty block with no break in it (Outlook's `appendonsend` marker) is kept.
  const trailing = /\s+|<br\b[^>]*>|<\/(?!body\b|html\b)[a-z][^>]*>|<(div|p)\b[^>]*>\s*(?:&nbsp;|<br\b[^>]*>)(?:\s|&nbsp;|<br\b[^>]*>)*<\/\1\s*>/iy;
  for (trailing.lastIndex = end; trailing.exec(content); trailing.lastIndex = end) end = trailing.lastIndex;
  // Words running on past `was` are not Claude's alone.
  return end === content.length || content[end] === '<' ? end : null;
}

/**
 * What one piece of HTML shows: a block's edge or a line break as a space, a
 * character reference as its character, any other tag as nothing - but an
 * image or other embedded content as a character no words hold, since Graph
 * counts a pasted image in no `hasAttachments`, and replacing the words around
 * it would lose it.
 */
function shownBy(piece: string): string {
  if (piece.startsWith('<')) {
    if (/^<(img|picture|object|embed|iframe|video|audio|svg|canvas)\b/i.test(piece)) return '￼';
    return /^<\/?(br|p|div|li|tr|td|h[1-6]|blockquote|hr|table)\b/i.test(piece) ? ' ' : '';
  }
  // A space a reference stands for (`&nbsp;`) comes back trimmed to nothing.
  if (piece.length > 1 && piece.startsWith('&')) return plainTextOf(piece) || ' ';
  return piece;
}

/**
 * Where `was` ends among pieces read from `start` (each what it shows and how
 * long it is in the source), comparing spacing aside - or null where they show
 * something else first.
 */
function endOfWords(pieces: readonly { shows: string; length: number }[], start: number, was: string): number | null {
  const wanted = was.replace(/\s+/g, ' ').trim();
  let seen = '';
  let gap = false;
  let at = start;
  for (const piece of pieces) {
    if (seen === wanted) return at;
    at += piece.length;
    for (const char of piece.shows) {
      if (SPACING.test(char)) {
        gap = seen !== '';
        continue;
      }
      seen += gap ? ` ${char}` : char;
      gap = false;
      if (!wanted.startsWith(seen)) return null;
    }
  }
  return seen === wanted ? at : null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The id of the message a reply answers: the newest of the conversation that is not a draft or in Deleted Items, or null where none is left. */
async function latestIn(mailbox: Mailbox, conversationId: string): Promise<string | null> {
  const whole = await conversationMessages(mailbox, conversationId, await foldersOf(mailbox));
  const newest = [...whole].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  return newest?.messageId ?? null;
}

/** The draft Graph answers a create with: its id and conversation, and where Outlook on the web opens it - or null where it holds none. */
export function draftIn(answer: unknown): { id: string; conversationId: string; link: string } | null {
  const { id, conversationId, webLink } = (answer ?? {}) as { id?: unknown; conversationId?: unknown; webLink?: unknown };
  if (typeof id !== 'string' || !id || typeof conversationId !== 'string' || !conversationId) return null;
  return { id, conversationId, link: linkOf(id, webLink) };
}

/**
 * The calls one look for a draft may spend: a refresh, the draft, Deleted
 * Items, and where the draft is no longer there Sent Items and a page or two
 * of its conversation.
 */
const CALLS_PER_LOOK = 7;

/** What a draft is read for, to tell it is still there unsent and where it opens. */
const DRAFT_FIELDS = 'id,isDraft,parentFolderId,webLink';

/**
 * What became of a draft *Email…* made ("Conversation follow-up: Open,
 * previews, drafts and Check now misbehave on real Gmail and Outlook
 * mailboxes", issue 1720), told as the draft watch tells it (`checkDrafts`):
 * still a draft outside Deleted Items, and where it opens; sent, its
 * conversation holding a message in Sent Items since `after`; or null for one
 * gone or in Deleted Items, which counts as deleted unsent.
 */
export async function findOutlookDraft(
  host: OnDemandHost,
  config: OutlookConnectorConfig,
  draft: DraftWaiting,
  look?: DraftLook,
): Promise<DraftFound | null> {
  try {
    const credential = credentialIn(await host.getCredentials());
    if (!credential) throw new SignInLost(SIGN_IN_UNREADABLE);
    const mailbox = new Mailbox(host, config, credential, { left: CALLS_PER_LOOK });
    // Its words too where they are asked for, in the same read, as text (issue 1732).
    const read = look?.text
      ? await mailbox.get(`messages/${encodeURIComponent(draft.draftId)}?$select=${DRAFT_FIELDS},uniqueBody,hasAttachments`, { bodyAsText: true })
      : await mailbox.get(`messages/${encodeURIComponent(draft.draftId)}?$select=${DRAFT_FIELDS}`);
    const deletedItems = deletedItemsIn(await mailbox.get('mailFolders/deleteditems?$select=id'));
    if (!deletedItems) throw new SourceError('Outlook gave no Deleted Items folder for this mailbox');
    const link = draftStillThere(read, deletedItems);
    if (link !== null) {
      if (!look?.text) return { draftLink: link };
      // An attachment added is an edit too, as it is in Gmail: the draft is then yours.
      const attached = (read as { hasAttachments?: unknown } | null)?.hasAttachments === true;
      return { draftLink: link, text: attached ? null : draftWordsOf(read) };
    }
    const whole = await conversationMessages(mailbox, draft.conversationId, await foldersOf(mailbox, deletedItems));
    return sentSince(whole, draft.after) ? { sent: true } : null;
  } catch (error) {
    throw inTheirWords(error, 'Outlook could not look for the draft');
  }
}

/** The newest message of yours in a conversation after `after` - every one where `after` is null: what tells a draft sent from one deleted. */
function sentSince(whole: readonly MailTurn[], after: string | null): MailTurn | undefined {
  const since = after === null ? Number.NEGATIVE_INFINITY : Date.parse(after);
  return whole.filter((one) => one.by === 'you' && Date.parse(one.at) > since).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
}

/**
 * Where a draft opens, read as `messages/{id}` answers it, while it is a draft
 * outside Deleted Items - or null for one sent, or deleted unsent.
 */
export function draftStillThere(answer: unknown, deletedItems: string): string | null {
  const { id, isDraft, parentFolderId, webLink } = (answer ?? {}) as Record<string, unknown>;
  if (typeof id !== 'string' || !id || isDraft !== true || parentFolderId === deletedItems) return null;
  return linkOf(id, webLink);
}

/** Where Outlook on the web opens a message: its `webLink`, else the deep link to its id. */
function linkOf(id: string, webLink: unknown): string {
  return typeof webLink === 'string' && webLink ? webLink : `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(id)}`;
}

/**
 * Why the draft was not made, in words for the person: what they can do about a
 * lost sign-in, and Outlook's status otherwise - never the request's address.
 */
function inTheirWords(error: unknown, otherwise = 'Outlook could not make the draft'): Error {
  if (error instanceof SignInLost) return new SourceError(error.message);
  if (error instanceof Refused) return new SourceError(`Outlook refused the draft (${error.status})`, error.status);
  if (error instanceof Changed) return new SourceError('Outlook could not make the draft this time. Try again in a moment.', error.status);
  if (error instanceof NotAnswering) return new SourceError('Outlook did not answer. Try again in a moment.', error.status);
  if (error instanceof OutOfCalls) return new SourceError('Outlook could not be asked this time. Try again in a moment.');
  if (error instanceof SourceError) return error;
  return new SourceError(otherwise);
}

/**
 * The drafts *Email…* made that open Items still wait on, asked once the turns
 * of a run are reported, so a draft sent and read as a turn this run is no
 * longer among them. **One read of each draft a run while it is unsent**:
 * still a draft outside Deleted Items, it changes nothing. Otherwise it was
 * sent (it is a message now, or Graph no longer knows its id) or deleted
 * (moved to Deleted Items): the conversation is read, and a message in Sent
 * Items after the draft's `after` is your turn, reported here since the read of
 * received mail may never have shown it (sent while the Item was done, or
 * before the cursor); none, and the draft is reported gone.
 */
export async function checkDrafts(
  host: ConnectorHost,
  mailbox: Mailbox,
  deletedItems: string,
  foldersNow: () => Promise<Folders>,
): Promise<void> {
  for (const draft of await host.draftsWaiting()) {
    const read = (await mailbox.get(`messages/${encodeURIComponent(draft.draftId)}?$select=id,isDraft,parentFolderId`)) as {
      isDraft?: unknown;
      parentFolderId?: unknown;
    } | null;
    if (draftStillThere(read, deletedItems) !== null) continue;
    const sent = sentSince(await conversationMessages(mailbox, draft.conversationId, await foldersNow()), draft.after);
    if (sent) {
      await host.reportTurn({
        conversationId: sent.conversationId,
        messageId: sent.messageId,
        by: sent.by,
        from: sent.from,
        at: sent.at,
        excerpt: sent.excerpt,
        ...(sent.link ? { link: sent.link } : {}),
      });
    } else {
      await host.reportDraftGone({ conversationId: draft.conversationId, draftId: draft.draftId });
    }
  }
}
