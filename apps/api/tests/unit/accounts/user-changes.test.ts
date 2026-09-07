import { describe, expect, it } from 'vitest';
import { whatStopsChanging } from '../../../src/accounts/user-changes.js';

/**
 * Unit level: which changes are refused is a decision about a person's current
 * role, who is asking and how many admins there are - three values, no register
 * behind them. That the refusal reaches a caller, and that a role applies from
 * the next request onward, are the integration suite's
 * (`tests/integration/http/user-management.test.ts`), which is the only place
 * they can be shown.
 */
describe('User management', () => {
  const ADA = { id: 'user-ada', role: 'user' };
  const MICHAEL = { id: 'user-michael', role: 'admin' };
  const BOTH = [MICHAEL.id, ADA.id];

  describe('a change is refused only where it would leave the admin pages unreachable', () => {
    it.each([
      {
        situation: 'somebody is renamed',
        who: ADA,
        change: { name: 'Ada Lovelace', role: 'user' as const },
        askedBy: MICHAEL.id,
        admins: [MICHAEL.id],
      },
      {
        situation: 'somebody is made an admin',
        who: ADA,
        change: { name: 'Ada', role: 'admin' as const },
        askedBy: MICHAEL.id,
        admins: [MICHAEL.id],
      },
      // The one who is only an admin has nothing to lose by it.
      {
        situation: 'the only admin makes themselves an admin again',
        who: MICHAEL,
        change: { name: 'Michael', role: 'admin' as const },
        askedBy: MICHAEL.id,
        admins: [MICHAEL.id],
      },
      {
        situation: 'one of two admins is made ordinary by the other',
        who: MICHAEL,
        change: { name: 'Michael', role: 'user' as const },
        askedBy: ADA.id,
        admins: BOTH,
      },
      // Names have never been unique here and the register does not ask them to
      // be; what it enforces is the address, which is not editable at all.
      {
        situation: 'somebody is given a name another person already has',
        who: ADA,
        change: { name: 'Michael', role: 'user' as const },
        askedBy: MICHAEL.id,
        admins: [MICHAEL.id],
      },
    ])('allows it when $situation', ({ who, change, askedBy, admins }) => {
      expect(whatStopsChanging({ who, change, askedBy, admins })).toBeNull();
    });

    it.each([
      {
        situation: 'the name is nothing but spaces',
        who: ADA,
        change: { name: '   ', role: 'user' as const },
        askedBy: MICHAEL.id,
        admins: [MICHAEL.id],
        says: /a name is needed/,
      },
      /**
       * The mistake that cannot be undone by the person making it: an admin who
       * takes their own role away is on the far side of the gate the moment the
       * request lands, so the page they would put it back from is one they can
       * no longer open.
       */
      {
        situation: 'an admin takes their own admin away',
        who: MICHAEL,
        change: { name: 'Michael', role: 'user' as const },
        askedBy: MICHAEL.id,
        admins: BOTH,
        says: /another admin can do it for you/,
      },
      /**
       * Said differently on purpose: "another admin can do it for you" is false
       * when there is no other admin, and the way back from nobody holding the
       * role is the SQL the environment was bootstrapped with.
       */
      {
        situation: 'the last admin is made ordinary',
        who: MICHAEL,
        change: { name: 'Michael', role: 'user' as const },
        askedBy: MICHAEL.id,
        admins: [MICHAEL.id],
        says: /only admin/,
      },
    ])('refuses it when $situation, saying why', ({ who, change, askedBy, admins, says }) => {
      expect(whatStopsChanging({ who, change, askedBy, admins })?.what).toMatch(says);
    });

    /**
     * A role the register should never hold, which the column's CHECK is what
     * really prevents. Asked anyway because this is the code that has to be
     * right if that constraint is ever wrong: anything that is not `admin` has
     * nothing to lose, so nothing here refuses the change.
     */
    it('treats a role it does not know as one that opens nothing', () => {
      const change = { name: 'Somebody', role: 'user' as const };

      expect(
        whatStopsChanging({
          who: { id: 'user-somebody', role: 'wizard' },
          change,
          askedBy: 'user-somebody',
          admins: [],
        }),
      ).toBeNull();
    });
  });
});
