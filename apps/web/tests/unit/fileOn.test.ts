import { describe, expect, it } from 'vitest';
import type { Workspace, WorkspaceSnapshot } from '@cockpit/shared';
import { newPanelOffer, type HeldWorkspace } from '../../src/fileOn';

/**
 * F1: reading what was typed into Capture's *File on* as a Panel to make is a
 * calculation on the Workspaces held and the Dashboard you were last on. That
 * the Panel is then really made and the capture filed on it is the component's
 * test (components/CaptureNote.test.tsx) and the walk in
 * tests/e2e/workspace-capture.test.ts.
 */

const workspace = (id: string, name: string) => ({ id, tenantId: 't', name, color: '#000000' }) as Workspace;
const snapshotOf = (...dashboards: [string, string][]) =>
  ({ dashboards: dashboards.map(([id, name]) => ({ id, name })), panels: [] }) as unknown as WorkspaceSnapshot;

const WORK = workspace('ws-work', 'Work');
const HOME = workspace('ws-home', 'Home');
const HELD: HeldWorkspace[] = [
  { workspace: WORK, snapshot: snapshotOf(['d-today', 'Today'], ['d-later', 'Later']) },
  { workspace: HOME, snapshot: snapshotOf(['d-house', 'House']) },
];
/** Work was last left on Later; Home on nothing that is a Dashboard. */
const lastOn = (workspaceId: string, dashboards: readonly { id: string }[]) =>
  dashboards.find((one) => one.id === (workspaceId === 'ws-work' ? 'd-later' : null))?.id ?? null;

const made = (workspaceId: string, dashboardId: string, name: string) =>
  expect.objectContaining({ kind: 'make', workspaceId, dashboardId, name });

describe('Capture', () => {
  describe('+ New panel makes the Panel where the text says', () => {
    it.each([
      {
        situation: 'a plain name with a Workspace chosen',
        typed: 'Falcon',
        where: 'ws-work',
        from: 'ws-home',
        expected: made('ws-work', 'd-later', 'Falcon'),
      },
      {
        situation: 'a plain name with a Workspace chosen that was last left on no Dashboard',
        typed: 'Garden',
        where: 'ws-home',
        from: 'ws-work',
        expected: made('ws-home', 'd-house', 'Garden'),
      },
      {
        situation: 'a plain name under Any workspace, opened from a Workspace left on a Dashboard',
        typed: 'Falcon',
        where: null,
        from: 'ws-work',
        expected: made('ws-work', 'd-later', 'Falcon'),
      },
      {
        situation: 'Dashboard ▸ Name',
        typed: 'today ▸ Falcon',
        where: 'ws-work',
        from: 'ws-home',
        expected: made('ws-work', 'd-today', 'Falcon'),
      },
      {
        situation: 'Dashboard ▸ Name typed with a keyboard’s >',
        typed: 'Today>Falcon',
        where: 'ws-work',
        from: 'ws-home',
        expected: made('ws-work', 'd-today', 'Falcon'),
      },
      {
        situation: 'Workspace ▸ Dashboard ▸ Name under Any workspace',
        typed: 'Home ▸ House ▸ Garden',
        where: null,
        from: 'ws-work',
        expected: made('ws-home', 'd-house', 'Garden'),
      },
      {
        situation: 'a plain name under Any workspace, opened from a Workspace left on no Dashboard',
        typed: 'Garden',
        where: null,
        from: 'ws-home',
        expected: { kind: 'ask', reason: 'Say where: Workspace ▸ Dashboard ▸ Name.' },
      },
      {
        situation: 'a Dashboard that matches none',
        typed: 'Someday ▸ Falcon',
        where: 'ws-work',
        from: 'ws-work',
        expected: { kind: 'ask', reason: 'No Dashboard called “Someday” in Work.' },
      },
      {
        situation: 'a Workspace that matches none',
        typed: 'Play ▸ House ▸ Garden',
        where: null,
        from: 'ws-work',
        expected: { kind: 'ask', reason: 'No Workspace called “Play”.' },
      },
      {
        situation: 'another Workspace than the one chosen',
        typed: 'Home ▸ House ▸ Garden',
        where: 'ws-work',
        from: 'ws-work',
        expected: expect.objectContaining({ kind: 'ask' }),
      },
      { situation: 'a path with no name after it', typed: 'Today ▸ ', where: 'ws-work', from: 'ws-work', expected: null },
      { situation: 'nothing typed', typed: '  ', where: 'ws-work', from: 'ws-work', expected: null },
    ])('reads $situation', ({ typed, where, from, expected }) => {
      expect(newPanelOffer(typed, HELD, where, from, lastOn)).toEqual(expected);
    });

    it('says the Workspace is not read yet where there is no copy of it to make the Panel on', () => {
      const unread = HELD.map((one) => (one.workspace.id === 'ws-work' ? { ...one, snapshot: undefined } : one));

      expect(newPanelOffer('Today ▸ Falcon', unread, 'ws-work', 'ws-work', lastOn)).toEqual({
        kind: 'ask',
        reason: 'Work is not read yet, so a Panel cannot be made on it.',
      });
    });
  });
});
