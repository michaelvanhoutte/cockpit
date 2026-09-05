import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import {
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  inTheStore,
  seedRegister,
  startFromEmpty,
} from '../seed.js';

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

  /**
   * Login CSRF: another site making this browser sign in as somebody its owner
   * did not choose, so that everything captured afterwards lands in a stranger's
   * account.
   *
   * What stands between the two is that signing in declares `application/json`
   * and the request is checked against that header, not merely parsed. It is
   * worth a test rather than a comment because it is a *library's* behaviour:
   * the obvious reading - "a form cannot produce a JSON body" - is false, since
   * `enctype="text/plain"` is CORS-safelisted and a field named
   * `{"userId":"…","junk":"` with a value of `"}` serializes to valid JSON. If a
   * dependency bump ever made the body parse regardless of the header, nothing
   * else here would notice.
   */
  describe('signing in cannot be done by another site on your behalf', () => {
    it.each([
      {
        situation: 'a form that dresses valid JSON up as plain text',
        contentType: 'text/plain',
      },
      { situation: 'a delivery that says nothing about what it is', contentType: undefined },
    ])('hands out no sign-in to $situation', async ({ contentType }) => {
      const res = await SELF.fetch('http://cockpit.test/v1/sign-in', {
        method: 'POST',
        ...(contentType ? { headers: { 'content-type': contentType } } : {}),
        // Exactly what the form above serializes to, stray `=` and all.
        body: '{"userId":"user-ada","junk":"="}',
      });

      expect(res.status).not.toBe(200);
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
          message: 'Nobody should be able to file this',
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

    /**
     * A delivery from a source is not somebody who can sign in - Slack and
     * Gmail hold no cookie of ours and never will - so the gate must not be the
     * thing that answers it. What authenticates one is the connector's own
     * signature verification, behind this route rather than in front of it.
     *
     * Asserted as "answered by the connector layer" rather than as a status,
     * because there are no connectors yet: an unknown one is a 404 today and a
     * real one will be something else. What must never come back is the gate's
     * refusal, and that is what would happen the day the first connector ships
     * if this were left out.
     */
    it('lets a delivery from a source reach the connector that owns it', async () => {
      const res = await SELF.fetch('http://cockpit.test/ingress/nobody/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      expect(res.status).not.toBe(401);
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'unknown connector' });
    });
  });

  describe('signing out ends the sign-in for good', () => {
    /**
     * The live-updates stream is the one thing that outlives its own admission:
     * the gate lets it in once and it is then held open for hours, so "signing
     * out is final" is a claim about a socket that is already open, not only
     * about the next request the browser makes.
     *
     * Read to the end rather than sampled, because the outcome under test is
     * that it *stops*. A stream that went on delivering would leave this
     * waiting, which the runner's timeout turns into the failure it should be.
     */
    it('stops the live-updates stream it was holding open', { timeout: 30_000 }, async () => {
      const cookie = await signedInAs(USER_ID);
      const stream = await SELF.fetch('http://cockpit.test/v1/events', carrying(cookie));
      expect(stream.status).toBe(200);
      const listening = stream.body!.getReader();
      // The opening heartbeat, which is what says the stream is genuinely live
      // before anything is done to it.
      expect((await listening.read()).done).toBe(false);

      await SELF.fetch('http://cockpit.test/v1/sign-out', carrying(cookie, { method: 'POST' }));

      let ended = false;
      while (!ended) ended = (await listening.read()).done;
      expect(ended).toBe(true);
    });

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

  /**
   * Two Cockpits open at once is the ordinary way this is developed - a
   * `pnpm dev` per worktree, plus the browser suite's own stack - and to a
   * browser all of them are `localhost`, differing only by a port it does not
   * keep sign-ins apart by. So the jar below is one jar, holding what each of
   * them handed over, exactly as a browser would send it to both.
   *
   * What this cannot arrange, and does not claim, is that the two hold separate
   * registers: there is one Worker here. That is the right split anyway - which
   * sign-in a request is *carrying* is decided from the address before any
   * register is read, and that decision is what broke.
   *
   * Found by hand rather than by this suite: reads kept answering while adding
   * a panel came back "sign in to continue" a second later, because a request
   * to the Cockpit next door had emptied the one slot they shared on its way to
   * refusing it.
   */
  describe('two Cockpits open in one browser leave each other’s sign-ins alone', () => {
    const HERE = 'http://localhost:9182';
    const NEXT_DOOR = 'http://localhost:8987';

    /** What the browser puts in its jar for this address, `name=value`. */
    async function signedInAt(at: string, userId: string): Promise<string> {
      const res = await SELF.fetch(`${at}/v1/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      expect(res.status).toBe(200);
      return res.headers.get('set-cookie')!.split(';')[0]!;
    }

    /**
     * One host, one jar: a browser sends every one of them to every one of
     * them.
     *
     * The Cockpit next door's goes first, which is deliberate rather than
     * arbitrary - under a single shared name that is the value that answers,
     * so the rows below fail when this breaks instead of being right by luck
     * of the order.
     */
    async function bothSignedIn(): Promise<string> {
      const here = await signedInAt(HERE, USER_ID);
      const nextDoor = await signedInAt(NEXT_DOOR, OTHER_USER_ID);
      return `${nextDoor}; ${here}`;
    }

    /**
     * Two people rather than one twice over, because that is what makes a wrong
     * answer visible: with a single name the jar holds two values under it, one
     * of them wins, and the Cockpit that loses answers as somebody else.
     */
    it.each([
      { situation: 'the one you are working in', at: HERE, expected: 'Michael' },
      { situation: 'the one open beside it', at: NEXT_DOOR, expected: 'Ada' },
    ])('$situation says who you signed in to it as', async ({ at, expected }) => {
      const jar = await bothSignedIn();

      const res = await SELF.fetch(`${at}/v1/me`, carrying(jar));

      expect(res.status).toBe(200);
      expect((await res.json()) as { user: { name: string } }).toMatchObject({
        user: { name: expected },
      });
    });

    /**
     * The reported symptom, and the reason a change is checked beside a read:
     * it looked like changes being refused while reads worked, and it was
     * really whichever request happened to land after the one slot they shared
     * had been taken.
     */
    it('files what you capture in the account you signed in to there', async () => {
      const jar = await bothSignedIn();

      const res = await SELF.fetch(
        `${HERE}/v1/commands/capture_item`,
        carrying(jar, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            commandId: '018f0000-0000-7000-8000-000000000003',
            issuedAt: AT,
            workspaceId: WORKSPACE_ID,
            itemId: '018f0000-0000-7000-8000-000000000004',
            title: 'Captured while the Cockpit next door was open',
          }),
        }),
      );
      // Asserted with what it said, not on the status alone: every way this
      // can go wrong - the validator, a refusal, a workspace that is not there
      // - arrives as a number that names none of them.
      expect({ status: res.status, said: await res.text() }).toMatchObject({ status: 200 });

      // Michael's own store, so this fails rather than passes if the capture
      // went to the account of whoever signed in next door.
      const titles = await inTheStore((sql) => [
        ...sql.exec<{ title: string }>('SELECT title FROM items'),
      ]);
      expect(titles.map((row) => row.title)).toContain(
        'Captured while the Cockpit next door was open',
      );
    });

    it('refusing a sign-in it was never given does not end the other one', async () => {
      const here = await signedInAt(HERE, USER_ID);

      // Only this Cockpit's, which is the state a browser is in the moment
      // before you sign in to the one next door.
      const refused = await SELF.fetch(`${NEXT_DOOR}/v1/me`, carrying(here));

      expect(refused.status).toBe(401);
      // It takes nothing of this Cockpit's away on its way out - it holds none
      // of it to take. Under one name for both, this very response is what
      // signed you out here.
      expect(refused.headers.get('set-cookie') ?? '').not.toContain('cockpit_session_9182');
      expect((await SELF.fetch(`${HERE}/v1/me`, carrying(here))).status).toBe(200);
    });

    it('signing out of one leaves you signed in to the other', async () => {
      const jar = await bothSignedIn();

      const out = await SELF.fetch(`${NEXT_DOOR}/v1/sign-out`, carrying(jar, { method: 'POST' }));
      expect(out.status).toBe(200);

      expect((await SELF.fetch(`${HERE}/v1/me`, carrying(jar))).status).toBe(200);
      expect((await SELF.fetch(`${NEXT_DOOR}/v1/me`, carrying(jar))).status).toBe(401);
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
