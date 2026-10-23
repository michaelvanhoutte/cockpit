/**
 * Every date the Monitor shows, and every day it counts in, is Belgian: the
 * zone and region are fixed, since the people who read the page are in Belgium.
 * Instants stay exact (epoch milliseconds, ISO UTC in the export); only the day
 * they fall on and the words that show them are Belgian. One module, so a new
 * page cannot pick a zone of its own.
 */

export const TIME_ZONE = 'Europe/Brussels';
const LOCALE = 'en-BE';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const dateFormat = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, day: 'numeric', month: 'short', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const partsFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** 22 Oct 2026, 15:05 */
export const formatDateTime = (ms: number) => `${dateFormat.format(ms)}, ${timeFormat.format(ms)}`;

/** 22 Oct 2026: the Belgian day an instant falls on. */
export const formatDate = (ms: number) => dateFormat.format(ms);

/** A Belgian day, `2026-10-22`, as 22 Oct 2026. Noon UTC is the same calendar day in Brussels, in winter and summer alike. */
export const formatDay = (day: string) => dateFormat.format(Date.parse(`${day}T12:00:00Z`));

/** The Belgian day an instant falls on, `YYYY-MM-DD`. */
export function belgianDay(ms: number): string {
  const parts = partsFormat.formatToParts(ms);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The day `n` calendar days from a day (negative for earlier); calendar arithmetic, so a clock change never moves it. */
export const addDays = (day: string, n: number) => new Date(Date.parse(day) + n * DAY_MS).toISOString().slice(0, 10);

/** The Monday of the week a day falls in. */
export function weekStart(day: string): string {
  const t = Date.parse(day);
  return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}

/** Last Sunday of a month (0-based), 01:00 UTC: when the EU changes its clocks. */
function lastSundayAt1Utc(year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, lastDay.getUTCDate() - lastDay.getUTCDay(), 1);
}

/** Belgium's offset from UTC in milliseconds at an instant: two hours from the last Sunday of March to the last of October, else one. */
export function offsetMs(ms: number): number {
  const year = new Date(ms).getUTCFullYear();
  return ms >= lastSundayAt1Utc(year, 2) && ms < lastSundayAt1Utc(year, 9) ? 2 * HOUR_MS : HOUR_MS;
}

/** The instant a Belgian day begins. Clocks change at 01:00 UTC, after midnight in Brussels, so the offset at the day's UTC midnight is the offset at its start. */
export function startOfDay(day: string): number {
  const utcMidnight = Date.parse(day);
  return utcMidnight - offsetMs(utcMidnight);
}

/** The years whose clock changes the SQL below knows; an instant outside them is read at winter time. */
const FIRST_YEAR = 2024;
const LAST_YEAR = 2099;

/**
 * The Belgian day of an epoch-milliseconds column, as SQL: SQLite has no time
 * zones, so the clock changes are written out. `Intl` and this agree on every
 * instant from FIRST_YEAR to LAST_YEAR (a unit test sweeps both).
 */
export function belgianDaySql(column: string): string {
  const summers: string[] = [];
  for (let year = FIRST_YEAR; year <= LAST_YEAR; year++) {
    summers.push(`WHEN ${column} >= ${lastSundayAt1Utc(year, 2)} AND ${column} < ${lastSundayAt1Utc(year, 9)} THEN ${2 * HOUR_MS}`);
  }
  return `date((${column} + CASE ${summers.join(' ')} ELSE ${HOUR_MS} END) / 1000, 'unixepoch')`;
}
