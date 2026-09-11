import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import type { SqlStorage } from '@cloudflare/workers-types';
import { FIRST_WORKSPACE_NAME } from '@cockpit/shared';
import type { ChangeUser, RegisteredUser } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  OTHER_ACCOUNT_NAME,
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  asUser,
  inStoreAsItIs,
  seedRegister,
  signInAs,
  startFromEmpty,
  storeNamed,
  taskTypeIn,
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
const ME = 'http://cockpit.test/v1/me';

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

/** Deleting somebody, as the question on their row sends it once answered. */
function remove(who: string, askedBy: string = USER_ID): Promise<Response> {
  return asUser(`${ADMIN_USERS}/${who}`, { method: 'DELETE' }, askedBy);
}

/** Something Ada captured, so her account holds work of her own rather than only what every account starts with. */
const ADAS_ITEM = '018f0000-0000-7000-8000-000000000234';

/**
 * Written into her account directly rather than through a request, because a
 * request would sign her in - and the cases about her sign-in are the ones
 * that have to start it.
 */
async function adaHasCaptured(): Promise<void> {
  const answer = await storeNamed(OTHER_ACCOUNT_NAME).applyChange(OTHER_ACCOUNT_NAME, 'capture_item', {
    commandId: '018f0000-0000-7000-8000-000000000235',
    issuedAt: '2026-09-11T10:00:00.000Z',
    workspaceId: WORKSPACE_ID,
    itemId: ADAS_ITEM,
    message: 'Ada’s own note',
    typeId: taskTypeIn(OTHER_ACCOUNT_NAME),
  });
  expect(answer.status).toBe('ok');
}

/** The tables an account holds, read as it stands, with the platform's own left out. */
function tablesIn(accountName: string): Promise<string[]> {
  return inStoreAsItIs(accountName, (sql) => ownTables(sql));
}

function ownTables(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .toArray()
    .map((row) => row.name)
    .filter((name) => !name.startsWith('_cf_') && !name.startsWith('sqlite_'));
}

/** Every row of every table an account holds, for the case that none of it changed. */
function everythingIn(accountName: string) {
  return inStoreAsItIs(accountName, (sql) =>
    ownTables(sql).map((table) => ({ table, rows: sql.exec(`SELECT * FROM "${table}"`).toArray() })),
  );
}

function itemsIn(accountName: string): Promise<string[]> {
  return inStoreAsItIs(accountName, (sql) =>
    sql
      .exec<{ id: string }>('SELECT id FROM items ORDER BY id')
      .toArray()
      .map((row) => row.id),
  );
}

