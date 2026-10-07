import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Dashboard, Filing, Item, Layout, Panel, WorkspaceSnapshot } from '@cockpit/shared';
import { NO_DASHBOARD_FILTER, writeDashboardFilter } from '../../src/dashboardFilter';
import { dashboardsOf, useReach } from '../../src/panelReach';
import type { Scope } from '../../src/panelReach';

/**
 * F1: what Go to panel lists beyond the Dashboard on screen. How the list
 * draws it and moves the screen is tests/unit/components/PanelList.test.tsx;
 * that the board counts the way this does is shared code (`itemsShownOn`),
 * proved against the board in tests/unit/components/PanelBoard.test.tsx.
 */

const asked = vi.hoisted(() => ({
  snapshots: vi.fn<(workspaceId: string) => Promise<unknown>>(),
}));

vi.mock('../../src/api/client', async () => {
  const actual = await vi.importActual<typeof import('../../src/api/client')>('../../src/api/client');
  return { ...actual, fetchSnapshot: asked.snapshots };
});

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    useParams: () => ({ workspaceId: 'work', dashboardId: 'today' }),
    useNavigate: () => vi.fn(),
    useRouter: () => ({ history: { back: vi.fn() } }),
  };
});

const dashboard = (id: string, name: string, workspaceId = 'work'): Dashboard => ({
  id,
  tenantId: 'tenant',
  workspaceId,
  name,
});

const panel = (id: string, name: string, dashboardId: string, over: Partial<Panel> = {}): Panel => ({
  id,
  tenantId: 'tenant',
  dashboardId,
  name,
  kind: 'items',
  format: 'plain',
  body: '',
  readOnly: false,
  filter: null,
  sort: null,
  ...over,
});

const item = (id: string, title: string, over: Partial<Item> = {}): Item =>
  ({
    id,
    tenantId: 'tenant',
    workspaceId: 'work',
    title,
    description: null,
    nextAction: null,
    priority: null,
    dueDate: null,
    completedAt: null,
    deletedAt: null,
    startedAt: null,
    typeId: null,
    ...over,
  }) as Item;

const filed = (panelId: string, itemId: string, position = 0): Filing => ({ panelId, itemId, position });

function aSnapshot(over: Partial<WorkspaceSnapshot>): WorkspaceSnapshot {
  return {
    items: [],
    dashboards: [],
    panels: [],
    layouts: [],
    filings: [],
    itemTypes: [],
    attachments: [],
    agentRuns: [],
    ...over,
  } as unknown as WorkspaceSnapshot;
}

beforeEach(() => localStorage.clear());

