import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { OTHER_USER_ID, TASK_TYPE_ID, USER_ID, WORKSPACE_ID, seedRegister, startFromEmpty, taskTypeIn } from '../seed.js';
import { GUEST_ACCOUNT_NAME, GUEST_USER_ID } from '../../../src/auth/register.js';
import { handleScheduled } from '../../../src/jobs/index.js';
import { issuerIsReachable, issuerWillIdentify } from '../issuer.js';

/**
 * Integration level, through the real Worker and the real register: the
 * history of sign-ins ("Record every sign-in, with guest activity, for 12
 * months", issue 653). What only a real database proves is that the row and
 * the session are one write, that a counter is bumped atomically from the
 * request doing the action, and what the nightly run removes. Reducing a
 * referrer to its host is pure and is settled at
 * apps/api/tests/unit/auth/sign-in-history.test.ts.
 */

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  env.GUEST_SIGN_IN = 'true';
});

interface Row {
  session_id: string;
  user_id: string | null;
  at: string;
  country: string | null;
  referrer_host: string | null;
  items_captured: number;
  dashboards_opened: number;
}

async function rows(): Promise<Row[]> {
  return (await env.DB.prepare('SELECT * FROM sign_ins ORDER BY at, session_id').all<Row>()).results;
}

async function sessionCount(): Promise<number> {
  return (await env.DB.prepare('SELECT count(*) AS n FROM sessions').first<{ n: number }>())!.n;
}

function sessionIn(res: Response): string | undefined {
  return res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .find((cookie) => cookie.startsWith('cockpit_session=') && !cookie.endsWith('='));
}

/** Pressing "Continue as guest", from wherever the request says it is. */
function continueAsGuest(query = '', country?: string): Promise<Response> {
  return SELF.fetch(`http://cockpit.test/v1/sign-in/guest${query}`, {
    redirect: 'manual',
    ...(country ? { cf: { country } } : {}),
  });
}

/** The whole Google walk for somebody the seed holds, as the browser makes it. */
async function signInWithGoogle(email: string, country?: string): Promise<Response> {
  await issuerIsReachable();
  const started = await SELF.fetch('http://cockpit.test/v1/sign-in/google', { redirect: 'manual' });
  const asked = new URL(started.headers.get('location')!);
  const attempt = started.headers.get('set-cookie')!.split(';')[0]!;
  issuerWillIdentify({ email, nonce: asked.searchParams.get('nonce')! });
  return SELF.fetch(
    `http://cockpit.test/v1/sign-in/google/callback?code=a-code&state=${asked.searchParams.get('state')}`,
    { headers: { cookie: attempt }, redirect: 'manual', ...(country ? { cf: { country } } : {}) },
  );
}

function post(cookie: string, command: string, body: object): Promise<Response> {
  return SELF.fetch(`http://cockpit.test/v1/commands/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

let captures = 0;
function aCapture() {
  captures += 1;
  const n = String(captures).padStart(4, '0');
  return {
    commandId: `018f0000-0000-7000-8000-0000000a${n}`,
    issuedAt: '2026-08-12T10:00:00.000Z',
    workspaceId: WORKSPACE_ID,
    itemId: `018f0000-0000-7000-8000-0000000b${n}`,
    message: 'Something the guest thought of',
    typeId: taskTypeIn(GUEST_ACCOUNT_NAME),
  };
}

function snapshotOf(cookie: string): Promise<Response> {
  return SELF.fetch(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`, {
    headers: { cookie },
  });
}

