import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Workspace, WorkspaceSnapshot } from '@cockpit/shared';
import { CommandRefused, sendCommand } from '../../../src/api/client';
import { changes } from '../../../src/api/changes';
import { useSendCommand } from '../../../src/api/queries';
import { WorkspaceTabs } from '../../../src/components/WorkspaceTabs';
import { readAllItemsTab, setAllItemsTab } from '../../../src/allItemsTab';
import { askForRecurringItem, takeRecurringRequest } from '../../../src/recurringModal';

/**
 * F1: what is under test is the strip's own behaviour - what its menu offers,
 * what a form sends, and what it does with an answer it does not like. Whether
 * a name is actually refused is the server's rule, proved against a real store
 * in apps/api/tests/integration/http/workspaces.test.ts; that the gestures
 * reach a real menu is tests/e2e/workspace-management.test.ts.
 */
const held = vi.hoisted(() => ({
  workspaces: [] as Workspace[],
  items: 0,
  here: 'ws-work',
  /** The workspace whose All items page is on screen, or null. */
  onAllItemsOf: null as string | null,
}));

const wentTo = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('@tanstack/react-router', () => ({
  // `href` so it is a link to the accessibility tree, which is what a tab is.
  // Everything else is passed through rather than dropped: the tab is a `Link`
  // rendered `asChild` by the menu, so what makes it a trigger arrives as props
  // from Radix and a mock keeping only `children` would drop them.
  Link: ({
    children,
    to: _to,
    params: _params,
    ...rest
  }: {
    children?: React.ReactNode;
    to?: unknown;
    params?: unknown;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href="#" {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => (to: unknown) => {
    wentTo.calls.push(to);
  },
  useParams: () => ({ workspaceId: held.here }),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({
      location: { pathname: held.onAllItemsOf ? `/w/${held.onAllItemsOf}/items` : `/w/${held.here}` },
    }),
}));

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  sendCommand: vi.fn(),
}));

vi.mock('../../../src/api/queries', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/api/queries')>();
  return {
    ...real,
    useSendCommand: vi.fn(),
    workspacesQuery: {
      queryKey: ['workspaces'],
      queryFn: () => Promise.resolve({ workspaces: held.workspaces }),
    },
    snapshotQuery: (workspaceId: string) => ({
      queryKey: ['snapshot', workspaceId],
      queryFn: (): Promise<WorkspaceSnapshot> =>
        Promise.resolve({
          items: Array.from({ length: held.items }, (_, i) => ({ id: `item-${i}` })),
          dashboards: [{ id: `${workspaceId}-first` }, { id: `${workspaceId}-second` }],
        } as WorkspaceSnapshot),
    }),
  };
});

const mockUseSendCommand = vi.mocked(useSendCommand);

