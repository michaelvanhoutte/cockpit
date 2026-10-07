import type { Env } from '../env.js';
import { endpointsFor, gmailIssuerFor } from '../auth/issuer.js';
import { enqueueCleanUp, enqueueReadingItsMeaning } from '../jobs/enrichment.js';
import { open, seal, sealingKey, type Sealed } from './credential-crypto.js';
import {
  cockpitLabelIn,
  conversationFrom,
  conversationPage,
  credentialRefreshed,
  historyPage,
  gmailCredentialIn,
  labelChange,
  labelChangeRefusal,
  STARRED,
  stillLabelled,
  usableAccessToken,
  type GmailConversation,
  type GmailCredential,
} from './gmail.js';
import { derivedUuid } from './push-host.js';
import type { OpenStateWanted } from '@cockpit/connector-sdk';
import type { GmailMark } from '@cockpit/shared';
import type { AppliedSourceChange } from '../accounts/source-state.js';

/**
 * Checking an account's Gmail connections, which its store's alarm does every
 * five minutes while it holds one ("Bring in the conversations already
 * labelled Cockpit as tasks", issue 725).
 *
 * **The I/O half, and only that.** What a conversation brings in, which
 * label is Cockpit's and what a refresh leaves sealed are decided in
 * `gmail.ts` and proved at L1; what this does with Gmail and the store is
 * proved through the store's own alarm at L2, with Gmail faked at the
 * network boundary (tests/integration/http/gmail-import.test.ts).
 *
 * **A full reconcile, here creating only**: the history position is recorded
 * first, for the history reads below to start from, then the labelled conversations are
 * listed a page at a time - each page's new conversations read and brought
 * in before the next page is asked for, and the page persisted only once all
 * of them are. So a run that stops resumes at the page it stopped in, and a
 * conversation already brought in is found again by its link rather than
 * read again.
 *
 * **Then history** ("Bring in a conversation within five minutes of labelling
 * it Cockpit", issue 726): once a listing is complete, each run asks Gmail
 * what changed since the stored position, and a position Gmail no longer
 * keeps starts the full reconcile over.
 *
 * **And closing** ("Close a Gmail task when its label comes off, and reopen it
 * when it goes back", issue 727): a conversation whose label comes off, or
 * whose mail is binned or deleted, has its Item marked done, and one labelled
 * again is reopened, through the host's source-state change. The full
 * reconcile does the same once its listing is complete; it runs on
 * connecting, on a lapsed position, and nightly.
 *
 * **And the other way** ("Take the Cockpit label off in Gmail when its task
 * is done in Cockpit", issue 728): before anything is read, each run takes
 * the label off the conversations whose Items a person marked done or
 * dismissed, and puts it back on those reopened, until Gmail confirms each.
 *
 * **Or by star** ("Connect Gmail by star, and bring in conversations starred
 * from then on", issue 822): a connection following the star brings in only
 * what its history says was starred after the position recorded on connecting
 * (`bringInStarred`) - and keeps each Item in step with its star both ways,
 * as the label's are ("Keep a starred Gmail task in step with its star, both
 * ways", issue 823), its full reconcile listing what is starred only to close.
 */

/**
 * How many calls one run may make. The Workers free plan allows 50 outbound
 * requests per invocation, an alarm's included; this leaves room for the
 * issuer's discovery document and the queue sends beside them.
 */
export const CALLS_PER_RUN = 40;

/**
 * How many labelled conversations Gmail is asked for at a time: about what one
 * run can read, so a page is rarely listed twice, and well under Gmail's own
 * ceiling of 500.
 */
const PAGE_SIZE = 50;

/** How many history records Gmail is asked for at a time (its ceiling is 500). */
const HISTORY_PAGE_SIZE = 100;

/**
 * The most conversations one history page may name and still be read from
 * the history; a page naming more is left to the full reconcile, which pages
 * through the same work. Leaves a run's other calls room beside them: the
 * label, the history page, and a refresh.
 */
