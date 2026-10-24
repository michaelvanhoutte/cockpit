import 'fake-indexeddb/auto';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CommandResult, Dashboard, Panel, WorkspaceSnapshot } from '@cockpit/shared';
import { changes } from '../../../src/api/changes';
import { CommandRefused, fetchSnapshot, fetchWorkspaces, sendCommand } from '../../../src/api/client';
import { useSnapshot } from '../../../src/api/useSnapshot';
import { DashboardBar } from '../../../src/components/DashboardBar';
import { resetStanding, stand } from '../../../src/offline';
import { UndoWhatJustHappened } from '../../../src/undo';

/**
 * A Dashboard change as each control makes it, with the server holding the
 * answer - the frontend-with-its-own-backend level (F2), run in this runner as
 * `FilingsAtOnce.test.tsx` is. The bar, the queries and the tab's queue are the
 * app's own and only the network is replaced: a server that answers when the
 * test says, keeps the Dashboards it is told to, and refuses what the real one
 * refuses. What each change draws is tests/unit/drawnAhead.test.ts, when it
 * stops being drawn is tests/unit/changeQueue.test.ts, and that the address
 * decides against the drawn copy is tests/unit/router.test.tsx; what is asked
 * here is that every control is wired to them.
 *
 * The router is the one stand-in beyond the network: pressing a tab or adding a
 * Dashboard moves `Board` the way an address would, deciding whether the
 * Dashboard exists against the copy as drawn.
 */

const router = vi.hoisted(() => ({
  open: null as string | null,
  go: (_to: unknown) => {},
}));

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  fetchSnapshot: vi.fn(),
  fetchWorkspaces: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    search: _search,
    params,
    className,
    ...rest
  }: {
    children?: React.ReactNode;
    to?: string;
    search?: unknown;
    params?: { dashboardId?: string };
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href="#"
      className={`${className ?? ''}${params?.dashboardId && params.dashboardId === router.open ? ' active' : ''}`}
      {...rest}
    >
      {children}
    </a>
  ),
  // Lands a step later, as the real router's does once the route has loaded.
  useNavigate: () => (to: unknown) => Promise.resolve().then(() => router.go(to)),
}));

const WORK = 'ws-work';
const TODAY: Dashboard = { id: 'd-today', tenantId: 'tenant', workspaceId: WORK, name: 'Today' };
const READING: Dashboard = { id: 'd-reading', tenantId: 'tenant', workspaceId: WORK, name: 'Reading' };
const ADMIN: Dashboard = { id: 'd-admin', tenantId: 'tenant', workspaceId: WORK, name: 'Admin' };

function aPanel(id: string, name: string, dashboardId: string): Panel {
  return {
    id,
    tenantId: 'tenant',
    dashboardId,
    name,
    kind: 'items',
    format: 'plain',
    body: '',
    readOnly: false,
    neverPropose: false,
    filter: null,
    sort: null,
    columns: null,
  } as Panel;
}

/** What the server holds. A Dashboard change alters it only when the test lets the server answer. */
let stored: { dashboards: Dashboard[]; panels: Panel[] };

/** Every change the server has been sent and not yet answered, oldest first. */
let waiting: { name: string; payload: Record<string, unknown>; answer: () => void; refuse: (error: Error) => void }[];

/** What the server does with a Dashboard change it accepts, and the refusals the real one gives. */
function keep(name: string, payload: Record<string, unknown>) {
  const held = stored.dashboards;
  const named = (text: string, except?: string) =>
    held.find((one) => one.id !== except && one.name.toLowerCase() === text.toLowerCase());
  const id = payload.dashboardId as string;
  if (name === 'add_dashboard') {
    const taken = named(payload.name as string);
    if (taken) throw new CommandRefused(409, `a dashboard called ${taken.name} already exists in this workspace`);
    held.push({ id, tenantId: 'tenant', workspaceId: WORK, name: payload.name as string });
    stored.panels.push(aPanel(payload.panelId as string, 'Panel 1', id));
    return;
  }
  if (!held.some((one) => one.id === id)) throw new CommandRefused(404, 'that dashboard is not there');
  if (name === 'rename_dashboard') {
    const taken = named(payload.name as string, id);
    if (taken) throw new CommandRefused(409, `a dashboard called ${taken.name} already exists in this workspace`);
    stored.dashboards = held.map((one) => (one.id === id ? { ...one, name: payload.name as string } : one));
  } else if (name === 'delete_dashboard') {
    if (held.length === 1) throw new CommandRefused(409, 'a workspace keeps its last dashboard');
    stored.dashboards = held.filter((one) => one.id !== id);
    stored.panels = stored.panels.filter((panel) => panel.dashboardId !== id);
  } else if (name === 'reorder_dashboards') {
    const order = payload.dashboardIds as string[];
    if (order.length !== held.length || !held.every((one) => order.includes(one.id))) {
      throw new CommandRefused(409, 'the dashboards changed while they were being put in order');
    }
    stored.dashboards = order.map((one) => held.find((d) => d.id === one)!);
  }
}

