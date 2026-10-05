import { describe, expect, it } from 'vitest';
import { FIRST_WORKSPACE_NAME } from '@cockpit/shared';
import { survivingWorkspace, whereToLand } from '../../src/landing';

/**
 * F1: where a bare `/` opens is a decision over the account's list and the
 * width. That the router asks it, and that a link still goes where it says, is
 * `router.test.tsx` and the walk in tests/e2e.
 */

const work = { id: 'ws-work', name: 'Work' };
const personal = { id: 'ws-personal', name: 'Personal' };
const untouched = { id: 'ws-1', name: FIRST_WORKSPACE_NAME };

describe('Workspace management', () => {
  describe('A bare / opens Capture on a phone, and the first workspace at a desk', () => {
    it.each([
      {
        situation: 'a phone, signed in with workspaces',
        workspaces: [work, personal],
        room: false,
        lands: { to: 'capture' },
      },
      {
        situation: 'a desk',
        workspaces: [work, personal],
        room: true,
        lands: { to: 'workspace', workspaceId: 'ws-work' },
      },
      {
        situation: 'a phone, an account with no workspaces',
        workspaces: [],
        room: false,
        lands: { to: 'start' },
      },
      {
        situation: 'a desk, an account with no workspaces',
        workspaces: [],
        room: true,
        lands: { to: 'start' },
      },
      {
        situation: 'a desk, one workspace still called Workspace 1',
        workspaces: [untouched],
        room: true,
        lands: { to: 'workspace', workspaceId: 'ws-1' },
      },
      {
        situation: 'a phone, one workspace still called Workspace 1',
        workspaces: [untouched],
        room: false,
        lands: { to: 'capture' },
      },
    ])('$situation', ({ workspaces, room, lands }) => {
      expect(whereToLand(workspaces, room)).toEqual(lands);
    });
  });

  describe('Deleting the workspace you are on lands on one that is left, never on Capture', () => {
    it.each([
      { situation: 'workspaces remain', left: [personal], lands: { to: 'workspace', workspaceId: 'ws-personal' } },
      { situation: 'it was the last', left: [], lands: { to: 'start' } },
    ])('$situation', ({ left, lands }) => {
      expect(survivingWorkspace(left)).toEqual(lands);
    });
  });
});
