import { describe, expect, it } from 'vitest';
import { FIRST_WORKSPACE_NAME } from '@cockpit/shared';
import { survivingWorkspace, whereToLand } from '../../src/landing';

/**
 * F1: where a bare `/` opens is a decision over the account's list, one
 * remembered fact and the width. That the router asks it, and that a link
 * still goes where it says, is `router.test.tsx` and the walk in tests/e2e.
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
        welcomed: true,
        room: false,
        lands: { to: 'capture' },
      },
      {
        situation: 'a desk',
        workspaces: [work, personal],
        welcomed: true,
        room: true,
        lands: { to: 'workspace', workspaceId: 'ws-work' },
      },
      {
        situation: 'a phone, an account with no workspaces',
        workspaces: [],
        welcomed: true,
        room: false,
        lands: { to: 'start' },
      },
      {
        situation: 'a desk, an account with no workspaces',
        workspaces: [],
        welcomed: true,
        room: true,
        lands: { to: 'start' },
      },
    ])('$situation', ({ workspaces, welcomed, room, lands }) => {
      expect(whereToLand(workspaces, welcomed, room)).toEqual(lands);
    });
  });

  describe('A new account is welcomed before it lands, at any width', () => {
    it.each([
      { situation: 'a phone, not yet welcomed', welcomed: false, room: false, lands: { to: 'welcome' } },
      { situation: 'a desk, not yet welcomed', welcomed: false, room: true, lands: { to: 'welcome' } },
      { situation: 'a phone, welcomed', welcomed: true, room: false, lands: { to: 'capture' } },
    ])('$situation', ({ welcomed, room, lands }) => {
      expect(whereToLand([untouched], welcomed, room)).toEqual(lands);
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
