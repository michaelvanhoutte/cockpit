import { describe, expect, it } from 'vitest';
import type { RegisteredUser } from '@cockpit/shared';
import type { Requested } from '../../src/drawnAhead';
import { usersDrawnOver, type ShownUsers } from '../../src/registeredUsersDrawnAhead';

/**
 * F1: what each change to a user draws over the register the server sent. That the
 * controls send them, and that the window draws the result, is
 * tests/unit/components/UsersAtOnce.test.tsx; when they stop being drawn is
 * tests/unit/changeQueue.test.ts.
 */

const ADA: RegisteredUser = {
  id: 'user-ada',
  name: 'Ada',
  email: 'ada@example.com',
  role: 'user',
  accountName: 'Ada',
  lastSignedInAt: '2026-09-01T00:00:00.000Z',
  disabled: false,
};
const CHARLES: RegisteredUser = { ...ADA, id: 'user-charles', name: 'Charles', email: 'charles@example.com', accountName: 'Charles' };
const held: ShownUsers = { users: [ADA, CHARLES] };

const added = (name: string, email: string, userId = 'pending-1'): Requested => ({ name: 'add_user', payload: { userId, name, email } });
const renamed = (userId: string, name: string, role: 'user' | 'admin' = 'user'): Requested => ({ name: 'change_user', payload: { userId, name, role } });
const blocked = (userId: string, disabled: boolean): Requested => ({ name: 'set_user_access', payload: { userId, disabled } });
const deleted = (userId: string): Requested => ({ name: 'delete_user', payload: { userId } });

const names = (list: ShownUsers) => list.users.map((user) => user.name);
const ada = (list: ShownUsers) => list.users.find((user) => user.id === 'user-ada')!;

describe('User management', () => {
  describe('a change to a user is drawn as the server will have it', () => {
    it('shows somebody added at once, with the name typed and the address as the register keeps it', () => {
      const drawn = usersDrawnOver(held, [added('  Anna  ', '  Anna@Example.COM ')]);

      expect(drawn.users.find((user) => user.id === 'pending-1')).toMatchObject({
        name: 'Anna',
        email: 'anna@example.com',
        role: 'user',
        accountName: 'Anna',
        lastSignedInAt: null,
        disabled: false,
      });
    });

    it('marks the person added as not yet read back, since the id the server decides is not known', () => {
      const drawn = usersDrawnOver(held, [added('Anna', 'anna@example.com')]);

      expect(drawn.users.find((user) => user.id === 'pending-1')?.pending).toBe(true);
      expect(drawn.users.filter((user) => user.pending)).toHaveLength(1);
    });

    it.each([
      { situation: 'between the names it falls between', name: 'Bea', expected: ['Ada', 'Bea', 'Charles'] },
      { situation: 'ahead of every name after it, whatever its capitals', name: 'adam', expected: ['Ada', 'adam', 'Charles'] },
      { situation: 'after the last', name: 'Zed', expected: ['Ada', 'Charles', 'Zed'] },
      { situation: 'first', name: 'Aaron', expected: ['Aaron', 'Ada', 'Charles'] },
    ])('places somebody added $situation, as the register orders them, so the row does not move when it is read', ({ name, expected }) => {
      expect(names(usersDrawnOver(held, [added(name, 'new@example.com')]))).toEqual(expected);
    });

    it('draws nobody twice when a read begun before the answer already holds them', () => {
      const drawn = usersDrawnOver(held, [added('Ada', 'ADA@example.com')]);

      expect(drawn).toEqual(held);
    });

    it('draws somebody whose address is another person’s all the same, until the server refuses it', () => {
      expect(names(usersDrawnOver(held, [added('Someone', 'ada@example.com')]))).toEqual(['Ada', 'Charles', 'Someone']);
    });

    it('renames somebody, and names the account they own after them as the server does', () => {
      const drawn = usersDrawnOver(held, [renamed('user-ada', '  Ada Lovelace ')]);

      expect(ada(drawn)).toMatchObject({ name: 'Ada Lovelace', accountName: 'Ada Lovelace' });
      expect(names(drawn)).toEqual(['Ada Lovelace', 'Charles']);
    });

    it('changes somebody’s role', () => {
      expect(ada(usersDrawnOver(held, [renamed('user-ada', 'Ada', 'admin')])).role).toBe('admin');
    });

    it('says somebody has no access once blocked, and that they have it again once unblocked', () => {
      expect(ada(usersDrawnOver(held, [blocked('user-ada', true)])).disabled).toBe(true);
      expect(ada(usersDrawnOver(held, [blocked('user-ada', true), blocked('user-ada', false)])).disabled).toBe(false);
    });

    it('takes somebody deleted out of the list and leaves the others', () => {
      expect(names(usersDrawnOver(held, [deleted('user-ada')]))).toEqual(['Charles']);
    });

    it('draws a person who is changed and then deleted as gone', () => {
      expect(names(usersDrawnOver(held, [renamed('user-ada', 'Ada Lovelace'), deleted('user-ada')]))).toEqual(['Charles']);
    });

    it('leaves everyone else as they were', () => {
      const drawn = usersDrawnOver(held, [renamed('user-ada', 'Ada Lovelace', 'admin'), blocked('user-ada', true)]);

      expect(drawn.users.find((user) => user.id === 'user-charles')).toEqual(CHARLES);
    });

    it('does not write into the register it was given', () => {
      usersDrawnOver(held, [added('Anna', 'anna@example.com'), renamed('user-ada', 'Ada Lovelace'), deleted('user-charles')]);

      expect(held).toEqual({ users: [ADA, CHARLES] });
    });
  });
});
