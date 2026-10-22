import type { AccountDb } from './client.js';
import { listRunningSeries } from './repo.js';
import { whyItFailed } from './retire-agents.js';
import { occurrenceDueAt } from '../domain/series.js';

/**
 * What the account's alarm reads of its series beside the change that brings
 * one back ("Bring a repeating Item back on its day, as a fresh copy", issue
 * 1407): when the next is due, and what it says when one cannot be brought back.
 */

/**
 * When the account's next series is due - the start of its Next on, on its own
 * calendar - or null where none is running. With `retry`, a series already due
 * by `retry.triedAt` is one the alarm just failed to bring back, and is due
 * again at `retry.retryAt`, so it holds back no other series.
 */
export function nextOccurrenceDueAt(
  db: AccountDb,
  tenantId: string,
  retry?: { triedAt: number; retryAt: number },
): number | null {
  const due = listRunningSeries(db, tenantId)
    .map(occurrenceDueAt)
    .map((at) => (retry !== undefined && at <= retry.triedAt ? retry.retryAt : at));
  return due.length === 0 ? null : Math.min(...due);
}

/** A series, or every series, the alarm could not bring back - with why, but none of the person's words (`whyItFailed`). */
export function occurrenceNotBroughtBack(message: string, error: unknown): void {
  console.error(JSON.stringify({ level: 'error', message, cause: whyItFailed(error) }));
}
