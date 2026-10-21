import type { ConnectorHost, MirroredOpenStates, OpenStateWanted, SyncAnswer } from '@cockpit/connector-sdk';
import {
  ChangeRefused,
  NotAnswering,
  OutOfCalls,
  mailboxOf,
  type GmailConnectorConfig,
  type Mailbox,
} from './mailbox.js';
import {
  STARRED,
  cockpitLabelIn,
  conversationFrom,
  conversationPage,
  emailFrom,
  emailHistoryPage,
  emailIdIn,
  emailIn,
  emailMarked,
  emailPage,
  emailSourceId,
  historyPage,
  labelChange,
  namesOf,
  namesOfEmail,
  stillMarked,
  userLabelsIn,
  type EmailChanges,
} from './messages.js';

/**
 * A run of Gmail, in the order it must go (the quirks behind each step are in
 * the package README):
 *
 * 1. **Waiting open states are pushed first** (`mirrorOpenStates`), so what the
 *    history then reports of them agrees with the Items and changes nothing.
 * 2. **A complete listing where there is no position to read from** - first
 *    run, a position Gmail no longer keeps, or a changed choice - recorded
 *    position first, so whatever is marked while the listing runs is after it.
 * 3. **Then the history since the saved position**, a page at a time.
 *
 * A connection following the label brings in a conversation as an Item. One
 * following the star brings in each email starred as an Item of its own - a
 * star belongs to one email - and keeps closing the conversation Items it
 * brought in before that, which are never reopened.
 *
 * A run that reaches its call budget saves where it was and answers that there
 * is more to do; the next run resumes inside the page it stopped in.
 */

/** How many labelled conversations Gmail is asked for at a time: about what one run can read. */
const PAGE_SIZE = 50;

/**
 * How many starred emails a listing asks for at a time. A listing by star
 * reads nothing but the ids, so a page costs one call whatever its size; 500 is
 * Gmail's ceiling.
 */
const STAR_PAGE_SIZE = 500;

/**
 * What the saved state's `history.done` means. Raised when it changes meaning
 * - from conversations of a page done to conversations grouping the emails of
 * a page done - so a place saved under the old one is read again from the
 * page's start, which is safe because everything emitted is idempotent.
 */
const STATE_VERSION = 2;

/** How many history records Gmail is asked for at a time (its ceiling is 500). */
const HISTORY_PAGE_SIZE = 100;

/** What the connection says while its mailbox has no label called Cockpit. */
export const NO_LABEL =
  'there is no label called Cockpit in this account. Create it in Gmail, and label the conversations to bring in.';

/** The choice a connection that holds none follows. */
const DEFAULT_CHOICE = 'label';

/**
 * Where bringing in one connection's conversations has got to: this connector's
 * private state, kept by the host as an opaque blob.
 *
 * `historyId` is the position history is read from, null while there is none;
 * `history` and `listing` each hold a place inside a page - the token that asks
 * for it and how many of its conversations are already done - so a run that
 * stops part-way never starts the page over, which a page larger than one
 * run's budget would otherwise never finish.
 */
export interface GmailState {
  /** What `done` counts (`STATE_VERSION`); a place saved under another is read again from its page's start. */
  readonly version: number;
  /** The choice this was kept under; a connection now following another starts over. */
  readonly choice: string;
  /** The mailbox's address, which is what a conversation's link names. */
  address: string | null;
  historyId: string | null;
  history: { pageToken: string | null; done: number };
  /** The complete listing under way, or null when none is. */
  listing: {
    pageToken: string | null;
    done: number;
    /** Every source id the listing has seen so far: a conversation's by label, an email's and its conversation's by star. */
    seen: string[];
    /** Every page is read: the last of it is to be reported. */
    listed: boolean;
  } | null;
}

function freshListing(): NonNullable<GmailState['listing']> {
  return { pageToken: null, done: 0, seen: [], listed: false };
}

