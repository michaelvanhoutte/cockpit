import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import type { Usage } from '@cockpit/shared';
import { OTHER_USER_ID, USER_ID, asUser, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker and the real register: the
 * admin's Usage window reads ("Add an admin Usage window for sign-ins and guest
 * sessions", issue 654). What only a real database proves is the role gate in
 * front of the route and the SQL that groups the history by day, country and
 * referrer. The window's own bounds and the link's shape are pure and are
 * settled at apps/api/tests/unit/accounts/usage.test.ts.
 */

const USAGE = 'http://cockpit.test/v1/admin/usage';
const DAY_MS = 86_400_000;

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  env.GUEST_SIGN_IN = 'true';
  delete env.WEB_ANALYTICS_URL;
});

/** An instant this many days ago, at this time of the day, in UTC. */
function daysAgo(days: number, time = '12:00:00.000'): string {
  const day = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  return `${day}T${time}Z`;
}

let sessions = 0;
/** A sign-in the history holds, written as the register would have. */
async function signedInAt(
  at: string,
  who: { userId?: string; country?: string; referrerHost?: string; items?: number; dashboards?: number } = {},
): Promise<void> {
  sessions += 1;
  await env.DB.prepare(
    `INSERT INTO sign_ins (session_id, user_id, at, country, referrer_host, items_captured, dashboards_opened)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      `usage-session-${sessions}`,
      who.userId ?? null,
      at,
      who.country ?? null,
      who.referrerHost ?? null,
      who.items ?? 0,
      who.dashboards ?? 0,
    )
    .run();
}

async function usage(query = '', userId: string = USER_ID): Promise<Usage> {
  const res = await asUser(`${USAGE}${query}`, {}, userId);
  expect(res.status).toBe(200);
  return (await res.json()) as Usage;
}

describe('User management', () => {
  describe('only an admin can read the usage', () => {
    it('gives an admin the data', async () => {
      const read = await usage();

      expect(read.named.map((person) => person.userId).sort()).toEqual([OTHER_USER_ID, USER_ID].sort());
    });

    it('refuses somebody signed in who is not an admin', async () => {
      const res = await asUser(USAGE, {}, OTHER_USER_ID);

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'not allowed' });
    });

    it('refuses somebody holding no sign-in', async () => {
      const res = await SELF.fetch(USAGE);

      expect(res.status).toBe(401);
    });
  });

  describe('named users’ sign-ins are shown, latest and history, and guests are not among them', () => {
    const ada = (read: Usage) => read.named.find((person) => person.userId === OTHER_USER_ID)!;

    it('lists a person’s sign-ins in the window, newest first', async () => {
      await signedInAt(daysAgo(5), { userId: OTHER_USER_ID });
      await signedInAt(daysAgo(1), { userId: OTHER_USER_ID });
      await signedInAt(daysAgo(3), { userId: OTHER_USER_ID });

      expect(ada(await usage()).signIns).toEqual([daysAgo(1), daysAgo(3), daysAgo(5)]);
    });

    it('shows a person who never signed in with no history', async () => {
      const shown = ada(await usage());

      expect(shown).toMatchObject({ name: 'Ada', latest: null, signIns: [] });
    });

    it('leaves out their sign-ins from before the window, and keeps the latest ever', async () => {
      await env.DB.prepare('UPDATE users SET last_signed_in_at = ? WHERE id = ?')
        .bind(daysAgo(100), OTHER_USER_ID)
        .run();
      await signedInAt(daysAgo(100), { userId: OTHER_USER_ID });

      expect(ada(await usage())).toMatchObject({ latest: daysAgo(100), signIns: [] });
    });

    it('does not list guests, who have no user, nor count them as anybody', async () => {
      // A real guest sign-in, so the shared guest user exists in the register.
      const guest = await SELF.fetch('http://cockpit.test/v1/sign-in/guest', { redirect: 'manual' });
      expect(guest.headers.get('location')).toBe('/');
      await signedInAt(daysAgo(1), { country: 'BE' });

      const read = await usage();

      expect(read.named.map((person) => person.userId).sort()).toEqual([OTHER_USER_ID, USER_ID].sort());
      expect(read.named.flatMap((person) => person.signIns)).toHaveLength(1);
    });

    it('does not show a deleted user, whose history went with them', async () => {
      await signedInAt(daysAgo(2), { userId: OTHER_USER_ID });
      const removed = await asUser(`http://cockpit.test/v1/admin/users/${OTHER_USER_ID}`, { method: 'DELETE' });
      expect(removed.status).toBe(200);

      const read = await usage();

      expect(read.named.map((person) => person.userId)).toEqual([USER_ID]);
    });
  });

  describe('guest sessions are counted per day, by country and by referrer, over a bounded window', () => {
    it('gives one count per day, newest first, summing what guests did', async () => {
      await signedInAt(daysAgo(1, '00:00:00.000'), { items: 2, dashboards: 1 });
      await signedInAt(daysAgo(1, '23:59:59.999'), { items: 3 });
      await signedInAt(daysAgo(2), { dashboards: 4 });

      expect((await usage()).guests.perDay).toEqual([
        { day: daysAgo(1).slice(0, 10), sessions: 2, itemsCaptured: 5, dashboardsOpened: 1 },
        { day: daysAgo(2).slice(0, 10), sessions: 1, itemsCaptured: 0, dashboardsOpened: 4 },
      ]);
    });

    it('groups by country and by referrer host, most sessions first, with a missing one together as unknown', async () => {
      await signedInAt(daysAgo(1), { country: 'BE', referrerHost: 'news.example.com' });
      await signedInAt(daysAgo(1), { country: 'BE', referrerHost: 'news.example.com' });
      await signedInAt(daysAgo(1), { country: 'BE', referrerHost: 'other.example' });
      await signedInAt(daysAgo(2), { country: 'NL' });
      await signedInAt(daysAgo(2));
      await signedInAt(daysAgo(3));

      const { guests } = await usage();

      expect(guests.byCountry).toEqual([
        { country: 'BE', sessions: 3 },
        { country: null, sessions: 2 },
        { country: 'NL', sessions: 1 },
      ]);
      expect(guests.byReferrer).toEqual([
        { host: null, sessions: 3 },
        { host: 'news.example.com', sessions: 2 },
        { host: 'other.example', sessions: 1 },
      ]);
    });

    it('leaves out named users’ sign-ins', async () => {
      await signedInAt(daysAgo(1), { userId: USER_ID, country: 'BE', referrerHost: 'not-a-guest.example' });

      const { guests } = await usage();

      expect(guests).toEqual({ perDay: [], byCountry: [], byReferrer: [] });
    });

    it('excludes rows outside the window and takes them in when the window is longer', async () => {
      await signedInAt(daysAgo(40));
      await signedInAt(daysAgo(2));

      expect((await usage()).guests.perDay.map((row) => row.sessions)).toEqual([1]);
      const longer = await usage('?days=60');
      expect(longer.days).toBe(60);
      expect(longer.guests.perDay.map((row) => row.sessions)).toEqual([1, 1]);
    });

    it('cuts a window longer than the history is kept to the longest there is', async () => {
      expect((await usage('?days=9999')).days).toBe(365);
    });

    it('answers an empty window with nothing in it rather than an error', async () => {
      const read = await usage();

      expect(read.days).toBe(30);
      expect(read.guests).toEqual({ perDay: [], byCountry: [], byReferrer: [] });
    });

    it('answers a window that is not a number with the usual one', async () => {
      expect((await usage('?days=lots')).days).toBe(30);
    });
  });

  describe('the link to page traffic is the configured address, and absent without one', () => {
    it('carries the address when one is configured', async () => {
      env.WEB_ANALYTICS_URL = 'https://dash.cloudflare.com/acct/web-analytics';

      expect((await usage()).analyticsUrl).toBe('https://dash.cloudflare.com/acct/web-analytics');
    });

    it.each([
      { situation: 'none is configured', configured: undefined },
      { situation: 'the configured one is empty', configured: '' },
      { situation: 'the configured one is not a web address', configured: 'javascript:alert(1)' },
    ])('carries none when $situation', async ({ configured }) => {
      if (configured === undefined) delete env.WEB_ANALYTICS_URL;
      else env.WEB_ANALYTICS_URL = configured;

      expect((await usage()).analyticsUrl).toBeNull();
    });
  });
});
