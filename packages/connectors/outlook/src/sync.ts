import type { ConnectorHost, SyncAnswer } from '@cockpit/connector-sdk';
import { NotAnswering, OutOfCalls, mailboxOf, type Mailbox, type OutlookConnectorConfig } from './graph.js';
import { checkDrafts } from './drafts.js';
import { OVERLAP_MS, conversationMessages, foldersOf, reportTurnsSince, standingOf, type Folders } from './conversations.js';
import {
  COCKPIT_CATEGORY,
  LIST_FIELDS,
  READ_FIELDS,
  conversationKey,
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
 *
 * **Following the flag brings in a conversation, not a message** ("Outlook
 * follows the flagged conversation as Gmail does", issue 1707): a flagged
 * message the run has not read, in a conversation no open Item follows, is
 * read in full and its conversation read whole, and is emitted under
 * `conversation:` and the conversation's id, following it. Between the listing
 * and that, one read of the mail received since the last run (every folder,
 * `conversations.ts`) reports each message in a followed conversation as a
 * turn, and each draft *Email…* made that is still waited on is read once
 * (`drafts.ts`, issue 1709). An Item made of one message before stays as it was
 * (`seen`), and never follows.
 */

/** How many messages Graph is asked for at a time: a listing reads only ids, so a page costs one call whatever its size. */
const PAGE_SIZE = 100;

/**
 * How many messages already in one run reports the names or due day of (the two share this budget): each report is a
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
  /**
   * Following the flag: the day last reported as due for each conversation (or
   * message) that has one, so a day unchanged at a re-read is not reported
   * again. Saved only once the host took the report, so one that failed is
   * reported again next run. A day that is removed keeps its entry: nothing is
   * reported for it, and the same day put back is not news.
   */
  readonly due?: Record<string, string>;
  /**
   * Following the flag: the flagged messages whose conversation was brought in
   * (or was followed already), so a run does not read them again. Like `seen`,
   * only what the last listing still held.
   */
  readonly read?: string[];
  /** Following the flag: where the next read of received mail starts. */
  readonly turnsSince?: string;
}

/** The saved state, read - or a fresh one where there is none, it is unreadable, or it was kept under another choice. */
export function stateIn(saved: unknown, choice: Mark): OutlookState {
  const held = (saved ?? {}) as Partial<OutlookState>;
  if (held.choice !== choice || !Array.isArray(held.seen)) return { choice, seen: [], names: {}, due: {} };
  const names: Record<string, string[]> = {};
  if (held.names && typeof held.names === 'object') {
    for (const [id, set] of Object.entries(held.names)) {
      if (Array.isArray(set) && set.every((one) => typeof one === 'string')) names[id] = set;
    }
  }
  const due: Record<string, string> = {};
  if (held.due && typeof held.due === 'object') {
    for (const [key, day] of Object.entries(held.due)) if (typeof day === 'string') due[key] = day;
  }
  const ids = (list: unknown) => (Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string' && id.length > 0) : []);
  return {
    choice,
    seen: ids(held.seen),
    names,
    due,
    read: ids(held.read),
    ...(typeof held.turnsSince === 'string' && Number.isFinite(Date.parse(held.turnsSince)) ? { turnsSince: held.turnsSince } : {}),
  };
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
  const readBefore = new Set(state.read ?? []);
  const byConversation = mark === 'flag';
  const runStart = now();
  const done = new Set<string>();
  // What each message's names were last reported as, this run's reports added.
  const reported: Record<string, string[]> = { ...state.names };
  // The day last reported as due for each Item, this run's reports added.
  const dueReported: Record<string, string> = { ...state.due };
  let moreToDo = false;
  // A message already in whose categories changed since the last report:
  // the listing reads them every run, so this costs no call (issue 1146).
  let reports = 0;
  // Each Item's names: a message's own, or - following the flag - the union of
  // the names of the flagged messages of the conversation its Item follows.
  const keyOf = (messageId: string) => (byConversation && !known.has(messageId) ? conversationKey(listing.conversations[messageId]!) : messageId);
  const namesByItem = new Map<string, Set<string>>();
  for (const messageId of listing.messageIds) {
    if (!known.has(messageId) && !readBefore.has(messageId)) continue;
    const set = namesByItem.get(keyOf(messageId)) ?? new Set<string>();
    for (const name of namesOf(listing.categories[messageId] ?? [], mark)) set.add(name);
    namesByItem.set(keyOf(messageId), set);
  }
  for (const [sourceId, set] of namesByItem) {
    const names = [...set];
    const before = reported[sourceId];
    if (before && sameNames(before, names)) continue;
    if (reports === NAMES_REPORTED_PER_RUN) {
      moreToDo = true;
      break;
    }
    reports += 1;
    await host.reportNames({ sourceId, names, ...(mark === 'category' ? { followed: COCKPIT_CATEGORY } : {}) });
    reported[sourceId] = names;
  }
  // The earliest day a flag is due among the flagged messages each Item holds.
  const earliest = (ids: Iterable<string>): Map<string, string> => {
    const days = new Map<string, string>();
    for (const messageId of ids) {
      const day = listing.dueDays[messageId];
      const key = keyOf(messageId);
      if (day && (!days.has(key) || day < days.get(key)!)) days.set(key, day);
    }
    return days;
  };
  // Reported for an Item already in: a day that differs from the last reported, a removed day being nothing to report.
  // An Item with no entry yet takes today's day as where it starts ('' for none) and reports nothing, so one brought in before days were read keeps its date.
  const already = listing.messageIds.filter((id) => known.has(id) || readBefore.has(id));
  const days = earliest(already);
  for (const messageId of already) {
    const key = keyOf(messageId);
    if (dueReported[key] === undefined) dueReported[key] = days.get(key) ?? '';
  }
  for (const [sourceId, day] of days) {
    if (dueReported[sourceId] === day) continue;
    if (reports === NAMES_REPORTED_PER_RUN) {
      moreToDo = true;
      break;
    }
    reports += 1;
    await host.reportDueDay({ sourceId, dueDay: day });
    dueReported[sourceId] = day;
  }
  // What a conversation not brought in yet is due, from every flagged message of it.
  const newDays = earliest(listing.messageIds.filter((id) => !known.has(id)));
  let turnsSince = state.turnsSince;
  let turnsOutOfCalls = false;
  try {
    let followed: Set<string> | null = null;
    let folders: Folders | null = null;
    const foldersNow = async () => (folders ??= await foldersOf(mailbox, listing.deletedItems));
    if (byConversation) {
      followed = new Set(await host.followedConversations());
      // Turns first, so a reply that arrives with a flag moves the status
      // before the conversation is read as where things stand.
      if (followed.size > 0) {
        const since = state.turnsSince ?? new Date(runStart.getTime() - OVERLAP_MS).toISOString();
        const turns = await reportTurnsSince(host, mailbox, await foldersNow(), followed, since, runStart);
        turnsSince = turns.next;
        if (turns.moreToDo) {
          moreToDo = true;
          turnsOutOfCalls = true;
        } else {
          // Once the turns are reported, so a draft sent and read as a turn this run is no longer waited on.
          // A draft that could not be read this time is read next run, and must not stop the flagged mail being brought in.
          try {
            await checkDrafts(host, mailbox, listing.deletedItems, foldersNow);
          } catch (error) {
            if (error instanceof OutOfCalls) moreToDo = true;
            else if (error instanceof NotAnswering) {
              host.log('warn', 'an Outlook connection could not check its drafts this time', { cause: error.message });
            } else throw error;
          }
        }
      } else {
        turnsSince = new Date(runStart.getTime() - OVERLAP_MS).toISOString();
      }
    }
    // A run out of calls reading turns leaves the bringing in to the next.
    if (!turnsOutOfCalls || !byConversation) {
      for (const messageId of listing.messageIds) {
        if (known.has(messageId) || readBefore.has(messageId)) continue;
        if (byConversation) {
          const conversationId = listing.conversations[messageId]!;
          if (!followed!.has(conversationId)) {
            const dueDay = newDays.get(conversationKey(conversationId));
            const brought = await bringInConversation(host, mailbox, mark, listing.deletedItems, messageId, foldersNow, now, dueDay);
            // Only once it was brought in: another flagged message of it must not be skipped for one that was gone.
            if (brought) {
              reported[conversationKey(conversationId)] = brought;
              dueReported[conversationKey(conversationId)] = dueDay ?? '';
              followed!.add(conversationId);
            }
          }
        } else {
          const names = await bringIn(host, mailbox, mark, listing.deletedItems, messageId, now);
          if (names) reported[messageId] = names;
        }
        done.add(messageId);
      }
    }
  } catch (error) {
    // What was emitted stands and is kept; a failed emit is not caught here,
    // and keeps nothing, so the same ids are read and found known next run.
    if (error instanceof OutOfCalls) moreToDo = true;
    else if (error instanceof NotAnswering) {
      host.log('warn', 'an Outlook connection could not be read to the end this time', { cause: error.message });
    } else throw error;
  }

  // Following the flag, a message with no Item of its own is listed as its
  // conversation, which closes when no message in it is flagged any more.
  const sourceIds = [...new Set(listing.messageIds.map(keyOf))];
  await host.reportCompleteListing({
    choice: mark,
    sourceIds,
    // What the check's line says it listed: the messages flagged, however many conversations they are in.
    ...(sourceIds.length === listing.messageIds.length ? {} : { count: listing.messageIds.length }),
  });
  // Only what was read joins what was known: a message the run did not get to
  // stays unseen, and is read first thing next run.
  const seen = listing.messageIds.filter((messageId) => known.has(messageId) || (!byConversation && done.has(messageId)));
  const read = byConversation ? listing.messageIds.filter((id) => readBefore.has(id) || done.has(id)) : [];
  await host.setState({
    choice: mark,
    seen,
    names: Object.fromEntries(
      [...new Set([...seen, ...(byConversation ? read : [])].map(keyOf))].flatMap((key) => (reported[key] ? [[key, reported[key]]] : [])),
    ),
    ...(byConversation
      ? { due: Object.fromEntries([...new Set([...seen, ...read].map(keyOf))].flatMap((key) => (dueReported[key] !== undefined ? [[key, dueReported[key]]] : []))) }
      : {}),
    ...(byConversation ? { read, ...(turnsSince ? { turnsSince } : {}) } : {}),
  } satisfies OutlookState);
  return moreToDo ? { moreToDo: true } : undefined;
}

interface Listing {
  readonly deletedItems: string;
  readonly messageIds: string[];
  /** Each listed message's categories, as the listing read them. */
  readonly categories: Record<string, string[]>;
  /** Each listed message's conversation. */
  readonly conversations: Record<string, string>;
  /** The day each flagged message's flag is due, where it has one. */
  readonly dueDays: Record<string, string>;
}

/** Every message carrying the mark outside Deleted Items, or an error where the listing could not be finished. */
async function list(mailbox: Mailbox, mark: Mark): Promise<Listing> {
  const deletedItems = deletedItemsIn(await mailbox.get('mailFolders/deleteditems?$select=id'));
  if (!deletedItems) throw new Error('Microsoft gave no Deleted Items folder for this mailbox');

  const messageIds = new Set<string>();
  const categories: Record<string, string[]> = {};
  const conversations: Record<string, string> = {};
  const dueDays: Record<string, string> = {};
  let next: string | null = `messages?$filter=${encodeURIComponent(markFilter(mark))}&$select=${LIST_FIELDS}&$top=${PAGE_SIZE}`;
  while (next) {
    const page = messagePage(await mailbox.get(next), mark, deletedItems);
    for (const messageId of page.messageIds) messageIds.add(messageId);
    Object.assign(categories, page.categories);
    Object.assign(conversations, page.conversations);
    Object.assign(dueDays, page.dueDays);
    next = page.nextLink;
  }
  return { deletedItems, messageIds: [...messageIds], categories, conversations, dueDays };
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

/**
 * Reads one flagged message and its conversation whole, and offers the
 * conversation as one titled Task that follows it - the message's subject,
 * sender, text and link, and where the conversation stands. The host's
 * `already-known` means the conversation was an Item before (done, or no longer
 * followed), which is reported reopened. A message gone, unflagged or binned
 * since the listing is left alone, as in `bringIn`.
 */
async function bringInConversation(
  host: ConnectorHost,
  mailbox: Mailbox,
  mark: Mark,
  deletedItems: string,
  messageId: string,
  foldersNow: () => Promise<Folders>,
  now: () => Date,
  dueDay: string | undefined,
): Promise<string[] | null> {
  const answer = await mailbox.get(`messages/${encodeURIComponent(messageId)}?$select=${READ_FIELDS}`, { bodyAsText: true });
  const message = messageFrom(answer, mark, deletedItems);
  if (!message) return null;
  const whole = await conversationMessages(mailbox, message.conversationId, await foldersNow());
  const conversation = standingOf(whole, message.conversationId);
  const sourceId = conversationKey(message.conversationId);
  const filing = await host.emitItem({
    sourceId,
    sourceLink: message.link,
    sender: message.sender,
    sourceTimestamp: message.receivedAt,
    capturedMessage: message.text,
    title: message.title,
    choice: mark,
    names: namesOf(message.categories, mark),
    ...(dueDay ? { dueDay } : {}),
    ...(conversation ? { conversation } : {}),
  });
  if (filing === 'already-known') {
    await host.emitSourceStateChange({ sourceId, change: 'reopened', observedAt: now().toISOString() });
    // The reopen gives the connection's days first; the flag's day replaces them while the date is still the connection's.
    if (dueDay) await host.reportDueDay({ sourceId, dueDay });
  }
  return namesOf(message.categories, mark);
}
