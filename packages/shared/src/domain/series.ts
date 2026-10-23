import { z } from 'zod';
import { captureTimeZoneSchema } from './item.js';

/**
 * A recurring item's rule: a series row in the account's store, which each Item
 * that is one of its copies names by `seriesId`. The rule is the series', never
 * copied onto an Item, so *Next on* and a deletion have one owner however many
 * copies exist.
 */

/** How often, in the order the Recurring items form offers them. */
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
 * deleting the recurring item, and a stopped series is still named by the Items
 * that belong to it. `timeZone` is the browser's when the rule was set: a day
 * starts at midnight there. `title` and `workspaceId` are the recurring item's
 * own, enough for a copy's *From recurring item* line and its mark ("Point a copy
 * at its master, and retire the Repeats chip", issue 1450): both null on a
 * series that was never made into a recurring item.
 */
export const seriesSchema = repeatRuleSchema.extend({
  id: z.uuid(),
  tenantId: z.string(),
  timeZone: captureTimeZoneSchema,
  stoppedAt: z.iso.datetime().nullable(),
  title: z.string().nullable().default(null),
  workspaceId: z.string().nullable().default(null),
});
export type Series = z.infer<typeof seriesSchema>;

/** The recurring item a copy came from, as the copy's line and mark say it. */
export interface RecurringOrigin {
  id: string;
  title: string;
  /** The Workspace the recurring item is listed in, which is where its form opens. */
  workspaceId: string | null;
  /** False once the recurring item is deleted: the copies stay and name it. */
  running: boolean;
  rule: RepeatRule;
}

/**
 * The recurring item an Item is a copy of, or null for an Item that is no copy -
 * or one of a series that was never made into a recurring item, which has no
 * title to say. A deleted recurring item is still named (`running` false).
 */
export function recurringOriginOf(
  item: { seriesId: string | null },
  series: readonly Series[] | undefined,
): RecurringOrigin | null {
  const own = item.seriesId === null ? undefined : series?.find((one) => one.id === item.seriesId);
  if (!own || own.title === null) return null;
  return {
    id: own.id,
    title: own.title,
    workspaceId: own.workspaceId,
    running: own.stoppedAt === null,
    rule: { frequency: own.frequency, nextOn: own.nextOn, dueAfterDays: own.dueAfterDays },
  };
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

/**
 * The day `count` periods after `day`, every period counted from `day` itself: so
 * monthly from the 31st falls on the last day of a shorter month and is the 31st
 * again the month after, and yearly from 29 February is 28 February between leap years.
 */
export function periodsAfter(day: string, frequency: RepeatFrequency, count: number): string {
  switch (frequency) {
    case 'daily':
      return daysOnFrom(day, count);
    case 'weekly':
      return daysOnFrom(day, 7 * count);
    case 'monthly':
      return monthsOnFrom(day, count);
    case 'quarterly':
      return monthsOnFrom(day, 3 * count);
    case 'yearly':
      return monthsOnFrom(day, 12 * count);
  }
}

/** The day one period after `day`. */
export function onePeriodAfter(day: string, frequency: RepeatFrequency): string {
  return periodsAfter(day, frequency, 1);
}

/** About how many whole periods lie from `from` to `to`: a start for the count, never past it by more than one. */
function periodsBetween(from: string, to: string, frequency: RepeatFrequency): number {
  const a = partsOf(from);
  const b = partsOf(to);
  if (frequency === 'daily' || frequency === 'weekly') {
    const days = Math.floor((utcDay(b.year, b.month, b.date).getTime() - utcDay(a.year, a.month, a.date).getTime()) / 86_400_000);
    return Math.floor(days / (frequency === 'daily' ? 1 : 7));
  }
  const months = b.year * 12 + b.month - (a.year * 12 + a.month);
  return Math.floor(months / { monthly: 1, quarterly: 3, yearly: 12 }[frequency]);
}

/**
 * The first day a series anchored on `anchor` comes round after `after`, and
 * `anchor` itself where that is later ("Bring a repeating Item back on its day",
 * issue 1407). Never `after` or a day before it, which is what keeps an
 * occurrence off a day already passed.
 */
export function firstDayAfter(anchor: string, frequency: RepeatFrequency, after: string): string {
  if (anchor > after) return anchor;
  let count = Math.max(1, periodsBetween(anchor, after, frequency));
  while (count > 1 && periodsAfter(anchor, frequency, count - 1) > after) count -= 1;
  while (periodsAfter(anchor, frequency, count) <= after) count += 1;
  return periodsAfter(anchor, frequency, count);
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

/** *Weekly on Monday* - the rule alone, which is also what the row's ↻ says on hover after "Recurring". */
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

/** The row's hover: *Recurring weekly on Monday*. */
export function recurringTitle(rule: Pick<RepeatRule, 'frequency' | 'nextOn'>): string {
  return `Recurring ${ruleLabel(rule).replace(/^./u, (first) => first.toLowerCase())}`;
}

/**
 * The line under the popover's controls: *Weekly on Monday · next Mon 2 Nov · due Sat 7 Nov*.
 * The days are written by `say`, which a screen hands its viewer's region
 * ("Show every date the app shows in your own time zone and region", issue
 * 1427); `shortDay` is the one that needs no viewer.
 */
export function readBack(rule: RepeatRule, say: (day: string) => string = shortDay): string {
  const parts = [ruleLabel(rule), `next ${say(rule.nextOn)}`];
  if (rule.dueAfterDays !== null) parts.push(`due ${say(daysOnFrom(rule.nextOn, rule.dueAfterDays))}`);
  return parts.join(' · ');
}
