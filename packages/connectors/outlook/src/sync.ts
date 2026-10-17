import type { ConnectorHost, SyncAnswer } from '@cockpit/connector-sdk';
import { NotAnswering, OutOfCalls, mailboxOf, type Mailbox, type OutlookConnectorConfig } from './graph.js';
import {
  COCKPIT_CATEGORY,
  LIST_FIELDS,
  READ_FIELDS,
  deletedItemsIn,
  markFilter,
  markOf,
  messageFrom,
  messagePage,
  namesOf,
  type Mark,
} from './messages.js';

/**
 * A run of Outlook, in the order it must go (the quirks behind each step are in
 * the package README). Before it, the host has had the waiting open states
 * pushed (`mirrorOpenStates`), so the listing agrees with what was pushed.
 *
 * 1. **List the immutable ids of every message carrying the mark**, mailbox-wide
 *    and leaving out Deleted Items, a page at a time. A listing that stops
 *    between pages reports nothing, so nothing is closed for it.
 * 2. **Read in full, and emit, only the ids the previous listing did not see.**
 *    The host answers `already-known` for one it has filed before, which is
 *    reported reopened: that is a message marked again after its Item closed.
 * 3. **Report the listing complete under the choice**, so the host closes the
 *    Items of messages that lost the mark or left for Deleted Items.
 * 4. **Keep the listing** as the next run's previous one - only now, after the
 *    emits succeeded, so a run that stops earlier reads the same ids again and
 *    finds them known.
 *
 * A run that reaches its call budget keeps what it emitted and answers that
 * there is more to do.
 */

/** How many messages Graph is asked for at a time: a listing reads only ids, so a page costs one call whatever its size. */
const PAGE_SIZE = 100;

/**
 * How many messages already in one run reports the names of: each report is a
 * round trip to the host, which counts against the 1,000 calls to Cloudflare's
 * own services an invocation is allowed, and the first run after names were
 * reported at all reports every message listed. The rest wait for the next run,
 * which the run's answer brings forward.
 */
export const NAMES_REPORTED_PER_RUN = 400;

/** The choice a connection that holds none follows: the flag, which is offered to start. */
const DEFAULT_CHOICE: Mark = 'flag';

/**
 * Where bringing in one connection's messages has got to: this connector's
 * private state, kept by the host as an opaque blob. `seen` is the last
 * listing a run finished with - minus any message it did not get to read -
 * under the mark `choice` names.
 */
export interface OutlookState {
  /** The choice this was kept under; a connection now following another starts over. */
  readonly choice: Mark;
  readonly seen: string[];
  /**
   * The names last reported for each message in `seen`, so a set unchanged
   * at a re-read is not reported again. A message with none kept - every one
   * from before names were reported - is reported at its next re-read.
   */
  readonly names?: Record<string, string[]>;
}

/** The saved state, read - or a fresh one where there is none, it is unreadable, or it was kept under another choice. */
export function stateIn(saved: unknown, choice: Mark): OutlookState {
  const held = (saved ?? {}) as Partial<OutlookState>;
  if (held.choice !== choice || !Array.isArray(held.seen)) return { choice, seen: [], names: {} };
  const names: Record<string, string[]> = {};
  if (held.names && typeof held.names === 'object') {
    for (const [id, set] of Object.entries(held.names)) {
      if (Array.isArray(set) && set.every((one) => typeof one === 'string')) names[id] = set;
    }
  }
  return { choice, seen: held.seen.filter((id): id is string => typeof id === 'string' && id.length > 0), names };
}

/** Whether two name sets hold the same names, in whatever order. */
function sameNames(one: readonly string[], other: readonly string[]): boolean {
  if (one.length !== other.length) return false;
  const sorted = [...other].sort();
  return [...one].sort().every((name, at) => name === sorted[at]);
}

