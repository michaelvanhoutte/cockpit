//
// Every date and time the published harness reports (tools/cycle-time,
// ci-stability, selection, test-explorer, architecture) show is Belgian: the
// zone and region are fixed, since the people who read the pages are in
// Belgium and each page is a static file that cannot ask who is looking. The
// model files beside the pages keep their ISO UTC times; only what a reader
// sees goes through here. One module, so a new page cannot pick a zone of its
// own (the Harness Monitor's twin is apps/harness-monitor/src/belgium.ts).
//
// Pure: instants in, text and instants out. No clock is read.
//

export const TIME_ZONE = 'Europe/Brussels';
const LOCALE = 'en-BE';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const format = (options) => new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, hourCycle: 'h23', ...options });
const dateFormat = format({ day: 'numeric', month: 'short', year: 'numeric' });
const dayMonthFormat = format({ day: 'numeric', month: 'short' });
const minuteFormat = format({ hour: '2-digit', minute: '2-digit' });
const secondFormat = format({ hour: '2-digit', minute: '2-digit', second: '2-digit' });
const partsFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** An instant given as an ISO string, a Date or epoch milliseconds, as epoch milliseconds. */
const ms = (instant) => (typeof instant === 'number' ? instant : new Date(instant).getTime());

/** 22 Oct 2026, 15:05 */
export const formatDateTime = (instant) => `${dateFormat.format(ms(instant))}, ${minuteFormat.format(ms(instant))}`;

/** 22 Oct 2026: the Belgian day an instant falls on. */
export const formatDate = (instant) => dateFormat.format(ms(instant));

/** 22 Oct: a day without its year, where the chart around it says which. */
export const formatDayMonth = (instant) => dayMonthFormat.format(ms(instant));

/** 15:05 */
export const formatClockMinutes = (instant) => minuteFormat.format(ms(instant));

/** 15:05:09 */
export const formatClock = (instant) => secondFormat.format(ms(instant));

function partsOf(at) {
  const parts = {};
  for (const { type, value } of partsFormat.formatToParts(at)) parts[type] = Number(value);
  return parts;
}

/** The Belgian day an instant falls on, `YYYY-MM-DD`. */
export function belgianDay(instant) {
  const { year, month, day } = partsOf(ms(instant));
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Belgium's offset from UTC at an instant: an hour in winter, two in summer. */
export function offsetMs(instant) {
  const at = ms(instant);
  const { year, month, day, hour, minute, second } = partsOf(at);
  return Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(at / 1000) * 1000;
}

/**
 * The instant a Belgian day, `YYYY-MM-DD`, begins. Clocks change at 01:00 UTC,
 * after the day's Belgian midnight, so the offset at the day's UTC midnight is
 * the offset at its start: the days either side of a change are 23 and 25 hours.
 */
export function startOfDay(day) {
  const utcMidnight = Date.parse(day);
  return utcMidnight - offsetMs(utcMidnight);
}

/** The day `n` calendar days from a Belgian day (negative for earlier); calendar arithmetic, so a clock change never moves it. */
export const addDays = (day, n) => new Date(Date.parse(day) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * The instants the Belgian days begin at, from the first at or after `from`
 * to the last at or before `to`, in order.
 */
export function dayStartsBetween(from, to) {
  const out = [];
  let day = belgianDay(from);
  for (let at = startOfDay(day); at <= to; at = startOfDay(day)) {
    if (at >= from) out.push(at);
    day = addDays(day, 1);
  }
  return out;
}

/**
 * The first instant at or after `at` that is a multiple of `step` on the
 * Belgian clock, so an hourly or two-hourly tick falls on the hour the reader's
 * own clock shows rather than on the hour in Greenwich.
 */
export function nextRoundTime(at, step) {
  const local = Math.ceil((at + offsetMs(at)) / step) * step;
  for (let k = local; ; k += step) {
    // The offset in force at that clock reading: guess it from an hour before, then read it at the instant the guess gives.
    const instant = k - offsetMs(k - offsetMs(k - HOUR_MS));
    if (instant >= at) return instant;
  }
}
