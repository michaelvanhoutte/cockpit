import { and, desc, gte, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { USAGE_DEFAULT_DAYS, USAGE_MAX_DAYS, daysOnFrom, type GuestDay, type Usage } from '@cockpit/shared';
import { createDb } from '../db/client.js';
import { captureDay } from '../domain/capture-day.js';
import { dayStartsAt } from '../domain/series.js';
import { signIns, users } from '../db/schema.js';
import type { Env } from '../env.js';
import { GUEST_USER_ID } from './new-user.js';

/**
 * What the admin's Usage window shows ("Add an admin Usage window for sign-ins
 * and guest sessions", issue 654), read from the register's `sign_ins` history
 * (issue 653) and aggregated in SQL.
 */

/** A window of days, each with the instant it starts on the viewer's calendar. */
export interface UsageWindow {
  days: number;
  since: string;
  dayStarts: { day: string; startsAt: string }[];
}

/** The most sign-ins one person's history lists: the window is for a glance, not an export. */
const HISTORY_PER_PERSON = 50;

/** The most countries or referrers listed. Referrers are client input, so their number is unbounded. */
const LONGEST_BREAKDOWN = 50;

/**
 * The window a request asks for, bounded: no value, a value that is not a
 * whole number or one below 1 reads as the default, and one above the longest
 * history kept is cut to it. **Days are days on the calendar of the viewer's
 * zone and include today** ("Count Settings › Usage's days on your own
 * calendar", issue 1428), so `days: 1` is today alone, and `since` is the
 * instant the first of them began there. **No zone, or one this runtime cannot
 * read, counts in UTC.**
 *
 * Each day comes with the instant it starts (`dayStarts`, oldest first), which
 * is what a sign-in is placed on a day by: searched for rather than worked out
 * from an offset, so a day a clock change shortens or lengthens is right.
 */
export function usageWindow(asked: string | number | undefined, now: Date, timeZone?: string): UsageWindow {
  const parsed = typeof asked === 'number' ? asked : Number(asked);
  const days =
    asked === undefined || !Number.isInteger(parsed) || parsed < 1
      ? USAGE_DEFAULT_DAYS
      : Math.min(parsed, USAGE_MAX_DAYS);
  const zone = timeZone !== undefined && captureDay(now.toISOString(), timeZone) !== null ? timeZone : 'UTC';
  const today = captureDay(now.toISOString(), zone)!.date;
  const dayStarts = Array.from({ length: days }, (_, back) => {
    const day = daysOnFrom(today, back + 1 - days);
    return { day, startsAt: new Date(dayStartsAt(day, zone)!).toISOString() };
  });
  return { days, since: dayStarts[0]!.startsAt, dayStarts };
}

/** The day an instant (`...T12:15:00.000Z`) falls on: the last one that had started by then. */
function dayOf(at: string, dayStarts: UsageWindow['dayStarts']): string {
  let low = 0;
  let high = dayStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (dayStarts[middle]!.startsAt <= at) low = middle;
    else high = middle - 1;
  }
  return dayStarts[low]!.day;
}

/**
 * The Cloudflare Web Analytics address to link to, or `null` where none is
 * configured. Only an http(s) address is a link: the value is configuration,
 * but it ends up in an `href`, and a `javascript:` one must never get there.
 */
export function analyticsLink(configured: string | undefined): string | null {
  if (!configured?.trim()) return null;
  try {
    const url = new URL(configured.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export async function readUsage(
  env: Env,
  asked: string | number | undefined,
  now: Date,
  timeZone?: string,
): Promise<Usage> {
  const { days, since, dayStarts } = usageWindow(asked, now, timeZone);
  const db = createDb(env.DB);

  const guest = and(isNull(signIns.userId), gte(signIns.at, since));
  // The query cannot know the viewer's days, so it counts per quarter of an
  // hour - fine enough that none straddles a midnight, as every zone's offset
  // is a whole number of quarters - and the days are cut below. What comes
  // back is bounded by the window (at most 96 a day), not by how many guests
  // signed in.
  const quarter = sql<string>`substr(${signIns.at}, 1, 14) || printf('%02d', cast(substr(${signIns.at}, 15, 2) as integer) / 15 * 15)`;
  const sessions = sql<number>`count(*)`;

  // Five independent reads, started together: each is a D1 round trip.
  const [people, named, perQuarter, byCountry, byReferrer] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, lastSignedInAt: users.lastSignedInAt })
      .from(users)
      // Guests are one shared user with nothing to say about any one person.
      .where(ne(users.id, GUEST_USER_ID)),
    db
      .select({ userId: signIns.userId, at: signIns.at })
      .from(signIns)
      .where(and(isNotNull(signIns.userId), gte(signIns.at, since)))
      .orderBy(desc(signIns.at)),
    db
      .select({
        quarter,
        sessions,
        itemsCaptured: sql<number>`sum(${signIns.itemsCaptured})`,
        dashboardsOpened: sql<number>`sum(${signIns.dashboardsOpened})`,
      })
      .from(signIns)
      .where(guest)
      .groupBy(quarter),
    db
      .select({ country: signIns.country, sessions })
      .from(signIns)
      .where(guest)
      .groupBy(signIns.country)
      .orderBy(desc(sessions), signIns.country)
      .limit(LONGEST_BREAKDOWN),
    db
      .select({ host: signIns.referrerHost, sessions })
      .from(signIns)
      .where(guest)
      .groupBy(signIns.referrerHost)
      .orderBy(desc(sessions), signIns.referrerHost)
      .limit(LONGEST_BREAKDOWN),
  ]);

  const guestDays = new Map<string, GuestDay>();
  for (const row of perQuarter) {
    const day = dayOf(`${row.quarter}:00.000Z`, dayStarts);
    const total = guestDays.get(day) ?? { day, sessions: 0, itemsCaptured: 0, dashboardsOpened: 0 };
    total.sessions += Number(row.sessions);
    total.itemsCaptured += Number(row.itemsCaptured);
    total.dashboardsOpened += Number(row.dashboardsOpened);
    guestDays.set(day, total);
  }

  const historyOf = new Map<string, string[]>();
  for (const row of named) {
    const history = historyOf.get(row.userId!) ?? [];
    if (history.length < HISTORY_PER_PERSON) history.push(row.at);
    historyOf.set(row.userId!, history);
  }

  return {
    days,
    analyticsUrl: analyticsLink(env.WEB_ANALYTICS_URL),
    named: people
      .map((person) => ({
        userId: person.id,
        name: person.name,
        latest: person.lastSignedInAt,
        signIns: historyOf.get(person.id) ?? [],
      }))
      // Whoever signed in most recently first; people who never have, last.
      .sort((a, b) => (b.latest ?? '').localeCompare(a.latest ?? '') || a.name.localeCompare(b.name)),
    guests: {
      // Newest first; a day nobody signed in on has no row.
      perDay: [...guestDays.values()].sort((a, b) => b.day.localeCompare(a.day)),
      byCountry: byCountry.map((row) => ({ ...row, sessions: Number(row.sessions) })),
      byReferrer: byReferrer.map((row) => ({ ...row, sessions: Number(row.sessions) })),
    },
  };
}
