import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { GUEST_ACCOUNT_NAME, GUEST_USER_ID } from '../../../src/auth/register.js';
import {
  OTHER_USER_ID,
  TASK_TYPE_ID,
  USER_ID,
  WORKSPACE_ID,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
  taskTypeIn,
} from '../seed.js';
import {
  issuerIsForgotten,
  issuerIsReachable,
  issuerWillIdentify,
  issuerWillRefuseTheExchange,
  type Claims,
} from '../issuer.js';

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

/**
 * Pressing "Continue with Google": what the browser is sent to, and what it is
 * left holding to come back with.
 */
async function startSignIn(): Promise<{ asked: URL; attempt: string }> {
  const res = await SELF.fetch('http://cockpit.test/v1/sign-in/google', { redirect: 'manual' });
  expect(res.status).toBe(302);
  return {
    asked: new URL(res.headers.get('location')!),
    attempt: res.headers.get('set-cookie')!.split(';')[0]!,
  };
}

/** Coming back from Google, carrying whatever the browser holds. */
function comeBack(query: Record<string, string>, cookie?: string): Promise<Response> {
  return SELF.fetch(`http://cockpit.test/v1/sign-in/google/callback?${new URLSearchParams(query)}`, {
    redirect: 'manual',
    ...(cookie ? { headers: { cookie } } : {}),
  });
}

/** The whole walk, as a browser makes it, for whoever the issuer says you are. */
async function signInAsGoogleAccount(
  claims: Omit<Claims, 'nonce'> & { nonce?: string },
): Promise<Response> {
  await issuerIsReachable();
  const { asked, attempt } = await startSignIn();
  issuerWillIdentify({ ...claims, nonce: claims.nonce ?? asked.searchParams.get('nonce')! });
  return comeBack({ code: 'a-code', state: asked.searchParams.get('state')! }, attempt);
}