function workspacesIn(accountName: string): Promise<string[]> {
  return inStoreAsItIs(accountName, (sql) =>
    sql
      .exec<{ name: string }>('SELECT name FROM workspaces WHERE deleted_at IS NULL ORDER BY name')
      .toArray()
      .map((row) => row.name),
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
        lastSignedInAt: null,
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

  describe('deleting a user takes the account they owned with them', () => {
    it('leaves nothing of somebody who had workspaces and items, in the register or their account', async () => {
      await adaHasCaptured();
      expect(await tablesIn(OTHER_ACCOUNT_NAME)).not.toEqual([]);

      expect((await remove(OTHER_USER_ID)).status).toBe(200);

      expect((await listedBy(USER_ID)).map((user) => user.id)).toEqual([USER_ID]);
      expect(
        (await env.DB.prepare('SELECT id FROM tenants WHERE id = ?').bind(OTHER_ACCOUNT_NAME).all())
          .results,
      ).toHaveLength(0);
      // Not a table left, the record of which changes ran included: that is
      // what makes whatever opens this account next start it as a new one.
      expect(await tablesIn(OTHER_ACCOUNT_NAME)).toEqual([]);
    });

    it('deletes somebody who never signed in, whose account nobody ever opened', async () => {
      expect(await tablesIn(OTHER_ACCOUNT_NAME)).toEqual([]);

      expect((await remove(OTHER_USER_ID)).status).toBe(200);

      expect((await listedBy(USER_ID)).map((user) => user.id)).toEqual([USER_ID]);
    });

    it('leaves every other account exactly as it was', async () => {
      // Both opened, so "untouched" is a claim about something that is there.
      await asUser('http://cockpit.test/v1/workspaces');
      await adaHasCaptured();
      const before = await everythingIn(ACCOUNT_NAME);
      expect(before.length).toBeGreaterThan(0);

      await remove(OTHER_USER_ID);

      expect(await everythingIn(ACCOUNT_NAME)).toEqual(before);
    });

    it('refuses the next request from a sign-in they were holding', async () => {
      const ada = await signInAs(OTHER_USER_ID);
      expect((await SELF.fetch(ME, { headers: { cookie: ada } })).status).toBe(200);

      await remove(OTHER_USER_ID);

      expect((await SELF.fetch(ME, { headers: { cookie: ada } })).status).toBe(401);
    });

    /**
     * Adding somebody always makes them an account of their own, but a
     * restored register only checks that an account exists - so two people
     * pointing at one is a state that can arrive, and destroying it would take
     * the other person's work with it.
     */
    it('refuses when somebody else uses the same account, and destroys nothing', async () => {
      await env.DB.prepare(
        'INSERT INTO users (id, name, account_id, role, email, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind('user-grace', 'Grace', OTHER_ACCOUNT_NAME, 'user', 'grace@example.com', '2026-09-11T00:00:00.000Z')
        .run();
      await adaHasCaptured();

      const res = await remove(OTHER_USER_ID);

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/user-grace uses the same account/);
      expect(await itemsIn(OTHER_ACCOUNT_NAME)).toEqual([ADAS_ITEM]);
    });
  });

  describe('deleting a user leaves nothing of their account behind, however old it is', () => {
    /**
     * An account older than the stores can still have rows in the four tables
     * D1 kept for rollback (architecture, "D1 still holds the four tables an
     * account's data used to live in"), and three of them hold `tenants` with a
     * restricting foreign key - so removing the register row was refused after
     * the store had already been destroyed, on every attempt. Written straight
     * into D1, because nothing but history makes these rows now.
     */
    it('deletes somebody whose account is older than this version of Cockpit, and leaves none of what it held', async () => {
      const at = '2026-08-01T00:00:00.000Z';
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO workspaces (id, tenant_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)',
        ).bind('old-ws', OTHER_ACCOUNT_NAME, 'Old', '#3a72c8', at),
        env.DB.prepare(
          'INSERT INTO items (id, tenant_id, workspace_id, source, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind('old-item', OTHER_ACCOUNT_NAME, 'old-ws', 'internal', 'Old item', 'to_process', at, at),
        env.DB.prepare(
          'INSERT INTO associations (id, tenant_id, item_id, kind, label, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).bind('old-association', OTHER_ACCOUNT_NAME, 'old-item', 'person', 'Bart', at),
        env.DB.prepare(
          'INSERT INTO commands (command_id, tenant_id, workspace_id, name, payload, issued_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).bind('old-command', OTHER_ACCOUNT_NAME, 'old-ws', 'capture_item', '{}', at, at),
      ]);

      expect((await remove(OTHER_USER_ID)).status).toBe(200);

      expect((await listedBy(USER_ID)).map((user) => user.id)).toEqual([USER_ID]);
      for (const table of ['workspaces', 'items', 'associations', 'commands']) {
        const { results } = await env.DB.prepare(`SELECT tenant_id FROM ${table} WHERE tenant_id = ?`)
          .bind(OTHER_ACCOUNT_NAME)
          .all();
        expect(results, table).toHaveLength(0);
      }
    });
  });

  describe('a name given back carries nothing of the person who had it', () => {
    /** The reason this whole capability exists, and so the one case it has. */
    it('opens somebody added under a deleted user’s name on what every account starts with, and nothing else', async () => {
      await adaHasCaptured();
      await remove(OTHER_USER_ID);

      const res = await asUser(ADMIN_USERS, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada', email: 'ada.again@example.com' }),
      });
      expect(res.status).toBe(201);

      // The same account as the Ada before her, which is what makes the rest of
      // this mean anything: a name deriving a fresh account would pass whatever
      // deleting did.
      expect(
        (await env.DB.prepare('SELECT account_id FROM users WHERE email = ?').bind('ada.again@example.com').first())
          ?.account_id,
      ).toBe(OTHER_ACCOUNT_NAME);
      expect(await workspacesIn(OTHER_ACCOUNT_NAME)).toEqual([FIRST_WORKSPACE_NAME]);
      expect(await itemsIn(OTHER_ACCOUNT_NAME)).toEqual([]);
    });
  });

  describe('a deletion interrupted leaves nothing that cannot be finished', () => {
    /**
     * Where a deletion that stopped after destroying the account leaves it:
     * still in the register, holding nothing. Destroyed by the account's own
     * operation, which is what the deletion calls.
     */
    async function stoppedAfterTheData() {
      await adaHasCaptured();
      await storeNamed(OTHER_ACCOUNT_NAME).destroy();
    }

    it('lets the person still sign in, to an account holding nothing of theirs', async () => {
      await stoppedAfterTheData();

      const res = await asUser('http://cockpit.test/v1/workspaces', {}, OTHER_USER_ID);

      expect(res.status).toBe(200);
      expect((await listedBy(USER_ID)).map((user) => user.id)).toContain(OTHER_USER_ID);
      expect(await itemsIn(OTHER_ACCOUNT_NAME)).toEqual([]);
    });

    it('finishes when it is run again after that', async () => {
      await stoppedAfterTheData();

      expect((await remove(OTHER_USER_ID)).status).toBe(200);

      expect((await listedBy(USER_ID)).map((user) => user.id)).toEqual([USER_ID]);
    });

    it('answers that there is no such user when run for somebody already deleted, and changes nothing', async () => {
      await remove(OTHER_USER_ID);

      const res = await remove(OTHER_USER_ID);

      expect(res.status).toBe(404);
      expect((await listedBy(USER_ID)).map((user) => user.id)).toEqual([USER_ID]);
      expect(await tablesIn(OTHER_ACCOUNT_NAME)).toEqual([]);
    });
  });

  describe('you cannot delete the last way in', () => {
    it.each([
      {
        situation: 'an admin deletes themselves while another admin is there',
        secondAdmin: true,
        says: /cannot delete yourself/,
      },
      {
        situation: 'the only admin deletes themselves',
        secondAdmin: false,
        says: /only admin/,
      },
    ])('refuses it and changes nothing when $situation', async ({ secondAdmin, says }) => {
      if (secondAdmin) await change(OTHER_USER_ID, { name: 'Ada', role: 'admin' });
      await asUser('http://cockpit.test/v1/workspaces');

      const res = await remove(USER_ID);

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(says);
      expect((await asUser(ADMIN_USERS, {}, USER_ID)).status).toBe(200);
      expect(await workspacesIn(ACCOUNT_NAME)).toEqual([FIRST_WORKSPACE_NAME]);
    });

    /**
     * "The last admin, deleted by another admin" is not a case: whoever asks is
     * an admin who can sign in, so two are counted whenever the two differ. What
     * is left to prove is the direction - that one admin can delete another.
     */
    it('lets an admin be deleted by another admin', async () => {
      await change(OTHER_USER_ID, { name: 'Ada', role: 'admin' });

      expect((await remove(OTHER_USER_ID)).status).toBe(200);
    });

    // That somebody who is not an admin is refused is the gate's, which reads
    // the path before any route: the writes above prove it guards writes, and
    // no change to deleting could make a case of its own here go red.
  });

  describe('what somebody’s account holds is counted before they are deleted', () => {
    async function counted(who: string) {
      const res = await asUser(`${ADMIN_USERS}/${who}/account`);
      return { status: res.status, body: res.ok ? ((await res.json()) as { workspaces: number }) : null };
    }

    it('counts an account nobody ever opened as holding nothing, and opens nothing to say so', async () => {
      expect(await counted(OTHER_USER_ID)).toEqual({ status: 200, body: { workspaces: 0 } });
      expect(await tablesIn(OTHER_ACCOUNT_NAME)).toEqual([]);
    });

    it('counts the workspaces an account holds, and not the ones deleted from it', async () => {
      await adaHasCaptured();
      await inStoreAsItIs(OTHER_ACCOUNT_NAME, (sql) =>
        sql.exec(
          `INSERT INTO workspaces (id, tenant_id, name, folded_name, color, position, created_at, deleted_at)
           VALUES ('ws-gone', ?, 'Gone', 'gone', '#3a72c8', 5, '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:01.000Z')`,
          OTHER_ACCOUNT_NAME,
        ),
      );

      expect(await counted(OTHER_USER_ID)).toEqual({ status: 200, body: { workspaces: 1 } });
    });

    it('answers that there is no such user for somebody the register does not hold', async () => {
      expect((await counted('user-nobody')).status).toBe(404);
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
     * Signing in is what records the timestamp, so this is the one field that
     * is a fact about what somebody has done rather than about the row. Michael
     * has signed in by the time the list is read - `asUser` signs him in to ask
     * - and Ada has not.
     */
    it('says when somebody last signed in, or that they never have', async () => {
      const users = await listedBy(USER_ID);

      expect(users.find((user) => user.id === USER_ID)?.lastSignedInAt).toEqual(expect.any(String));
      expect(users.find((user) => user.id === OTHER_USER_ID)?.lastSignedInAt).toBeNull();
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
