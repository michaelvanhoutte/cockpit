import { dayOf } from './filters';

/**
 * What a due date reads as, and how it tints a row ("Colour an action's own
 * deadline as it approaches, and mark it red once passed", issue 473).
 *
 * Both are pure, and given `now`/`locale` rather than reading a clock or
 * `navigator`, so they are provable without either (the testing skill's
 * L1/F1 restriction on the clock, the same reason `waited.ts` is).
 */

const DUE_DATE_FORMATS = new Map<string | undefined, Intl.DateTimeFormat>();

/**
 * `Intl.DateTimeFormat` construction resolves locale data and is worth paying
 * for once per locale rather than once per row per render (the same reasoning
 * `AdminPage.tsx`'s `SIGNED_IN_FORMAT` gives).
 */
function dueDateFormat(locale: string | undefined): Intl.DateTimeFormat {
  const cached = DUE_DATE_FORMATS.get(locale);
  if (cached) return cached;
  const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  DUE_DATE_FORMATS.set(locale, format);
  return format;
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
  return Number.isNaN(parsed.getTime()) ? null : dueDateFormat(locale).format(parsed);
}

/** How an Item's row is tinted by its own due date, or left plain. */
export type DueColor = { kind: 'none' } | { kind: 'due'; intensity: number } | { kind: 'overdue' };

/**
 * Calm for most of the window between when a due date was set and when it is
 * due, warming into `due` amber only in the final stretch - a quadratic
 * ease-in on the elapsed fraction, so a quarter-long deadline stays calm for
 * weeks and a week-long one heats up within days. Once the due date has
 * passed, by the viewer's own calendar day (mirroring the Filter's own
 * due-date windows, `filters.ts`'s `holdsFor`), the answer is `overdue`
 * however long past it is - there is no further escalation.
 */
export function dueColorOf(
  dueDate: string | null,
  dueDateSetAt: string | null,
  createdAt: string,
  now: number,
): DueColor {
  if (dueDate === null) return { kind: 'none' };
  if (dueDate < dayOf(new Date(now))) return { kind: 'overdue' };

  // An item that already carried a due date before this shipped has no
  // `dueDateSetAt` of its own - the ramp falls back to when the item itself
  // was made rather than a backfill migration.
  const setAt = Date.parse(dueDateSetAt ?? createdAt);
  const due = Date.parse(`${dueDate}T00:00:00.000Z`);
  const span = due - setAt;
  const fraction = span > 0 ? Math.min(1, Math.max(0, (now - setAt) / span)) : 1;
  return { kind: 'due', intensity: fraction * fraction };
}