/** The session cookie an answer sets, or nothing where it set none. */
function sessionIn(res: Response): string | undefined {
  return res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .find((cookie) => cookie.startsWith('cockpit_session=') && !cookie.endsWith('='));
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
  describe('you sign in with Google, and only people already in the register get in', () => {
    it('opens the account of somebody whose address the register holds', async () => {
      const back = await signInAsGoogleAccount({ email: 'michael@example.com' });

      expect(back.headers.get('location')).toBe('/');
      const workspaces = await SELF.fetch('http://cockpit.test/v1/workspaces', {
        headers: { cookie: sessionIn(back)! },
      });
      expect(workspaces.status).toBe(200);
    });

    /**
     * Proving who you are at Google is not being entitled to an account here:
     * the register is the allowlist, and nothing on this path creates a person.
     * The row count is the second half of that - a refusal that quietly made an
     * account would still redirect the same way.
     */
    it('refuses an address the register does not hold, and writes nothing', async () => {
      const before = await env.DB.prepare('SELECT count(*) AS n FROM users').first<{ n: number }>();

      const back = await signInAsGoogleAccount({ email: 'stranger@example.com' });

      expect(back.headers.get('location')).toBe('/signin?refused=unknown-account');
      expect(sessionIn(back)).toBeUndefined();
      expect(
        await env.DB.prepare('SELECT count(*) AS n FROM users').first<{ n: number }>(),
      ).toEqual(before);
    });

    /**
     * An address Google has not checked is one anybody can claim, so an
     * allowlist of addresses would be worth nothing without this.
     */
    it('refuses an address Google has not verified', async () => {
      const back = await signInAsGoogleAccount({
        email: 'michael@example.com',
        emailVerified: false,
      });

      expect(back.headers.get('location')).toBe('/signin?refused=failed');
      expect(sessionIn(back)).toBeUndefined();
    });

    /**
     * The address is how somebody is recognised the first time and the Google
     * account is how they are recognised afterwards, which is what stops a
     * changed address locking a person out.
     */
    it('knows somebody by their Google account once they have signed in with it', async () => {
      await signInAsGoogleAccount({ email: 'michael@example.com', subject: 'google|michael' });
      await env.DB.prepare("UPDATE users SET email = ? WHERE id = 'user-michael'")
        .bind('michael@somewhere-else.example.com')
        .run();

      const back = await signInAsGoogleAccount({
        email: 'michael@somewhere-else.example.com',
        subject: 'google|michael',
      });

      expect(back.headers.get('location')).toBe('/');
    });

    /**
     * And the other half of the same rule: an address given to a new owner is
     * not a way into the previous owner's account.
     */
    it('refuses a different Google account claiming an address that is already claimed', async () => {
      await signInAsGoogleAccount({ email: 'michael@example.com', subject: 'google|michael' });

      const back = await signInAsGoogleAccount({
        email: 'michael@example.com',
        subject: 'google|somebody-else',
      });

      expect(back.headers.get('location')).toBe('/signin?refused=unknown-account');
      expect(sessionIn(back)).toBeUndefined();
    });
  });

  /**
   * The other way in, which asks nobody anything ("Sign in as a guest, without
   * a password", issue 354). Every rule here is about what the register ends up
   * holding - one account however many people ask for it, and none at all where
   * the deployment does not offer one - so it is asked of a real register,
   * through the route a press actually makes.
   */
  describe('continuing as a guest puts everybody in one shared account', () => {
    /** Pressing "Continue as guest", which is a navigation like the other two. */
    function continueAsGuest(): Promise<Response> {
      return SELF.fetch('http://cockpit.test/v1/sign-in/guest', { redirect: 'manual' });
    }

    /** How many accounts and how many people the register holds. */
    async function registerHolds(): Promise<{ accounts: number; people: number }> {
      const counted = await env.DB.prepare(
        'SELECT (SELECT count(*) FROM tenants) AS accounts, (SELECT count(*) FROM users) AS people',
      ).first<{ accounts: number; people: number }>();
      return counted!;
    }

    /** Who a browser holding this cookie is, as the register answers it. */
    async function whoTheyAre(cookie: string): Promise<{ id: string; name: string }> {
      const res = await SELF.fetch('http://cockpit.test/v1/me', carrying(cookie));
      expect(res.status).toBe(200);
      return ((await res.json()) as { user: { id: string; name: string } }).user;
    }

    it('makes the guest account the first time somebody asks for it, and signs them in', async () => {
      // The seed's two people in their two accounts, and no guest anywhere:
      // what every case here starts from, so a third of each is the guest's.
      expect(await registerHolds()).toEqual({ accounts: 2, people: 2 });

      const back = await continueAsGuest();

      expect(back.headers.get('location')).toBe('/');
      expect(await whoTheyAre(sessionIn(back)!)).toMatchObject({ id: GUEST_USER_ID });
      expect(await registerHolds()).toEqual({ accounts: 3, people: 3 });
    });

    it('signs a second guest into the account that is already there', async () => {
      const first = await continueAsGuest();

      const second = await continueAsGuest();

      expect(second.headers.get('location')).toBe('/');
      // A visit of their own, into the same account - which is the pair of
      // claims: a shared account is not a shared sign-in.
      expect(sessionIn(second)).not.toBe(sessionIn(first));
      expect(await whoTheyAre(sessionIn(second)!)).toEqual(await whoTheyAre(sessionIn(first)!));
      expect(await registerHolds()).toEqual({ accounts: 3, people: 3 });
    });

    /**
     * The one thing a plain link must never do: a cross-site page can send a
     * browser here without its owner doing anything, so a live sign-in is left
     * exactly as it is rather than being replaced with the one every stranger
     * can read.
     */
    it('leaves a visitor who is already signed in exactly where they were', async () => {
      const signedIn = await signInAsGoogleAccount({ email: 'michael@example.com' });
      const before = sessionIn(signedIn)!;

      const back = await SELF.fetch(
        'http://cockpit.test/v1/sign-in/guest',
        carrying(before, { redirect: 'manual' }),
      );

      expect(back.headers.get('location')).toBe('/');
      expect(sessionIn(back)).toBeUndefined();
      expect(await whoTheyAre(before)).toMatchObject({ id: USER_ID });
      expect(await registerHolds()).toEqual({ accounts: 2, people: 2 });
    });

    /**
     * The one race this feature has: two strangers pressing it in the same
     * instant, before there is anything to find. Only the register decides
     * this - one write wins and the other is ignored - which is why it is asked
     * here and not at L1.
     */
    it('makes one account when two people ask at the same moment', async () => {
      const [first, second] = await Promise.all([continueAsGuest(), continueAsGuest()]);

      expect([first.headers.get('location'), second.headers.get('location')]).toEqual(['/', '/']);
      expect(await whoTheyAre(sessionIn(first)!)).toMatchObject({ id: GUEST_USER_ID });
      expect(await whoTheyAre(sessionIn(second)!)).toMatchObject({ id: GUEST_USER_ID });
      expect(await registerHolds()).toEqual({ accounts: 3, people: 3 });
    });

    /**
     * The accepted consequence, asserted rather than assumed: guests are not
     * kept apart, and what one files is there for the next one. The account
     * resetting daily is what makes that safe, and is its own piece of work.
     */
    it('shows one guest what another guest filed', async () => {
      const filed = await continueAsGuest();
      const reading = await continueAsGuest();
      const itemId = '018f0000-0000-7000-8000-00000000035a';

      const captured = await SELF.fetch(
        'http://cockpit.test/v1/commands/capture_item',
        carrying(sessionIn(filed)!, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            commandId: '018f0000-0000-7000-8000-00000000035b',
            issuedAt: AT,
            workspaceId: WORKSPACE_ID,
            itemId,
            message: 'Left behind by the guest before you',
            typeId: taskTypeIn(GUEST_ACCOUNT_NAME),
          }),
        }),
      );
      expect({ status: captured.status, said: await captured.text() }).toMatchObject({
        status: 200,
      });

      const seen = await SELF.fetch(
        `http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`,
        carrying(sessionIn(reading)!),
      );
      expect(seen.status).toBe(200);
      expect(((await seen.json()) as { items: { id: string }[] }).items.map((i) => i.id)).toContain(
        itemId,
      );
    });

    /**
     * These ids are derived from a name the same way a real person's are
     * (`accounts/new-user.ts`), so a person added as "Guest" before anybody
     * ever presses this control would occupy them first: both inserts above
     * would then conflict and write nothing, and blindly signing in as the id
     * would hand a stranger that real person's account. The row is checked
     * rather than trusted on sight - no real person is ever added without an
     * address, so one is never the guest's.
     */
    it('refuses to sign anybody in where the guest id already belongs to somebody real', async () => {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(
          GUEST_ACCOUNT_NAME,
          'Somebody Real',
          AT,
        ),
        env.DB.prepare(
          'INSERT INTO users (id, name, account_id, role, email, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).bind(GUEST_USER_ID, 'Somebody Real', GUEST_ACCOUNT_NAME, 'admin', 'real@example.com', AT),
      ]);

      const back = await continueAsGuest();

      expect(back.headers.get('location')).toBe('/signin?refused=failed');
      expect(sessionIn(back)).toBeUndefined();
      expect(
        await env.DB.prepare('SELECT email, role FROM users WHERE id = ?').bind(GUEST_USER_ID).first(),
      ).toMatchObject({ email: 'real@example.com', role: 'admin' });
    });

    /**
     * Disabling the guest account works the same way disabling anybody else
     * does ("Take somebody's access away without taking their work", issue
     * 233): existing guest sessions end and no new one can be started, which an
     * admin who finds "Guest" in the register and disables it is entitled to
     * expect.
     */
    describe('where the guest account has been disabled', () => {
      it('refuses, the same way a disabled person is refused anywhere else', async () => {
        await continueAsGuest();
        await env.DB.prepare('UPDATE users SET disabled_at = ? WHERE id = ?')
          .bind(AT, GUEST_USER_ID)
          .run();

        const back = await continueAsGuest();

        expect(back.headers.get('location')).toBe('/signin?refused=failed');
        expect(sessionIn(back)).toBeUndefined();
      });
    });

    /**
     * The guest account reads like any other person on the admin page, and
     * nothing stops an admin promoting it there ("Rename a user, and make
     * somebody an admin", issue 232). That mistake must not become every
     * anonymous visitor holding an admin session.
     */
    it('refuses to sign anybody in once the guest account has been made an admin', async () => {
      await continueAsGuest();
      await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?")
        .bind(GUEST_USER_ID)
        .run();

      const back = await continueAsGuest();

      expect(back.headers.get('location')).toBe('/signin?refused=failed');
      expect(sessionIn(back)).toBeUndefined();
    });

    /**
     * Staging, and anybody who found the address: the same answer to both,
     * because the control is in one built SPA that every deployment serves and
     * the Worker is the only thing that can tell them apart.
     *
     * Taking the variable off `env` rather than standing a second stack up -
     * absence is the whole mechanism, and it is one line here.
     */
    describe('where the deployment offers no guest sign-in', () => {
      beforeEach(() => {
        delete env.GUEST_SIGN_IN;
      });
      afterEach(() => {
        env.GUEST_SIGN_IN = 'true';
      });

      it('refuses, and makes no account to sign anybody into', async () => {
        const back = await continueAsGuest();

        expect(back.headers.get('location')).toBe('/signin?refused=failed');
        expect(sessionIn(back)).toBeUndefined();
        expect(await registerHolds()).toEqual({ accounts: 2, people: 2 });
      });
    });
  });

  /**
   * The two refusals are told apart on purpose ("Take somebody's access away
   * without taking their work", issue 233): a colleague whose access was
   * removed must not be told this Cockpit does not know them, and sent looking
   * for a sign-in problem that is not theirs. The cost is that whoever tries
   * the address learns it is held here, taken knowingly.
   *
   * Whether the refusal reads as words on the logon page is
   * apps/web/tests/unit/pages/LogonPage.test.tsx's; what is asked here is that
   * the two are different answers, so a change to one is not quietly a change
   * to both.
   */
  describe('a disabled user is turned away and told why', () => {
    async function accessTakenFrom(userId: string) {
      await env.DB.prepare('UPDATE users SET disabled_at = ? WHERE id = ?')
        .bind(AT, userId)
        .run();
    }

    // An address the register never held is answered `unknown-account` by the
    // case above, which is what makes this a different answer rather than the
    // same one twice.
    it('refuses somebody whose access was taken away', async () => {
      await accessTakenFrom(USER_ID);

      const back = await signInAsGoogleAccount({ email: 'michael@example.com' });

      expect(back.headers.get('location')).toBe('/signin?refused=access-removed');
      expect(sessionIn(back)).toBeUndefined();
    });

    /**
     * The common case: somebody who has been using this Cockpit, so the
     * register knows their Google account and finds them by it rather than by
     * their address. It is a second path through the same rule and the one
     * almost every real disabling takes.
     */
    it('refuses somebody disabled after they had been signing in', async () => {
      await signInAsGoogleAccount({ email: 'michael@example.com', subject: 'google|michael' });
      await accessTakenFrom(USER_ID);

      const back = await signInAsGoogleAccount({
        email: 'michael@example.com',
        subject: 'google|michael',
      });

      expect(back.headers.get('location')).toBe('/signin?refused=access-removed');
      expect(sessionIn(back)).toBeUndefined();
    });

    /**
     * Taken away before they had ever signed in, which is the case that decides
     * the order of the two checks: they are refused for having no access rather
     * than as a stranger, and this Cockpit does not learn which Google account
     * they are on the way.
     */
    it('refuses somebody disabled before their first sign-in, and records nothing about them', async () => {
      await accessTakenFrom(OTHER_USER_ID);

      const back = await signInAsGoogleAccount({ email: 'ada@example.com', subject: 'google|ada' });

      expect(back.headers.get('location')).toBe('/signin?refused=access-removed');
      const [row] = (
        await env.DB.prepare('SELECT google_subject FROM users WHERE id = ?')
          .bind(OTHER_USER_ID)
          .all<{ google_subject: string | null }>()
      ).results;
      expect(row?.google_subject).toBeNull();
    });

    it('lets somebody enabled again sign in, into everything they had', async () => {
      await accessTakenFrom(USER_ID);
      await env.DB.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').bind(USER_ID).run();

      const back = await signInAsGoogleAccount({ email: 'michael@example.com' });

      expect(back.headers.get('location')).toBe('/');
      const workspaces = await SELF.fetch('http://cockpit.test/v1/workspaces', {
        headers: { cookie: sessionIn(back)! },
      });
      expect(workspaces.status).toBe(200);
    });

    /**
     * The second lock, and the one state no request can produce: disabling
     * deletes the sign-ins somebody holds and no new one can be made for them,
     * so a live session for a disabled person only exists in the moment a
     * sign-in lands as the disabling commits. Written into the register
     * directly for that reason - the same exception the constraints suite is
     * written under - and asked through the real gate, which is where the
     * answer has to come from.
     */
    it('refuses a sign-in somebody still holds when their access is taken away', async () => {
      const cookie = await signInAs(USER_ID);
      expect((await SELF.fetch('http://cockpit.test/v1/me', carrying(cookie))).status).toBe(200);

      await accessTakenFrom(USER_ID);

      const res = await SELF.fetch('http://cockpit.test/v1/me', carrying(cookie));
      expect(res.status).toBe(401);
    });
  });

  /**
   * Every way a reply can be wrong is proved at
   * tests/unit/auth/oidc.test.ts, against real tokens and a real key. What
   * cannot be proved there is that any of it is asked on the way in, which is
   * these two - one reply that belongs to another sign-in, and one issuer that
   * will not answer.
   */
  describe('a sign-in only completes for the browser that started it', () => {
    it('refuses a reply carrying another sign-in’s proof', async () => {
      await issuerIsReachable();
      const { attempt } = await startSignIn();

      const back = await comeBack({ code: 'a-code', state: 'a-state-from-somewhere-else' }, attempt);

      expect(back.headers.get('location')).toBe('/signin?refused=failed');
      expect(sessionIn(back)).toBeUndefined();
    });

    it('refuses a reply the browser was never given anything to prove', async () => {
      await issuerIsReachable();
      const { asked } = await startSignIn();

      const back = await comeBack({ code: 'a-code', state: asked.searchParams.get('state')! });

      expect(back.headers.get('location')).toBe('/signin?refused=failed');
      expect(sessionIn(back)).toBeUndefined();
    });

    /**
     * The attempt is spent before the reply is acted on, so a reply delivered
     * twice - out of a browser's history, or by somebody who took the address -
     * finds nothing to check itself against the second time.
     */
    it('refuses the same reply delivered twice', async () => {
      await issuerIsReachable();
      const { asked, attempt } = await startSignIn();
      const reply = { code: 'a-code', state: asked.searchParams.get('state')! };
      issuerWillIdentify({
        email: 'michael@example.com',
        nonce: asked.searchParams.get('nonce')!,
      });
      expect((await comeBack(reply, attempt)).headers.get('location')).toBe('/');

      // The browser is no longer holding the attempt: what it sends the second
      // time is the cookie the first answer deleted, which is nothing.
      const again = await comeBack(reply);

      expect(again.headers.get('location')).toBe('/signin?refused=failed');
      expect(sessionIn(again)).toBeUndefined();
    });

    it('refuses when the issuer will not exchange the code', async () => {
      await issuerIsReachable();
      const { asked, attempt } = await startSignIn();
      issuerWillRefuseTheExchange();

      const back = await comeBack(
        { code: 'a-code', state: asked.searchParams.get('state')! },
        attempt,
      );

      expect(back.headers.get('location')).toBe('/signin?refused=failed');
      expect(sessionIn(back)).toBeUndefined();
    });

    /**
     * What the browser holds while it is away is a secret for as long as one
     * sign-in takes: script must not be able to read it, and it must not
     * outlive the sign-in it belongs to.
     */
    it('leaves the browser holding nothing script can read and nothing that lasts', async () => {
      const res = await SELF.fetch('http://cockpit.test/v1/sign-in/google', { redirect: 'manual' });

      const cookie = res.headers.get('set-cookie')!;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(Number(/Max-Age=(\d+)/.exec(cookie)![1])).toBeLessThanOrEqual(10 * 60);
    });

    it('starts a sign-in of its own for a browser already holding one', async () => {
      const first = await signInAsGoogleAccount({ email: 'michael@example.com' });
      const second = await signInAsGoogleAccount({ email: 'michael@example.com' });

      expect(sessionIn(second)).not.toBe(sessionIn(first));
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
          typeId: TASK_TYPE_ID,
        }),
      });

      await expectRefusedInOurOwnWords(res);
    });

    /**
     * Two, where there used to be three: the list of people to choose from was
     * the third, and it went with the picker. What is left is the health check,
     * which is deliberately outside every gate, and the way in itself.
     */
    it('lets the health check through', async () => {
      expect((await SELF.fetch('http://cockpit.test/health')).status).toBe(200);
    });

    it('lets somebody who is nobody yet start signing in', async () => {
      await issuerIsReachable();
      const res = await SELF.fetch('http://cockpit.test/v1/sign-in/google', { redirect: 'manual' });

      expect(res.status).toBe(302);
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

  /**
   * A browser holding an older build goes on asking for the addresses that
   * build knew, and what it is told decides whether it recovers: a refusal is
   * indistinguishable from "you are not signed in" and lands it on a failure
   * panel, while `410` is read as "you are behind" and fetches the new version
   * ("Update instead of failing when a build asks for an address that has been
   * retired", issue 217, and apps/web/src/updating.ts, which owns that half).
   */
  describe('an address this Cockpit used to have says it is retired, to anyone who asks', () => {
    /**
     * The case that matters, and the reason these are outside the gate: the
     * browser this exists for is on the logon page holding no sign-in, so an
     * answer behind the gate would never reach it.
     */
    it.each([
      { situation: 'the list of people it used to show', path: '/v1/users' },
      { situation: 'the way it used to sign you in', path: '/v1/sign-in' },
    ])('says $situation is gone, to a browser holding no sign-in', async ({ path }) => {
      const res = await SELF.fetch(`http://cockpit.test${path}`);

      expect(res.status).toBe(410);
      expect((await res.json()) as { error: string }).toMatchObject({ error: expect.any(String) });
    });

    it('says the same to one holding a sign-in', async () => {
      const res = await SELF.fetch('http://cockpit.test/v1/users', carrying(await signInAs(USER_ID)));

      expect(res.status).toBe(410);
    });

    /**
     * Every way of asking, because half of the browsers this exists for are
     * making the request the other half are not - the list was read with a GET
     * and signing in was a POST.
     */
    it('says so however it is asked', async () => {
      const res = await SELF.fetch('http://cockpit.test/v1/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-michael' }),
      });

      expect(res.status).toBe(410);
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
      const cookie = await signInAs(USER_ID);
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
      const cookie = await signInAs(USER_ID);
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

    /**
     * What the browser puts in its jar for this address, `name=value`.
     *
     * The whole flow at that address rather than at the test's usual one,
     * because what is being asked about here is the *name* the cookie is given,
     * and the name is derived from the address the request came in on.
     */
    async function signedInAt(at: string, email: string): Promise<string> {
      await issuerIsReachable();
      const started = await SELF.fetch(`${at}/v1/sign-in/google`, { redirect: 'manual' });
      const asked = new URL(started.headers.get('location')!);
      const attempt = started.headers.get('set-cookie')!.split(';')[0]!;

      issuerWillIdentify({ email, nonce: asked.searchParams.get('nonce')! });
      const back = await SELF.fetch(
        `${at}/v1/sign-in/google/callback?code=a-code&state=${asked.searchParams.get('state')}`,
        { headers: { cookie: attempt }, redirect: 'manual' },
      );
      expect(back.headers.get('location')).toBe('/');
      return back.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0]!)
        .find((cookie) => cookie.startsWith('cockpit_session'))!;
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
      const here = await signedInAt(HERE, 'michael@example.com');
      const nextDoor = await signedInAt(NEXT_DOOR, 'ada@example.com');
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
            message: 'Captured while the Cockpit next door was open',
            typeId: TASK_TYPE_ID,
          }),
        }),
      );
      // Asserted with what it said, not on the status alone: every way this
      // can go wrong - the validator, a refusal, a workspace that is not there
      // - arrives as a number that names none of them.
      expect({ status: res.status, said: await res.text() }).toMatchObject({ status: 200 });

      // Michael's own store, so this fails rather than passes if the capture
      // went to the account of whoever signed in next door.
      const captured = await inTheStore((sql) => [
        ...sql.exec<{ captured_message: string }>('SELECT captured_message FROM items'),
      ]);
      expect(captured.map((row) => row.captured_message)).toContain(
        'Captured while the Cockpit next door was open',
      );
    });

    it('refusing a sign-in it was never given does not end the other one', async () => {
      const here = await signedInAt(HERE, 'michael@example.com');

      // Only this Cockpit's, which is the state a browser is in the moment
      // before you sign in to the one next door.
      const refused = await SELF.fetch(`${NEXT_DOOR}/v1/me`, carrying(here));

      expect(refused.status).toBe(401);
      // Nothing handed back at all, which is the discriminating half: it found
      // none of its own to clear, so there is no `Set-Cookie` here to carry
      // this Cockpit's away. Under one name for both it would have found this
      // one, renewed it, and answered as somebody else.
      expect(refused.headers.get('set-cookie')).toBeNull();
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
      const cookie = await signInAs(USER_ID);
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