const THEME = { color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' };

/** What the strip asks the server for, in the shape both senders take it. */
type AskedFor = { name: string; payload: Record<string, string> };

function aWorkspace(name: string, color = THEME.color): Workspace {
  return {
    id: `ws-${name.toLowerCase()}`,
    tenantId: 'tenant',
    name,
    ...THEME,
    color,
  } as Workspace;
}

/**
 * The strip holding these workspaces.
 *
 * The sender stands in for the app's own: what the strip draws of a change is
 * tests/unit/components/WorkspacesAtOnce.test.tsx, with the real queue.
 */
function showTabs(
  names: string[],
  answer: {
    here?: string;
    items?: number;
    onAllItemsOf?: string;
    sendFails?: Error;
  } = {},
) {
  held.workspaces = names.map((name) => aWorkspace(name));
  held.items = answer.items ?? 0;
  held.here = answer.here ?? held.workspaces[0]!.id;
  held.onAllItemsOf = answer.onAllItemsOf ?? null;
  wentTo.calls = [];
  const sent = vi.fn((_args: AskedFor) =>
    answer.sendFails ? Promise.reject(answer.sendFails) : Promise.resolve(),
  );
  mockUseSendCommand.mockImplementation(() => sent as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The page on screen holds its workspace's snapshot, its route having loaded it.
  if (held.onAllItemsOf) {
    client.setQueryData(['snapshot', held.onAllItemsOf], {
      workspace: { id: held.onAllItemsOf },
      dashboards: [{ id: `${held.onAllItemsOf}-first` }, { id: `${held.onAllItemsOf}-second` }],
    });
  }
  render(
    <QueryClientProvider client={client}>
      <WorkspaceTabs bar={THEME.bar} bringIntoView={() => {}}>
        <button type="button">Add a workspace</button>
      </WorkspaceTabs>
    </QueryClientProvider>,
  );
  return { sent, user: userEvent.setup() };
}

/** The open menu's entries in order, a separator drawn as "---". */
function entriesOfTheOpenMenu() {
  return Array.from(screen.getByRole('menu').querySelectorAll('[role="menuitem"], [role="separator"]')).map((node) =>
    node.getAttribute('role') === 'separator' ? '---' : (node.textContent ?? ''),
  );
}

/** Opens a tab's own menu the way a pointer does. */
async function menuOf(name: string) {
  fireEvent.contextMenu(await screen.findByRole('link', { name }));
  return screen.findByRole('menu');
}

/**
 * Lays the strip out, because jsdom does not: `tabDrag.ts`'s `placeAt` reads
 * each tab's edges off `getBoundingClientRect`, which jsdom always
 * answers with zeroes. Each tab is given a 100-pixel-wide slot instead, the
 * same stand-in `PanelBoard.test.tsx`'s `layOut` uses for panels.
 */
function layOutTabs() {
  const tabs = [...document.querySelectorAll('[data-tab-id]')];
  tabs.forEach((tab, index) => {
    tab.getBoundingClientRect = () => ({ left: index * 100, right: (index + 1) * 100 }) as DOMRect;
  });
}

/** Drags a tab far enough to land in the slot at `toIndex`, and drops it there. */
function dragTab(name: string, toIndex: number) {
  const tab = screen.getByRole('link', { name });
  fireEvent.pointerDown(tab, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 0, buttons: 1 });
  layOutTabs();
  fireEvent.pointerMove(tab, {
    pointerId: 1,
    pointerType: 'mouse',
    clientX: toIndex * 100 + 50,
    buttons: 1,
  });
  fireEvent.pointerUp(tab, { pointerId: 1, pointerType: 'mouse' });
}

describe('Workspace management', () => {
  describe('what can be done to a workspace is on the tab it is', () => {
    // The list this replaces was two presses away in the header's menu, and
    // then a row to find. What each entry does is the rules below.
    it('offers editing, the All items tab, Recurring items and deleting on the tab itself', async () => {
      showTabs(['Work', 'Personal', 'Acme']);

      await menuOf('Personal');

      expect(screen.getAllByRole('menuitem').map((entry) => entry.textContent)).toEqual([
        'Edit…',
        'Show All items tab',
        'Recurring items',
        'Delete',
      ]);
    });

    it('opens the menu of the tab you are already on when it is pressed', async () => {
      // The press has no other job - you are looking at what it would switch
      // to - and it is the way in that needs no right button and no long
      // press, which is what a phone has.
      const { user } = showTabs(['Work', 'Personal'], { here: 'ws-work' });

      await user.click(await screen.findByRole('link', { name: 'Work' }));

      expect(await screen.findByRole('menuitem', { name: 'Edit…' })).toBeVisible();
    });

    it('leaves a press on any other tab as the switch it is', async () => {
      const { user } = showTabs(['Work', 'Personal'], { here: 'ws-work' });

      await user.click(await screen.findByRole('link', { name: 'Personal' }));

      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  describe('the workspace you are in also carries the menu as a visible "…"', () => {
    // "Give the open workspace and dashboard their own "…", and split the
    // header's menu into settings and you", issue 567: a menu reachable only
    // by right-click, a long press or the menu key was invisible until found.
    it('offers the same entries the tab’s own menu offers', async () => {
      const { user } = showTabs(['Work', 'Personal', 'Acme'], { here: 'ws-personal' });

      await user.click(await screen.findByRole('button', { name: 'Actions for Personal' }));

      expect(entriesOfTheOpenMenu()).toEqual(['Edit…', '---', 'Show All items tab', 'Recurring items', '---', 'Delete']);
    });

    it('is exactly Edit…, the All items tab, Recurring items, then Delete, in groups, on the open workspace’s tab as well', async () => {
      showTabs(['Work', 'Personal'], { here: 'ws-work' });

      await menuOf('Work');

      expect(entriesOfTheOpenMenu()).toEqual(['Edit…', '---', 'Show All items tab', 'Recurring items', '---', 'Delete']);
    });

    it('is not offered for a workspace you are not on', async () => {
      showTabs(['Work', 'Personal'], { here: 'ws-work' });

      expect(await screen.findByRole('button', { name: 'Actions for Work' })).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Actions for Personal' })).toBeNull();
    });

    it('returns the focus to it once what it opened is closed', async () => {
      const { user } = showTabs(['Work', 'Personal'], { here: 'ws-personal' });
      const button = await screen.findByRole('button', { name: 'Actions for Personal' });

      await user.click(button);
      await user.click(screen.getByRole('menuitem', { name: 'Edit…' }));
      await user.click(await screen.findByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(button).toHaveFocus());
    });

    it('returns the focus to it once the Recurring items modal is closed', async () => {
      const { user } = showTabs(['Work', 'Personal'], { here: 'ws-personal' });
      const button = await screen.findByRole('button', { name: 'Actions for Personal' });

      await user.click(button);
      await user.click(screen.getByRole('menuitem', { name: 'Recurring items' }));
      await user.click(await screen.findByRole('button', { name: 'Close' }));

      await waitFor(() => expect(button).toHaveFocus());
    });
  });

  describe('a copy’s link opens the Recurring items modal from outside the menu', () => {
    it('opens it over whatever is on screen, once, when a copy’s form asks for a recurring item', async () => {
      showTabs(['Work', 'Personal'], { here: 'ws-work' });
      await screen.findByRole('button', { name: 'Actions for Work' });
      expect(screen.queryByRole('dialog')).toBeNull();

      act(() => askForRecurringItem({ workspaceId: 'ws-personal', seriesId: '018f0000-0000-7000-8000-0000000000aa' }));

      expect(await screen.findByRole('dialog')).toBeVisible();
      expect(screen.getByText('Recurring items')).toBeVisible();
      expect(takeRecurringRequest()).toBeNull();
    });

    it('does not send the focus back to the tab the modal was last opened from by its menu', async () => {
      const { user } = showTabs(['Work', 'Personal'], { here: 'ws-personal' });
      const button = await screen.findByRole('button', { name: 'Actions for Personal' });
      await user.click(button);
      await user.click(screen.getByRole('menuitem', { name: 'Recurring items' }));
      await user.click(await screen.findByRole('button', { name: 'Close' }));
      await waitFor(() => expect(button).toHaveFocus());

      act(() => askForRecurringItem({ workspaceId: 'ws-personal', seriesId: '018f0000-0000-7000-8000-0000000000aa' }));
      await screen.findByRole('dialog');
      await user.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(button).not.toHaveFocus();
    });
  });

  describe('a workspace’s menu switches that workspace’s All items tab', () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => localStorage.clear());

    it('turns the open workspace’s tab on, and then offers to hide it', async () => {
      const { user } = showTabs(['Work', 'Personal'], { here: 'ws-work' });

      await user.click(await screen.findByRole('button', { name: 'Actions for Work' }));
      await user.click(screen.getByRole('menuitem', { name: 'Show All items tab' }));

      expect(readAllItemsTab(localStorage, 'ws-work')).toBe(true);
      await user.click(await screen.findByRole('button', { name: 'Actions for Work' }));
      expect(screen.getByRole('menuitem', { name: 'Hide All items tab' })).toBeVisible();
      expect(screen.queryByRole('menuitem', { name: 'Show All items tab' })).toBeNull();
    });

    it('turns another workspace’s tab on and leaves the open one’s as it was', async () => {
      showTabs(['Work', 'Personal'], { here: 'ws-work' });

      await menuOf('Personal');
      fireEvent.click(screen.getByRole('menuitem', { name: 'Show All items tab' }));

      expect(readAllItemsTab(localStorage, 'ws-personal')).toBe(true);
      expect(readAllItemsTab(localStorage, 'ws-work')).toBe(false);
    });

    it('returns to the workspace’s first dashboard when hidden while on its All items', async () => {
      setAllItemsTab('ws-work', true);
      showTabs(['Work', 'Personal'], { here: 'ws-work', onAllItemsOf: 'ws-work' });

      await menuOf('Work');
      fireEvent.click(screen.getByRole('menuitem', { name: 'Hide All items tab' }));

      expect(readAllItemsTab(localStorage, 'ws-work')).toBe(false);
      await waitFor(() =>
        expect(wentTo.calls).toMatchObject([
          { to: '/w/$workspaceId/d/$dashboardId', params: { workspaceId: 'ws-work', dashboardId: 'ws-work-first' } },
        ]),
      );
    });

    it('returns to the first dashboard as drawn, with a reorder still unanswered', async () => {
      let answer = () => {};
      vi.mocked(sendCommand).mockImplementationOnce(
        () => new Promise((resolve) => (answer = () => resolve({ ok: true, applied: true }))),
      );
      setAllItemsTab('ws-work', true);
      showTabs(['Work', 'Personal'], { here: 'ws-work', onAllItemsOf: 'ws-work' });
      const moved = changes.enqueue({
        name: 'reorder_dashboards',
        payload: {
          commandId: 'c-1',
          issuedAt: '2026-10-21T09:00:00.000Z',
          workspaceId: 'ws-work',
          dashboardId: 'ws-work-second',
          dashboardIds: ['ws-work-second', 'ws-work-first'],
        },
      });

      await menuOf('Work');
      fireEvent.click(screen.getByRole('menuitem', { name: 'Hide All items tab' }));

      await waitFor(() =>
        expect(wentTo.calls).toMatchObject([{ params: { workspaceId: 'ws-work', dashboardId: 'ws-work-second' } }]),
      );
      answer();
      await moved;
      changes.forgetAnswered();
    });

    it('stays on the dashboard when hidden while on a dashboard', async () => {
      setAllItemsTab('ws-work', true);
      showTabs(['Work', 'Personal'], { here: 'ws-work' });

      await menuOf('Work');
      fireEvent.click(screen.getByRole('menuitem', { name: 'Hide All items tab' }));

      expect(readAllItemsTab(localStorage, 'ws-work')).toBe(false);
      expect(wentTo.calls).toEqual([]);
    });

    it('stays on this workspace’s All items when another workspace’s tab is hidden', async () => {
      setAllItemsTab('ws-work', true);
      setAllItemsTab('ws-personal', true);
      showTabs(['Work', 'Personal'], { here: 'ws-work', onAllItemsOf: 'ws-work' });

      await menuOf('Personal');
      fireEvent.click(screen.getByRole('menuitem', { name: 'Hide All items tab' }));

      expect(readAllItemsTab(localStorage, 'ws-personal')).toBe(false);
      expect(readAllItemsTab(localStorage, 'ws-work')).toBe(true);
      expect(wentTo.calls).toEqual([]);
    });
  });

  describe('changing a workspace sends only what actually changed', () => {
    // An untouched box must send nothing, or it would carry the value the form
    // opened with over an edit made somewhere else in the meantime - and a
    // colour nobody touched would repaint the workspace on every rename.
    it.each([
      { situation: 'a new name and the colour left alone', rename: 'Client', paint: false },
      { situation: 'a colour and the name left alone', rename: null, paint: true },
      { situation: 'both halves', rename: 'Client', paint: true },
      { situation: 'neither half', rename: null, paint: false },
    ])('sends what moved and no more, given $situation', async (row) => {
      const { sent, user } = showTabs(['Work', 'Personal']);
      await menuOf('Personal');
      await user.click(screen.getByRole('menuitem', { name: 'Edit…' }));

      if (row.rename) {
        await user.clear(screen.getByRole('textbox', { name: 'Name of Personal' }));
        await user.type(screen.getByRole('textbox', { name: 'Name of Personal' }), row.rename);
      }
      if (row.paint) await user.click(screen.getByRole('button', { name: /^Teal for Personal$/ }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      const names = sent.mock.calls.map(([args]) => args.name);
      expect(names).toEqual(
        [row.rename ? 'rename_workspace' : null, row.paint ? 'set_workspace_theme' : null].filter(
          Boolean,
        ),
      );
    });

    it('closes the form at the click, whatever the server has yet to say', async () => {
      const { sent, user } = showTabs(['Work', 'Personal']);
      sent.mockReturnValue(new Promise(() => {}));
      await menuOf('Personal');
      await user.click(screen.getByRole('menuitem', { name: 'Edit…' }));
      await user.clear(screen.getByRole('textbox', { name: 'Name of Personal' }));
      await user.type(screen.getByRole('textbox', { name: 'Name of Personal' }), 'Client');

      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(sent).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('textbox', { name: /^Name of/ })).toBeNull();
    });
  });

  describe('a workspace you move is sent as the whole order it leaves', () => {
    it('sends the order the drag made', async () => {
      // The order a move is computed from is the order in hand, drawn over the
      // list (tests/unit/components/WorkspacesAtOnce.test.tsx).
      const { sent } = showTabs(['Work', 'Personal', 'Acme']);
      await screen.findByRole('link', { name: 'Work' });

      dragTab('Work', 1);

      expect(sent.mock.calls[0]?.[0]).toMatchObject({
        name: 'reorder_workspaces',
        payload: { workspaceIds: ['ws-personal', 'ws-work', 'ws-acme'] },
      });
    });

    it('leaves the tabs alone under a pointer holding nothing', async () => {
      // A press can end where this strip never hears about it: below the
      // threshold nothing has been captured yet, so a release that slid off
      // the tab - into the gap between two, or the space above a short one -
      // is delivered elsewhere and leaves the press recorded. The next hover
      // back across that tab must not read as that drag continuing, or the
      // strip reorders under a pointer holding nothing and sends a move
      // nobody asked for.
      const { sent } = showTabs(['Work', 'Personal', 'Acme']);
      const tab = await screen.findByRole('link', { name: 'Work' });

      fireEvent.pointerDown(tab, { button: 0, pointerType: 'mouse', clientX: 100, buttons: 1 });
      // Let go somewhere that is not a tab, which is what leaves the press behind.
      fireEvent.pointerUp(document.body);
      fireEvent.pointerMove(tab, { pointerType: 'mouse', clientX: 400, buttons: 0 });
      fireEvent.click(tab);

      expect(sent).not.toHaveBeenCalled();
      expect(
        screen
          .getAllByRole('link')
          .map((each) => each.textContent)
          .filter((name) => name !== ''),
      ).toEqual(['Work', 'Personal', 'Acme']);
    });
  });

  describe('deleting a workspace asks first, and says what stops being visible', () => {
    it.each([
      { situation: 'a workspace holding nothing', items: 0, asks: 'Delete Personal? There is nothing in it.' },
      { situation: 'a workspace holding one item', items: 1, asks: 'Delete Personal and hide its 1 item?' },
      { situation: 'a workspace holding several', items: 4, asks: 'Delete Personal and hide its 4 items?' },
    ])('says what goes with it, for $situation', async (row) => {
      const { user } = showTabs(['Work', 'Personal'], { items: row.items });
      await menuOf('Personal');

      await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

      expect(await screen.findByRole('alertdialog', { name: row.asks })).toBeVisible();
    });

    it('leaves the focus in the strip once the tab it was asked from has gone', async () => {
      // The question closes by ceasing to exist rather than by being
      // dismissed, so nothing else puts the focus anywhere and it falls to the
      // top of a page you cannot see. It goes to the tab you are on, which is
      // the nearest thing to where you were.
      //
      // **This is the easy half.** The list here is fixed, so the workspace
      // deleted is one this walk was not looking at and the tab to land on is
      // there already. Deleting the one you *are* on moves the app to another
      // workspace first, and the focus has to wait for that - which passed
      // here while the app put the focus on a tab about to be taken away, and
      // is held in tests/e2e/workspace-management.test.ts instead.
      const { user } = showTabs(['Work', 'Personal'], { here: 'ws-work', items: 0 });
      await menuOf('Personal');
      await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
      await user.click(await screen.findByRole('button', { name: 'Yes, delete Personal' }));

      await waitFor(() => expect(screen.getByRole('link', { name: 'Work' })).toHaveFocus());
    });

    it('lands on a workspace that is left rather than on `/`, which opens Capture on a phone', async () => {
      const { sent, user } = showTabs(['Work', 'Personal'], { here: 'ws-personal' });
      // Nothing answered: the next workspace is chosen from the list as drawn.
      sent.mockReturnValue(new Promise(() => {}));
      await menuOf('Personal');
      await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
      await user.click(await screen.findByRole('button', { name: 'Yes, delete Personal' }));

      await waitFor(() =>
        expect(wentTo.calls).toEqual([{ to: '/w/$workspaceId', params: { workspaceId: 'ws-work' } }]),
      );
    });

    it('sends the delete only once the question has been answered', async () => {
      const { sent, user } = showTabs(['Work', 'Personal'], { items: 2 });
      await menuOf('Personal');
      await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
      await screen.findByRole('alertdialog');
      expect(sent).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Yes, delete Personal' }));

      expect(sent.mock.calls[0]?.[0]).toMatchObject({
        name: 'delete_workspace',
        payload: { workspaceId: 'ws-personal' },
      });
    });
  });
});
