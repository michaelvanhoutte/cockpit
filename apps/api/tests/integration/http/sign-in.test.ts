import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { USER_ID, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker, because every rule here is about
 * what reaches a handler at all. The gate is middleware in front of the whole
 * application; a test that called a handler directly would prove the handler
 * works and say nothing about whether anything stops an unsigned request
 * getting to it, which is the only thing being claimed.
 *
 * How long a sign-in lasts and what makes one current is *not* re-proved here.
 * That is a comparison against a clock and it is settled at
 * apps/api/tests/unit/auth/session.test.ts. The one case below that touches it
 * asks the question that file cannot: whether those rules are on the request
 * path at all.
 */

const AT = '2026-08-12T10:00:00.000Z';

async function signIn(userId: string): Promise<Response> {
  return SELF.fetch('http://cockpit.test/v1/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
}

/** The cookie a browser would be sending back after signing in. */
async function signedInAs(userId: string): Promise<string> {
  const res = await signIn(userId);
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

function carrying(cookie: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...((init.headers as Record<string, string>) ?? {}), cookie } };
}

/** Every kind of request the application answers, named as the person doing it. */
const EVERY_WAY_IN = [
  { situation: 'asking for your workspaces', path: '/v1/workspaces' },
  { situation: "asking for a workspace's contents", path: '/v1/workspaces/ws-work/snapshot' },
  { situation: 'asking who you are', path: '/v1/me' },
  { situation: 'listening for what has changed', path: '/v1/events' },
];

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Sign-in', () => {
  describe('you choose who you are from the people Cockpit knows', () => {
    it('offers their names and nothing else about them', async () => {
      const res = await SELF.fetch('http://cockpit.test/v1/users');

      expect(res.status).toBe(200);
      const { users } = (await res.json()) as { users: Record<string, unknown>[] };
      expect(users.map((u) => u.name)).toEqual(['Michael', 'Ada']);
      // Which account somebody owns and what standing they hold are the two
      // things this read must never carry: it answers before anybody has signed
      // in, so whatever is in it is public.
      for (const user of users) {
        expect(Object.keys(user).sort()).toEqual(['id', 'name']);
      }
    });

    it('refuses a name that is nobody here', async () => {
      const res = await signIn('user-nobody');

      expect(res.status).toBe(404);
      expect(res.headers.get('set-cookie')).toBeNull();
    });
  });

  describe('nothing but the logon page works until you have signed in', () => {
    /**
     * Refused *and* refused in the application's own shape, in one assertion,
     * because the second half is only a claim about the first. A refusal that
     * arrives as a web page reaches a background revalidation and a
     * live-updates stream as something which does not read like a sign-in
     * problem at all (architecture, "App login"), and that is the cost this
     * whole gate exists to stop paying - so the two are never checked apart,
     * where the format could go on passing over a request nothing refused.
     */
    async function expectRefusedInOurOwnWords(res: Response): Promise<void> {
      expect(res.status).toBe(401);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect((await res.json()) as { error: string }).toMatchObject({ error: expect.any(String) });
    }

    it.each(EVERY_WAY_IN)('refuses $situation, in Cockpit’s own words', async ({ path }) => {
      await expectRefusedInOurOwnWords(await SELF.fetch(`http://cockpit.test${path}`));
    });

    it('refuses capturing a thought, the same way', async () => {
      const res = await SELF.fetch('http://cockpit.test/v1/commands/capture_item', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: '018f0000-0000-7000-8000-000000000001',
          issuedAt: AT,
          workspaceId: 'ws-work',
          itemId: '018f0000-0000-7000-8000-000000000002',
          title: 'Nobody should be able to file this',
        }),
      });

      await expectRefusedInOurOwnWords(res);
    });

    it.each([
      { situation: 'the people to choose from', path: '/v1/users' },
      { situation: 'the health check', path: '/health' },
    ])('lets $situation through', async ({ path }) => {
      const res = await SELF.fetch(`http://cockpit.test${path}`);

      expect(res.status).toBe(200);
    });
  });

  describe('signing out ends the sign-in for good', () => {
    it('refuses the very next request made with it', async () => {
      const cookie = await signedInAs(USER_ID);
      expect((await SELF.fetch('http://cockpit.test/v1/workspaces', carrying(cookie))).status).toBe(
        200,
      );

      const out = await SELF.fetch(
        'http://cockpit.test/v1/sign-out',
        carrying(cookie, { method: 'POST' }),
      );
      expect(out.status).toBe(200);

      const after = await SELF.fetch('http://cockpit.test/v1/workspaces', carrying(cookie));
      expect(after.status).toBe(401);
    });
  });

  describe('a sign-in lasts a set time and renews while you use it', () => {
    it('refuses a request carrying one whose time has run out', async () => {
      const cookie = await signedInAs(USER_ID);
      // Straight to the register, because the only other way to arrange this is
      // to wait a month. What is under test is that the rules are consulted on
      // the request path, not what the rules say - that is settled at L1.
      await env.DB.prepare('UPDATE sessions SET expires_at = ?')
        .bind('2026-08-12T10:00:00.000Z')
        .run();

      const res = await SELF.fetch('http://cockpit.test/v1/workspaces', carrying(cookie));

      expect(res.status).toBe(401);
    });
  });
});