const CHANGED_PER_HISTORY_PAGE = 30;

/** What the account row says while a connection cannot be checked - after "Failing:". */
export const NO_LABEL =
  'there is no label called Cockpit in this account. Create it in Gmail, and label the conversations to bring in.';
export const SIGN_IN_REFUSED = 'Google no longer accepts the sign-in. Connect again.';

/** One Gmail connection of the account, as the store holds it. */
export interface GmailConnectionToCheck {
  readonly id: string;
  readonly workspaceId: string;
  /** Google's own name for the mailbox (`external_account_key`). */
  readonly mailboxKey: string;
  /** The mailbox's address, which is what the row is called. */
  readonly address: string;
  /** The one mark it follows: the label called Cockpit, or the star (issue 822). */
  readonly follows: GmailMark;
  readonly sealed: Sealed;
}

/** Where bringing in one connection's conversations has got to (`gmail_checks`). */
export interface GmailProgress {
  readonly historyId: string;
  readonly pageToken: string | null;
  /** When the current full reconcile started, which is what names it. */
  readonly startedAt: string;
  readonly listedAt: string | null;
}

/** What the store does for a check: everything it reads and writes, synchronously, and nothing else. */
export interface GmailCheckHost {
  readonly accountName: string;
  connections(): GmailConnectionToCheck[];
  progress(sourceAccountId: string): GmailProgress | null;
  /** A reconcile beginning, at this history position. */
  startListing(sourceAccountId: string, historyId: string, at: string): void;
  /** One page done: the next one to ask for, or the listing finished. */
  pageListed(sourceAccountId: string, nextPageToken: string | null, at: string): void;
  /**
   * One history page's conversations are in: the position the next read starts
   * from, and the page to continue at - null once the last page is done, when
   * the position is the new one.
   */
  historyPageRead(sourceAccountId: string, historyId: string, nextPageToken: string | null): void;
  /** Which of these conversations this mailbox has already brought into this Workspace. */
  alreadyBroughtIn(workspaceId: string, mailboxKey: string, threadIds: readonly string[]): Set<string>;
  /**
   * Makes the conversation's Item and links them - unless the connection has
   * gone since the run read it. Answers whether the link was written now,
   * which is what owes the Item its clean-up.
   */
  bringIn(
    connection: GmailConnectionToCheck,
    conversation: GmailConversation,
    ids: { itemId: string; commandId: string },
    at: string,
  ): 'linked' | 'already linked' | 'disconnected';
  /**
   * Gmail says these brought-in conversations are labelled (`reopened`) or
   * not (`resolved`): their Items made open and undismissed, or done, where
   * they are not already - and a labelled one noted as found by the current
   * full reconcile. Conversations never brought in are passed over. Answers
   * how many Items changed, or that the connection has gone since the run
   * read it.
   */
  sourceChanged(
    connection: GmailConnectionToCheck,
    threadIds: readonly string[],
    change: AppliedSourceChange,
    at: string,
  ): number | 'disconnected';
  /**
   * Once the full reconcile's listing is complete, up to `limit` brought-in
   * conversations it did not find whose Items are open - each to be read
   * before it is marked done. None while the listing is still going.
   */
  unconfirmed(connection: GmailConnectionToCheck, limit: number): string[];
  /**
   * Up to `limit` brought-in conversations whose label Cockpit wants changed
   * and Gmail has not confirmed - each with whether it should be labelled.
   */
  waitingForGmail(connection: GmailConnectionToCheck, limit: number): OpenStateWanted[];
  /**
   * Gmail holds the conversation labelled as wanted: nothing is waiting for
   * it any more - unless the Item changed again meanwhile, whose own change
   * still is. Answers that the connection has gone since the run read it.
   */
  gmailConfirmed(connection: GmailConnectionToCheck, confirmed: OpenStateWanted): 'confirmed' | 'disconnected';
  /**
   * Gmail will never take this change: it stops waiting, as a confirmed one
   * does - under the same proviso - so it holds up nothing else.
   */
  gmailRefused(connection: GmailConnectionToCheck, refused: OpenStateWanted): 'dropped' | 'disconnected';
  /**
   * The connection's credential, sealed again around a refreshed access token
   * - only where it still holds `was`, so a reconnect made meanwhile keeps its
   * own. Answers whether it did.
   */
  reseal(sourceAccountId: string, was: Sealed, sealed: Sealed): boolean;
  /** The connection was checked: it reads "last checked" and nothing says it is failing. */
  checked(sourceAccountId: string, at: string): void;
  /** The connection cannot be checked, and why. */
  failing(sourceAccountId: string, reason: string, at: string): void;
}

