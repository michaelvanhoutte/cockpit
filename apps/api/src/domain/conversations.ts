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