function freshState(choice: string, address: string | null = null): GmailState {
  return { version: STATE_VERSION, choice, address, historyId: null, history: { pageToken: null, done: 0 }, listing: null };
}

/**
 * The saved state, read - or a fresh one where there is none, it is unreadable,
 * or it was kept under another choice. One kept under an older `version` keeps
 * its position and the token of its page, but is read from that page's start;
 * a listing by star that was under way is listed again, its token having asked
 * Gmail for conversations and not emails.
 */
export function stateIn(saved: unknown, choice: string): GmailState {
  if (!saved || typeof saved !== 'object') return freshState(choice);
  const held = saved as Partial<GmailState>;
  const address = typeof held.address === 'string' && held.address ? held.address : null;
  if (held.choice !== choice) return freshState(choice, address);
  const current = held.version === STATE_VERSION;
  const history = held.history;
  const listing = held.listing;
  const count = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);
  const token = (value: unknown) => (typeof value === 'string' && value ? value : null);
  return {
    version: STATE_VERSION,
    choice,
    address,
    historyId: typeof held.historyId === 'string' && held.historyId ? held.historyId : null,
    history: { pageToken: token(history?.pageToken), done: current ? count(history?.done) : 0 },
    listing:
      listing && typeof listing === 'object' && Array.isArray(listing.seen)
        ? !current && choice === 'star'
          ? freshListing()
          : {
              pageToken: token(listing.pageToken),
              done: count(listing.done),
              seen: listing.seen.filter((id): id is string => typeof id === 'string'),
              listed: listing.listed === true,
            }
        : null,
  };
}

export async function syncMailbox(host: ConnectorHost, config: GmailConnectorConfig): Promise<SyncAnswer | void> {
  const choice = host.choice ?? DEFAULT_CHOICE;
  const mailbox = await mailboxOf(host, config);
  const saved = await host.getState();
  const run = new Reading(host, mailbox, choice, stateIn(saved, choice), config.now ?? (() => new Date()));
  // A state read under an older meaning is handed back under the new one.
  if (saved && typeof saved === 'object' && (saved as Partial<GmailState>).version !== STATE_VERSION) run.mustKeep();
  try {
    await run.read();
  } catch (error) {
    // Where the run got to is kept for the next, whatever stopped it. A failed
    // save must not hide why the run stopped.
    await run.keep().catch(() => undefined);
    if (error instanceof OutOfCalls) return { moreToDo: true };
    // Gmail or Google not answering this time is a blip, as it was in the core:
    // logged and left for the next run, where a thrown error would put
    // "Failing" on the Connections window for five minutes. What is wrong for
    // good (a sign-in refused, no label) still throws.
    if (error instanceof NotAnswering) {
      host.log('warn', 'a Gmail connection could not be checked this time', { cause: error.message });
      return;
    }
    throw error;
  }
}

class Reading {
  /** Whether the state holds something the host has not been given. */
  #unsaved = false;
  /** Gmail's list of labels, once read this run: the connection following the label reads it to find the mark. */
  #labelList: unknown;
  #userLabels: Map<string, string> | undefined;

  constructor(
    private readonly host: ConnectorHost,
    private readonly mailbox: Mailbox,
    private readonly choice: string,
    private readonly state: GmailState,
    private readonly now: () => Date,
  ) {}

  async read(): Promise<void> {
    const markId = await this.#markId();
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.state.historyId === null || this.state.listing) await this.#list(markId);
      if ((await this.#readHistory(markId)) === 'caught up') return;
      // The position lapsed: the complete listing, from a fresh position.
      this.state.historyId = null;
      this.state.history = { pageToken: null, done: 0 };
      this.state.listing = null;
      this.#unsaved = true;
    }
  }

  /** The mark's id: the label's, from the list this run reads anyway, or the star's. */
  async #markId(): Promise<string> {
    if (this.choice === 'star') return STARRED;
    this.#labelList = await this.mailbox.get('labels');
    return labelMarkIn(this.#labelList);
  }

