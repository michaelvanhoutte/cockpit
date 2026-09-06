import { describe, expect, it } from 'vitest';
import { planRegisterRestore, type RegisterBackup } from '../../../src/accounts/register.js';

/**
 * Unit level, because what a restore may do to the register is a decision about
 * two lists of rows: which are already there, which are missing, and which say
 * something the register already says about somebody else. No register is
 * needed to ask that, and three separate uniqueness rules branch here - the id,
 * the address and the Google identity - which is more cases than it is worth
 * arranging a real register for.
 *
 * The integration suite drives one of each through the route, which is what
 * proves the plan is wired to writes and to a 409.
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

function register(over: Partial<RegisterBackup> = {}): RegisterBackup {
  return { tenants: [], users: [], ...over };
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