export async function syncMailbox(host: ConnectorHost, config: OutlookConnectorConfig): Promise<SyncAnswer | void> {
  const mark = host.choice === null ? DEFAULT_CHOICE : markOf(host.choice);
  const mailbox = await mailboxOf(host, config);
  const state = stateIn(await host.getState(), mark);
  const now = config.now ?? (() => new Date());

  let listing: Listing;
  try {
    listing = await list(mailbox, mark);
  } catch (error) {
    // Nothing is reported or kept for a listing that did not finish.
    if (error instanceof OutOfCalls) return { moreToDo: true };
    // Microsoft not answering this time (a 429, a 503) is a blip, logged and
    // left for the next run, where a thrown error would put "Failing" on the
    // Connections window for five minutes. What is wrong for good still throws.
    if (error instanceof NotAnswering) {
      host.log('warn', 'an Outlook connection could not be checked this time', { cause: error.message });
      return;
    }
    throw error;
  }

  const known = new Set(state.seen);
  const done = new Set<string>();
  // What each message's names were last reported as, this run's reports added.
  const reported: Record<string, string[]> = { ...state.names };
  let moreToDo = false;
  // A message already in whose categories changed since the last report:
  // the listing reads them every run, so this costs no call (issue 1146).
  let reports = 0;
  for (const messageId of listing.messageIds) {
    if (!known.has(messageId)) continue;
    const names = namesOf(listing.categories[messageId] ?? [], mark);
    const before = reported[messageId];
    if (before && sameNames(before, names)) continue;
    if (reports === NAMES_REPORTED_PER_RUN) {
      moreToDo = true;
      break;
    }
    reports += 1;
    await host.reportNames({ sourceId: messageId, names, ...(mark === 'category' ? { followed: COCKPIT_CATEGORY } : {}) });
    reported[messageId] = names;
  }
  try {
    for (const messageId of listing.messageIds) {
      if (known.has(messageId)) continue;
      const names = await bringIn(host, mailbox, mark, listing.deletedItems, messageId, now);
      if (names) reported[messageId] = names;
      done.add(messageId);
    }
  } catch (error) {
    // What was emitted stands and is kept; a failed emit is not caught here,
    // and keeps nothing, so the same ids are read and found known next run.
    if (error instanceof OutOfCalls) moreToDo = true;
    else if (error instanceof NotAnswering) {
      host.log('warn', 'an Outlook connection could not be read to the end this time', { cause: error.message });
    } else throw error;
  }

  await host.reportCompleteListing({ choice: mark, sourceIds: listing.messageIds });
  // Only what was read joins what was known: a message the run did not get to
  // stays unseen, and is read first thing next run.
  const seen = listing.messageIds.filter((messageId) => known.has(messageId) || done.has(messageId));
  await host.setState({
    choice: mark,
    seen,
    names: Object.fromEntries(seen.flatMap((messageId) => (reported[messageId] ? [[messageId, reported[messageId]]] : []))),
  } satisfies OutlookState);
  return moreToDo ? { moreToDo: true } : undefined;
}

interface Listing {
  readonly deletedItems: string;
  readonly messageIds: string[];
  /** Each listed message's categories, as the listing read them. */
  readonly categories: Record<string, string[]>;
}

/** Every message carrying the mark outside Deleted Items, or an error where the listing could not be finished. */
async function list(mailbox: Mailbox, mark: Mark): Promise<Listing> {
  const deletedItems = deletedItemsIn(await mailbox.get('mailFolders/deleteditems?$select=id'));
  if (!deletedItems) throw new Error('Microsoft gave no Deleted Items folder for this mailbox');

  const messageIds = new Set<string>();
  const categories: Record<string, string[]> = {};
  let next: string | null = `messages?$filter=${encodeURIComponent(markFilter(mark))}&$select=${LIST_FIELDS}&$top=${PAGE_SIZE}`;
  while (next) {
    const page = messagePage(await mailbox.get(next), mark, deletedItems);
    for (const messageId of page.messageIds) messageIds.add(messageId);
    Object.assign(categories, page.categories);
    next = page.nextLink;
  }
  return { deletedItems, messageIds: [...messageIds], categories };
}

/**
 * Reads one message and offers it as a titled Task; the host's `already-known`
 * means it was filed before, which is reported reopened (it changes nothing
 * for an Item that is open, and not at all while a change of Cockpit's is
 * waiting for Outlook). A message gone, unmarked or moved to Deleted Items
 * since the listing is left alone: the listing the next run makes decides.
 */
async function bringIn(
  host: ConnectorHost,
  mailbox: Mailbox,
  mark: Mark,
  deletedItems: string,
  messageId: string,
  now: () => Date,
): Promise<string[] | null> {
  const answer = await mailbox.get(`messages/${encodeURIComponent(messageId)}?$select=${READ_FIELDS}`, { bodyAsText: true });
  const message = messageFrom(answer, mark, deletedItems);
  if (!message) return null;
  const names = namesOf(message.categories, mark);
  const filing = await host.emitItem({
    sourceId: message.messageId,
    sourceLink: message.link,
    sender: message.sender,
    sourceTimestamp: message.receivedAt,
    capturedMessage: message.text,
    title: message.title,
    choice: mark,
    names,
    ...(mark === 'category' ? { followed: COCKPIT_CATEGORY } : {}),
  });
  if (filing === 'already-known') {
    await host.emitSourceStateChange({ sourceId: message.messageId, change: 'reopened', observedAt: now().toISOString() });
  }
  return names;
}
