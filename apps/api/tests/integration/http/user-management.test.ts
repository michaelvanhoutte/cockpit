import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { FIRST_WORKSPACE_NAME } from '@cockpit/shared';
import type { ChangeUser, RegisteredUser } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  OTHER_ACCOUNT_NAME,
  OTHER_USER_ID,
  USER_ID,
  asUser,
  inStoreAsItIs,
  seedRegister,
  signInAs,
  startFromEmpty,
} from '../seed.js';

/**
 * Integration level, because every rule here is about who reaches a handler and
 * about a query against a real register. The role arrives on a join the gate
 * makes per request (`auth/register.ts`), so a unit test would have to invent
 * the one thing being claimed - that the role decided it.
 *
 * What is *not* here: whether a path is an admin path, and what a role opens.
 * Both are decisions about strings and are settled at
 * apps/api/tests/unit/auth/admin.test.ts, including the case this tier cannot
 * express - an address under the prefix that no route serves.
 */

const ADMIN_USERS = 'http://cockpit.test/v1/admin/users';
/** Any instant the schema's `is_timestamp` CHECKs accept. */
const WHEN = '2026-09-07T00:00:00.000Z';
const ME = 'http://cockpit.test/v1/me';
const WORKSPACES = 'http://cockpit.test/v1/workspaces';

async function listedBy(userId: string): Promise<RegisteredUser[]> {
  const res = await asUser(ADMIN_USERS, {}, userId);
  expect(res.status).toBe(200);
  return ((await res.json()) as { users: RegisteredUser[] }).users;
}

/** Changing somebody's name and role, as their row on the admin page does. */
function change(who: string, body: ChangeUser, askedBy: string = USER_ID): Promise<Response> {
  return asUser(
    `${ADMIN_USERS}/${who}`,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    askedBy,
  );
}

/** Deleting somebody and the account they owned, from their row's own menu. */
function remove(who: string, askedBy: string = USER_ID): Promise<Response> {
  return asUser(`${ADMIN_USERS}/${who}`, { method: 'DELETE' }, askedBy);
}

