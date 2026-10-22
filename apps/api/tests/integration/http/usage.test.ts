import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
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

  /**
   * "Count Settings › Usage's days on your own calendar" (issue 1428): the
   * days are grouped, and the window bounded, in a query against the real
   * register, so the calendar they are cut on only shows there. Time is
   * fixed here: the instants below mean a day only against a known "now".
   */
  describe('usage counts its days on the calendar of the zone it is read from', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const readAt = async (now: string, query: string): Promise<Usage> => {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(now) });
      return usage(query);
    };
    const days = (read: Usage) => read.guests.perDay.map((row) => [row.day, row.sessions]);

    describe('a guest’s sign-in is counted on the day it was in the viewer’s zone', () => {
      it.each([
        { situation: 'half past midnight in Brussels, still the day before in UTC', zone: 'Europe/Brussels', at: ['2026-10-21T22:30:00.000Z'], counted: [['2026-10-22', 1]] },
        { situation: 'the evening before in New York', zone: 'America/New_York', at: ['2026-10-21T22:30:00.000Z'], counted: [['2026-10-21', 1]] },
        {
          situation: 'either side of the night the clocks go back in Brussels, the offset changing in between',
          zone: 'Europe/Brussels',
          at: ['2026-10-24T22:30:00.000Z', '2026-10-25T23:30:00.000Z'],
          counted: [
            ['2026-10-26', 1],
            ['2026-10-25', 1],
          ],
        },
      ])('puts $situation on its own day', async ({ zone, at, counted }) => {
        for (const instant of at) await signedInAt(instant);

        const read = await readAt('2026-10-26T12:00:00.000Z', `?days=7&timeZone=${zone}`);

        expect(days(read)).toEqual(counted);
      });

      it('adds up everything on one local day, though it spans two UTC dates, and leaves the next day alone', async () => {
        await signedInAt('2026-10-21T22:10:00.000Z', { items: 1, dashboards: 1 });
        await signedInAt('2026-10-22T09:00:00.000Z', { items: 2 });
        await signedInAt('2026-10-22T21:50:00.000Z', { dashboards: 3 });
        await signedInAt('2026-10-22T22:00:00.000Z', { items: 7 });

        const read = await readAt('2026-10-23T12:00:00.000Z', '?days=7&timeZone=Europe/Brussels');

        expect(read.guests.perDay).toEqual([
          { day: '2026-10-23', sessions: 1, itemsCaptured: 7, dashboardsOpened: 0 },
          { day: '2026-10-22', sessions: 3, itemsCaptured: 3, dashboardsOpened: 4 },
        ]);
      });
    });

    describe('the window starts at the viewer’s midnight, today included', () => {
      // It is 23:30 UTC on 22 October: already the 23rd in Brussels.
      it.each([
        { situation: 'a guest at 00:30 where the viewer is', who: {}, at: '2026-10-22T22:30:00.000Z', where: 'inside' },
        { situation: 'a guest at 23:30 the day before where the viewer is', who: {}, at: '2026-10-22T21:30:00.000Z', where: 'outside' },
        { situation: 'a named person at 00:30 where the viewer is', who: { userId: OTHER_USER_ID }, at: '2026-10-22T22:30:00.000Z', where: 'inside' },
        { situation: 'a named person at 23:30 the day before where the viewer is', who: { userId: OTHER_USER_ID }, at: '2026-10-22T21:30:00.000Z', where: 'outside' },
      ])('a one day window has $situation $where it', async ({ who, at, where }) => {
        await signedInAt(at, who);

        const read = await readAt('2026-10-22T23:30:00.000Z', '?days=1&timeZone=Europe/Brussels');

        const ada = read.named.find((person) => person.userId === OTHER_USER_ID)!;
        expect(read.guests.perDay).toHaveLength(who.userId === undefined && where === 'inside' ? 1 : 0);
        expect(ada.signIns).toEqual(who.userId !== undefined && where === 'inside' ? [at] : []);
      });

      it('reaches back the full year from the viewer’s midnight, and not a day further', async () => {
        await signedInAt('2025-10-22T22:30:00.000Z');
        await signedInAt('2025-10-22T21:30:00.000Z');

        const read = await readAt('2026-10-22T23:30:00.000Z', '?days=365&timeZone=Europe/Brussels');

        // 365 days ending on 23 Oct 2026 begin on 24 Oct 2025, so both are before it.
        expect(read.days).toBe(365);
        expect(days(read)).toEqual([]);
        await signedInAt('2025-10-23T22:30:00.000Z');
        expect(days(await usage('?days=365&timeZone=Europe/Brussels'))).toEqual([['2025-10-24', 1]]);
      });
    });

    describe('a zone that is missing or unknown counts in UTC, and one of the wrong shape is refused', () => {
      it.each([
        { situation: 'no zone is sent', query: '' },
        { situation: 'the zone is one this runtime does not know', query: '&timeZone=Mars/Olympus_Mons' },
      ])('counts UTC days when $situation', async ({ query }) => {
        await signedInAt('2026-10-22T00:30:00.000Z');
        await signedInAt('2026-10-21T23:30:00.000Z');

        const read = await readAt('2026-10-22T12:00:00.000Z', `?days=1${query}`);

        expect(days(read)).toEqual([['2026-10-22', 1]]);
      });

      it('refuses a zone that is not the shape of one', async () => {
        const res = await asUser(`${USAGE}?timeZone=${encodeURIComponent('Europe/Brussels; DROP TABLE')}`);

        expect(res.status).toBe(400);
      });
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