/** Google refused the sign-in: nothing will work until it is connected again. */
class SignInRefused extends Error {}
/** Gmail or Google did not answer usefully this time - a 5xx, a rate limit, the network. */
class NotAnswering extends Error {}
/** Gmail holding the mailbox back for now - a rate limit - so a change it was asked for waits for the next run. */
class HeldBack extends NotAnswering {}
/** Gmail refusing a change in a way asking again will not alter; `status` is what it answered. */
class ChangeRefused extends Error {
  constructor(readonly status: number) {
    super(`Gmail refused the change: ${status}`);
  }
}
/** The run's calls are spent; what is left is the next run's. */
class OutOfCalls extends Error {}
/** The connection was disconnected or connected again while the run was reading it; the next run reads it afresh. */
class ConnectionChanged extends Error {}

/**
 * Checks every Gmail connection the account holds, as far as one run's calls
 * go - and answers whether there is more to do than this run reached, so the
 * alarm can come back sooner than five minutes.
 */
export async function checkGmail(env: Env, host: GmailCheckHost, now: Date): Promise<{ moreToDo: boolean }> {
  const connections = host.connections();
  if (connections.length === 0) return { moreToDo: false };
  const clientId = env.GMAIL_CLIENT_ID?.trim();
  const clientSecret = env.GMAIL_CLIENT_SECRET?.trim();
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  if (!clientId || !clientSecret || !key) {
    logged('error', 'Gmail connections were not checked: this environment cannot connect Gmail');
    return { moreToDo: false };
  }

  const calls = { left: CALLS_PER_RUN };
  const broughtIn: string[] = [];
  let moreToDo = false;
  for (const connection of connections) {
    // The fewest one check can make: the label, then a page - or by star, a
    // history page and a conversation.
    if (calls.left < 3) {
      moreToDo = true;
      break;
    }
    const at = now.toISOString();
    try {
      const opened = await open(connection.sealed, key);
      const credential = opened === null ? null : gmailCredentialIn(opened);
      if (!credential) throw new SignInRefused('the sign-in could not be read');
      let held = connection.sealed;
      const mailbox = new Mailbox(env, { clientId, clientSecret }, credential, now, calls, async (refreshed) => {
        const sealed = await seal(JSON.stringify(refreshed), key);
        if (!host.reseal(connection.id, held, sealed)) throw new ConnectionChanged('the sign-in was replaced');
        held = sealed;
      });
      const reached =
        connection.follows === 'star'
          ? await bringInStarred(host, connection, mailbox, at, broughtIn)
          : await bringInLabelled(host, connection, mailbox, at, broughtIn);
      if (reached === 'no label') {
        host.failing(connection.id, NO_LABEL, at);
        continue;
      }
      host.checked(connection.id, at);
    } catch (error) {
      if (error instanceof SignInRefused) {
        host.failing(connection.id, SIGN_IN_REFUSED, at);
      } else if (error instanceof OutOfCalls) {
        moreToDo = true;
        host.checked(connection.id, at);
      } else if (error instanceof ConnectionChanged) {
        // Disconnected, or connected again - which arms a check of its own.
        continue;
      } else {
        // Nothing is changed and nothing said: the next run tries again.
        logged('warn', 'a Gmail connection could not be checked this time', {
          sourceAccountId: connection.id,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // The clean-up every captured Item gets, once the run's own writes are done.
  for (const itemId of broughtIn) {
    await enqueueCleanUp(env, host.accountName, itemId);
    await enqueueReadingItsMeaning(env, host.accountName, itemId);
  }
  return { moreToDo };
}

/**
 * Brings in what is labelled and not yet in: the full reconcile where the
 * connection has none finished - or has just found its history position
 * lapsed - and otherwise what Gmail's history says changed since.
 */
async function bringInLabelled(
  host: GmailCheckHost,
  connection: GmailConnectionToCheck,
  mailbox: Mailbox,
  at: string,
  broughtIn: string[],
): Promise<'no label' | 'done'> {
  const labelId = cockpitLabelIn(await mailbox.get('labels'));
  if (!labelId) return 'no label';

  // Cockpit's own changes first, so what the history then reports of them
  // agrees with the Items and changes nothing.
  await pushWhatIsWanted(host, connection, mailbox, labelId);

  let progress = host.progress(connection.id);
  if (progress?.listedAt) {
    if ((await readHistory(host, connection, mailbox, labelId, progress, at, broughtIn)) === 'caught up') {
      // Whatever closing the last complete listing left for want of calls.
      await closeUnlisted(host, connection, mailbox, labelId, at);
      return 'done';
    }
    // The position has lapsed, or changed more than a run can read: the full
    // reconcile, from a fresh one.
  }

  if (!progress || progress.listedAt) {
    // The position first, so whatever is labelled while the listing runs is
    // after it, and the next slice's history reads it.
    host.startListing(connection.id, await positionNow(mailbox), at);
    progress = host.progress(connection.id)!;
  }

  while (!progress.listedAt) {
    const query = new URLSearchParams({ labelIds: labelId, maxResults: String(PAGE_SIZE) });
    if (progress.pageToken) query.set('pageToken', progress.pageToken);
    const page = conversationPage(await mailbox.get(`threads?${query}`));
    await bringInThreads(host, connection, mailbox, labelId, page.threadIds, at, broughtIn);
    // Listed is labelled: an Item done or dismissed is open again, and every
    // one is noted as found, which is what keeps it from being closed below.
    if (host.sourceChanged(connection, page.threadIds, 'reopened', at) === 'disconnected') {
      throw new ConnectionChanged('the connection was disconnected');
    }
    host.pageListed(connection.id, page.nextPageToken, at);
    const next = host.progress(connection.id);
    // Gone: connected again meanwhile, which starts the listing over.
    if (!next) throw new ConnectionChanged('the listing was started again');
    progress = next;
  }
  await closeUnlisted(host, connection, mailbox, labelId, at);
  return 'done';
}

/**
 * Brings in what is starred after the connection was made ("Connect Gmail by
 * star, and bring in conversations starred from then on", issue 822) - from
 * Gmail's history alone, never from a listing, because Gmail records that a
 * conversation is starred but never when - and keeps every Item it brought in
 * open exactly while its conversation is starred ("Keep a starred Gmail task
 * in step with its star, both ways", issue 823).
 *
 * **A position recorded is where the star starts counting.** With none yet -
 * just connected, or connected again - a fresh one is recorded and nothing is
 * listed: whatever was starred before it stays out. An Item it brought in
 * before is read before it is marked done.
 *
 * **The full reconcile lists what is starred only to close**: on a position
 * Gmail no longer keeps, and nightly, the starred conversations are listed a
 * page at a time - an Item done or dismissed whose conversation is starred
 * opened again, and none made - and only once the listing is complete is an
 * open Item it did not find read, and marked done where it is not starred.
 *
 * **Nothing is asked of the labels**, so a mailbox with no label called
 * Cockpit never fails a star connection.
 */
async function bringInStarred(
  host: GmailCheckHost,
  connection: GmailConnectionToCheck,
  mailbox: Mailbox,
  at: string,
  broughtIn: string[],
): Promise<'done'> {
  // Cockpit's own changes first, so what the history then reports of them
  // agrees with the Items and changes nothing.
  await pushWhatIsWanted(host, connection, mailbox, STARRED);

  let progress = host.progress(connection.id);
  if (!progress) {
    host.startListing(connection.id, await positionNow(mailbox), at);
    host.pageListed(connection.id, null, at);
    await closeUnlisted(host, connection, mailbox, STARRED, at);
    return 'done';
  }
  if (progress.listedAt) {
    if ((await readHistory(host, connection, mailbox, STARRED, progress, at, broughtIn)) === 'caught up') {
      await closeUnlisted(host, connection, mailbox, STARRED, at);
      return 'done';
    }
    // Lapsed: the full reconcile, from a fresh position.
    host.startListing(connection.id, await positionNow(mailbox), at);
    progress = host.progress(connection.id);
    if (!progress) throw new ConnectionChanged('the connection was disconnected');
  }

  while (!progress.listedAt) {
    const query = new URLSearchParams({ labelIds: STARRED, maxResults: String(PAGE_SIZE) });
    if (progress.pageToken) query.set('pageToken', progress.pageToken);
    const page = conversationPage(await mailbox.get(`threads?${query}`));
    // Listed is starred: an Item done or dismissed is open again, and every
    // one is noted as found. Nothing is brought in.
    if (host.sourceChanged(connection, page.threadIds, 'reopened', at) === 'disconnected') {
      throw new ConnectionChanged('the connection was disconnected');
    }
    host.pageListed(connection.id, page.nextPageToken, at);
    const next = host.progress(connection.id);
    if (!next) throw new ConnectionChanged('the listing was started again');
    progress = next;
  }
  await closeUnlisted(host, connection, mailbox, STARRED, at);
  return 'done';
}

/** The mailbox's history position now: what the next history read starts from. */
async function positionNow(mailbox: Mailbox): Promise<string> {
  const profile = (await mailbox.get('profile')) as { historyId?: unknown } | null;
  const historyId = profile?.historyId;
  if (typeof historyId !== 'string' && typeof historyId !== 'number') {
    throw new NotAnswering('Gmail gave no history position');
  }
  return String(historyId);
}

/**
 * Puts the label on, or takes it off, each conversation whose Item a person
 * opened or closed in Cockpit ("Take the Cockpit label off in Gmail when its
 * task is done in Cockpit", issue 728) - the `Cockpit` label alone, on the
 * whole conversation, and nothing else of the mailbox. By star, the star
 * alone, likewise ("Keep a starred Gmail task in step with its star, both
 * ways", issue 823): `markId` is whichever the connection follows.
 *
 * **Confirmed only once Gmail has answered**, so a run that stops between the
 * call and the record pushes it again, which changes nothing at Gmail. A
 * conversation that is gone has nothing left to label, and counts as
 * confirmed. Gmail not answering leaves the rest waiting for the next run,
 * which comes back to them before anything else; a rate limit does too, and
 * the run reads on.
 *
 * **One Gmail will never take is dropped, and logged**, rather than asked
 * again first on every run, where it would stop the check of everything else
 * the mailbox holds. The log names the connection and Gmail's answer alone.
 */
async function pushWhatIsWanted(
  host: GmailCheckHost,
  connection: GmailConnectionToCheck,
  mailbox: Mailbox,
  markId: string,
): Promise<void> {
  for (const wanted of host.waitingForGmail(connection, CALLS_PER_RUN)) {
    let settled: 'confirmed' | 'dropped' | 'disconnected';
    try {
      await mailbox.post(`threads/${encodeURIComponent(wanted.sourceId)}/modify`, labelChange(markId, wanted.open));
      settled = host.gmailConfirmed(connection, wanted);
    } catch (error) {
      if (error instanceof HeldBack) return;
      if (!(error instanceof ChangeRefused)) throw error;
      logged('warn', 'Gmail refused a label change, which is no longer asked of it', {
        sourceAccountId: connection.id,
        follows: connection.follows,
        status: error.status,
      });
      settled = host.gmailRefused(connection, wanted);
    }
    if (settled === 'disconnected') throw new ConnectionChanged('the connection was disconnected');
  }
}

/**
 * Marks done the open Items whose conversations a complete listing did not
 * find ("Close a Gmail task when its label comes off, and reopen it when it
 * goes back", issue 727) - each read first, so a conversation the listing
 * missed by moving between its pages, as a new reply moves it, stays open.
 * Gone, in the bin or no longer labelled is done. A run that stops part-way
 * leaves the rest for the next, which asks the store again after its history
 * read.
 *
 * **Only after a complete, successful listing**: `unconfirmed` names nothing
 * while it is still going, and a mailbox with no label called Cockpit never
 * gets here. By star, a fresh position counts as a listing that found
 * nothing, so every open Item is read once before any is marked done
 * (`bringInStarred`). Recovery after a long outage can close many at once,
 * which is logged with the count.
 */
async function closeUnlisted(
  host: GmailCheckHost,
  connection: GmailConnectionToCheck,
  mailbox: Mailbox,
  labelId: string,
  at: string,
): Promise<void> {
  let closed = 0;
  try {
    for (const threadId of host.unconfirmed(connection, CALLS_PER_RUN)) {
      const labelled = await stillThere(mailbox, threadId, labelId);
      const changed = host.sourceChanged(connection, [threadId], labelled ? 'reopened' : 'resolved', at);
      if (changed === 'disconnected') throw new ConnectionChanged('the connection was disconnected');
      if (!labelled) closed += changed;
    }
  } finally {
    if (closed > 0) {
      logged('info', 'marked done the Items of conversations no longer carrying the mark followed', {
        sourceAccountId: connection.id,
        follows: connection.follows,
        count: closed,
      });
    }
  }
}

/**
 * Brings each of these brought-in conversations' Items into step with whether
 * the conversation is labelled now: done where it is not, open and
 * undismissed where it is.
 */
async function settleThreads(
  host: GmailCheckHost,
  connection: GmailConnectionToCheck,
  mailbox: Mailbox,
  labelId: string,
  broughtInIds: readonly string[],
  at: string,
): Promise<void> {
  for (const threadId of broughtInIds) {
    const labelled = await stillThere(mailbox, threadId, labelId);
    const changed = host.sourceChanged(connection, [threadId], labelled ? 'reopened' : 'resolved', at);
    if (changed === 'disconnected') throw new ConnectionChanged('the connection was disconnected');
  }
}

/** Whether the conversation is still there and labelled - not deleted, not in the bin or spam. */
async function stillThere(mailbox: Mailbox, threadId: string, labelId: string): Promise<boolean> {
  const thread = await mailbox.get(`threads/${encodeURIComponent(threadId)}?format=minimal`);
  return thread !== null && stillLabelled(thread, labelId);
}

/**
 * Reads Gmail's history from the stored position a page at a time, bringing in
 * the conversations that gained the label ("Bring in a conversation within
 * five minutes of labelling it Cockpit", issue 726). The position moves only
 * once the last page's conversations are in, so a run that stops reads them
 * again and finds each one by its link. Gmail answers 404 for a position it no
 * longer keeps, after about a week: that is `lapsed`, and the caller starts the
 * full reconcile, which records a fresh one - as it does for a page naming more
 * conversations than a run can read.
 *
 * **By star, a page is never left to lapse as too long** (issue 822): its
 * pages are no longer than one run's calls can read, so a run that stops
 * part-way reads the page again and finds what it brought in by its link,
 * where a fresh position would miss the stars on it, which no listing finds
 * again. Only the conversations it has Items for are read to settle them
 * (issue 823); a page needing more reads than a run can make still brings in
 * what gained the star, and leaves settling the rest to the nightly listing.
 */
async function readHistory(
  host: GmailCheckHost,
  connection: GmailConnectionToCheck,
  mailbox: Mailbox,
  labelId: string,
  from: GmailProgress,
  at: string,
  broughtIn: string[],
): Promise<'caught up' | 'lapsed'> {
  const byLabel = connection.follows === 'label';
  const pageSize = byLabel ? HISTORY_PAGE_SIZE : CHANGED_PER_HISTORY_PAGE;
  let progress = from;
  for (;;) {
    const query = new URLSearchParams({ startHistoryId: progress.historyId, labelId, maxResults: String(pageSize) });
    for (const type of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) query.append('historyTypes', type);
    if (progress.pageToken) query.set('pageToken', progress.pageToken);
    const answer = await mailbox.get(`history?${query}`);
    if (answer === null) return 'lapsed';
    const page = historyPage(answer, labelId);
    const known = host.alreadyBroughtIn(connection.workspaceId, connection.mailboxKey, page.changed);
    const settling = page.changed.filter((id) => known.has(id));
    // Each conversation read costs a call, and a run that stops reads the page
    // again from its first: past what one run can read, it never ends. By
    // label, every one named may be read; by star, only those with an Item to
    // settle, and those gaining the star without one.
    const reads = byLabel ? page.changed.length : settling.length + page.gained.filter((id) => !known.has(id)).length;
    if (reads <= CHANGED_PER_HISTORY_PAGE) {
      await settleThreads(host, connection, mailbox, labelId, settling, at);
    } else if (byLabel) {
      return 'lapsed';
    }
    await bringInThreads(host, connection, mailbox, labelId, page.gained, at, broughtIn);
    if (page.nextPageToken) {
      host.historyPageRead(connection.id, progress.historyId, page.nextPageToken);
    } else {
      if (page.historyId === null) throw new NotAnswering('Gmail gave no history position');
      host.historyPageRead(connection.id, page.historyId, null);
    }
    const next = host.progress(connection.id);
    // Gone, or the nightly sweep started the listing over meanwhile.
    if (!next?.listedAt) throw new ConnectionChanged('the listing was started again');
    if (!page.nextPageToken) return 'caught up';
    progress = next;
  }
}

/** Reads each of these conversations not yet brought in, and brings it in. */
async function bringInThreads(
  host: GmailCheckHost,
  connection: GmailConnectionToCheck,
  mailbox: Mailbox,
  labelId: string,
  threadIds: readonly string[],
  at: string,
  broughtIn: string[],
): Promise<void> {
  const known = host.alreadyBroughtIn(connection.workspaceId, connection.mailboxKey, threadIds);
  for (const threadId of threadIds.filter((id) => !known.has(id))) {
    const thread = await mailbox.get(`threads/${encodeURIComponent(threadId)}?format=full`);
    // Gone between the listing and the read - deleted, or no longer there to
    // read - or no longer labelled by the time it is read, is nothing to bring in.
    if (thread === null || !stillLabelled(thread, labelId)) continue;
    const conversation = conversationFrom(thread, labelId, connection.address);
    if (!conversation) continue;
    const named = `gmail:${connection.workspaceId}:${connection.mailboxKey}:${threadId}`;
    const ids = { itemId: await derivedUuid(`item:${named}`), commandId: await derivedUuid(`capture:${named}`) };
    const linked = host.bringIn(connection, conversation, ids, at);
    if (linked === 'disconnected') throw new ConnectionChanged('the connection was disconnected');
    if (linked === 'linked') broughtIn.push(ids.itemId);
  }
}

/**
 * One mailbox, reached with its access token - refreshed where the cached one
 * has lapsed or Gmail refuses it, and sealed again before it is used, so a run
 * that stops after a refresh leaves the old token in place or the new one,
 * never neither.
 */
class Mailbox {
  #token: string | null;

  constructor(
    private readonly env: Env,
    private readonly client: { clientId: string; clientSecret: string },
    private credential: GmailCredential,
    private readonly now: Date,
    private readonly calls: { left: number },
    private readonly keep: (refreshed: GmailCredential) => Promise<void>,
  ) {
    this.#token = usableAccessToken(credential, now);
  }

  /** One read of Gmail's API, or null where what it names is not there. */
  get(path: string): Promise<unknown> {
    return this.#ask(path);
  }

  /** One change through Gmail's API - its answer, or null where what it names is not there. */
  post(path: string, body: unknown): Promise<unknown> {
    return this.#ask(path, body);
  }

  async #ask(path: string, body?: unknown): Promise<unknown> {
    const token = this.#token ?? (await this.#refresh());
    let response = await this.#call(path, token, body);
    if (response.status === 401) {
      // A token Google has stopped accepting early is refreshed once; a
      // second refusal is the sign-in's.
      response = await this.#call(path, await this.#refresh(), body);
      if (response.status === 401) throw new SignInRefused('Gmail refused a fresh access token');
    }
    if (response.status === 404) return null;
    if (!response.ok && body !== undefined && response.status < 500) {
      const refusal = labelChangeRefusal(response.status, await response.json().catch(() => null));
      if (refusal === 'never') throw new ChangeRefused(response.status);
      throw new HeldBack(`Gmail answered ${response.status} to a change`);
    }
    if (!response.ok) throw new NotAnswering(`Gmail answered ${response.status} to ${path.split('?')[0]}`);
    return response.json();
  }

  async #call(path: string, token: string, body?: unknown): Promise<Response> {
    this.#spend();
    const origin = this.env.GMAIL_API_ORIGIN?.trim() || 'https://gmail.googleapis.com';
    try {
      return await fetch(
        `${origin}/gmail/v1/users/me/${path}`,
        body === undefined
          ? { headers: { authorization: `Bearer ${token}` } }
          : {
              method: 'POST',
              headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
              body: JSON.stringify(body),
            },
      );
    } catch (error) {
      throw new NotAnswering(error instanceof Error ? error.message : String(error));
    }
  }

  async #refresh(): Promise<string> {
    this.#spend();
    let response: Response;
    try {
      const { tokenEndpoint } = await endpointsFor(gmailIssuerFor(this.env));
      response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.credential.refreshToken,
          client_id: this.client.clientId,
          client_secret: this.client.clientSecret,
        }),
      });
    } catch (error) {
      throw new NotAnswering(error instanceof Error ? error.message : String(error));
    }
    // A refresh token revoked, expired or for another client is answered
    // 400 or 401 (`invalid_grant`, `invalid_client`); anything else is Google
    // not answering this time.
    if (response.status === 400 || response.status === 401) {
      throw new SignInRefused(`Google refused to refresh the sign-in: ${response.status}`);
    }
    if (!response.ok) throw new NotAnswering(`Google answered ${response.status} to a refresh`);
    const refreshed = credentialRefreshed(this.credential, await response.json().catch(() => null), this.now);
    if (!refreshed) throw new NotAnswering('Google answered a refresh with no access token');
    await this.keep(refreshed);
    this.credential = refreshed;
    this.#token = refreshed.accessToken;
    return refreshed.accessToken!;
  }

  #spend(): void {
    if (this.calls.left <= 0) throw new OutOfCalls();
    this.calls.left -= 1;
  }
}

function logged(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
  const line = JSON.stringify({ level, connector: 'gmail', message, data });
  if (level === 'error') console.error(line);
  else console.log(line);
}