/** Taking somebody's access away, or giving it back, from their row's own menu. */
function access(who: string, disabled: boolean, askedBy: string = USER_ID): Promise<Response> {
  return asUser(
    `${ADMIN_USERS}/${who}/access`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ disabled }),
    },
    askedBy,
  );
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('User management', () => {
  describe('only an admin can see who else has an account', () => {
    it('lists everybody for an admin', async () => {
      const users = await listedBy(USER_ID);

      expect(users.map((user) => user.id).sort()).toEqual([OTHER_USER_ID, USER_ID].sort());
    });

    it('refuses somebody signed in who is not an admin', async () => {
      const res = await asUser(ADMIN_USERS, {}, OTHER_USER_ID);

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'not allowed' });
    });

    /**
     * Sent to the logon page rather than told it is an admin address: whoever
     * is nobody yet has no role to be refused for, and the sign-in gate is in
     * front of this one.
     */
    it('refuses somebody holding no sign-in', async () => {
      const res = await SELF.fetch(ADMIN_USERS);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'sign in to continue' });
    });

    /**
     * The hole the operator's gate was opened by once, asked again of this one
     * because it is a new prefix rather than the same one renamed: the router
     * decodes a path before matching it, so a gate reading the raw URL sees a
     * string the router never used and waves the request through to a handler
     * it thinks nothing guards. Ada is signed in, because a session is the one
     * thing somebody trying this already has.
     */
    it.each([
      { situation: 'the first letter escaped', path: '/v1/%61dmin/users' },
      { situation: 'a letter in the middle escaped', path: '/v1/adm%69n/users' },
    ])('refuses an ordinary user asking with $situation', async ({ path }) => {
      const res = await asUser(`http://cockpit.test${path}`, {}, OTHER_USER_ID);

      expect(res.status).toBe(403);
    });

  });

  describe('adding a user gives them an account of their own, ready to sign in to', () => {
    async function add(body: unknown, userId: string = USER_ID) {
      return asUser(
        ADMIN_USERS,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
        userId,
      );
    }

    it('adds the person, and an account holding the workspace every account starts with', async () => {
      const res = await add({ name: 'Anna', email: 'anna@example.com' });

      expect(res.status).toBe(201);
      const { user, accountReady } = (await res.json()) as {
        user: RegisteredUser;
        accountReady: boolean;
      };
      expect(user).toMatchObject({
        id: 'user-anna',
        name: 'Anna',
        email: 'anna@example.com',
        role: 'user',
        accountName: 'Anna',
        hasSignedIn: false,
      });
      expect(accountReady).toBe(true);

      expect(
        (await env.DB.prepare('SELECT id FROM tenants WHERE id = ?').bind('tenant-anna').all())
          .results,
      ).toHaveLength(1);

      /**
       * The half the register cannot show: her *store*, opened as she was
       * added, holding the workspace every account starts with rather than
       * nothing. Read as it stands - not brought up to date first - because
       * being already up to date is exactly the claim.
       */
      const workspaces = await inStoreAsItIs('tenant-anna', (sql) => [
        ...sql.exec('SELECT name FROM workspaces ORDER BY name').raw(),
      ]);
      expect(workspaces.flat()).toEqual([FIRST_WORKSPACE_NAME]);
    });

    it('lists the person it just added', async () => {
      await add({ name: 'Anna', email: 'anna@example.com' });

      expect((await listedBy(USER_ID)).map((user) => user.id)).toContain('user-anna');
    });

    /**
     * Names are not unique and the register has never asked them to be; the
     * address is what it enforces. So the second Anna is added with an account
     * of her own rather than refused.
     */
    it('adds a second person of the same name, with an account of their own', async () => {
      await add({ name: 'Anna', email: 'anna@example.com' });
      const res = await add({ name: 'Anna', email: 'anna.smith@example.com' });

      expect(res.status).toBe(201);
      const { user } = (await res.json()) as { user: RegisteredUser };
      expect(user.id).toBe('user-anna-2');
    });

    /**
     * Three people whose name fills the account limit, which is where the
     * derivation and the lookup can disagree: the second one's id is trimmed to
     * make room for its suffix, so a lookup keyed on the untrimmed name cannot
     * see it - and the third is handed the id the second already has, refused
     * by the register, and told to try again for ever. Three rather than two,
     * because two is the case that works either way.
     */
    it('tells three people of one very long name apart', async () => {
      const long = 'Annabellinda'.repeat(4);
      const ids: string[] = [];

      for (const who of ['one', 'two', 'three']) {
        const res = await add({ name: long, email: `${who}@example.com` });
        expect(res.status).toBe(201);
        ids.push(((await res.json()) as { user: RegisteredUser }).user.id);
      }

      expect(new Set(ids).size).toBe(3);
    });

    it.each([
      {
        situation: 'an address somebody already has',
        body: { name: 'Someone', email: 'ada@example.com' },
        says: /already how user-ada signs in/,
      },
      {
        situation: 'the same address spelled in another case',
        body: { name: 'Someone', email: 'ADA@Example.com' },
        says: /already how user-ada signs in/,
      },
      // What a name derives and what an address has to look like are settled at
      // apps/api/tests/unit/accounts/new-user.test.ts; re-proving them here
      // would be the upward duplication the testing strategy rejects. What is
      // left is the pair only a real register can answer.
    ])('refuses $situation, and writes nothing', async ({ body, says }) => {
      const before = (await env.DB.prepare('SELECT id FROM users').all()).results.length;

      const res = await add(body);

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(says);
      expect((await env.DB.prepare('SELECT id FROM users').all()).results).toHaveLength(before);
    });

    it('refuses a request with no address at all before it reaches the register', async () => {
      const res = await add({ name: 'Anna' });

      expect(res.status).toBe(400);
    });

    /**
     * The same gate as the list, asked of the write as well: a role that only
     * guarded reads would be a page an ordinary user cannot see and can still
     * change.
     */
    it('refuses somebody who is not an admin', async () => {
      const res = await add({ name: 'Anna', email: 'anna@example.com' }, OTHER_USER_ID);

      expect(res.status).toBe(403);
      expect((await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind('user-anna').all()).results)
        .toHaveLength(0);
    });
  });

  describe('a role changes what somebody may do from their next request onward', () => {
    /**
     * The whole reason the role is read per request rather than carried in the
     * cookie: it has to apply to the sign-in somebody is already holding,
     * without ending it. A case signs in once and `asUser` carries that same
     * cookie afterwards (`seed.ts`), so the two reads either side of the change
     * are the one sign-in being answered differently.
     */
    it('answers an ordinary user made an admin, on the sign-in they already held', async () => {
      expect((await asUser(ADMIN_USERS, {}, OTHER_USER_ID)).status).toBe(403);

      await change(OTHER_USER_ID, { name: 'Ada', role: 'admin' });

      expect((await asUser(ADMIN_USERS, {}, OTHER_USER_ID)).status).toBe(200);
    });

    it('refuses an admin made ordinary, without ending the sign-in they held', async () => {
      expect((await asUser(ADMIN_USERS, {}, USER_ID)).status).toBe(200);

      await change(OTHER_USER_ID, { name: 'Ada', role: 'admin' });
      const res = await change(USER_ID, { name: 'Michael', role: 'user' }, OTHER_USER_ID);
      expect(res.status).toBe(200);

      expect((await asUser(ADMIN_USERS, {}, USER_ID)).status).toBe(403);
      // Refused this page, and still signed in: a role is not a sign-in, and
      // taking one away must not throw somebody out of the app.
      expect((await asUser('http://cockpit.test/v1/me', {}, USER_ID)).status).toBe(200);
    });

    it.each([
      {
        situation: 'an admin takes their own admin away while another admin is there',
        secondAdmin: true,
        says: /another admin can do it for you/,
      },
      {
        situation: 'the only admin makes themselves ordinary',
        secondAdmin: false,
        says: /only admin/,
      },
    ])('refuses it and changes nothing when $situation', async ({ secondAdmin, says }) => {
      if (secondAdmin) await change(OTHER_USER_ID, { name: 'Ada', role: 'admin' });

      const res = await change(USER_ID, { name: 'Michael', role: 'user' });

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(says);
      // Still an admin, so the page they would put it back from is still open.
      expect((await asUser(ADMIN_USERS, {}, USER_ID)).status).toBe(200);
    });

    /**
     * Both directions, because one of them is the refusal turned around: an
     * `askedBy` compared the wrong way would let each admin demote only
     * themselves, which is the exact opposite of the rule and passes a case
     * that walks one way.
     */
    it('lets either of two admins be made ordinary by the other', async () => {
      await change(OTHER_USER_ID, { name: 'Ada', role: 'admin' });

      expect((await change(OTHER_USER_ID, { name: 'Ada', role: 'user' })).status).toBe(200);

      await change(OTHER_USER_ID, { name: 'Ada', role: 'admin' });
      expect((await change(USER_ID, { name: 'Michael', role: 'user' }, OTHER_USER_ID)).status).toBe(
        200,
      );
    });

    // Two admins demoting each other in the same instant could get past both
    // reads and leave none: a window `changeUser` records and does not close,
    // and one no test here can produce - two requests through `SELF.fetch` are
    // answered one after the other, so the second reads what the first wrote.

    it('refuses somebody who is not an admin, and changes nothing', async () => {
      const res = await change(USER_ID, { name: 'Somebody Else', role: 'user' }, OTHER_USER_ID);

      expect(res.status).toBe(403);
      expect((await listedBy(USER_ID)).find((user) => user.id === USER_ID)?.name).toBe('Michael');
    });
  });

  describe('a renamed user is renamed everywhere their name is shown', () => {
    /**
     * The account too, because it is named after the person who owns it - the
     * pair `addUser` creates. Left behind, the list would put "Ada Lovelace"
     * and "Ada" side by side with nothing to explain the difference and no way
     * for an admin to put it right.
     */
    it('shows the new name in the list, on the person and on their account', async () => {
      await change(OTHER_USER_ID, { name: '  Ada Lovelace  ', role: 'user' });

      const ada = (await listedBy(USER_ID)).find((user) => user.id === OTHER_USER_ID);
      // Trimmed, because the box is where the spaces come from.
      expect(ada?.name).toBe('Ada Lovelace');
      expect(ada?.accountName).toBe('Ada Lovelace');
    });

    it('leaves the account alone when the change is refused', async () => {
      expect((await change(USER_ID, { name: 'Michael V', role: 'user' })).status).toBe(409);

      expect((await listedBy(USER_ID)).find((user) => user.id === USER_ID)?.accountName).toBe(
        'Michael',
      );
    });

    /**
     * The half a list cannot show: what the app calls the person who was
     * renamed, which is read from the register on every request just as the
     * role is.
     */
    it('changes what the app calls the person who was renamed', async () => {
      await change(USER_ID, { name: 'Michael V', role: 'admin' });

      const res = await asUser('http://cockpit.test/v1/me', {}, USER_ID);
      expect(((await res.json()) as { user: { name: string } }).user.name).toBe('Michael V');
    });

    /**
     * Names are not unique and the register has never asked them to be, which
     * `addUser` already relies on: what it enforces is the address, and that is
     * not editable here at all.
     */
    it('accepts a name another user already has', async () => {
      expect((await change(OTHER_USER_ID, { name: 'Michael', role: 'user' })).status).toBe(200);

      expect((await listedBy(USER_ID)).map((user) => user.name)).toEqual(['Michael', 'Michael']);
    });

    it('refuses a change to somebody the register does not hold', async () => {
      const res = await change('user-nobody', { name: 'Nobody', role: 'user' });

      expect(res.status).toBe(404);
    });
  });

  describe('taking somebody’s access away ends the sign-ins they already hold', () => {
    it('refuses the next request from a tab they left open', async () => {
      const ada = await signInAs(OTHER_USER_ID);
      expect((await SELF.fetch(ME, { headers: { cookie: ada } })).status).toBe(200);

      expect((await access(OTHER_USER_ID, true)).status).toBe(200);

      // 401 rather than 403, which is what sends the tab to the logon page: the
      // sign-in it was holding is not one any more.
      expect((await SELF.fetch(ME, { headers: { cookie: ada } })).status).toBe(401);
    });

    /**
     * Only a disabling ends anything. Two admins with the list open, one
     * enables Ada and she gets back to work, the other's copy still shows her
     * disabled and offers Enable - and pressing it must not throw her out of
     * what she is doing.
     */
    it('leaves the sign-ins of somebody who already has their access alone', async () => {
      const ada = await signInAs(OTHER_USER_ID);

      expect((await access(OTHER_USER_ID, false)).status).toBe(200);

      expect((await SELF.fetch(ME, { headers: { cookie: ada } })).status).toBe(200);
    });

    /**
     * Deleted rather than merely refused, so giving somebody their access back
     * does not revive a sign-in they are no longer at the keyboard for. They
     * sign in afresh, which the sign-in suite proves they can.
     */
    it('does not give the old sign-in back when they are enabled again', async () => {
      const ada = await signInAs(OTHER_USER_ID);
      await access(OTHER_USER_ID, true);

      await access(OTHER_USER_ID, false);

      expect((await SELF.fetch(ME, { headers: { cookie: ada } })).status).toBe(401);
      expect(
        (await env.DB.prepare('SELECT id FROM sessions WHERE user_id = ?').bind(OTHER_USER_ID).all())
          .results,
      ).toHaveLength(0);
    });
  });

  describe('a disabled user keeps everything they own', () => {
    /**
     * The whole reason this exists beside deleting somebody: their account is
     * not touched, so enabling them again puts them back into exactly what they
     * left. Read from the store as it stands rather than through a request,
     * since the person it belongs to can no longer make one.
     */
    it('leaves their account holding what it held', async () => {
      // Ada opens her account, which is what builds her store: an account
      // nobody has ever used holds nothing, and "nothing is still nothing"
      // would be a case that cannot fail.
      const hers = await asUser('http://cockpit.test/v1/workspaces', {}, OTHER_USER_ID);
      const before = ((await hers.json()) as { workspaces: { name: string }[] }).workspaces.map(
        (workspace) => workspace.name,
      );
      expect(before.length).toBeGreaterThan(0);

      await access(OTHER_USER_ID, true);

      // Read as it stands rather than through a request, since the person it
      // belongs to can no longer make one - which is the point.
      const after = await inStoreAsItIs(OTHER_ACCOUNT_NAME, (sql) => [
        ...sql.exec('SELECT name FROM workspaces ORDER BY name').raw(),
      ]);
      expect(after.flat().sort()).toEqual([...before].sort());
    });

    /**
     * The column arrived on a register that already had people in it and
     * nothing was backfilled, so absent has to mean enabled - otherwise the
     * migration would have locked everybody out on the way in.
     */
    it('says everybody already in the register still has their access', async () => {
      expect((await listedBy(USER_ID)).map((user) => user.disabled)).toEqual([false, false]);
    });

    it('says so on the row once somebody is disabled, rather than dropping them', async () => {
      await access(OTHER_USER_ID, true);

      const users = await listedBy(USER_ID);
      expect(users).toHaveLength(2);
      expect(users.find((user) => user.id === OTHER_USER_ID)?.disabled).toBe(true);
    });
  });

  describe('you cannot disable the last way in', () => {
    it.each([
      {
        situation: 'an admin takes their own access away while another admin is there',
        secondAdmin: true,
        says: /another admin can do it for you/,
      },
      {
        situation: 'the only admin takes their own access away',
        secondAdmin: false,
        says: /only admin/,
      },
    ])('refuses it and changes nothing when $situation', async ({ secondAdmin, says }) => {
      if (secondAdmin) await change(OTHER_USER_ID, { name: 'Ada', role: 'admin' });

      const res = await access(USER_ID, true);

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(says);
      expect((await asUser(ADMIN_USERS, {}, USER_ID)).status).toBe(200);
    });

    /**
     * An admin who cannot sign in can do nothing for anybody, so counting them
     * would tell the last one left that somebody else could help - which is the
     * one sentence this rule exists to get right.
     */
    it('does not count an admin who has no access as somebody who could help', async () => {
      await change(OTHER_USER_ID, { name: 'Ada', role: 'admin' });
      await access(OTHER_USER_ID, true);

      const res = await access(USER_ID, true);

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/only admin/);
    });

    /**
     * The count includes the person being changed whatever their access,
     * because the rule subtracts them: leaving a disabled admin out of their
     * own count made the last one who *can* sign in look like the last admin
     * there is - so an admin disabled first, which is the ordinary order, could
     * not then be made ordinary at all.
     */
    it.each([
      {
        situation: 'made ordinary',
        act: (who: string) => change(who, { name: 'Ada', role: 'user' }),
      },
      { situation: 'disabled again', act: (who: string) => access(who, true) },
    ])('lets an admin who already has no access be $situation', async ({ act }) => {
      await change(OTHER_USER_ID, { name: 'Ada', role: 'admin' });
      await access(OTHER_USER_ID, true);

      expect((await act(OTHER_USER_ID)).status).toBe(200);
    });

    it('refuses disabling the last admin, whoever asks', async () => {
      await change(OTHER_USER_ID, { name: 'Ada', role: 'admin' });
      await change(USER_ID, { name: 'Michael', role: 'user' }, OTHER_USER_ID);

      const res = await access(OTHER_USER_ID, true, OTHER_USER_ID);

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/only admin/);
    });

    it('lets an ordinary user be disabled', async () => {
      expect((await access(OTHER_USER_ID, true)).status).toBe(200);
    });

    it('refuses somebody who is not an admin, and changes nothing', async () => {
      const res = await access(USER_ID, true, OTHER_USER_ID);

      expect(res.status).toBe(403);
      expect((await listedBy(USER_ID)).find((user) => user.id === USER_ID)?.disabled).toBe(false);
    });

    it('refuses taking the access of somebody the register does not hold', async () => {
      expect((await access('user-nobody', true)).status).toBe(404);
    });
  });

  /**
   * What the question asked before deleting somebody is built on: the page says
   * what goes with them, and it cannot say it from anything the list holds.
   */
  describe('what somebody’s account holds can be asked before they are deleted', () => {
    function holdingsOf(who: string, askedBy: string = USER_ID): Promise<Response> {
      return asUser(`${ADMIN_USERS}/${who}/account`, {}, askedBy);
    }

    it('counts the workspaces the account has', async () => {
      expect((await asUser(WORKSPACES, {}, OTHER_USER_ID)).status).toBe(200);

      const res = await holdingsOf(OTHER_USER_ID);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workspaces: 1 });
    });

    /**
     * The invariant the whole answer rests on. Bringing an account up to date is
     * what creates the workspace it starts with, so an answer read the ordinary
     * way would say "one workspace" for an account holding nothing - and make it
     * hold one on the way past, which is a page creating what it came to count.
     */
    it('says an account nobody has opened holds nothing, and does not open it', async () => {
      const res = await holdingsOf(OTHER_USER_ID);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workspaces: 0 });
      expect(
        await inStoreAsItIs(OTHER_ACCOUNT_NAME, (sql) => [
          ...sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").raw(),
        ]),
      ).toEqual([]);
    });

    it('answers somebody the register does not hold as nobody', async () => {
      expect((await holdingsOf('user-nobody')).status).toBe(404);
    });

    it('refuses somebody who is not an admin', async () => {
      expect((await holdingsOf(USER_ID, OTHER_USER_ID)).status).toBe(403);
    });
  });

  describe('deleting a user takes the account they owned with them', () => {
    /** What that account holds, read as it stands - never brought up to date. */
    function stillHolds(accountName: string) {
      return inStoreAsItIs(accountName, (sql) => [
        ...sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").raw(),
      ]).then((tables) => tables.flat());
    }

    it('takes the person, their account and its contents', async () => {
      // Ada opens her account, which is what puts anything in it.
      expect((await asUser(WORKSPACES, {}, OTHER_USER_ID)).status).toBe(200);
      expect((await stillHolds(OTHER_ACCOUNT_NAME)).length).toBeGreaterThan(0);

      expect((await remove(OTHER_USER_ID)).status).toBe(204);

      expect((await listedBy(USER_ID)).map((user) => user.id)).toEqual([USER_ID]);
      expect(
        (await env.DB.prepare('SELECT id FROM tenants WHERE id = ?').bind(OTHER_ACCOUNT_NAME).all())
          .results,
      ).toHaveLength(0);
      expect(await stillHolds(OTHER_ACCOUNT_NAME)).toEqual([]);
    });

    /**
     * The ordinary state of somebody added and never signed in: there is no
     * data to destroy, and looking for some must not be what stops this.
     */
    it('deletes somebody whose account was never opened', async () => {
      expect(await stillHolds(OTHER_ACCOUNT_NAME)).toEqual([]);

      expect((await remove(OTHER_USER_ID)).status).toBe(204);

      expect((await listedBy(USER_ID)).map((user) => user.id)).toEqual([USER_ID]);
    });

    it('leaves another account exactly as it was', async () => {
      const mine = await asUser(WORKSPACES, {}, USER_ID);
      const before = ((await mine.json()) as { workspaces: { name: string }[] }).workspaces;
      expect((await asUser(WORKSPACES, {}, OTHER_USER_ID)).status).toBe(200);

      await remove(OTHER_USER_ID);

      const after = await asUser(WORKSPACES, {}, USER_ID);
      expect(((await after.json()) as { workspaces: { name: string }[] }).workspaces).toEqual(before);
    });

    /**
     * D1 still holds the four tables an account's data used to live in
     * (src/db/schema.ts), rows and all, because promoting an earlier commit is
     * the first way back and those rows are what it reads. Three of them point
     * at `tenants` under ON DELETE RESTRICT, so a deployed environment - where
     * every account that predates the stores has rows there - refuses the
     * account row unless they go first, and refuses it *after* the store is
     * already destroyed. Nothing in a migrated-but-empty test database has a
     * row to restrict it, which is why this one puts one there.
     */
    it('takes the rows D1 still holds from before the stores', async () => {
      await env.DB.batch([
        env.DB
          .prepare(
            'INSERT INTO workspaces (id, tenant_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .bind('ws-before', OTHER_ACCOUNT_NAME, 'Before', '#8b5cf6', WHEN),
        env.DB
          .prepare(
            'INSERT INTO items (id, tenant_id, workspace_id, source, title, status, unseen,' +
              ' created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind('item-before', OTHER_ACCOUNT_NAME, 'ws-before', 'internal', 'Hers', 'task', 0, WHEN, WHEN),
        env.DB
          .prepare(
            'INSERT INTO associations (id, tenant_id, item_id, kind, label, created_at)' +
              ' VALUES (?, ?, ?, ?, ?, ?)',
          )
          .bind('assoc-before', OTHER_ACCOUNT_NAME, 'item-before', 'person', 'Ada', WHEN),
        env.DB
          .prepare(
            'INSERT INTO commands (command_id, tenant_id, workspace_id, name, payload, issued_at,' +
              ' received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .bind('cmd-before', OTHER_ACCOUNT_NAME, 'ws-before', 'item.create', '{}', WHEN, WHEN),
      ]);

      expect((await remove(OTHER_USER_ID)).status).toBe(204);

      for (const table of ['associations', 'items', 'commands', 'workspaces']) {
        const { results } = await env.DB
          .prepare(`SELECT 1 FROM ${table} WHERE tenant_id = ?`)
          .bind(OTHER_ACCOUNT_NAME)
          .all();
        expect(results, `${table} still holds rows of the account that was deleted`).toHaveLength(0);
      }
      expect(
        (await env.DB.prepare('SELECT id FROM tenants WHERE id = ?').bind(OTHER_ACCOUNT_NAME).all())
          .results,
      ).toHaveLength(0);
    });

    /** Another account's rows in those same tables are nobody else's to take. */
    it('leaves the rows D1 holds for another account', async () => {
      await env.DB
        .prepare('INSERT INTO workspaces (id, tenant_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind('ws-mine', ACCOUNT_NAME, 'Mine', '#8b5cf6', WHEN)
        .run();

      expect((await remove(OTHER_USER_ID)).status).toBe(204);

      const { results } = await env.DB
        .prepare('SELECT id FROM workspaces WHERE tenant_id = ?')
        .bind(ACCOUNT_NAME)
        .all();
      expect(results).toHaveLength(1);
    });

    it('refuses the sign-in they were holding at its next request', async () => {
      const ada = await signInAs(OTHER_USER_ID);
      expect((await SELF.fetch(ME, { headers: { cookie: ada } })).status).toBe(200);

      await remove(OTHER_USER_ID);

      expect((await SELF.fetch(ME, { headers: { cookie: ada } })).status).toBe(401);
    });
  });

  /**
   * The reason this issue exists. An account is addressed by its name, so a
   * name handed out again would open the store the last person left behind -
   * and one person would be looking at another's work, with nothing anywhere
   * saying so.
   */
  describe('a name given back carries nothing of the person who had it', () => {
    it('opens an account with only what every account starts with', async () => {
      const add = (body: unknown) =>
        asUser(
          ADMIN_USERS,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
          USER_ID,
        );

      await add({ name: 'Anna', email: 'anna@example.com' });
      /**
       * Something of hers in the account, so that finding it afterwards would
       * be finding *her* work rather than what any account starts with. Written
       * into the store rather than made through a request because only the
       * seeded people can sign in here; what is being proved is that deleting
       * takes it, not how it got there.
       */
      await inStoreAsItIs('tenant-anna', (sql) =>
        sql.exec(
          'INSERT INTO workspaces (id, tenant_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)',
          'ws-hers',
          'tenant-anna',
          'Hers',
          '#8b5cf6',
          '2026-09-07T00:00:00.000Z',
        ),
      );

      await remove('user-anna');

      // Somebody else, deriving the same name and so the same account.
      const again = await add({ name: 'Anna', email: 'anna.two@example.com' });
      expect(((await again.json()) as { user: RegisteredUser }).user.id).toBe('user-anna');

      // Read from the store as it stands: adding somebody opens their account,
      // so by now it holds what a new account holds - and nothing of Anna's.
      const names = await inStoreAsItIs('tenant-anna', (sql) => [
        ...sql.exec('SELECT name FROM workspaces ORDER BY name').raw(),
      ]);
      expect(names.flat()).toEqual([FIRST_WORKSPACE_NAME]);
    });
  });

  describe('you cannot delete the last way in', () => {
    it.each([
      {
        situation: 'an admin deletes themselves while another admin is there',
        secondAdmin: true,
        says: /another admin can do it for you/,
      },
      {
        situation: 'the only admin deletes themselves',
        secondAdmin: false,
        says: /only admin/,
      },
    ])('refuses it and deletes nothing when $situation', async ({ secondAdmin, says }) => {
      if (secondAdmin) await change(OTHER_USER_ID, { name: 'Ada', role: 'admin' });

      const res = await remove(USER_ID);

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(says);
      expect((await listedBy(USER_ID)).map((user) => user.id)).toContain(USER_ID);
    });

    it('refuses deleting the last admin, whoever asks', async () => {
      await change(OTHER_USER_ID, { name: 'Ada', role: 'admin' });
      await change(USER_ID, { name: 'Michael', role: 'user' }, OTHER_USER_ID);

      const res = await remove(OTHER_USER_ID, OTHER_USER_ID);

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/only admin/);
    });

    it('refuses somebody who is not an admin, and deletes nothing', async () => {
      const res = await remove(USER_ID, OTHER_USER_ID);

      expect(res.status).toBe(403);
      expect((await listedBy(USER_ID)).map((user) => user.id)).toContain(USER_ID);
    });

    /**
     * A second attempt, which is also what an interrupted deletion meets: the
     * register no longer holds them, so there is no such user and nothing else
     * is touched.
     */
    it('answers a second deletion as somebody the register does not hold', async () => {
      expect((await remove(OTHER_USER_ID)).status).toBe(204);

      expect((await remove(OTHER_USER_ID)).status).toBe(404);
      expect((await listedBy(USER_ID)).map((user) => user.id)).toEqual([USER_ID]);
    });
  });

  describe('the list says everything the register knows about a person', () => {
    it('says who somebody is, what they hold and which account is theirs', async () => {
      const [ada] = await listedBy(USER_ID).then((users) =>
        users.filter((user) => user.id === OTHER_USER_ID),
      );

      expect(ada).toMatchObject({
        id: OTHER_USER_ID,
        name: 'Ada',
        email: 'ada@example.com',
        role: 'user',
        // The account's name, not the id it is addressed by: `tenant-ada` is
        // how the platform reaches a store and says nothing to a reader.
        accountName: 'Ada',
      });
    });

    /**
     * Two claims the seeded pair cannot make, since both their names are
     * capitalised and different: that the order does not put every capital
     * ahead of every lowercase letter, and that two people of one name come
     * back in a settled order rather than whichever SQLite chose this time.
     */
    it('lists people by name, folded, and settles a tie rather than leaving one', async () => {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(
          'tenant-zoe',
          'Zoe',
          '2026-09-07T00:00:00.000Z',
        ),
        env.DB.prepare(
          'INSERT INTO users (id, name, account_id, role, email, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).bind('user-zoe', 'zoe', 'tenant-zoe', 'user', 'zoe@example.com', '2026-09-07T00:00:00.000Z'),
      ]);

      const names = (await listedBy(USER_ID)).map((user) => user.name);

      expect(names).toEqual(['Ada', 'Michael', 'zoe']);
    });

    /**
     * Signing in is what records the Google identity, so this is the one field
     * that is a fact about what somebody has done rather than about the row.
     * Michael has signed in by the time the list is read - `asUser` signs him
     * in to ask - and Ada has not.
     */
    it('says whether somebody has ever signed in', async () => {
      const users = await listedBy(USER_ID);

      expect(users.find((user) => user.id === USER_ID)?.hasSignedIn).toBe(true);
      expect(users.find((user) => user.id === OTHER_USER_ID)?.hasSignedIn).toBe(false);
    });

    /**
     * The one screen in the product that crosses accounts on purpose. Stated
     * rather than assumed, because every other read is scoped to the account
     * the sign-in names and this one must not be.
     */
    it('lists people who own other accounts, not only the asker’s', async () => {
      const users = await listedBy(USER_ID);

      expect(users.map((user) => user.accountName).sort()).toEqual(['Ada', 'Michael']);
    });
  });
});
