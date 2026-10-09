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
  historyPage,
  labelChange,
  stillMarked,
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
 * A run that reaches its call budget saves where it was and answers that there
 * is more to do; the next run resumes inside the page it stopped in.
 */

/** How many labelled conversations Gmail is asked for at a time: about what one run can read. */
const PAGE_SIZE = 50;

/**
 * How many starred conversations a listing asks for at a time. A listing by
 * star reads nothing but the ids, so a page costs one call whatever its size;
 * 500 is Gmail's ceiling.
 */
const STAR_PAGE_SIZE = 500;

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
    /** Every conversation the listing has seen so far. */
    seen: string[];
    /** Every page is read: the last of it is to be reported. */
    listed: boolean;
  } | null;
}

function freshState(choice: string, address: string | null = null): GmailState {
  return { choice, address, historyId: null, history: { pageToken: null, done: 0 }, listing: null };
}

/** The saved state, read - or a fresh one where there is none, it is unreadable, or it was kept under another choice. */
export function stateIn(saved: unknown, choice: string): GmailState {
  if (!saved || typeof saved !== 'object') return freshState(choice);
  const held = saved as Partial<GmailState>;
  const address = typeof held.address === 'string' && held.address ? held.address : null;
  if (held.choice !== choice) return freshState(choice, address);
  const history = held.history;
  const listing = held.listing;
  const count = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);
  const token = (value: unknown) => (typeof value === 'string' && value ? value : null);
  return {
    choice,
    address,
    historyId: typeof held.historyId === 'string' && held.historyId ? held.historyId : null,
    history: { pageToken: token(history?.pageToken), done: count(history?.done) },
    listing:
      listing && typeof listing === 'object' && Array.isArray(listing.seen)
        ? {
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
  const run = new Reading(host, mailbox, choice, stateIn(await host.getState(), choice), config.now ?? (() => new Date()));
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

  constructor(
    private readonly host: ConnectorHost,
    private readonly mailbox: Mailbox,
    private readonly choice: string,
    private readonly state: GmailState,
    private readonly now: () => Date,
  ) {}

  async read(): Promise<void> {
    const markId = await markIdOf(this.mailbox, this.choice);
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
      state.listing = { pageToken: null, done: 0, seen: [], listed: false };
      // The position first, so whatever is marked while the listing runs is
      // after it, and the history reads it.
      this.#unsaved = true;
      await this.keep();
    }
    const listing = state.listing!;
    const byStar = this.choice === 'star';

    while (!listing.listed) {
      const page = conversationPage(await this.mailbox.get(this.#listQuery(markId, listing.pageToken)));
      if (byStar) {
        // By star, a listing only closes: Gmail says a conversation is starred
        // and never when, so nothing starred before the position is brought in.
        listing.seen.push(...page.threadIds);
      } else {
        for (let index = listing.done; index < page.threadIds.length; index++) {
          await this.#follow(page.threadIds[index]!, markId, true);
          listing.seen.push(page.threadIds[index]!);
          listing.done = index + 1;
          this.#unsaved = true;
        }
      }
      listing.pageToken = page.nextPageToken;
      listing.done = 0;
      listing.listed = page.nextPageToken === null;
      this.#unsaved = true;
      await this.keep();
    }

    // A reply moves a conversation to the front of the listing, past a reader
    // part-way down it: the front is read once more so none is missed for it.
    const front = conversationPage(await this.mailbox.get(this.#listQuery(markId, null)));
    await this.host.reportCompleteListing({
      choice: this.choice,
      sourceIds: [...new Set([...listing.seen, ...front.threadIds])],
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
    return `threads?${query}`;
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

      const page = historyPage(answer, markId);
      const gained = new Set(page.gained);
      const affected = [...new Set([...page.changed, ...page.gained])];
      for (let index = state.history.done; index < affected.length; index++) {
        await this.#follow(affected[index]!, markId, gained.has(affected[index]!));
        state.history.done = index + 1;
        this.#unsaved = true;
      }

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
      await this.host.emitSourceStateChange({ sourceId: threadId, change: 'reopened', observedAt });
      return;
    }
    const conversation = conversationFrom(thread, markId, await this.#address());
    if (!conversation) return;
    const filing = await this.host.emitItem({
      source: 'mail',
      sourceId: conversation.threadId,
      sourceLink: conversation.link,
      sender: conversation.sender,
      sourceTimestamp: conversation.sentAt,
      capturedMessage: conversation.text,
      title: conversation.title,
      choice: this.choice,
    });
    if (filing === 'already-known') {
      await this.host.emitSourceStateChange({ sourceId: threadId, change: 'reopened', observedAt });
    }
  }
}

/**
 * The id of the mark this connection follows: Gmail's own label for a star, or
 * the mailbox's label called Cockpit - which a mailbox without cannot be read,
 * and says so.
 */
async function markIdOf(mailbox: Mailbox, choice: string): Promise<string> {
  if (choice === 'star') return STARRED;
  const labelId = cockpitLabelIn(await mailbox.get('labels'));
  if (!labelId) throw new Error(NO_LABEL);
  return labelId;
}

/**
 * Puts the mark on, or takes it off, each conversation whose Item a person
 * opened or closed in Cockpit - the mark followed alone, on the whole
 * conversation, and nothing else of the mailbox.
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
      try {
        await mailbox.post(`threads/${encodeURIComponent(one.sourceId)}/modify`, labelChange(markId, one.open));
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
