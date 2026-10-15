import { describe, expect, it } from 'vitest';
import { resolveSpokenPath, type PlaceNamed, type PlaceTreeWorkspace } from '../../../src/domain/spoken-path.js';

/**
 * L1: where the names a note said point is a pure decision over the names an
 * account has ("File a capture on the panels you name, read from the spoken
 * path", issue 1116). Which names the words mean is the model's, held by the
 * contract tier; what is filed once this has decided is
 * apps/api/tests/integration/http/note-cleanup-path.test.ts.
 */

const panel = (id: string, name: string, kind: 'items' | 'text' | 'filter' = 'items') => ({ id, name, kind });

/** Home and Work, Home's Admin & money on Day to day alone, This week on both of Home's dashboards, and Inbox zero in both workspaces. */
const TREE: PlaceTreeWorkspace[] = [
  {
    id: 'home',
    name: 'Home',
    dashboards: [
      {
        id: 'home-day',
        name: 'Day to day',
        panels: [
          panel('admin', 'Admin & money'),
          panel('week-day', 'This week'),
          panel('zero-home', 'Inbox zero'),
          panel('notes', 'Notes', 'text'),
          panel('due', 'Due soon', 'filter'),
        ],
      },
      { id: 'home-plans', name: 'Plans', panels: [panel('week-plans', 'This week'), panel('trips', 'Trips')] },
    ],
  },
  {
    id: 'work',
    name: 'Work',
    dashboards: [{ id: 'work-day', name: 'Day to day', panels: [panel('zero-work', 'Inbox zero'), panel('hiring', 'Hiring')] }],
  },
];

const said = (named: Partial<PlaceNamed>): PlaceNamed => ({ workspace: null, dashboard: null, panels: [], ...named });

describe('Capture', () => {
  describe('the place a note names files it on the one place it points to, and nowhere when it points to several', () => {
    it.each([
      { situation: 'a panel named that is unique', named: said({ panels: ['admin & money'] }), expected: { workspaceId: 'home', panelIds: ['admin'] } },
      { situation: 'a panel named on two dashboards of one workspace, no dashboard said', named: said({ panels: ['This week'] }), expected: { workspaceId: null, panelIds: [] } },
      { situation: 'the same, with the dashboard said', named: said({ dashboard: 'Plans', panels: ['This week'] }), expected: { workspaceId: 'home', panelIds: ['week-plans'] } },
      { situation: 'a panel named in two workspaces, no workspace said', named: said({ panels: ['Inbox zero'] }), expected: { workspaceId: null, panelIds: [] } },
      { situation: 'the same, with the workspace said', named: said({ workspace: 'Work', panels: ['Inbox zero'] }), expected: { workspaceId: 'work', panelIds: ['zero-work'] } },
      { situation: 'two panels named, both unique', named: said({ panels: ['Admin & money', 'Trips'] }), expected: { workspaceId: 'home', panelIds: ['admin', 'trips'] } },
      { situation: 'two panels named, one of them on two dashboards', named: said({ panels: ['Admin & money', 'This week'] }), expected: { workspaceId: 'home', panelIds: ['admin'] } },
      { situation: 'two unique panels named in two workspaces, no workspace said', named: said({ panels: ['Trips', 'Hiring'] }), expected: { workspaceId: null, panelIds: [] } },
      { situation: 'a dashboard named alone that one workspace has', named: said({ dashboard: 'Plans' }), expected: { workspaceId: 'home', panelIds: [] } },
      { situation: 'a dashboard named alone that two workspaces have', named: said({ dashboard: 'Day to day' }), expected: { workspaceId: null, panelIds: [] } },
      { situation: 'a workspace and a panel of another workspace named', named: said({ workspace: 'Work', panels: ['Admin & money'] }), expected: { workspaceId: 'work', panelIds: [] } },
      { situation: 'a workspace named alone', named: said({ workspace: 'home' }), expected: { workspaceId: 'home', panelIds: [] } },
      { situation: 'names that match nothing', named: said({ workspace: 'Garden', dashboard: 'Someday', panels: ['Groceries'] }), expected: { workspaceId: null, panelIds: [] } },
      { situation: 'an unknown dashboard beside a unique panel', named: said({ dashboard: 'Someday', panels: ['Hiring'] }), expected: { workspaceId: 'work', panelIds: ['hiring'] } },
      { situation: 'a panel of text named', named: said({ panels: ['Notes'] }), expected: { workspaceId: null, panelIds: [] } },
      { situation: 'a Filter named', named: said({ panels: ['Due soon'] }), expected: { workspaceId: null, panelIds: [] } },
      { situation: 'nothing named', named: said({}), expected: { workspaceId: null, panelIds: [] } },
    ])('for $situation', ({ named, expected }) => {
      expect(resolveSpokenPath(TREE, named)).toEqual(expected);
    });

    it('matches only within the one workspace a capture made inside it may reach', () => {
      const work = TREE.filter((workspace) => workspace.id === 'work');

      expect(resolveSpokenPath(work, said({ panels: ['Inbox zero'] }))).toEqual({ workspaceId: 'work', panelIds: ['zero-work'] });
      expect(resolveSpokenPath(work, said({ panels: ['Admin & money'] }))).toEqual({ workspaceId: null, panelIds: [] });
    });
  });
});