describe('Sign-in', () => {
  describe('every deliberate sign-in leaves exactly one history row, and nothing else does', () => {
    it('leaves one for a named user, for them, with the time', async () => {
      const before = Date.now();
      const back = await signInWithGoogle('michael@example.com');
      expect(back.headers.get('location')).toBe('/');

      const [only, ...more] = await rows();
      expect(more).toEqual([]);
      expect(only).toMatchObject({ user_id: USER_ID, referrer_host: null });
      expect(Date.parse(only!.at)).toBeGreaterThanOrEqual(before - 1_000);
    });

    it('leaves one for somebody who presses Continue as guest, with no user', async () => {
      const back = await continueAsGuest();

      expect(back.headers.get('location')).toBe('/');
      const [only, ...more] = await rows();
      expect(more).toEqual([]);
      expect(only).toMatchObject({ user_id: null, items_captured: 0, dashboards_opened: 0 });
    });

    it('adds none when a sign-in renews itself', async () => {
      const cookie = sessionIn(await continueAsGuest())!;

      expect((await SELF.fetch('http://cockpit.test/v1/me', { headers: { cookie } })).status).toBe(200);
      expect((await SELF.fetch('http://cockpit.test/v1/me', { headers: { cookie } })).status).toBe(200);

      expect(await rows()).toHaveLength(1);
    });

    describe('where the guest sign-in is refused', () => {
      it('leaves none when the deployment offers no guest sign-in', async () => {
        delete env.GUEST_SIGN_IN;

        await continueAsGuest();

        expect(await rows()).toEqual([]);
      });

      it('leaves none when the guest row has been made an admin', async () => {
        await continueAsGuest();
        await env.DB.prepare('DELETE FROM sign_ins').run();
        await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(GUEST_USER_ID).run();

        const back = await continueAsGuest();

        expect(sessionIn(back)).toBeUndefined();
        expect(await rows()).toEqual([]);
      });
    });

    it('writes neither the session nor the row when the batch fails', async () => {
      await continueAsGuest(); // so the guest account exists and only the batch can fail
      await env.DB.prepare('DELETE FROM sign_ins').run();
      await env.DB.prepare('DELETE FROM sessions').run();
      await env.DB.prepare(
        "CREATE TRIGGER sign_ins_refuse BEFORE INSERT ON sign_ins BEGIN SELECT RAISE(ABORT, 'refused'); END",
      ).run();

      try {
        const back = await continueAsGuest();
        expect(sessionIn(back)).toBeUndefined();
      } finally {
        await env.DB.prepare('DROP TRIGGER sign_ins_refuse').run();
      }

      expect(await sessionCount()).toBe(0);
      expect(await rows()).toEqual([]);
    });
  });

  describe('a row says where the sign-in came from', () => {
    it.each([
      { situation: 'the request names a country', country: 'BE', recorded: 'BE' },
      { situation: 'the request names no country', country: undefined, recorded: null },
    ])('records the country when $situation', async ({ country, recorded }) => {
      await signInWithGoogle('michael@example.com', country);
      await continueAsGuest('', country);

      expect((await rows()).map((row) => row.country)).toEqual([recorded, recorded]);
    });

    it.each([
      {
        situation: 'the guest link carries a page address',
        query: `?${new URLSearchParams({ referrer: 'https://conselit.com/a?b=1' })}`,
        recorded: 'conselit.com',
      },
      { situation: 'the guest link carries no referrer', query: '', recorded: null },
      { situation: 'the guest link carries something that is not an address', query: '?referrer=nonsense', recorded: null },
      {
        situation: 'the guest link carries an absurdly long one',
        query: `?${new URLSearchParams({ referrer: `https://${'a'.repeat(5_000)}.com/` })}`,
        recorded: null,
      },
    ])('records for a guest only the host when $situation', async ({ query, recorded }) => {
      await continueAsGuest(query);

      expect((await rows())[0]!.referrer_host).toBe(recorded);
    });

    it('records no referrer for a named user, whatever is sent', async () => {
      await signInWithGoogle('michael@example.com');

      expect((await rows())[0]!.referrer_host).toBeNull();
    });
  });

  describe('a guest’s row counts what that guest did, on their own row', () => {
    it('counts a capture, and not the same capture replayed', async () => {
      const cookie = sessionIn(await continueAsGuest())!;
      const capture = aCapture();

      expect((await post(cookie, 'capture_item', capture)).status).toBe(200);
      const replay = await post(cookie, 'capture_item', capture);
      expect(await replay.json()).toMatchObject({ applied: false });

      expect((await rows())[0]!.items_captured).toBe(1);
    });

    it('counts each time a dashboard is opened', async () => {
      const cookie = sessionIn(await continueAsGuest())!;

      expect((await snapshotOf(cookie)).status).toBe(200);
      expect((await snapshotOf(cookie)).status).toBe(200);

      expect((await rows())[0]!.dashboards_opened).toBe(2);
    });

    it('keeps two guests apart, each on their own row', async () => {
      const first = sessionIn(await continueAsGuest())!;
      const second = sessionIn(await continueAsGuest())!;

      await Promise.all([post(first, 'capture_item', aCapture()), snapshotOf(second)]);

      const [a, b] = await Promise.all(
        [first, second].map(async (cookie) =>
          env.DB.prepare('SELECT items_captured, dashboards_opened FROM sign_ins WHERE session_id = ?')
            .bind(cookie.split('=')[1])
            .first(),
        ),
      );
      expect(a).toEqual({ items_captured: 1, dashboards_opened: 0 });
      expect(b).toEqual({ items_captured: 0, dashboards_opened: 1 });
    });

    it('counts both when one guest’s two tabs act at once', async () => {
      const cookie = sessionIn(await continueAsGuest())!;

      await Promise.all([post(cookie, 'capture_item', aCapture()), post(cookie, 'capture_item', aCapture())]);

      expect((await rows())[0]!.items_captured).toBe(2);
    });

    it('counts nothing for a named user', async () => {
      const cookie = sessionIn(await signInWithGoogle('michael@example.com'))!;
      const capture = { ...aCapture(), typeId: TASK_TYPE_ID };

      expect((await post(cookie, 'capture_item', capture)).status).toBe(200);
      expect((await snapshotOf(cookie)).status).toBe(200);

      expect(await rows()).toMatchObject([{ items_captured: 0, dashboards_opened: 0 }]);
    });

    it('still answers the request when the count fails', async () => {
      const cookie = sessionIn(await continueAsGuest())!;
      await env.DB.prepare(
        "CREATE TRIGGER sign_ins_no_bump BEFORE UPDATE ON sign_ins BEGIN SELECT RAISE(ABORT, 'refused'); END",
      ).run();

      try {
        expect((await post(cookie, 'capture_item', aCapture())).status).toBe(200);
        expect((await snapshotOf(cookie)).status).toBe(200);
      } finally {
        await env.DB.prepare('DROP TRIGGER sign_ins_no_bump').run();
      }

      expect((await rows())[0]).toMatchObject({ items_captured: 0, dashboards_opened: 0 });
    });

    it('changes nothing when the session has no row', async () => {
      const cookie = sessionIn(await continueAsGuest())!;
      await env.DB.prepare('DELETE FROM sign_ins').run();

      expect((await post(cookie, 'capture_item', aCapture())).status).toBe(200);

      expect(await rows()).toEqual([]);
    });
  });

  describe('rows older than 12 months are removed by the nightly run, newer ones kept', () => {
    async function aRowAt(at: string, id: string): Promise<void> {
      await env.DB.prepare('INSERT INTO sign_ins (session_id, user_id, at) VALUES (?, NULL, ?)').bind(id, at).run();
    }
    const runTheNight = () => handleScheduled({} as never, env);
    const monthsAgo = (months: number, extraDays: number) => {
      const when = new Date();
      when.setUTCMonth(when.getUTCMonth() - months);
      when.setUTCDate(when.getUTCDate() - extraDays);
      return when.toISOString();
    };

    afterEach(async () => {
      await env.DB.prepare('DELETE FROM sign_ins').run();
    });

    it('removes a row just over 12 months old and keeps one just under, however often it runs', async () => {
      await aRowAt(monthsAgo(12, 1), 'over');
      await aRowAt(monthsAgo(12, -1), 'under');

      await runTheNight();
      expect((await rows()).map((row) => row.session_id)).toEqual(['under']);

      await runTheNight();
      expect((await rows()).map((row) => row.session_id)).toEqual(['under']);
    });

    it('still runs in an environment with no guest account', async () => {
      expect(await env.DB.prepare('SELECT id FROM tenants WHERE id = ?').bind(GUEST_ACCOUNT_NAME).first()).toBeNull();
      await aRowAt(monthsAgo(13, 0), 'over');

      await runTheNight();

      expect(await rows()).toEqual([]);
    });
  });

  describe('deleting a user removes their history and nobody else’s', () => {
    it('keeps the guest’s rows and other users’ rows', async () => {
      await signInWithGoogle('ada@example.com');
      const admin = sessionIn(await signInWithGoogle('michael@example.com'))!;
      await continueAsGuest();
      expect(await rows()).toHaveLength(3);

      const removed = await SELF.fetch(`http://cockpit.test/v1/admin/users/${OTHER_USER_ID}`, {
        method: 'DELETE',
        headers: { cookie: admin },
      });
      expect(removed.status).toBe(200);

      expect((await rows()).map((row) => row.user_id).sort()).toEqual([null, USER_ID]);
    });
  });
});
