import { and, desc, gte, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { USAGE_DEFAULT_DAYS, USAGE_MAX_DAYS, type Usage } from '@cockpit/shared';
import { createDb } from '../db/client.js';
import { signIns, users } from '../db/schema.js';
import type { Env } from '../env.js';
import { GUEST_USER_ID } from './new-user.js';

/**
 * What the admin's Usage window shows ("Add an admin Usage window for sign-ins
 * and guest sessions", issue 654), read from the register's `sign_ins` history
 * (issue 653) and aggregated in SQL.
 */

const DAY_MS = 86_400_000;

/** The most sign-ins one person's history lists: the window is for a glance, not an export. */
const HISTORY_PER_PERSON = 50;

/** The most countries or referrers listed. Referrers are client input, so their number is unbounded. */
const LONGEST_BREAKDOWN = 50;

/**
 * The window a request asks for, bounded: no value, a value that is not a
 * whole number or one below 1 reads as the default, and one above the longest
 * history kept is cut to it. **Days are UTC days and include today**, so
 * `days: 1` is today alone, and `since` is the instant the first of them began.
 */
export function usageWindow(asked: string | number | undefined, now: Date): { days: number; since: string } {
  const parsed = typeof asked === 'number' ? asked : Number(asked);
  const days =
    asked === undefined || !Number.isInteger(parsed) || parsed < 1
      ? USAGE_DEFAULT_DAYS
      : Math.min(parsed, USAGE_MAX_DAYS);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { days, since: new Date(today - (days - 1) * DAY_MS).toISOString() };
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

export async function readUsage(env: Env, asked: string | number | undefined, now: Date): Promise<Usage> {
  const { days, since } = usageWindow(asked, now);
  const db = createDb(env.DB);

  const guest = and(isNull(signIns.userId), gte(signIns.at, since));
  const day = sql<string>`substr(${signIns.at}, 1, 10)`;
  const sessions = sql<number>`count(*)`;

  // Five independent reads, started together: each is a D1 round trip.
  const [people, named, perDay, byCountry, byReferrer] = await Promise.all([
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
        day,
        sessions,
        itemsCaptured: sql<number>`sum(${signIns.itemsCaptured})`,
        dashboardsOpened: sql<number>`sum(${signIns.dashboardsOpened})`,
      })
      .from(signIns)
      .where(guest)
      .groupBy(day)
      .orderBy(desc(day)),
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
      perDay: perDay.map((row) => ({
        ...row,
        sessions: Number(row.sessions),
        itemsCaptured: Number(row.itemsCaptured),
        dashboardsOpened: Number(row.dashboardsOpened),
      })),
      byCountry: byCountry.map((row) => ({ ...row, sessions: Number(row.sessions) })),
      byReferrer: byReferrer.map((row) => ({ ...row, sessions: Number(row.sessions) })),
    },
  };
}
