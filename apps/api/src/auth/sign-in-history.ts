import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { signIns } from '../db/schema.js';
import type { Env } from '../env.js';

/**
 * The register's history of sign-ins ("Record every sign-in, with guest
 * activity, for 12 months", issue 653): one row per deliberate sign-in, written
 * with the session itself (`startVisit`, auth/register.ts) and read by the
 * admin's Usage window.
 */

/** The longest referrer host kept: display text, so a cap rather than a refusal. */
const LONGEST_HOST = 100;

/** A referrer longer than this was not a page address anybody navigated from. */
const LONGEST_REFERRER = 2_048;

/** How long a row is kept. */
const KEPT_MONTHS = 12;

/**
 * Where a sign-in came from, as it is written: both parts display text that
 * the Usage window shows and nothing decides on.
 */
export interface WhereFrom {
  /** Cloudflare's own two-letter country for the request; no address is kept. */
  readonly country: string | null;
  /** Only the host of the page the guest link was pressed on. */
  readonly referrerHost: string | null;
}

/**
 * The host of the page somebody came from, or `null` where there is nothing
 * trustworthy to keep.
 *
 * **Client-supplied, so never trusted**: it arrives as a query parameter
 * anybody can write. Only an http(s) address's host survives - never its path
 * or query, which can carry anything - lowercased and capped, and everything
 * else (absent, not an address, absurdly long) is `null` rather than an error,
 * because a sign-in must never fail over a field that is only for display.
 */
export function referrerHostOf(referrer: unknown): string | null {
  if (typeof referrer !== 'string' || !referrer || referrer.length > LONGEST_REFERRER) return null;
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.hostname ? url.hostname.slice(0, LONGEST_HOST) : null;
}

/**
 * The country off the request's Cloudflare metadata (`request.cf`), or `null` where there is
 * none (local development, a test) - which is not a failure.
 */
export function countryOf(request: object): string | null {
  // `cf` is Workers-only, so it is read off the request without the DOM type
  // (which the web package typechecks this file against) having to know it.
  const country = (request as { cf?: { country?: unknown } }).cf?.country;
  return typeof country === 'string' && /^[A-Za-z0-9]{2}$/.test(country) ? country.toUpperCase() : null;
}

/** What a guest's row counts. */
export type GuestCounter = 'itemsCaptured' | 'dashboardsOpened';

/**
 * Counts one thing a guest did, on their own sign-in's row.
 *
 * **Atomic `n = n + 1` in the database**, so two tabs of one guest acting at
 * once are both counted, and **only on a guest's row** (`user_id IS NULL`): a
 * named user's sign-in is never counted, and a session with no row changes
 * nothing.
 *
 * **Best-effort, and it says so by not throwing**: a metric never fails the
 * request that happened to be measured. A bump that fails undercounts by one,
 * which is the cost the design took knowingly.
 */
export async function countForGuest(
  env: Env,
  sessionId: string,
  counter: GuestCounter,
): Promise<void> {
  try {
    const column = counter === 'itemsCaptured' ? signIns.itemsCaptured : signIns.dashboardsOpened;
    await createDb(env.DB)
      .update(signIns)
      .set(
        counter === 'itemsCaptured'
          ? { itemsCaptured: sql`${column} + 1` }
          : { dashboardsOpened: sql`${column} + 1` },
      )
      .where(and(eq(signIns.sessionId, sessionId), isNull(signIns.userId)));
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: `a guest's ${counter} was not counted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    );
  }
}

/**
 * Removes the rows older than 12 months, from the nightly run. A plain
 * `DELETE ... WHERE at < cutoff`, so repeating it removes nothing more and one
 * stopped midway leaves the rest for the next night.
 */
export async function purgeOldSignIns(env: Env, now: Date): Promise<void> {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - KEPT_MONTHS);
  await createDb(env.DB).delete(signIns).where(lt(signIns.at, cutoff.toISOString()));
}
