import { SourceError, type ConnectorHost, type DraftFound, type DraftMade, type DraftWaiting, type DraftWanted, type OnDemandHost } from '@cockpit/connector-sdk';
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
import { TITLE_LENGTH, cutTo, deletedItemsIn, oneLine, type MailTurn } from './messages.js';

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
    let answer: unknown;
    if (wanted.replyIn === null) {
      const subject = cutTo(oneLine(wanted.subject), TITLE_LENGTH);
      answer = await mailbox.post('messages', { subject, body: { contentType: 'text', content: '' } });
    } else {
      const latest = await latestIn(mailbox, wanted.replyIn);
      if (!latest) throw new SourceError('the conversation is no longer in Outlook');
      answer = await mailbox.post(`messages/${encodeURIComponent(latest)}/createReply`, {});
      if (answer === null) throw new SourceError('the conversation is no longer in Outlook');
    }
    const made = draftIn(answer);
    if (!made) throw new SourceError('Outlook answered without the draft it made');
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
export async function findOutlookDraft(host: OnDemandHost, config: OutlookConnectorConfig, draft: DraftWaiting): Promise<DraftFound | null> {
  try {
    const credential = credentialIn(await host.getCredentials());
    if (!credential) throw new SignInLost(SIGN_IN_UNREADABLE);
    const mailbox = new Mailbox(host, config, credential, { left: CALLS_PER_LOOK });
    const read = await mailbox.get(`messages/${encodeURIComponent(draft.draftId)}?$select=${DRAFT_FIELDS}`);
    const deletedItems = deletedItemsIn(await mailbox.get('mailFolders/deleteditems?$select=id'));
    if (!deletedItems) throw new SourceError('Outlook gave no Deleted Items folder for this mailbox');
    const link = draftStillThere(read, deletedItems);
    if (link !== null) return { draftLink: link };
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