  /**
   * The labels the person made, by id. Read at no cost where the connection
   * follows the label, whose run has the list already; a connection following
   * the star pays one call, the first time a run has names to report.
   */
  async #labelNames(): Promise<Map<string, string>> {
    if (!this.#userLabels) {
      this.#labelList ??= await this.mailbox.get('labels');
      this.#userLabels = userLabelsIn(this.#labelList);
    }
    return this.#userLabels;
  }

  /** Marks the state as holding something the host has not been given. */
  mustKeep(): void {
    this.#unsaved = true;
  }

  /** Hands the host the state, once, if it holds anything new. */
  async keep(): Promise<void> {
    if (!this.#unsaved) return;
    await this.host.setState(this.state);
    this.#unsaved = false;
  }

  async #list(markId: string): Promise<void> {
    const state = this.state;
    if (state.historyId === null) {
      const profile = (await this.mailbox.get('profile')) as { historyId?: unknown; emailAddress?: unknown } | null;
      const historyId = profile?.historyId;
      if (typeof historyId !== 'string' && typeof historyId !== 'number') {
        throw new NotAnswering('Gmail gave no history position');
      }
      if (typeof profile?.emailAddress === 'string' && profile.emailAddress) state.address = profile.emailAddress;
      state.historyId = String(historyId);
      state.history = { pageToken: null, done: 0 };
      state.listing = freshListing();
      // The position first, so whatever is marked while the listing runs is
      // after it, and the history reads it.
      this.#unsaved = true;
      await this.keep();
    }
    const listing = state.listing!;
    const byStar = this.choice === 'star';

    while (!listing.listed) {
      if (byStar) {
        // By star, a listing only closes: Gmail says an email is starred and
        // never when, so nothing starred before the position is brought in.
        // It names each email's Item and its conversation's, so both kinds of
        // Item close correctly.
        const page = emailPage(await this.mailbox.get(this.#listQuery(markId, listing.pageToken)));
        listing.seen.push(...starredSourceIds(page.emails));
        listing.pageToken = page.nextPageToken;
        listing.listed = page.nextPageToken === null;
      } else {
        const page = conversationPage(await this.mailbox.get(this.#listQuery(markId, listing.pageToken)));
        for (let index = listing.done; index < page.threadIds.length; index++) {
          await this.#follow(page.threadIds[index]!, markId, true);
          listing.seen.push(page.threadIds[index]!);
          listing.done = index + 1;
          this.#unsaved = true;
        }
        listing.pageToken = page.nextPageToken;
        listing.listed = page.nextPageToken === null;
      }
      listing.done = 0;
      this.#unsaved = true;
      await this.keep();
    }

    // A reply moves a conversation to the front of the listing, past a reader
    // part-way down it: the front is read once more so none is missed for it.
    const frontIds =
      byStar
        ? starredSourceIds(emailPage(await this.mailbox.get(this.#listQuery(markId, null))).emails)
        : conversationPage(await this.mailbox.get(this.#listQuery(markId, null))).threadIds;
    const sourceIds = [...new Set([...listing.seen, ...frontIds])];
    await this.host.reportCompleteListing({
      choice: this.choice,
      sourceIds,
      // By star the ids name each email's Item and its conversation's: what is
      // starred is the emails.
      ...(byStar ? { count: sourceIds.filter((id) => emailIdIn(id) !== null).length } : {}),
    });
    state.listing = null;
    this.#unsaved = true;
    await this.keep();
  }

  /** The mailbox's address, asked for only if the state somehow holds none. */
  async #address(): Promise<string> {
    if (this.state.address === null) {
      const profile = (await this.mailbox.get('profile')) as { emailAddress?: unknown } | null;
      this.state.address = typeof profile?.emailAddress === 'string' ? profile.emailAddress : '';
      this.#unsaved = true;
    }
    return this.state.address;
  }

  #listQuery(markId: string, pageToken: string | null): string {
    const query = new URLSearchParams({
      labelIds: markId,
      maxResults: String(this.choice === 'star' ? STAR_PAGE_SIZE : PAGE_SIZE),
    });
    if (pageToken) query.set('pageToken', pageToken);
    // By star it lists emails, since a star belongs to one; by label, conversations.
    return `${this.choice === 'star' ? 'messages' : 'threads'}?${query}`;
  }

  /**
   * Reads Gmail's history from the saved position a page at a time. The
   * position moves only once the last page's conversations are done, so a run
   * that stops reads that page again from where it stopped, and anything read
   * twice is already known to the host. Gmail answers 404 for a position it no
   * longer keeps, after about a week: that is `lapsed`.
   */
  async #readHistory(markId: string): Promise<'caught up' | 'lapsed'> {
    const state = this.state;
    for (;;) {
      const query = new URLSearchParams({
        startHistoryId: state.historyId!,
        labelId: markId,
        maxResults: String(HISTORY_PAGE_SIZE),
      });
      for (const type of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) {
        query.append('historyTypes', type);
      }
      if (state.history.pageToken) query.set('pageToken', state.history.pageToken);
      const answer = await this.mailbox.get(`history?${query}`);
      if (answer === null) return 'lapsed';

      const page = this.choice === 'star' ? await this.#followEmails(answer, markId) : await this.#followConversations(answer, markId);

      if (page.nextPageToken) {
        state.history = { pageToken: page.nextPageToken, done: 0 };
        this.#unsaved = true;
      } else {
        if (page.historyId === null) throw new NotAnswering('Gmail gave no history position');
        if (page.historyId !== state.historyId || state.history.pageToken !== null || state.history.done > 0) {
          this.#unsaved = true;
        }
        state.historyId = page.historyId;
        state.history = { pageToken: null, done: 0 };
      }
      await this.keep();
      if (!page.nextPageToken) return 'caught up';
    }
  }

  /** One history page of a connection following the label: each conversation it names, read once. */
  async #followConversations(answer: unknown, markId: string): Promise<{ nextPageToken: string | null; historyId: string | null }> {
    const state = this.state;
    const page = historyPage(answer, markId);
    const gained = new Set(page.gained);
    const changed = new Set(page.changed);
    const affected = [...new Set([...page.changed, ...page.gained, ...page.relabelled])];
    for (let index = state.history.done; index < affected.length; index++) {
      const threadId = affected[index]!;
      // A conversation only relabelled has its names read again and nothing
      // else: it neither closes nor reopens.
      if (!gained.has(threadId) && !changed.has(threadId)) await this.#reportNames(threadId, markId);
      else await this.#follow(threadId, markId, gained.has(threadId));
      state.history.done = index + 1;
      this.#unsaved = true;
    }
    return page;
  }

  /**
   * One history page of a connection following the star: each conversation it
   * names, read once, whatever number of its emails changed.
   */
  async #followEmails(answer: unknown, markId: string): Promise<{ nextPageToken: string | null; historyId: string | null }> {
    const state = this.state;
    const page = emailHistoryPage(answer, markId);
    for (let index = state.history.done; index < page.conversations.length; index++) {
      await this.#followEmailsOf(page.conversations[index]!, markId);
      state.history.done = index + 1;
      this.#unsaved = true;
    }
    return page;
  }

  /**
   * Reads one conversation and says what became of each email of it the page
   * names, and of the conversation Item an earlier release made of it:
   *
   * - **An email** still starred is brought in where it gained the star (and
   *   `reopened` where the host already knew it), and otherwise only
   *   `reopened`, or has its names read again; one no longer starred, in the
   *   bin or gone is `resolved`.
   * - **A conversation Item from before** only closes, once no email in the
   *   conversation is starred: reopening it would star the whole conversation.
   */
  async #followEmailsOf(changes: EmailChanges, markId: string): Promise<void> {
    const { threadId } = changes;
    const gained = new Set(changes.gained);
    const changed = new Set(changes.changed);
    const thread = await this.mailbox.get(
      `threads/${encodeURIComponent(threadId)}?format=${gained.size > 0 ? 'full' : 'minimal'}`,
    );
    const observedAt = this.now().toISOString();
    for (const emailId of new Set([...changes.changed, ...changes.gained, ...changes.relabelled])) {
      const sourceId = emailSourceId(emailId);
      const message = thread === null ? null : emailIn(thread, emailId);
      if (!emailMarked(message, markId)) {
        // Only a read of the email says which way a change went; one only
        // relabelled that is no longer starred has nothing to say.
        if (gained.has(emailId) || changed.has(emailId)) {
          await this.host.emitSourceStateChange({ sourceId, change: 'resolved', observedAt });
        }
        continue;
      }
      const names = namesOfEmail(message, await this.#labelNames(), markId);
      if (gained.has(emailId)) {
        const email = emailFrom(message, await this.#address());
        if (!email) continue;
        const filing = await this.host.emitItem({
          sourceId,
          sourceLink: email.link,
          sender: email.sender,
          sourceTimestamp: email.sentAt,
          capturedMessage: email.text,
          title: email.title,
          choice: this.choice,
          names,
        });
        if (filing === 'already-known') await this.host.emitSourceStateChange({ sourceId, change: 'reopened', observedAt });
      } else {
        await this.host.reportNames({ sourceId, names });
        if (changed.has(emailId)) await this.host.emitSourceStateChange({ sourceId, change: 'reopened', observedAt });
      }
    }
    if (thread === null || !stillMarked(thread, markId)) {
      await this.host.emitSourceStateChange({ sourceId: threadId, change: 'resolved', observedAt });
    } else if (changes.relabelled.length > 0) {
      // The conversation Item from before is still open, and keeps its names.
      await this.#say(threadId, thread, markId);
    }
  }

  /** Reports the names of a conversation read, whole; the host works out what is new. */
  async #say(threadId: string, thread: unknown, markId: string): Promise<void> {
    await this.host.reportNames({ sourceId: threadId, names: namesOf(thread, await this.#labelNames(), markId) });
  }

  /** Reads a conversation whose labels changed, and reports its names if it is still marked. */
  async #reportNames(threadId: string, markId: string): Promise<void> {
    const thread = await this.mailbox.get(`threads/${encodeURIComponent(threadId)}?format=minimal`);
    if (thread !== null && stillMarked(thread, markId)) await this.#say(threadId, thread, markId);
  }

  /**
   * Reads one conversation and says what became of it: gone, in the bin or no
   * longer marked is `resolved`; marked is brought in as a titled Task where
   * `bringIn` says it should be, and `reopened` where the host already knew it
   * (which changes nothing for an Item that is open, and not at all while a
   * change of Cockpit's is waiting for Gmail).
   */
  async #follow(threadId: string, markId: string, bringIn: boolean): Promise<void> {
    const thread = await this.mailbox.get(`threads/${encodeURIComponent(threadId)}?format=${bringIn ? 'full' : 'minimal'}`);
    const observedAt = this.now().toISOString();
    if (thread === null || !stillMarked(thread, markId)) {
      await this.host.emitSourceStateChange({ sourceId: threadId, change: 'resolved', observedAt });
      return;
    }
    if (!bringIn) {
      await this.#say(threadId, thread, markId);
      await this.host.emitSourceStateChange({ sourceId: threadId, change: 'reopened', observedAt });
      return;
    }
    const conversation = conversationFrom(thread, markId, await this.#address());
    if (!conversation) return;
    const filing = await this.host.emitItem({
      sourceId: conversation.threadId,
      sourceLink: conversation.link,
      sender: conversation.sender,
      sourceTimestamp: conversation.sentAt,
      capturedMessage: conversation.text,
      title: conversation.title,
      choice: this.choice,
      names: namesOf(thread, await this.#labelNames(), markId),
    });
    if (filing === 'already-known') {
      await this.host.emitSourceStateChange({ sourceId: threadId, change: 'reopened', observedAt });
    }
  }
}

/**
 * What a page of starred emails says is still open: each email's Item, and its
 * conversation's - the Item an earlier release made of it, which stays open
 * while any email in the conversation is starred.
 */
function starredSourceIds(emails: readonly { id: string; threadId: string }[]): string[] {
  return [...new Set(emails.flatMap((email) => [emailSourceId(email.id), email.threadId]))];
}

/**
 * The id of the mark this connection follows: Gmail's own label for a star, or
 * the mailbox's label called Cockpit - which a mailbox without cannot be read,
 * and says so.
 */
async function markIdOf(mailbox: Mailbox, choice: string): Promise<string> {
  return choice === 'star' ? STARRED : labelMarkIn(await mailbox.get('labels'));
}

/** The id of the label called Cockpit in Gmail's list of labels, or the failure that says there is none. */
function labelMarkIn(labels: unknown): string {
  const labelId = cockpitLabelIn(labels);
  if (!labelId) throw new Error(NO_LABEL);
  return labelId;
}

/**
 * Puts the mark on, or takes it off, each conversation whose Item a person
 * opened or closed in Cockpit - the mark followed alone, on the whole
 * conversation, and nothing else of the mailbox. **By star the Item is an
 * email's, and the star goes on or off that email alone.** An Item from before
 * that, which is a conversation's, only closes - by taking the star off the
 * whole conversation; reopening it is given up on, since starring the
 * conversation would star every email in it and bring each in as an Item.
 *
 * **Confirmed only once Gmail has answered**, so a run that stops between the
 * call and the host's record pushes it again, which changes nothing at Gmail. A
 * conversation that is gone has nothing left to mark, and counts as confirmed.
 * Gmail not answering, or holding the mailbox back with a rate limit, leaves
 * the rest waiting for the next run. **One Gmail will never take is given up
 * on**, rather than asked again first on every run, where it would hold up
 * everything else.
 */
export async function mirrorOpenStates(
  host: ConnectorHost,
  config: GmailConnectorConfig,
  wanted: OpenStateWanted[],
): Promise<MirroredOpenStates> {
  const mailbox = await mailboxOf(host, config);
  const choice = host.choice ?? DEFAULT_CHOICE;
  const confirmed: string[] = [];
  const gaveUp: string[] = [];
  try {
    const markId = await markIdOf(mailbox, choice);
    for (const one of wanted) {
      const emailId = choice === 'star' ? emailIdIn(one.sourceId) : null;
      if (choice === 'star' && emailId === null && one.open) {
        host.log('info', 'a starred conversation brought in before emails came in one by one is not starred again', {});
        gaveUp.push(one.sourceId);
        continue;
      }
      try {
        const path =
          emailId === null
            ? `threads/${encodeURIComponent(one.sourceId)}/modify`
            : `messages/${encodeURIComponent(emailId)}/modify`;
        await mailbox.post(path, labelChange(markId, one.open));
        confirmed.push(one.sourceId);
      } catch (error) {
        if (!(error instanceof ChangeRefused)) throw error;
        host.log('warn', 'Gmail refused a label change, which is no longer asked of it', { status: error.status });
        gaveUp.push(one.sourceId);
      }
    }
  } catch (error) {
    // Out of calls, or Gmail not answering this time: what was done stands,
    // and the rest is handed back next run.
    if (!(error instanceof OutOfCalls) && !(error instanceof NotAnswering)) throw error;
  }
  return { confirmed, gaveUp };
}
