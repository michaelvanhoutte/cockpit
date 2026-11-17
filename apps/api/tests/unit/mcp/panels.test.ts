import { describe, expect, it } from 'vitest';
import { panelSchema, type Dashboard, type Panel, type ReadableWorkspace, type Workspace } from '@cockpit/shared';
import { describePanels, findPanel, panelNamesAllowed } from '../../../src/mcp/panels.js';

/**
 * L1: how a connected app names a Panel ("MCP changes and deletes: name Panels
 * in update_item and create_item", issue 1812) against Workspaces, Dashboards
 * and Panels as the store lists them, and how the tools list the ones that take
 * Items. That a name found files the Item where the app's Move to… would is
 * tests/integration/http/update-item.test.ts.
 */

const workspace = (id: string, name: string): Workspace => ({
  id,
  tenantId: 't',
  name,
  color: '#6f62b5',
  bar: '#594e91',
  ground: '#e2e2df',
  header: '#2d2e35',
});
const dashboard = (workspaceId: string, id: string, name: string): Dashboard => ({ id, tenantId: 't', workspaceId, name });
const panel = (dashboardId: string, id: string, name: string, kind: 'items' | 'filter' | 'text' = 'items'): Panel =>
  panelSchema.parse({ id, tenantId: 't', dashboardId, name, kind });

const HOME = workspace('ws-home', 'Home');
const WORK = workspace('ws-work', 'Work');

/**
 * Home: a Dashboard "Day to day" with Admin and Calls, a Filter "Today" and a text "Notes".
 * Work: a Dashboard "Work" with Admin, and one "Sales" with Quotes and Admin again.
 */
const CATALOGUE: ReadableWorkspace[] = [
  {
    workspace: HOME,
    dashboards: [dashboard('ws-home', 'd-day', 'Day to day')],
    panels: [
      panel('d-day', 'p-home-admin', 'Admin'),
      panel('d-day', 'p-calls', 'Calls'),
      panel('d-day', 'p-today', 'Today', 'filter'),
      panel('d-day', 'p-notes', 'Notes', 'text'),
    ],
    layouts: [],
  },
  {
    workspace: WORK,
    dashboards: [dashboard('ws-work', 'd-work', 'Work'), dashboard('ws-work', 'd-sales', 'Sales')],
    panels: [
      panel('d-work', 'p-work-admin', 'Admin'),
      panel('d-sales', 'p-quotes', 'Quotes'),
      panel('d-sales', 'p-sales-admin', 'Admin'),
    ],
    layouts: [],
  },
];

/** The same Workspaces where Admin is the name of one Panel in each. */
const UNSHARED: ReadableWorkspace[] = [
  { ...CATALOGUE[0]!, panels: CATALOGUE[0]!.panels.filter((p) => p.id !== 'p-calls') },
  { ...CATALOGUE[1]!, panels: CATALOGUE[1]!.panels.filter((p) => p.id === 'p-work-admin' || p.id === 'p-quotes') },
];

const idOf = (found: ReturnType<typeof findPanel>) => (found.ok ? found.panel.id : null);
const saidOf = (found: ReturnType<typeof findPanel>) => (found.ok ? '' : found.refusal);

