import { deviceTimeZone } from './deviceTimeZone';

/**
 * The one place a date or time becomes words ("Show every date the app shows in
 * your own time zone and region", issue 1427). `eslint.config.mjs` fails a
 * component that formats one itself, so a new screen cannot pick its own zone
 * or locale; the rule it holds is in `docs/product/across-the-app.md`.
 *
 * **Both inputs are read from the device each time something is drawn**, never
 * kept: the zone is the browser's now, and the region is the first of
 * `navigator.languages` that names one, written as English with that region
 * (`nl-BE` reads as `en-BE`, `fr, nl-BE` as `en-BE`, `fr` as plain `en`). A
 * region the platform has no English data for falls back to US order, which is
 * the cost of keeping the words English.
 */

/** The English a browser's languages ask for: with the region of the first that names one. */
export function englishOf(languages: readonly string[]): string {
  for (const tag of languages) {
    try {
      const { region } = new Intl.Locale(tag);
      if (region) return `en-${region}`;
    } catch {
      // A tag the platform cannot read names no region.
    }
  }
  return 'en';
}

function deviceLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/** What each way of writing a moment or a day asks of `Intl`. */
const SHAPES = {
  dateTime: { dateStyle: 'medium', timeStyle: 'short' },
  date: { dateStyle: 'medium' },
  time: { hour: '2-digit', minute: '2-digit' },
  weekdayAndDay: { weekday: 'short', day: 'numeric', month: 'short' },
  dayAndMonth: { day: 'numeric', month: 'short' },
  dayAndMonthAndYear: { day: 'numeric', month: 'short', year: '2-digit' },
  weekdayAndDate: { weekday: 'long', day: 'numeric', month: 'long' },
  weekdayAndDateAndYear: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  dateInFull: { day: 'numeric', month: 'long' },
  dateInFullAndYear: { day: 'numeric', month: 'long', year: 'numeric' },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

type Shape = keyof typeof SHAPES;

/** One per locale, zone and shape: constructing one resolves locale data, and a zone that changed is a different key. */
const formats = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, zone: string | undefined, shape: Shape): Intl.DateTimeFormat {
  const key = `${locale}|${zone ?? ''}|${shape}`;
  let format = formats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { ...SHAPES[shape], ...(zone ? { timeZone: zone } : {}) });
    formats.set(key, format);
  }
  return format;
}

/** Plain spaces, whatever the platform puts before AM or PM. */
const tidy = (words: string) => words.replace(/[  ]/g, ' ');

/** A moment, in the device's zone. */
function at(shape: Shape, instant: string | number | Date): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return String(instant);
  return tidy(formatter(englishOf(deviceLanguages()), deviceTimeZone(), shape).format(date));
}

/** A day with no time, the same day in every zone. `null` for anything that is not a date. */
function onTheDay(shape: Shape, day: string): string | null {
  const date = new Date(day);
  if (Number.isNaN(date.getTime())) return null;
  return tidy(formatter(englishOf(deviceLanguages()), 'UTC', shape).format(date));
}

/** *22 Oct 2026, 15:05* (nl-BE) or *Oct 22, 2026, 3:05 PM* (en-US): a moment, in the device's zone. */
export const dateTimeLabel = (instant: string | number | Date) => at('dateTime', instant);

/** The day a moment falls on in the device's zone, with no time. */
export const momentDateLabel = (instant: string | number | Date) => at('date', instant);

/** The clock time of a moment in the device's zone. */
export const timeOfDayLabel = (instant: string | number | Date) => at('time', instant);

/**
 * When a note was added to an Item, as its *Details* tab says it (*Added 14:32*,
 * issue 1640): the clock time where it was added on the day the Item was
 * captured, on the device's calendar, and the date with it on any other day.
 */
export function addedLabel(addedAt: string, capturedAt: string): string {
  return momentDateLabel(addedAt) === momentDateLabel(capturedAt) ? timeOfDayLabel(addedAt) : dateTimeLabel(addedAt);
}

/** A day with no time attached (a due date), written in the region's order and never moved by the zone. */
export const dayLabel = (day: string) => onTheDay('date', day);

/** The day a moment falls on in the device's zone, with its weekday (*Fri 23 Oct*): what *Waiting since* says. */
export const momentWeekdayDayLabel = (instant: string | number | Date) => at('weekdayAndDay', instant);

/** A day with its weekday (*Mon 2 Nov*), as a repeating rule's read-back says its days. */
export const weekdayDayLabel = (day: string) => onTheDay('weekdayAndDay', day) ?? day;

/**
 * A day as a phone's narrow strip shows it: day and month, with a two-digit
 * year only when it is not in `now`'s year on the device's calendar.
 */
export function shortDayLabel(day: string, now: Date): string | null {
  const date = new Date(day);
  if (Number.isNaN(date.getTime())) return null;
  const thisYear = deviceCalendar(now).getUTCFullYear();
  return onTheDay(date.getUTCFullYear() === thisYear ? 'dayAndMonth' : 'dayAndMonthAndYear', day);
}

/** A day heading with its weekday (*Thursday 22 October*), the year only where `withYear`. */
export const weekdayDateLabel = (instant: Date, withYear: boolean) =>
  at(withYear ? 'weekdayAndDateAndYear' : 'weekdayAndDate', instant);

/** A date in full words (*22 October*), the year only where `withYear`. */
export const dateInFullLabel = (instant: Date, withYear: boolean) =>
  at(withYear ? 'dateInFullAndYear' : 'dateInFull', instant);

/** Zone and parts only: no locale decides a number here, so the calendar below is the same for every region. */
const calendars = new Map<string, Intl.DateTimeFormat>();

/**
 * A moment's calendar and clock as the device reads them, carried in a UTC
 * date so its UTC fields are the device's (`getUTCDate()` is the day on the
 * device's calendar). For arithmetic on the device's months and days, where a
 * moment's own local fields would follow the zone the platform started in.
 */
export function deviceCalendar(instant: Date | number): Date {
  const zone = deviceTimeZone();
  const key = zone ?? '';
  let format = calendars.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
      ...(zone ? { timeZone: zone } : {}),
    });
    calendars.set(key, format);
  }
  const part: Record<string, number> = {};
  for (const { type, value } of format.formatToParts(instant)) part[type] = Number(value);
  return new Date(
    Date.UTC(part.year!, part.month! - 1, part.day!, part.hour!, part.minute!, part.second!),
  );
}
