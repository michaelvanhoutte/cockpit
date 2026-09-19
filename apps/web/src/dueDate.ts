import { dayOf } from './filters';

/**
 * How near a due date is, as the pill a row wears for it. Replaces the row's
 * own colour ("Colour an action's own deadline as it approaches, and mark it
 * red once passed", issue 473), which read as unclear across a whole list: the
 * row stays ordinary and only the pill says how near the deadline is.
 *
 * Pure, and given `now` rather than reading a clock, so it is provable without
 * one (the testing skill's L1/F1 restriction, the same reason `waited.ts` is).
 */
export type DeadlineLevel = 'week' | 'near' | 'today' | 'over';

export interface Deadline {
  level: DeadlineLevel;
  /** What the pill says: "Due in 5d", "Due tomorrow", "Due today", "Overdue 2d". */
  label: string;
}

/** How many days ahead a deadline starts to show at all: further out, the date on the meta line is all there is. */
export const DEADLINE_SHOWS_WITHIN_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * The pill for a due date, or `null` while it is further off than a week, for
 * no due date, and for anything that is not really a date. Counted in the
 * viewer's own calendar days, the way the Filter's own due-date windows are
 * (`filters.ts`'s `holdsFor`): a date-only string is UTC midnight, and so is
 * what `dayOf` answers for today, so their difference is a whole number of
 * days.
 *
 * Calm at a distance and louder as it closes: a quiet outline within a week, a
 * soft fill within two days, solid on the day, red once passed - and no further
 * escalation however long past it is, only the count.
 */
export function deadlineOf(dueDate: string | null, now: number): Deadline | null {
  if (dueDate === null) return null;
  const days = Math.round((Date.parse(dueDate) - Date.parse(dayOf(new Date(now)))) / DAY_MS);
  if (Number.isNaN(days)) return null;
  if (days < 0) return { level: 'over', label: `Overdue ${-days}d` };
  if (days === 0) return { level: 'today', label: 'Due today' };
  if (days === 1) return { level: 'near', label: 'Due tomorrow' };
  if (days === 2) return { level: 'near', label: 'Due in 2d' };
  if (days <= DEADLINE_SHOWS_WITHIN_DAYS) return { level: 'week', label: `Due in ${days}d` };
  return null;
}

/**
 * What a due date reads as on the row, or `null` for none and for anything
 * that is not really a date. Defensive the same way `usableInstant`
 * (`AdminPage.tsx`) is: `dueDate` is store-validated, but a row does not
 * crash on a value it did not itself write.
 *
 * `locale` follows the viewer's own browser rather than a fixed `en-US` -
 * `undefined` in production, which `Intl.DateTimeFormat` resolves to the
 * browser's own; a caller passes one explicitly only to test the formatting.
 * The `UTC` timezone pin is unrelated and unchanged: it is what keeps a
 * date-only value from shifting a day under a negative-UTC-offset timezone.
 */
export function dueDateLabel(dueDate: string | null, locale?: string): string | null {
  if (dueDate === null) return null;
  const parsed = new Date(dueDate);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(parsed);
}