describe('MCP connections', () => {
  describe('a Panel name finds exactly one Panel that takes items, or is refused with the names that would', () => {
    it.each([
      { situation: 'a name one Panel has, in another case', scope: 'ws-home', name: 'calls', id: 'p-calls' },
      { situation: 'a name with spaces around it', scope: 'ws-home', name: '  Calls ', id: 'p-calls' },
      { situation: 'a shared name written Dashboard ▸ Panel', scope: 'ws-work', name: 'Work ▸ Admin', id: 'p-work-admin' },
      { situation: 'the other Dashboard of the shared name, in another case', scope: 'ws-work', name: 'sales ▸ admin', id: 'p-sales-admin' },
      { situation: 'a Panel of any Workspace for an Item on Any workspace', scope: null, name: 'Quotes', id: 'p-quotes' },
      { situation: 'a name shared across Workspaces, written Workspace ▸ Dashboard ▸ Panel', scope: null, name: 'Home ▸ Day to day ▸ Admin', id: 'p-home-admin' },
    ])('finds $situation', ({ scope, name, id }) => {
      expect(idOf(findPanel(CATALOGUE, scope, name))).toBe(id);
    });

    it('refuses a name two Dashboards share, listing each as Dashboard ▸ Panel', () => {
      const said = saidOf(findPanel(CATALOGUE, 'ws-work', 'admin'));
      expect(said).toContain('Several Panels are called "admin"');
      expect(said).toContain('Work ▸ Admin; Sales ▸ Admin');
      expect(said).toContain('Dashboard ▸ Panel');
    });

    it('refuses a name Workspaces share where the Item may go to any, listing each with its Workspace', () => {
      const said = saidOf(findPanel(UNSHARED, null, 'Admin'));
      expect(said).toContain('Home ▸ Day to day ▸ Admin; Work ▸ Work ▸ Admin');
      expect(said).toContain('Workspace ▸ Dashboard ▸ Panel');
    });

    it('refuses a name no Panel in the Workspace has, listing the Panels there', () => {
      const said = saidOf(findPanel(CATALOGUE, 'ws-home', 'Garden'));
      expect(said).toContain('No Panel is called "Garden"');
      expect(said).toContain('in the workspace "Home" that take items are "Admin", "Calls"');
    });

    it.each([
      { situation: 'a Filter panel', name: 'Today', says: 'a Filter panel, which gathers items' },
      { situation: 'a text Panel', name: 'Notes', says: 'a text Panel, which holds none' },
    ])('refuses $situation, which takes no items, and lists the ones that do', ({ name, says }) => {
      const said = saidOf(findPanel(CATALOGUE, 'ws-home', name));
      expect(said).toContain(says);
      expect(said).toContain('"Admin", "Calls"');
    });

    it('refuses a Panel of another Workspace for an Item that has one, with the Panels of its own', () => {
      const said = saidOf(findPanel(CATALOGUE, 'ws-home', 'Quotes'));
      expect(said).toContain('No Panel is called "Quotes"');
      expect(said).toContain('"Admin", "Calls"');
      expect(said).not.toContain('Sales');
    });

    it('says there are none where the Workspace has no Panel that takes items', () => {
      const said = saidOf(findPanel([{ ...CATALOGUE[0]!, panels: [] }], 'ws-home', 'Admin'));
      expect(said).toContain('There are no Panels in the workspace "Home" that take items yet');
    });

    it('prefers the Panel that takes items where a Filter has the same name', () => {
      const withFilter: ReadableWorkspace[] = [
        { ...CATALOGUE[0]!, panels: [...CATALOGUE[0]!.panels, panel('d-day', 'p-filter-admin', 'admin', 'filter')] },
      ];
      expect(idOf(findPanel(withFilter, 'ws-home', 'ADMIN'))).toBe('p-home-admin');
    });
  });

  describe('a tool lists every Workspace’s Panels that take items', () => {
    it('names each Workspace’s Panels, the shared ones as Dashboard ▸ Panel, and leaves out a Filter and a text Panel', () => {
      const said = describePanels(CATALOGUE);
      expect(said).toBe('Home: "Admin", "Calls"; Work: "Work ▸ Admin", "Quotes", "Sales ▸ Admin"');
    });

    it('allows each as it is listed, and a name shared by Workspaces in full as well', () => {
      expect(panelNamesAllowed(UNSHARED)).toEqual([
        'Admin',
        'Home ▸ Day to day ▸ Admin',
        'Work ▸ Work ▸ Admin',
        'Quotes',
      ]);
    });

    it('says none yet, and allows no name at all, for an account with no Panel', () => {
      const none = CATALOGUE.map((one) => ({ ...one, panels: [] }));
      expect(describePanels(none)).toBe('none yet');
      expect(panelNamesAllowed(none)).toEqual([]);
    });

    it('says none yet for a Workspace that has none beside one that has', () => {
      expect(describePanels([CATALOGUE[0]!, { ...CATALOGUE[1]!, panels: [] }])).toBe('Home: "Admin", "Calls"; Work: none yet');
    });
  });
});
