import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import type { RegisteredUser } from '@cockpit/shared';
import { OTHER_USER_ID, USER_ID, asUser, seedRegister, startFromEmpty } from '../seed.js';

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

async function listedBy(userId: string): Promise<RegisteredUser[]> {
  const res = await asUser(ADMIN_USERS, {}, userId);
  expect(res.status).toBe(200);
  return ((await res.json()) as { users: RegisteredUser[] }).users;
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
     * The reason the role is read per request rather than carried in the
     * cookie: taking somebody's admin away has to apply to the sign-in they are
     * already holding, without ending it. Nothing takes a role away yet - that
     * is its own issue - so the register is written directly here, which is
     * what a future admin page will do through a handler.
     */
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

    it('refuses an admin whose role was taken away while they held a sign-in', async () => {
      expect((await asUser(ADMIN_USERS, {}, USER_ID)).status).toBe(200);

      await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind('user', USER_ID).run();

      expect((await asUser(ADMIN_USERS, {}, USER_ID)).status).toBe(403);
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
