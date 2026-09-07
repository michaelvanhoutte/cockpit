import { describe, expect, it } from 'vitest';
import { isAdminPath, roleOpens } from '../../../src/auth/admin.js';

/**
 * Unit level: what the role opens is a decision about a path and a word, with
 * no request, no register and no session behind it. The integration suite
 * proves the gate is *wired* - that a real request is refused or let through -
 * and it can only ask that of addresses something actually answers. This asks
 * the half it cannot: an address under the prefix that no route serves, where
 * being refused and there being nothing there look identical from outside.
 */
describe('User management', () => {
  describe('the admin pages are the only addresses a role stands in front of', () => {
    it.each([
      { situation: 'the list of everybody', path: '/v1/admin/users', guarded: true },
      { situation: 'one person’s own address', path: '/v1/admin/users/x', guarded: true },
      // The half the integration tier cannot ask, which is why this table
      // exists: an address under the prefix that no route serves is refused
      // rather than merely absent, and from outside the two look identical.
      { situation: 'an address under it nothing serves', path: '/v1/admin/nothing', guarded: true },
      { situation: 'the workspaces a person reads', path: '/v1/workspaces', guarded: false },
      { situation: 'the health check', path: '/health', guarded: false },
      { situation: 'the operator’s own routes', path: '/v1/operator/backup/register', guarded: false },
      // A longer name rather than a path under the prefix - the trap the
      // sign-in gate's own list is written for, in the other direction: this
      // one must not be guarded by a role it never reaches.
      { situation: 'an address that merely starts like one', path: '/v1/administrators', guarded: false },
      // Under the prefix, and deliberately not guarded: these answer a command
      // line that holds no session at all, so a role check would refuse them
      // for having no visitor - the 401 that "Give the operator's routes the
      // operator's name" (issue 229) exists to stop them getting.
      {
        situation: 'where the operator’s routes used to be',
        path: '/v1/admin/backup/register',
        guarded: false,
      },
      {
        situation: 'where the operator restored an account',
        path: '/v1/admin/restore/accounts/tenant-default',
        guarded: false,
      },
    ])('$situation', ({ path, guarded }) => {
      expect(isAdminPath(path)).toBe(guarded);
    });
  });

  describe('an admin address opens for an admin and for nobody else', () => {
    it.each([
      { situation: 'an admin', role: 'admin', opens: true },
      { situation: 'an ordinary user', role: 'user', opens: false },
      // Nobody at all. The sign-in gate turns these away first, so this is what
      // holds if that order is ever changed: no visitor is not an open door.
      { situation: 'somebody with no role at all', role: undefined, opens: false },
      { situation: 'a role nobody grants', role: 'administrator', opens: false },
      { situation: 'the role written in other letters', role: 'Admin', opens: false },
      { situation: 'an empty role', role: '', opens: false },
    ])('$situation', ({ role, opens }) => {
      expect(roleOpens('/v1/admin/users', role)).toBe(opens);
    });

    it.each([
      { situation: 'an ordinary user', role: 'user' },
      { situation: 'nobody at all', role: undefined },
    ])('lets $situation past an address the role does not guard', ({ role }) => {
      expect(roleOpens('/v1/workspaces', role)).toBe(true);
    });
  });
});