describe('Dashboards', () => {
  describe('Go to panel lists each Panel as its Dashboard draws it, with the count its header shows', () => {
    const snapshot = aSnapshot({
      dashboards: [dashboard('today', 'Today'), dashboard('empty', 'Empty'), dashboard('research', 'Research')],
      panels: [
        panel('a', 'Alpha', 'today'),
        panel('b', 'Beta', 'today'),
        panel('notes', 'Notes', 'today', { kind: 'text' }),
        panel('high', 'Urgent', 'today', {
          kind: 'filter',
          filter: { conditions: [{ field: 'priority', values: ['high'] }], match: 'all', groupBy: 'none' },
        }),
        panel('papers', 'Papers', 'research'),
      ],
      items: [item('i1', 'Pay VAT', { priority: 'high' }), item('i2', 'Call back'), item('i3', 'Read')],
      filings: [filed('a', 'i1'), filed('a', 'i2', 1), filed('papers', 'i3')],
      layouts: [
        {
          id: 'layout',
          tenantId: 'tenant',
          dashboardId: 'today',
          rows: [
            { height: null, cells: [{ panelId: 'high', span: 12 }] },
            { height: null, cells: [{ panelId: 'b', span: 6 }, { panelId: 'a', span: 6 }] },
          ],
        } as Layout,
      ],
    });

    it('puts the Panels of an arranged Dashboard in the order its Layout draws them, and a never-arranged one in its own', () => {
      const lists = dashboardsOf(snapshot, localStorage);

      expect(lists.map((one) => [one.name, one.entries.map((entry) => entry.title)])).toEqual([
        // `Notes` is on no row of the Layout, so it is drawn on a row of its own after them.
        ['Today', ['Urgent', 'Beta', 'Alpha', 'Notes']],
        ['Research', ['Papers']],
      ]);
    });

    it('counts a Panel of items, a Filter and a Panel of text as their headers do', () => {
      const [today] = dashboardsOf(snapshot, localStorage);

      expect(Object.fromEntries(today!.entries.map((entry) => [entry.title, entry.count]))).toEqual({
        Urgent: 1,
        Beta: 0,
        Alpha: 2,
        Notes: null,
      });
    });

    it('leaves out a Dashboard with no Panels', () => {
      expect(dashboardsOf(snapshot, localStorage).map((one) => one.id)).not.toContain('empty');
    });

    it('marks a Panel hidden by its own Dashboard’s filter, and only on that Dashboard', () => {
      writeDashboardFilter(localStorage, 'today', { ...NO_DASHBOARD_FILTER, text: 'vat' });

      const [today, research] = dashboardsOf(snapshot, localStorage);

      expect(today!.entries.map((entry) => [entry.title, entry.hidden])).toEqual([
        ['Urgent', false],
        ['Beta', true],
        ['Alpha', false],
        ['Notes', true],
      ]);
      expect(research!.entries.every((entry) => !entry.hidden)).toBe(true);
    });

    it('counts what the Dashboard’s filter leaves, as the board does', () => {
      writeDashboardFilter(localStorage, 'today', { ...NO_DASHBOARD_FILTER, text: 'vat' });

      const [today] = dashboardsOf(snapshot, localStorage);

      expect(today!.entries.find((entry) => entry.title === 'Alpha')?.count).toBe(1);
    });
  });

  describe('other Workspaces are read only when a wider scope is chosen', () => {
    const workspaces = {
      workspaces: [
        { id: 'work', tenantId: 'tenant', name: 'Work', color: '#111111', bar: '', ground: '', header: '' },
        { id: 'home', tenantId: 'tenant', name: 'Home', color: '#222222', bar: '', ground: '', header: '' },
      ],
    };
    const snapshotOf = (workspaceId: string) =>
      aSnapshot({
        dashboards: [dashboard('d-' + workspaceId, workspaceId, workspaceId)],
        panels: [panel('p-' + workspaceId, 'A Panel', 'd-' + workspaceId)],
      });

    function reaching(initial: Scope) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(['workspaces'], workspaces);
      client.setQueryData(['snapshot', 'work'], snapshotOf('work'));
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      return renderHook(({ scope }: { scope: Scope }) => useReach(scope, () => undefined), {
        wrapper,
        initialProps: { scope: initial },
      });
    }

    beforeEach(() => {
      asked.snapshots.mockReset();
      asked.snapshots.mockImplementation((workspaceId) => Promise.resolve(snapshotOf(workspaceId)));
    });

    it('asks for no Workspace at Dashboard, the one on screen at Workspace, and every one at All', async () => {
      const { result, rerender } = reaching(1);
      expect(asked.snapshots).not.toHaveBeenCalled();
      expect(result.current.workspaces.map((one) => [one.id, one.state, one.dashboardCount])).toEqual([
        ['work', 'ready', 1],
        ['home', 'loading', 0],
      ]);

      rerender({ scope: 2 });
      expect(asked.snapshots).not.toHaveBeenCalled();
      expect(result.current.workspaces[0]!.dashboards.map((one) => one.name)).toEqual(['work']);

      rerender({ scope: 3 });
      await waitFor(() => expect(result.current.workspaces[1]!.state).toBe('ready'));
      expect(asked.snapshots.mock.calls.map(([id]) => id)).toEqual(['home']);
      expect(result.current.workspaces[1]!.dashboards.map((one) => one.name)).toEqual(['home']);
    });

    it('reports a Workspace still being read as loading', async () => {
      asked.snapshots.mockImplementation(() => new Promise(() => undefined));
      const { result } = reaching(3);
      await waitFor(() => expect(asked.snapshots).toHaveBeenCalled());
      expect(result.current.workspaces.map((one) => one.state)).toEqual(['ready', 'loading']);
    });

    it('reports a Workspace that failed to load as failed', async () => {
      asked.snapshots.mockRejectedValue(new Error('offline'));
      const { result } = reaching(3);

      await waitFor(() => expect(result.current.workspaces[1]!.state).toBe('failed'));
      expect(result.current.workspaces[0]!.state).toBe('ready');
    });
  });
});
