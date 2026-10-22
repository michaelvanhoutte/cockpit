import { captureDay } from './capture-day.js';

/**
 * The due date a connection gives an Item that arrives at `arrivedAt`: `days`
 * calendar days after the day it arrived ("Give each email a Gmail or Outlook
 * connection brings in a due date a set number of days out", issue 1409).
 *
 * **The day it arrives in Cockpit, never the message's own date**, so a
 * conversation labelled months ago is not overdue on arrival. **Read on the
 * calendar of the account's latest capture zone** - the first of `zones`, most
 * recent first, this runtime can read, the same list a capture's due date is
 * read on (`recentCapturedTimeZones`) - **else UTC**: no zone to read is not a
 * reason to give no date.
 */
export function dueDateOnArrival(arrivedAt: string, zones: readonly string[], days: number): string {
  const arrival = zones.map((zone) => captureDay(arrivedAt, zone)).find((day) => day !== null) ?? captureDay(arrivedAt, 'UTC');
  if (arrival === null) throw new RangeError(`not an instant: ${arrivedAt}`);
  const [year, month, day] = arrival.date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * Whether an Item's due date is still the one its connection gave: the person
 * has neither set nor cleared it, and it is the date the link recorded. A
 * reading that replaced it leaves the two apart, as does a person.
 */
export function dueDateIsTheConnections(
  item: { dueDate: string | null; dueDateChosenAt: string | null },
  given: string | null,
): boolean {
  return given !== null && item.dueDateChosenAt === null && item.dueDate === given;
}
