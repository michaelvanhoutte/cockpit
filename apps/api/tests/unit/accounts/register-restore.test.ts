import { describe, expect, it } from 'vitest';
import { planRegisterRestore, type RegisterBackup } from '../../../src/accounts/register.js';

/**
 * Unit level, because what a restore may do to the register is a decision about
 * two lists of rows: which are already there, which are missing, and which say
 * something the register already says about somebody else. No register is
 * needed to ask that, and four separate uniqueness rules branch here - an
 * account's id, a user's id, the address and the Google identity - which is
 * more cases than it is worth arranging a real register for.
 *
 * The integration suite drives one through the route, which is what proves the
 * plan is wired to writes and to a 409.
 */

const AT = '2026-09-01T10:00:00.000Z';

function user(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'user-ada',
    name: 'Ada',
    account_id: 'tenant-ada',
    role: 'user',
    email: 'ada@example.com',
    google_subject: null,
    created_at: AT,
    ...over,
  };
}

/**
 * A register holding what it is given and nothing else. `??` rather than a
 * spread, so a case that names only one of the two halves gets an empty other
 * half instead of `undefined` for it.
 */
function register(over: Partial<RegisterBackup> = {}): RegisterBackup {
  return { tenants: over.tenants ?? [], users: over.users ?? [] };
}

