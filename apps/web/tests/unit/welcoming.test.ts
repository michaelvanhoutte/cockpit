import { describe, expect, it } from 'vitest';
import { FIRST_WORKSPACE_NAME } from '@cockpit/shared';
import { shouldWelcome } from '../../src/welcoming';

/**
 * F1: which state the app opens on the question in is a decision over a list
 * and one remembered fact, so the storage is handed in rather than reached for
 * - the same shape `lastVisited.ts` takes. That the router really asks this,
 * and that a link to a dashboard is never diverted into it, is the walk in
 * tests/e2e.
 */

const named = (...names: string[]) => names.map((name) => ({ name }));

describe('Across the app', () => {
  /**
   * An account arrives holding one workspace called *Workspace 1*
   * (apps/api/src/accounts/changes.ts), so that is what "nobody has started on
   * this yet" looks like. Nothing is stored to know it: the rows say it, which
   * means an account restored from a backup is exactly as far along as it was.
   */
  describe('a new account is asked what its workspace is, once', () => {
    it.each([
      {
        situation: 'one workspace, still wearing the name it arrived with, never asked',
        has: [FIRST_WORKSPACE_NAME],
        before: false,
        opens: true,
      },
      { situation: 'the workspace has been named', has: ['Work'], before: false, opens: false },
      {
        situation: 'a second workspace has been made',
        has: [FIRST_WORKSPACE_NAME, 'Work'],
        before: false,
        opens: false,
      },
      {
        situation: 'this browser has been through it already',
        has: [FIRST_WORKSPACE_NAME],
        before: true,
        opens: false,
      },
      {
        // Both halves are needed, and this is the one that shows it: the rows
        // alone would ask again, and having been through it is what stops them.
        situation: 'the workspace was renamed back to the name it arrived with',
        has: [FIRST_WORKSPACE_NAME],
        before: true,
        opens: false,
      },
      { situation: 'the account has no workspaces at all', has: [], before: false, opens: false },
    ])('$situation', ({ has, before, opens }) => {
      expect(shouldWelcome(named(...has), before)).toBe(opens);
    });

    it('asks again where the browser remembers nothing, rather than failing', () => {
      // A private window, cleared storage, a browser that refuses it: all of
      // them arrive here as "not been through it", and the way out is naming
      // the workspace rather than anything stored.
      expect(shouldWelcome(named(FIRST_WORKSPACE_NAME), false)).toBe(true);
      expect(shouldWelcome(named('Work'), false)).toBe(false);
    });
  });
});