function theWorkspace(): WorkspaceSnapshot {
  return {
    workspace: { id: WORK, tenantId: 'tenant', name: 'Work', color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' },
    items: [],
    dashboards: stored.dashboards,
    panels: stored.panels,
    layouts: [],
    associations: [],
    attachments: [],
    itemFormPresentation: 'centered',
    followUpDays: 3,
    duplicates: [],
    filings: [],
    agentRuns: [],
    generatedAt: '2026-10-21T09:00:00.000Z',
  } as unknown as WorkspaceSnapshot;
}

let client: QueryClient;

/** The board of the open Dashboard, as the page draws it: its name and its Panels, from the drawn copy. */
function Board({ dashboardId }: { dashboardId: string | null }) {
  const { data } = useSnapshot(WORK);
  const dashboard = data?.dashboards.find((one) => one.id === dashboardId);
  return (
    <section aria-label="Board">
      {dashboard && (
        <>
          <h2>{dashboard.name}</h2>
          {data?.panels
            .filter((panel) => panel.dashboardId === dashboard.id)
            .map((panel) => <p key={panel.id}>{panel.name}</p>)}
        </>
      )}
    </section>
  );
}

/** Where an address would take the tab: the Dashboard asked for if the drawn copy has it, else the Workspace's first. */
function aScreen(opening: string) {
  function Screen() {
    const [open, setOpen] = useState<string | null>(opening);
    router.open = open;
    router.go = (to) => {
      const { params } = to as { params: { dashboardId?: string } };
      const drawn = changes.drawnOver(client.getQueryData<WorkspaceSnapshot>(['snapshot', WORK])!);
      const wanted = params.dashboardId;
      setOpen(wanted && drawn.dashboards.some((one) => one.id === wanted) ? wanted : (drawn.dashboards[0]?.id ?? null));
    };
    return (
      <>
        <DashboardBar workspaceId={WORK} tint="#6f62b5" ground="#e3e1f2" openDashboardId={open} />
        <Board dashboardId={open} />
      </>
    );
  }
  return (
    <QueryClientProvider client={client}>
      <UndoWhatJustHappened>
        <Screen />
      </UndoWhatJustHappened>
    </QueryClientProvider>
  );
}

async function show(dashboards: Dashboard[], opening: string) {
  stored = {
    dashboards: [...dashboards],
    panels: dashboards.map((one) => aPanel(`p-${one.id}`, 'Panel 1', one.id)),
  };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(aScreen(opening));
  await waitFor(() => expect(client.getQueryData(['snapshot', WORK])).toBeDefined());
  await screen.findByRole('link', { name: dashboards[0]!.name });
  return userEvent.setup();
}

const board = () => within(screen.getByRole('region', { name: 'Board' }));
const theBar = () => screen.getAllByRole('link').map((tab) => tab.textContent);
const tab = (name: string) => screen.getByRole('link', { name });
const reads = () => vi.mocked(fetchSnapshot).mock.calls.length;
const waitingFor = () => waiting.map((request) => request.name);

/** Lets what the app does between an answer and the next request, and the read behind it, happen. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

/** The server answers the oldest change it is holding. */
async function answerNext() {
  await act(async () => waiting.shift()!.answer());
  await settle();
}

async function addADashboard(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: 'Add a dashboard' }));
  await user.type(screen.getByLabelText('Name of the new dashboard'), name);
  await user.click(screen.getByRole('button', { name: 'Add' }));
}

async function chooseOnTab(user: ReturnType<typeof userEvent.setup>, tabName: string, entry: string) {
  fireEvent.contextMenu(tab(tabName));
  await user.click(await screen.findByRole('menuitem', { name: entry }));
}

async function renameTo(user: ReturnType<typeof userEvent.setup>, from: string, to: string) {
  await chooseOnTab(user, from, 'Edit…');
  const box = screen.getByRole('textbox', { name: `Name of ${from}` });
  await user.clear(box);
  await user.type(box, to);
  await user.click(screen.getByRole('button', { name: 'Save' }));
}

