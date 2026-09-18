import { dayOf } from './filters';

/**
 * What a due date reads as, and how it tints a row ("Colour an action's own
 * deadline as it approaches, and mark it red once passed", issue 473).
 *
 * Both are pure, and given `now`/`locale` rather than reading a clock or
 * `navigator`, so they are provable without either (the testing skill's
 * L1/F1 restriction on the clock, the same reason `waited.ts` is).
 */

/**
 * How an Item's row is tinted by its own due date: `null` for none, the
 * ease-in intensity (0-1) toward `due` while it's still ahead, or `-1` once
 * it has passed - the ramp itself can never go negative, so this is
 * unambiguous without a second field.
 */
export type DueColor = number | null;

/**
 * Calm for most of the window between when a due date was set and when it is
 * due, warming into `due` amber only in the final stretch - a quadratic
 * ease-in on the elapsed fraction, so a quarter-long deadline stays calm for
 * weeks and a week-long one heats up within days. Once the due date has
 * passed, by the viewer's own calendar day (mirroring the Filter's own
 * due-date windows, `filters.ts`'s `holdsFor`), the answer is `-1` however
 * long past it is - there is no further escalation.
 */
export function dueColorOf(
  dueDate: string | null,
  dueDateSetAt: string | null,
  createdAt: string,
  now: number,
): DueColor {
  if (dueDate === null) return null;
  if (dueDate < dayOf(new Date(now))) return -1;

  // An item that already carried a due date before this shipped has no
  // `dueDateSetAt` of its own - the ramp falls back to when the item itself
  // was made rather than a backfill migration.
  const setAt = Date.parse(dueDateSetAt ?? createdAt);
  // A date-only string is already UTC midnight, per the Date Time String
  // Format (ECMA-262) - the same rule `dueDateLabel`'s `new Date(dueDate)`
  // below leans on, so this needs no time appended to get the same anchor.
  const span = Date.parse(dueDate) - setAt;
  // Squared for the ease-in, once elapsed is a fraction of the window (or
  // already full, for a window that has none left to elapse).
  return span > 0 ? Math.min(1, Math.max(0, (now - setAt) / span)) ** 2 : 1;
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
