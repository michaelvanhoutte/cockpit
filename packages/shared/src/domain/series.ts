import { z } from 'zod';
import { captureTimeZoneSchema } from './item.js';

/**
 * A repeating Item's rule ("Repeat an Item on a schedule, so it comes back
 * every Monday or every quarter", issue 1405): a series row in the account's
 * store, which each Item that is one of its occurrences names by `seriesId`.
 * The rule is the series', never copied onto an Item, so *Next on* and *Never*
 * have one owner however many occurrences exist.
 */

/** How often, in the order the Repeats popover offers them. *Never* is no series running, not a frequency. */
export const REPEAT_FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const;
export const repeatFrequencySchema = z.enum(REPEAT_FREQUENCIES);
export type RepeatFrequency = z.infer<typeof repeatFrequencySchema>;

/** The longest gap from the day an occurrence appears to its due date: a year and a leap day. */
export const MOST_DUE_AFTER_DAYS = 366;

/**
 * What the person sets: how often, the day the series is anchored to (*Next on*),
 * and how many calendar days after an occurrence appears it falls due (null for
 * no due date).
 */
export const repeatRuleSchema = z.object({
  frequency: repeatFrequencySchema,
  nextOn: z.iso.date(),
  dueAfterDays: z.number().int().min(0).max(MOST_DUE_AFTER_DAYS).nullable(),
});
export type RepeatRule = z.infer<typeof repeatRuleSchema>;

/**
 * The series as the Workspace snapshot carries it. `stoppedAt` is set by
 * *Never*, and a stopped series is still named by the Items that belong to it.
 * `timeZone` is the browser's when the rule was set: a day starts at midnight
 * there.
 */
export const seriesSchema = repeatRuleSchema.extend({
  id: z.uuid(),
  tenantId: z.string(),
  timeZone: captureTimeZoneSchema,
  stoppedAt: z.iso.datetime().nullable(),
});
export type Series = z.infer<typeof seriesSchema>;

/** The rule an Item repeats by, or null where it has none or its series is stopped. */
export function repeatOf(
  item: { seriesId: string | null },
  series: readonly Series[] | undefined,
): RepeatRule | null {
  const own = item.seriesId === null ? undefined : series?.find((one) => one.id === item.seriesId);
  if (!own || own.stoppedAt !== null) return null;
  return { frequency: own.frequency, nextOn: own.nextOn, dueAfterDays: own.dueAfterDays };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** A `YYYY-MM-DD` day as numbers; the calendar is the day's own, never a time zone's. */
function partsOf(day: string): { year: number; month: number; date: number } {
  const [year, month, date] = day.split('-').map(Number);
  return { year: year!, month: month!, date: date! };
}

function dayFrom(year: number, month: number, date: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
}

/**
 * A day as a UTC instant. `Date.UTC` reads years 0 to 99 as 1900 to 1999, so a half-typed
 * year would name the wrong weekday; `setUTCFullYear` does not.
 */
function utcDay(year: number, month: number, date: number): Date {
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, date);
  return at;
}

const daysInMonth = (year: number, month: number) => utcDay(year, month + 1, 0).getUTCDate();

/** The day `count` calendar days on. Built from the day's parts, as `toISOString` is no `YYYY-MM-DD` past the year 9999. */
export function daysOnFrom(day: string, count: number): string {
  const { year, month, date } = partsOf(day);
  const on = utcDay(year, month, date + count);
  return dayFrom(on.getUTCFullYear(), on.getUTCMonth() + 1, on.getUTCDate());
}

/** The day `count` months on, or the last day of that month where it is shorter (31 Jan + 1 month is 28 or 29 Feb). */
function monthsOnFrom(day: string, count: number): string {
  const { year, month, date } = partsOf(day);
  const index = year * 12 + (month - 1) + count;
  const [toYear, toMonth] = [Math.floor(index / 12), (index % 12) + 1];
  return dayFrom(toYear, toMonth, Math.min(date, daysInMonth(toYear, toMonth)));
}

/** The day one period after `day`. */
export function onePeriodAfter(day: string, frequency: RepeatFrequency): string {
  switch (frequency) {
    case 'daily':
      return daysOnFrom(day, 1);
    case 'weekly':
      return daysOnFrom(day, 7);
    case 'monthly':
      return monthsOnFrom(day, 1);
    case 'quarterly':
      return monthsOnFrom(day, 3);
    case 'yearly':
      return monthsOnFrom(day, 12);
  }
}

/** Where *Next on* starts when a frequency is first picked: one period from today. */
export const firstNextOn = onePeriodAfter;

/** `Mon 2 Nov` - a day as the read-back says it. */
export function shortDay(day: string): string {
  const { year, month, date } = partsOf(day);
  const weekday = WEEKDAYS[utcDay(year, month, date).getUTCDay()]!;
  return `${weekday.slice(0, 3)} ${date} ${MONTHS[month - 1]}`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** *Weekly on Monday* - the rule alone, which is also what the row's ↻ says on hover after "Repeats". */
export function ruleLabel(rule: Pick<RepeatRule, 'frequency' | 'nextOn'>): string {
  const { year, month, date } = partsOf(rule.nextOn);
  switch (rule.frequency) {
    case 'daily':
      return 'Daily';
    case 'weekly':
      return `Weekly on ${WEEKDAYS[utcDay(year, month, date).getUTCDay()]}`;
    case 'monthly':
      return `Monthly on the ${ordinal(date)}`;
    case 'quarterly': {
      const months = [0, 3, 6, 9].map((step) => MONTHS[(month - 1 + step) % 12]);
      return `Quarterly on the ${ordinal(date)} of ${months.join(', ')}`;
    }
    case 'yearly':
      return `Yearly on ${date} ${MONTHS_LONG[month - 1]}`;
  }
}

/** The row's hover: *Repeats weekly on Monday*. */
export function repeatsTitle(rule: Pick<RepeatRule, 'frequency' | 'nextOn'>): string {
  return `Repeats ${ruleLabel(rule).replace(/^./u, (first) => first.toLowerCase())}`;
}

/** The line under the popover's controls: *Weekly on Monday · next Mon 2 Nov · due Sat 7 Nov*. */
export function readBack(rule: RepeatRule): string {
  const parts = [ruleLabel(rule), `next ${shortDay(rule.nextOn)}`];
  if (rule.dueAfterDays !== null) parts.push(`due ${shortDay(daysOnFrom(rule.nextOn, rule.dueAfterDays))}`);
  return parts.join(' · ');
}

/** Whether two rules say the same thing; a rule is compared whole, never field by field by a caller. */
export function sameRule(a: RepeatRule | null, b: RepeatRule | null): boolean {
  if (a === null || b === null) return a === b;
  return a.frequency === b.frequency && a.nextOn === b.nextOn && a.dueAfterDays === b.dueAfterDays;
}