/** jsdom lays nothing out, so each tab is given a 100-pixel slot for the drag to measure (`DashboardBar.test.tsx` does the same). */
function dragTab(name: string, overSlot: number) {
  const link = tab(name);
  fireEvent.pointerDown(link, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 0, buttons: 1 });
  [...document.querySelectorAll('nav[aria-label="Dashboards"] a')].forEach((one, index) => {
    one.getBoundingClientRect = () => ({ left: index * 100, right: (index + 1) * 100 }) as DOMRect;
  });
  fireEvent.pointerMove(link, { pointerId: 1, pointerType: 'mouse', clientX: overSlot * 100 + 50, buttons: 1 });
  fireEvent.pointerUp(link, { pointerId: 1, pointerType: 'mouse' });
}

beforeEach(() => {
  localStorage.clear();
  resetStanding();
  waiting = [];
  vi.mocked(fetchSnapshot).mockReset();
  vi.mocked(fetchSnapshot).mockImplementation(async () => structuredClone(theWorkspace()));
  vi.mocked(fetchWorkspaces).mockImplementation(async () => ({ workspaces: [theWorkspace().workspace] }) as never);
  vi.mocked(sendCommand).mockImplementation(
    (name, payload) =>
      new Promise<CommandResult>((resolve, reject) => {
        waiting.push({
          name,
          payload: payload as Record<string, unknown>,
          answer: () => {
            try {
              keep(name, payload as Record<string, unknown>);
              resolve({ ok: true, applied: true });
            } catch (error) {
              reject(error);
            }
          },
          refuse: (error) => reject(error),
        });
      }),
  );
});

afterEach(async () => {
  cleanup();
  resetStanding();
  for (let round = 0; round < 6 && changes.unanswered() > 0; round += 1) {
    await act(async () => waiting.splice(0).forEach((request) => request.answer()));
    await settle();
  }
  changes.forgetAnswered();
});

