import type { ConversationTurnBy, Item } from '@cockpit/shared';
import { dueDateOnArrival } from './due-in-days.js';

/**
 * Who moved last in a conversation decides an Item's status ("A Gmail starred
 * conversation is one Item whose status follows who wrote last", issue 1705):
 * one rule for every source, which reports only who wrote (architecture,
 * "Connectors: plugin-shaped, host-blind"). Pure, as every domain handler is.
 */

/** The days a turn's due date is counted with: the connection's, where it gives some, and the Follow-ups delay. */
export interface TurnDays {
  connectionDays: number | null;
  followUpDays: number;
}

/**
 * The due date a turn gives: **yours** waits the Follow-ups delay, as *Wait for
 * reply…* does; **theirs** is due after the connection's days, else the
 * Follow-ups delay. Counted from the day the turn is recorded, on the calendar
 * of the account's latest capture zone, as a connection's date on arrival is
 * (`dueDateOnArrival`).
 */
export function turnDueDate(by: ConversationTurnBy, recordedAt: string, zones: readonly string[], days: TurnDays): string {
  const counted = by === 'you' ? days.followUpDays : (days.connectionDays ?? days.followUpDays);
  return dueDateOnArrival(recordedAt, zones, counted);
}

/**
 * What a turn does to the Item following the conversation, or null where it
 * does nothing:
 *
 * - **Yours**: Waiting for reply, as *Wait for reply…* makes it - waiting since
 *   it first started waiting, so a second message of yours moves only the date.
 * - **Theirs**: To do, the wait and any start taken back.
 * - **Either replaces the due date**, one set by hand included. The date is the
 *   source's, not the person's choice, so the marker that a reading may not
 *   replace it is left as it was.
 * - **A finished or dismissed Item, nothing**: Done ended the following.
 * - **Never refused as stale**: the turn is recorded on the store's clock as it
 *   arrives, so it is the latest change, and the later wins. An Item last
 *   changed "after" it was so only by a device clock running fast, as a
 *   source's own change is clamped for (`applySourceStateChange`); its
 *   `updatedAt` is kept rather than moved back.
 */
/**
 * The status an Item had when *Email…* or *Reply…* was pressed on it, kept on
 * its conversation's row (`status_before_draft`) until the draft is sent or
 * gone ("Email… makes a Gmail draft the Item then follows", issue 1708), and
 * whether the draft started the conversation - which, deleted unsent, leaves
 * nothing to follow.
 */
export interface StatusBeforeDraft {
  startedAt: string | null;
  waitingSince: string | null;
  opened: boolean;
}

/** `status_before_draft` as stored, read - or null where no draft is waited on, or the text is not one this wrote. */
export function statusBeforeDraftIn(stored: string | null): StatusBeforeDraft | null {
  if (stored === null) return null;
  try {
    const held = JSON.parse(stored) as Partial<StatusBeforeDraft>;
    const time = (value: unknown) => (typeof value === 'string' ? value : null);
    return { startedAt: time(held.startedAt), waitingSince: time(held.waitingSince), opened: held.opened === true };
  } catch {
    return null;
  }
}

/** The Item's status as a draft's row keeps it. */
export function statusBeforeDraftOf(item: Item, opened: boolean): string {
  return JSON.stringify({ startedAt: item.startedAt, waitingSince: item.waitingSince, opened } satisfies StatusBeforeDraft);
}

/**
 * *Email…* pressed: In progress, started now unless it already was, the wait
 * taken off - as *In progress* on Status makes it (`applySetStarted`). Stamped
 * on the store's clock, so never refused as stale; a later `updatedAt` is kept.
 */
export function applyStartDraft(item: Item, at: string): Item {
  return {
    ...item,
    startedAt: item.startedAt ?? at,
    waitingSince: null,
    updatedAt: at < item.updatedAt ? item.updatedAt : at,
  };
}

/**
 * A draft never made, or deleted unsent: the status the Item had before the
 * click put back - only while it is still In progress as the click left it,
 * since a status set by hand meanwhile is the person's later word. Null where
 * nothing changes: the Item finished, dismissed, or moved on.
 */
export function applyDropDraft(item: Item, before: StatusBeforeDraft, at: string): Item | null {
  if (item.completedAt !== null || item.deletedAt !== null) return null;
  if (item.startedAt === null || item.waitingSince !== null) return null;
  return {
    ...item,
    startedAt: before.startedAt,
    waitingSince: before.waitingSince,
    updatedAt: at < item.updatedAt ? item.updatedAt : at,
  };
}

export function applyConversationTurn(
  item: Item,
  turn: { by: ConversationTurnBy; recordedAt: string },
  dueDate: string,
): Item | null {
  if (item.completedAt !== null || item.deletedAt !== null) return null;
  const updatedAt = turn.recordedAt < item.updatedAt ? item.updatedAt : turn.recordedAt;
  const due = { dueDate, dueDateSetAt: turn.recordedAt, updatedAt };
  return turn.by === 'you'
    ? { ...item, ...due, waitingSince: item.waitingSince ?? turn.recordedAt }
    : { ...item, ...due, startedAt: null, waitingSince: null };
}
