import { and, eq, isNull } from 'drizzle-orm';
import { firstDayAfter } from '@cockpit/shared';
import type { AccountDb } from './client.js';
import { getSeries, listRunningSeries } from './repo.js';
import { whyItFailed } from './retire-agents.js';
import { series } from './schema.js';
import { captureDay } from '../domain/capture-day.js';
import { occurrenceDueAt } from '../domain/series.js';

/**
 * What the account's alarm reads and writes of its series beside the change
 * that brings one back ("Bring a repeating Item back on its day, as a fresh
 * copy", issue 1407): when the next is due, and a day already written passed
 * over.
 */

/** When the account's next series is due - the start of its Next on, on its own calendar - or null where none is running. */
export function nextOccurrenceDueAt(db: AccountDb, tenantId: string): number | null {
  const due = listRunningSeries(db, tenantId).map(occurrenceDueAt);
  return due.length === 0 ? null : Math.min(...due);
}

/**
 * Moves a series past a day whose Item is already written - its Next on put
 * back on that day after it came round - to the first day it comes round after
 * today, as coming round would have. **Only while Next on is still that day**,
 * so a change landing in between is never overwritten. Logged, ids only.
 */
export function passOverADayBroughtBack(db: AccountDb, tenantId: string, seriesId: string, day: string, at: string): void {
  const own = getSeries(db, tenantId, seriesId);
  if (!own || own.stoppedAt !== null || own.nextOn !== day) return;
  const today = captureDay(at, own.timeZone)?.date ?? captureDay(at, 'UTC')!.date;
  db.update(series)
    .set({ nextOn: firstDayAfter(own.anchorOn ?? own.nextOn, own.frequency, today), lastOn: day })
    .where(and(eq(series.tenantId, tenantId), eq(series.id, seriesId), eq(series.nextOn, day), isNull(series.stoppedAt)))
    .run();
  console.info(
    JSON.stringify({ level: 'info', message: 'a series passed over a day already brought back', data: { seriesId, day } }),
  );
}

/** A series, or every series, the alarm could not bring back - with why, but none of the person's words (`whyItFailed`). */
export function occurrenceNotBroughtBack(message: string, error: unknown): void {
  console.error(JSON.stringify({ level: 'error', message, cause: whyItFailed(error) }));
}