describe('Backup', () => {
  describe('restoring the register brings it up to what the backup needs and no further', () => {
    it('creates an account and its user where the register has neither', () => {
      const plan = planRegisterRestore(
        register(),
        register({ tenants: [{ id: 'tenant-ada', name: 'Ada', created_at: AT }], users: [user()] }),
      );

      expect(plan.tenantsToCreate.map((row) => row.id)).toEqual(['tenant-ada']);
      expect(plan.usersToCreate.map((row) => row.id)).toEqual(['user-ada']);
      expect(plan.collisions).toEqual([]);
    });

    /**
     * A restore replaces an *account's store* wholly. The register is not an
     * account's, it is the environment's, so rewriting a row would reach outside
     * what was asked for - restoring one user would rename another.
     */
    it('leaves a row that is already there exactly as it is', () => {
      const held = { id: 'tenant-ada', name: 'Ada as the register spells her', created_at: AT };
      const plan = planRegisterRestore(
        register({ tenants: [held], users: [user()] }),
        register({
          tenants: [{ id: 'tenant-ada', name: 'Ada as the backup spells her', created_at: AT }],
          users: [user({ name: 'Ada, differently' })],
        }),
      );

      expect(plan.tenantsToCreate).toEqual([]);
      expect(plan.usersToCreate).toEqual([]);
      expect(plan.collisions).toEqual([]);
    });

    it('creates only the rows that are missing, leaving the rest', () => {
      const plan = planRegisterRestore(
        register({ tenants: [{ id: 'tenant-ada', name: 'Ada', created_at: AT }] }),
        register({
          tenants: [
            { id: 'tenant-ada', name: 'Ada', created_at: AT },
            { id: 'tenant-bob', name: 'Bob', created_at: AT },
          ],
          users: [user()],
        }),
      );

      expect(plan.tenantsToCreate.map((row) => row.id)).toEqual(['tenant-bob']);
      expect(plan.usersToCreate.map((row) => row.id)).toEqual(['user-ada']);
    });
  });

  describe('restoring the register refuses a row nothing could write', () => {
    /**
     * The wire schema cannot catch these: a row is an open record there, so
     * `{}` is a valid one - the same gap `sameShapeThroughout` covers on the
     * account side. Without this an empty row reached the insert, which built
     * `INSERT INTO tenants () VALUES ()` and failed as a syntax error nothing
     * mapped: a 500 where a refusal belonged.
     */
    it.each([
      {
        situation: 'an account with no columns at all',
        incoming: { tenants: [{}], users: [] },
        says: /an account at position 1 carries no columns/,
      },
      {
        situation: 'a user with no columns at all',
        incoming: { tenants: [], users: [{}] },
        says: /a user at position 1 carries no columns/,
      },
      {
        situation: 'an account with no id',
        incoming: { tenants: [{ name: 'Ada', created_at: AT }], users: [] },
        says: /an account at position 1 has no id/,
      },
      {
        situation: 'a user owning no account',
        incoming: { tenants: [], users: [user({ account_id: null })] },
        says: /a user at position 1 has no account_id/,
      },
      // Which one it is, said at once, rather than one refusal per re-run.
      {
        situation: 'a user with neither',
        incoming: { tenants: [], users: [user({ id: null, account_id: null })] },
        says: /has no id and no account_id/,
      },
    ])('refuses $situation', ({ incoming, says }) => {
      const plan = planRegisterRestore(register(), register(incoming));

      expect(plan.unusable).toHaveLength(1);
      expect(plan.unusable[0]).toMatch(says);
    });

    it('says nothing about a register whose rows are all writable', () => {
      const plan = planRegisterRestore(
        register(),
        register({ tenants: [{ id: 'tenant-ada', name: 'Ada', created_at: AT }], users: [user()] }),
      );

      expect(plan.unusable).toEqual([]);
    });

    // A sparse row is not an unusable one: the register's own constraints have
    // the last word on every column this plan does not read.
    it('allows a row carrying only what the plan reads', () => {
      const plan = planRegisterRestore(
        register(),
        register({ tenants: [{ id: 'tenant-ada' }], users: [{ id: 'u', account_id: 'tenant-ada' }] }),
      );

      expect(plan.unusable).toEqual([]);
      expect(plan.tenantsToCreate).toHaveLength(1);
    });
  });

  describe('restoring the register is refused where it and the backup disagree about who somebody is', () => {
    it.each([
      {
        situation: 'the same person owning a different account',
        held: [user()],
        incoming: [user({ account_id: 'tenant-somewhere-else' })],
        says: /owning tenant-ada, not tenant-somewhere-else/,
      },
      {
        situation: 'an address already held by somebody else',
        held: [user({ id: 'user-someone', email: 'ada@example.com' })],
        incoming: [user()],
        says: /address ada@example.com is already in the register as user-someone/,
      },
      {
        situation: 'a Google account already held by somebody else',
        held: [user({ id: 'user-someone', email: 'other@example.com', google_subject: 'g-1' })],
        incoming: [user({ google_subject: 'g-1' })],
        says: /Google account behind user-ada is already in the register as user-someone/,
      },
    ])('refuses $situation', ({ held, incoming, says }) => {
      const plan = planRegisterRestore(register({ users: held }), register({ users: incoming }));

      expect(plan.collisions).toHaveLength(1);
      expect(plan.collisions[0]).toMatch(says);
      // Nothing is planned for a register that disagrees, so a caller that
      // ignored the collisions would still not write the row.
      expect(plan.usersToCreate).toEqual([]);
    });

    /**
     * Two users with no address between them are not a collision: SQLite counts
     * NULLs as distinct, which is what lets any number of people wait for a
     * Google account to be attached ("Record the Google account each user signs
     * in with", issue 195).
     */
    it('does not read two people with nothing to sign in by as the same person', () => {
      const plan = planRegisterRestore(
        register({ users: [user({ id: 'user-one', email: null, google_subject: null })] }),
        register({ users: [user({ id: 'user-two', email: null, google_subject: null })] }),
      );

      expect(plan.collisions).toEqual([]);
      expect(plan.usersToCreate.map((row) => row.id)).toEqual(['user-two']);
    });

    /**
     * A backup is a file, so two rows saying different things about one person
     * is a state that can really arrive. Only the register's own rows were
     * looked at before, so a file naming somebody twice passed both through and
     * the unique indexes refused the second at insert - a 500 where the
     * collision this exists to report belonged.
     */
    it.each([
      {
        situation: 'the same user twice',
        users: [user(), user({ name: 'Ada again' })],
        says: /names user user-ada twice/,
      },
      // The one this was got wrong on: the check landed on users and not on
      // accounts, five lines apart, under the comment saying why it exists.
      {
        situation: 'the same account twice',
        tenants: [
          { id: 'tenant-ada', name: 'Ada', created_at: AT },
          { id: 'tenant-ada', name: 'Ada again', created_at: AT },
        ],
        users: [],
        says: /names account tenant-ada twice/,
      },
      {
        situation: 'one address given to two people',
        users: [user(), user({ id: 'user-bob', email: 'ada@example.com' })],
        says: /address ada@example.com to more than one user/,
      },
      {
        situation: 'one Google account given to two people',
        users: [
          user({ google_subject: 'g-1' }),
          user({ id: 'user-bob', email: 'bob@example.com', google_subject: 'g-1' }),
        ],
        says: /Google account to more than one user/,
      },
    ])('refuses a backup naming $situation', ({ tenants = [], users, says }) => {
      const plan = planRegisterRestore(register(), register({ tenants, users }));

      expect(plan.collisions).toHaveLength(1);
      expect(plan.collisions[0]).toMatch(says);
      // The second row is not queued either, so a caller that ignored the
      // collisions still would not write it.
      expect([...plan.tenantsToCreate, ...plan.usersToCreate]).toHaveLength(1);
    });

    /**
     * The register enforces four uniquenesses and every one of them needs a
     * check here, which is the thing this got wrong. Asked as a set so a fifth
     * added to the schema fails here rather than at somebody's insert.
     */
    it('covers every uniqueness the register enforces', () => {
      const everyKind = planRegisterRestore(
        register(),
        register({
          tenants: [
            { id: 't', name: 'a', created_at: AT },
            { id: 't', name: 'b', created_at: AT },
          ],
          users: [
            user({ id: 'u1', email: 'a@b.c', google_subject: 'g' }),
            user({ id: 'u1', email: 'd@e.f', google_subject: 'h' }),
            user({ id: 'u2', email: 'a@b.c', google_subject: 'i' }),
            user({ id: 'u3', email: 'j@k.l', google_subject: 'g' }),
          ],
        }),
      );

      expect(everyKind.collisions).toHaveLength(4);
    });

    // Two people waiting for a Google account is not two people sharing one.
    it('lets a backup name several people with nothing to sign in by', () => {
      const plan = planRegisterRestore(
        register(),
        register({
          users: [
            user({ id: 'user-one', email: null, google_subject: null }),
            user({ id: 'user-two', email: null, google_subject: null }),
          ],
        }),
      );

      expect(plan.collisions).toEqual([]);
      expect(plan.usersToCreate).toHaveLength(2);
    });

    it('reports every disagreement rather than stopping at the first', () => {
      const plan = planRegisterRestore(
        register({
          users: [user(), user({ id: 'user-someone', email: 'taken@example.com' })],
        }),
        register({
          users: [
            user({ account_id: 'tenant-elsewhere' }),
            user({ id: 'user-new', email: 'taken@example.com' }),
          ],
        }),
      );

      expect(plan.collisions).toHaveLength(2);
    });
  });
});