describe('Dashboards', () => {
  describe('a Dashboard change shows the moment it is made, with the server still holding the answer', () => {
    it('puts a new Dashboard at the end of the bar, closes the question, and opens it with its Panel on the board', async () => {
      const user = await show([TODAY, READING], TODAY.id);

      await addADashboard(user, 'Research');

      expect(theBar()).toEqual(['Inbox', 'Today', 'Reading', 'Research']);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(board().getByRole('heading', { name: 'Research' })).toBeVisible();
      expect(board().getByText('Panel 1')).toBeVisible();
      expect(waitingFor()).toEqual(['add_dashboard']);
    });

    it('shows the new name on the tab when a Dashboard is renamed, and closes the form', async () => {
      const user = await show([TODAY, READING], TODAY.id);

      await renameTo(user, 'Reading', 'Library');

      expect(theBar()).toEqual(['Inbox', 'Today', 'Library']);
      expect(screen.queryByRole('textbox', { name: /^Name of/ })).toBeNull();
      expect(waitingFor()).toEqual(['rename_dashboard']);
    });

    it('takes another Dashboard’s tab away and leaves the board where it was', async () => {
      const user = await show([TODAY, READING], TODAY.id);

      await chooseOnTab(user, 'Reading', 'Delete');
      await user.click(await screen.findByRole('button', { name: 'Yes, delete Reading' }));

      expect(theBar()).toEqual(['Inbox', 'Today']);
      expect(board().getByRole('heading', { name: 'Today' })).toBeVisible();
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(waitingFor()).toEqual(['delete_dashboard']);
    });

    it('takes the open Dashboard’s tab away and puts the board on the next one', async () => {
      const user = await show([TODAY, READING, ADMIN], READING.id);

      await chooseOnTab(user, 'Reading', 'Delete');
      await user.click(await screen.findByRole('button', { name: 'Yes, delete Reading' }));

      expect(theBar()).toEqual(['Inbox', 'Today', 'Admin']);
      expect(board().getByRole('heading', { name: 'Today' })).toBeVisible();
      expect(waitingFor()).toEqual(['delete_dashboard']);
    });

    it('shows the new order when a tab is dragged', async () => {
      const user = await show([TODAY, READING, ADMIN], TODAY.id);
      void user;

      dragTab('Today', 2);

      await waitFor(() => expect(theBar()).toEqual(['Inbox', 'Reading', 'Today', 'Admin']));
      expect(waitingFor()).toEqual(['reorder_dashboards']);
    });
  });

  describe('adding a Dashboard opens it with no read first', () => {
    it('shows the board on the new Dashboard before any read, and reads once after the answer', async () => {
      const user = await show([TODAY], TODAY.id);
      await settle();
      const before = reads();

      await addADashboard(user, 'Research');

      expect(board().getByRole('heading', { name: 'Research' })).toBeVisible();
      expect(reads()).toBe(before);
      await answerNext();
      expect(reads()).toBe(before + 1);
      // And the board is still on it once the server's copy has landed.
      expect(board().getByRole('heading', { name: 'Research' })).toBeVisible();
      expect(theBar()).toEqual(['Inbox', 'Today', 'Research']);
    });
  });

  describe('a Dashboard change built on one still unanswered goes behind it', () => {
    it('lands the add and then the rename of the Dashboard just added, in that order', async () => {
      const user = await show([TODAY], TODAY.id);
      await addADashboard(user, 'Research');

      await renameTo(user, 'Research', 'Library');

      expect(theBar()).toEqual(['Inbox', 'Today', 'Library']);
      // Behind the add: the server is not asked about the rename yet.
      expect(waitingFor()).toEqual(['add_dashboard']);
      await answerNext();
      await waitFor(() => expect(waitingFor()).toEqual(['rename_dashboard']));
      await answerNext();

      expect(stored.dashboards.map((one) => one.name)).toEqual(['Today', 'Library']);
      expect(theBar()).toEqual(['Inbox', 'Today', 'Library']);
    });

    it('sends the rename back too when the add was refused', async () => {
      const user = await show([TODAY], TODAY.id);
      await addADashboard(user, 'Research');
      await renameTo(user, 'Research', 'Library');
      // Another device took the name first.
      stored.dashboards.push({ id: 'd-other', tenantId: 'tenant', workspaceId: WORK, name: 'Research' });

      await answerNext();
      await waitFor(() => expect(waitingFor()).toEqual(['rename_dashboard']));
      await answerNext();

      expect(theBar()).not.toContain('Library');
      expect(theBar()).not.toContain('Research');
      expect(await screen.findByRole('status')).toHaveTextContent('was not renamed');
    });
  });

  describe('a refused Dashboard change goes back and says why in the undo bar', () => {
    it('brings the old name back, with the server’s words, when a rename takes a name already used', async () => {
      const user = await show([TODAY, READING], TODAY.id);
      await renameTo(user, 'Reading', 'Today');
      expect(theBar()).toEqual(['Inbox', 'Today', 'Today']);

      await answerNext();

      expect(theBar()).toEqual(['Inbox', 'Today', 'Reading']);
      expect(await screen.findByRole('status')).toHaveTextContent('“Reading” was not renamed to “Today”. a dashboard called Today already exists in this workspace');
    });

    it('takes the new tab away and puts the board back where it was when an add is refused', async () => {
      const user = await show([TODAY, READING], TODAY.id);
      await addADashboard(user, 'Research');
      expect(board().getByRole('heading', { name: 'Research' })).toBeVisible();
      // Another device took the name first.
      stored.dashboards.push({ id: 'd-other', tenantId: 'tenant', workspaceId: WORK, name: 'Research' });

      await answerNext();

      expect(theBar()).toEqual(['Inbox', 'Today', 'Reading']);
      expect(board().getByRole('heading', { name: 'Today' })).toBeVisible();
      expect(await screen.findByRole('status')).toHaveTextContent(
        '“Research” was not added. a dashboard called Research already exists in this workspace',
      );
    });

    it('puts the board back where it was when an add is refused before it is sent', async () => {
      const user = await show([TODAY, READING], READING.id);
      stand({ chosen: true });

      await addADashboard(user, 'Research');
      await settle();

      expect(theBar()).toEqual(['Inbox', 'Today', 'Reading']);
      expect(board().getByRole('heading', { name: 'Reading' })).toBeVisible();
      expect(await screen.findByRole('status')).toHaveTextContent('“Research” was not added.');
    });

    it('brings the tab back when a delete is refused', async () => {
      const user = await show([TODAY, READING], TODAY.id);
      await chooseOnTab(user, 'Reading', 'Delete');
      await user.click(await screen.findByRole('button', { name: 'Yes, delete Reading' }));
      expect(theBar()).toEqual(['Inbox', 'Today']);

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, 'That dashboard is locked.')));
      await settle();

      expect(theBar()).toEqual(['Inbox', 'Today', 'Reading']);
      expect(await screen.findByRole('status')).toHaveTextContent('“Reading” was not deleted. That dashboard is locked.');
    });
  });
});
