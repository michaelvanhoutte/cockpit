import 'fake-indexeddb/auto';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WORKSPACE_THEMES, nextColor, themeOf, uuidv7, type CommandResult, type Workspace, type WorkspaceSnapshot } from '@cockpit/shared';
import { changes } from '../../../src/api/changes';
import { CommandRefused, fetchMe, fetchSnapshot, fetchWorkspaces, sendCommand } from '../../../src/api/client';
import { workspacesQuery, useSendCommand } from '../../../src/api/queries';
import { readForAnnouncement } from '../../../src/api/snapshotReads';
import { useSnapshot } from '../../../src/api/useSnapshot';
import { useWorkspaces } from '../../../src/api/useWorkspaces';
import { AddWorkspace } from '../../../src/components/AddWorkspace';
import { WorkspaceTabs } from '../../../src/components/WorkspaceTabs';
import { FirstWorkspacePage } from '../../../src/pages/FirstWorkspacePage';
import { litForChrome } from '../../../src/chrome';
import { resetStanding } from '../../../src/offline';
import { UndoWhatJustHappened } from '../../../src/undo';

/**
 * A Workspace change as each control makes it, with the server holding the
 * answer - the frontend-with-its-own-backend level (F2), run in this runner as
 * `DashboardsAtOnce.test.tsx` is. The strip, the queries and the tab's queue are
 * the app's own and only the network is replaced: a server that answers when
 * the test says, keeps the Workspaces it is told to, and refuses what the real
 * one refuses. What each change draws is tests/unit/drawnAhead.test.ts, when it
 * stops being drawn is tests/unit/changeQueue.test.ts, and that the page is
 * painted in the colour as drawn is tests/unit/pages/workspace-chrome.test.tsx;
 * what is asked here is that every control is wired to them.
 *
 * The router is the one stand-in beyond the network: pressing a tab or deleting
 * the open Workspace moves `Page` the way an address would, deciding whether the
 * Workspace exists against the list as drawn.
 */

const router = vi.hoisted(() => ({
  open: null as string | null,
  /** While set, an address does not land: the route is still being read, with the screen still on the Workspace it leaves. */
  frozen: false,
  go: (_to: unknown) => {},
}));

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  fetchSnapshot: vi.fn(),
  fetchWorkspaces: vi.fn(),
  fetchMe: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
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
  // Lands a step later, as the real router's does once the route has loaded.
  useNavigate: () => (to: unknown) => Promise.resolve().then(() => router.go(to)),
  useParams: () => ({ workspaceId: router.open ?? undefined }),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: `/w/${router.open}` } }),
}));

const TEAL = WORKSPACE_THEMES[3]!;
const VIOLET = WORKSPACE_THEMES[0]!;

function aWorkspace(name: string, theme: { tint: string; bar: string; ground: string; header: string } = VIOLET, id = `ws-${name.toLowerCase()}`): Workspace {
  return {
    id,
    tenantId: 'tenant',
    name,
    color: theme.tint,
    bar: theme.bar,
    ground: theme.ground,
    header: theme.header,
  };
}
const WORK = aWorkspace('Work');
const PERSONAL = aWorkspace('Personal');
const ACME = aWorkspace('Acme');

/** What the server holds. A Workspace change alters it only when the test lets the server answer. */
let stored: { workspaces: Workspace[] };

/** Every change the server has been sent and not yet answered, oldest first. */
let waiting: { name: string; payload: Record<string, unknown>; answer: () => void; refuse: (error: Error) => void }[];

/** What the server does with a Workspace change it accepts, and the refusals the real one gives. */
function keep(name: string, payload: Record<string, unknown>) {
  const held = stored.workspaces;
  const id = payload.workspaceId as string;
  if (name === 'create_workspace') {
    const taken = held.find((one) => one.name.toLowerCase() === (payload.name as string).toLowerCase());
    if (taken) throw new CommandRefused(409, `a workspace called ${taken.name} already exists`);
    stored.workspaces = [...held, aWorkspace(payload.name as string, themeOf(nextColor(held.map((one) => one.color))), id)];
    return;
  }
  if (!held.some((one) => one.id === id)) throw new CommandRefused(404, 'that workspace is not there');
  if (name === 'rename_workspace') {
    const taken = held.find((one) => one.id !== id && one.name.toLowerCase() === (payload.name as string).toLowerCase());
    if (taken) throw new CommandRefused(409, `a workspace called ${taken.name} already exists`);
    stored.workspaces = held.map((one) => (one.id === id ? { ...one, name: payload.name as string } : one));
  } else if (name === 'set_workspace_theme') {
    const theme = WORKSPACE_THEMES.find((one) => one.tint === payload.color)!;
    stored.workspaces = held.map((one) =>
      one.id === id ? { ...one, color: theme.tint, bar: theme.bar, ground: theme.ground, header: theme.header } : one,
    );
  } else if (name === 'delete_workspace') {
    stored.workspaces = held.filter((one) => one.id !== id);
  } else if (name === 'reorder_workspaces') {
    const order = payload.workspaceIds as string[];
    if (order.length !== held.length || !held.every((one) => order.includes(one.id))) {
      throw new CommandRefused(409, 'the workspaces changed while they were being put in order');
    }
    stored.workspaces = order.map((one) => held.find((w) => w.id === one)!);
  }
}

function theWorkspace(workspaceId: string): WorkspaceSnapshot {
  const held = stored.workspaces.find((one) => one.id === workspaceId);
  return {
    workspace: held ?? aWorkspace(workspaceId),
    items: [],
    // A Workspace the server holds arrives with its first Dashboard and that Dashboard's Panel.
    dashboards: held ? [{ id: `${workspaceId}-dashboard-1`, tenantId: 'tenant', workspaceId, name: 'Dashboard 1' }] : [],
    panels: held
      ? [{ id: `${workspaceId}-panel-1`, tenantId: 'tenant', dashboardId: `${workspaceId}-dashboard-1`, name: 'Panel 1', kind: 'items' }]
      : [],
    layouts: [],
    associations: [],
    attachments: [],
    duplicates: [],
    filings: [],
    agentRuns: [],
    generatedAt: '2026-10-21T09:00:00.000Z',
  } as unknown as WorkspaceSnapshot;
}

let client: QueryClient;

/** The page of the open Workspace: its name from the list as drawn, and its read held the way a page holds it. */
function Page({ workspaceId }: { workspaceId: string | null }) {
  const { data } = useWorkspaces();
  const { data: drawn } = useSnapshot(workspaceId ?? '', { enabled: workspaceId !== null });
  const here = data?.workspaces.find((one) => one.id === workspaceId);
  const dashboard = drawn?.dashboards[0];
  return (
    <section aria-label="Page">
      {here ? <h2>{here.name}</h2> : <p>nothing open</p>}
      {dashboard && <h3>{dashboard.name}</h3>}
      {drawn?.panels.filter((panel) => panel.dashboardId === dashboard?.id).map((panel) => <p key={panel.id}>{panel.name}</p>)}
    </section>
  );
}

/** What captures into a Workspace, with a note already made: sent as the app sends one made on its own page. */
function CaptureInto({ workspaceId }: { workspaceId: string }) {
  const send = useSendCommand();
  return (
    <button
      type="button"
      onClick={() =>
        void send({
          name: 'capture_item',
          payload: { commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId, itemId: uuidv7(), message: 'Call Bart' },
        }).catch(() => {})
      }
    >
      Capture here
    </button>
  );
}

/** Where an address would take the strip: the Workspace asked for if the drawn list has it, else the first. */
function aScreen(opening: string | null) {
  function Screen() {
    const [open, setOpen] = useState<string | null>(opening);
    router.open = open;
    router.go = (to) => {
      if (router.frozen) return;
      const { to: path, params } = to as { to: string; params?: { workspaceId?: string } };
      if (path === '/start') return setOpen(null);
      const drawn = changes.drawnList(client.getQueryData(['workspaces'])!);
      const wanted = params?.workspaceId;
      setOpen(wanted && drawn.workspaces.some((one) => one.id === wanted) ? wanted : (drawn.workspaces[0]?.id ?? null));
    };
    // Where an address would take an account with no Workspace: the screen that makes the first.
    if (open === null) return <FirstWorkspacePage />;
    return (
      <>
        <WorkspaceTabs bar={VIOLET.bar} bringIntoView={() => {}}>
          <AddWorkspace openWorkspaceId={open} />
        </WorkspaceTabs>
        <Page workspaceId={open} />
        <CaptureInto workspaceId={open} />
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

async function show(workspaces: Workspace[], opening: string | null) {
  stored = { workspaces: [...workspaces] };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(aScreen(opening));
  if (opening === null) {
    // The address read the list on the way in, which is what the stand-in for it decides from.
    await act(async () => void (await client.fetchQuery(workspacesQuery)));
    await screen.findByLabelText('Name of the new workspace');
    return userEvent.setup();
  }
  await screen.findByRole('link', { name: workspaces[0]!.name });
  await waitFor(() => expect(client.getQueryData(['workspaces'])).toBeDefined());
  return userEvent.setup();
}

const page = () => within(screen.getByRole('region', { name: 'Page' }));
const theStrip = () => within(screen.getByRole('navigation', { name: 'Workspaces' })).queryAllByRole('link').map((tab) => tab.textContent);
const tab = (name: string) => screen.getByRole('link', { name });
const waitingFor = () => waiting.map((request) => request.name);
const readsOf = (workspaceId: string) =>
  vi.mocked(fetchSnapshot).mock.calls.filter(([asked]) => asked === workspaceId).length;

/** Lets what the app does between an answer and the next request, and the read behind it, happen. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

/** The server answers the oldest change it is holding. */
async function answerNext() {
  await act(async () => waiting.shift()!.answer());
  await settle();
}

async function addAWorkspace(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: 'Add a workspace' }));
  await user.type(screen.getByLabelText('Name of the new workspace'), name);
  await user.click(screen.getByRole('button', { name: 'Add' }));
}

/** The Workspace on screen, whose id the app made. */
const theNewId = () => router.open!;

async function chooseOnTab(user: ReturnType<typeof userEvent.setup>, tabName: string, entry: string) {
  fireEvent.contextMenu(tab(tabName));
  await user.click(await screen.findByRole('menuitem', { name: entry }));
}

async function openTheForm(user: ReturnType<typeof userEvent.setup>, tabName: string) {
  await chooseOnTab(user, tabName, 'Edit…');
}

async function renameTo(user: ReturnType<typeof userEvent.setup>, from: string, to: string) {
  await openTheForm(user, from);
  const box = screen.getByRole('textbox', { name: `Name of ${from}` });
  await user.clear(box);
  await user.type(box, to);
  await user.click(screen.getByRole('button', { name: 'Save' }));
}

async function deleteOnTab(user: ReturnType<typeof userEvent.setup>, tabName: string) {
  await chooseOnTab(user, tabName, 'Delete');
  await user.click(await screen.findByRole('button', { name: `Yes, delete ${tabName}` }));
}

/** The colour a tab's mark wears: what the strip draws a Workspace's colour as. */
const markOf = (tabName: string) => tab(tabName).style.getPropertyValue('--tab-mark');

/** jsdom lays nothing out, so each tab is given a 100-pixel slot for the drag to measure (`WorkspaceTabs.test.tsx` does the same). */
function dragTab(name: string, overSlot: number) {
  const link = tab(name);
  fireEvent.pointerDown(link, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 0, buttons: 1 });
  [...document.querySelectorAll('[data-tab-id]')].forEach((one, index) => {
    one.getBoundingClientRect = () => ({ left: index * 100, right: (index + 1) * 100 }) as DOMRect;
  });
  fireEvent.pointerMove(link, { pointerId: 1, pointerType: 'mouse', clientX: overSlot * 100 + 50, buttons: 1 });
  fireEvent.pointerUp(link, { pointerId: 1, pointerType: 'mouse' });
}

beforeEach(() => {
  localStorage.clear();
  resetStanding();
  waiting = [];
  router.frozen = false;
  vi.mocked(fetchMe).mockResolvedValue({ user: { id: 'user-michael', name: 'Michael', role: 'user' } } as never);
  vi.mocked(fetchSnapshot).mockReset();
  vi.mocked(fetchSnapshot).mockImplementation(async (workspaceId: string) => structuredClone(theWorkspace(workspaceId)));
  vi.mocked(fetchWorkspaces).mockImplementation(async () => ({ workspaces: structuredClone(stored.workspaces) }));
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

describe('Workspace management', () => {
  describe('a Workspace change shows the moment it is made, with the server still holding the answer', () => {
    it('shows the new name on the tab when a Workspace is renamed, and closes the form', async () => {
      const user = await show([WORK, PERSONAL], WORK.id);

      await renameTo(user, 'Personal', 'Family');

      expect(theStrip()).toEqual(['Work', 'Family']);
      expect(screen.queryByRole('textbox', { name: /^Name of/ })).toBeNull();
      expect(waitingFor()).toEqual(['rename_workspace']);
    });

    it('shows the new colour on the tab when a Workspace is recoloured, and closes the form', async () => {
      const user = await show([WORK, PERSONAL], WORK.id);

      await openTheForm(user, 'Personal');
      await user.click(screen.getByRole('button', { name: /^Teal for Personal$/ }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(markOf('Personal')).toBe(litForChrome(TEAL.tint));
      expect(markOf('Work')).toBe(litForChrome(VIOLET.tint));
      expect(screen.queryByRole('textbox', { name: /^Name of/ })).toBeNull();
      expect(waitingFor()).toEqual(['set_workspace_theme']);
    });

    it('shows the new name and colour together when one form changes both', async () => {
      const user = await show([WORK, PERSONAL], WORK.id);

      await openTheForm(user, 'Personal');
      const box = screen.getByRole('textbox', { name: 'Name of Personal' });
      await user.clear(box);
      await user.type(box, 'Family');
      await user.click(screen.getByRole('button', { name: /^Teal for Personal$/ }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(theStrip()).toEqual(['Work', 'Family']);
      expect(markOf('Family')).toBe(litForChrome(TEAL.tint));
      expect(waitingFor()).toEqual(['rename_workspace']);
      await answerNext();
      await waitFor(() => expect(waitingFor()).toEqual(['set_workspace_theme']));
    });

    it('takes another Workspace’s tab away and leaves the page where it was', async () => {
      const user = await show([WORK, PERSONAL], WORK.id);

      await deleteOnTab(user, 'Personal');

      expect(theStrip()).toEqual(['Work']);
      expect(page().getByRole('heading', { name: 'Work' })).toBeVisible();
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(waitingFor()).toEqual(['delete_workspace']);
    });

    it('takes the open Workspace’s tab away and puts the page on the next one', async () => {
      const user = await show([WORK, PERSONAL, ACME], PERSONAL.id);

      await deleteOnTab(user, 'Personal');

      expect(theStrip()).toEqual(['Work', 'Acme']);
      await waitFor(() => expect(page().getByRole('heading', { name: 'Work' })).toBeVisible());
      expect(waitingFor()).toEqual(['delete_workspace']);
    });

    it('shows the new order when a tab is dragged', async () => {
      await show([WORK, PERSONAL, ACME], WORK.id);

      dragTab('Work', 2);

      await waitFor(() => expect(theStrip()).toEqual(['Personal', 'Acme', 'Work']));
      expect(waitingFor()).toEqual(['reorder_workspaces']);
    });

    it('keeps the change on the screen when the list is read again before the answer, and shows the server’s list after it', async () => {
      const user = await show([WORK, PERSONAL], WORK.id);
      await renameTo(user, 'Personal', 'Family');

      await act(async () => void (await client.invalidateQueries({ queryKey: ['workspaces'] })));
      await settle();
      expect(theStrip()).toEqual(['Work', 'Family']);

      await answerNext();
      expect(theStrip()).toEqual(['Work', 'Family']);
      // Another device renames it again once the answer has been read: that is the server's now.
      stored.workspaces = stored.workspaces.map((one) => (one.id === PERSONAL.id ? { ...one, name: 'Relatives' } : one));
      await act(async () => void (await client.invalidateQueries({ queryKey: ['workspaces'] })));

      await waitFor(() => expect(theStrip()).toEqual(['Work', 'Relatives']));
    });
  });

  describe('a new Workspace opens the moment it is added, with the server still holding the answer', () => {
    const NEW = 'Bookkeeping';

    it('opens it from the bar on its first Dashboard with one Panel, and closes the question', async () => {
      const user = await show([WORK, PERSONAL], WORK.id);

      await addAWorkspace(user, NEW);

      expect(theStrip()).toEqual(['Work', 'Personal', NEW]);
      expect(screen.queryByRole('dialog')).toBeNull();
      await waitFor(() => expect(page().getByRole('heading', { name: NEW })).toBeVisible());
      expect(page().getByRole('heading', { name: 'Dashboard 1' })).toBeVisible();
      expect(page().getAllByText('Panel 1')).toHaveLength(1);
      expect(waitingFor()).toEqual(['create_workspace']);
    });

    it('opens it from the first-Workspace page the same way', async () => {
      const user = await show([], null);

      await user.type(screen.getByLabelText('Name of the new workspace'), NEW);
      await user.click(screen.getByRole('button', { name: 'New workspace' }));

      await waitFor(() => expect(page().getByRole('heading', { name: NEW })).toBeVisible());
      expect(page().getByRole('heading', { name: 'Dashboard 1' })).toBeVisible();
      expect(page().getAllByText('Panel 1')).toHaveLength(1);
      expect(theStrip()).toEqual([NEW]);
      expect(waitingFor()).toEqual(['create_workspace']);
    });

    it('draws it in the colour the server will give it', async () => {
      const user = await show([WORK, PERSONAL], WORK.id);

      await addAWorkspace(user, NEW);

      // Violet is Work's and Personal's, so the first free one is the palette's second.
      expect(markOf(NEW)).toBe(litForChrome(WORKSPACE_THEMES[1].tint));
    });
  });

  describe('a new Workspace is not read before its answer, and the list and the Workspace are read once after it', () => {
    it('asks for neither before the answer, and for each once after it', async () => {
      const user = await show([WORK, PERSONAL], WORK.id);
      const listReads = vi.mocked(fetchWorkspaces).mock.calls.length;

      await addAWorkspace(user, 'Bookkeeping');
      await waitFor(() => expect(page().getByRole('heading', { name: 'Dashboard 1' })).toBeVisible());
      await settle();
      expect(readsOf(theNewId())).toBe(0);
      expect(vi.mocked(fetchWorkspaces).mock.calls.length).toBe(listReads);

      await answerNext();

      expect(readsOf(theNewId())).toBe(1);
      expect(vi.mocked(fetchWorkspaces).mock.calls.length).toBe(listReads + 1);
      // And it stays open on what the server has sent.
      expect(theStrip()).toEqual(['Work', 'Personal', 'Bookkeeping']);
      expect(page().getByRole('heading', { name: 'Dashboard 1' })).toBeVisible();
      expect(page().getAllByText('Panel 1')).toHaveLength(1);
    });

    it('asks for neither before the answer when it is added from the first-Workspace page', async () => {
      const user = await show([], null);
      const listReads = vi.mocked(fetchWorkspaces).mock.calls.length;

      await user.type(screen.getByLabelText('Name of the new workspace'), 'Bookkeeping');
      await user.click(screen.getByRole('button', { name: 'New workspace' }));
      await waitFor(() => expect(page().getByRole('heading', { name: 'Dashboard 1' })).toBeVisible());
      await settle();
      expect(readsOf(theNewId())).toBe(0);
      expect(vi.mocked(fetchWorkspaces).mock.calls.length).toBe(listReads);

      await answerNext();

      expect(readsOf(theNewId())).toBe(1);
      expect(vi.mocked(fetchWorkspaces).mock.calls.length).toBe(listReads + 1);
    });
  });

  describe('a change built on a Workspace still being added goes behind its add', () => {
    it('sends a capture into it only once the add is answered', async () => {
      const user = await show([WORK, PERSONAL], WORK.id);
      await addAWorkspace(user, 'Bookkeeping');
      await waitFor(() => expect(page().getByRole('heading', { name: 'Dashboard 1' })).toBeVisible());

      await user.click(screen.getByRole('button', { name: 'Capture here' }));
      await settle();

      expect(waitingFor()).toEqual(['create_workspace']);
      await answerNext();
      await waitFor(() => expect(waitingFor()).toEqual(['capture_item']));
    });
  });

  describe('a deleted Workspace is not read while its delete is unanswered', () => {
    it('starts no read of it when the server announces a change to it', async () => {
      const user = await show([WORK, PERSONAL], PERSONAL.id);
      await waitFor(() => expect(readsOf(PERSONAL.id)).toBeGreaterThan(0));
      // The address has not landed yet: the page is still reading the Workspace it leaves.
      router.frozen = true;
      await deleteOnTab(user, 'Personal');
      const before = readsOf(PERSONAL.id);

      await act(async () => readForAnnouncement(client, { type: 'snapshot_invalidated', workspaceId: PERSONAL.id }));
      await settle();

      expect(readsOf(PERSONAL.id)).toBe(before);
      expect(waitingFor()).toEqual(['delete_workspace']);
    });

    it('drops its held copy and reads the list once the delete is answered, after which the server’s list is what is drawn', async () => {
      const user = await show([WORK, PERSONAL], WORK.id);
      await deleteOnTab(user, 'Personal');
      await waitFor(() => expect(client.getQueryData(['snapshot', PERSONAL.id])).toBeDefined());
      const listReads = vi.mocked(fetchWorkspaces).mock.calls.length;

      await answerNext();

      expect(client.getQueryData(['snapshot', PERSONAL.id])).toBeUndefined();
      expect(vi.mocked(fetchWorkspaces).mock.calls.length).toBe(listReads + 1);
      expect(changes.deleting(PERSONAL.id)).toBe(false);
      expect(theStrip()).toEqual(['Work']);
    });

    it('reads a Workspace that is not being deleted when the server announces a change to it', async () => {
      await show([WORK, PERSONAL], WORK.id);
      await waitFor(() => expect(readsOf(WORK.id)).toBeGreaterThan(0));
      const before = readsOf(WORK.id);

      await act(async () => readForAnnouncement(client, { type: 'snapshot_invalidated', workspaceId: WORK.id }));
      await settle();

      expect(readsOf(WORK.id)).toBeGreaterThan(before);
    });
  });

  describe('a refused Workspace change goes back and says why in the undo bar', () => {
    it('takes the new tab away and puts the page back on the Workspace you were on when an add is refused', async () => {
      const user = await show([WORK, PERSONAL], PERSONAL.id);
      await addAWorkspace(user, 'Bookkeeping');
      await waitFor(() => expect(page().getByRole('heading', { name: 'Dashboard 1' })).toBeVisible());
      // Another device took the name first.
      stored.workspaces.push(aWorkspace('Bookkeeping'));

      await answerNext();

      expect(theStrip()).toEqual(['Work', 'Personal']);
      await waitFor(() => expect(page().getByRole('heading', { name: 'Personal' })).toBeVisible());
      expect(await screen.findByRole('status')).toHaveTextContent('“Bookkeeping” was not added. a workspace called Bookkeeping already exists');
    });

    it('brings the first-Workspace page back when its add is refused', async () => {
      const user = await show([], null);
      await user.type(screen.getByLabelText('Name of the new workspace'), 'Bookkeeping');
      await user.click(screen.getByRole('button', { name: 'New workspace' }));
      await waitFor(() => expect(page().getByRole('heading', { name: 'Dashboard 1' })).toBeVisible());
      stored.workspaces.push(aWorkspace('Bookkeeping'));

      await answerNext();

      expect(await screen.findByLabelText('Name of the new workspace')).toBeVisible();
      expect(await screen.findByRole('status')).toHaveTextContent('“Bookkeeping” was not added.');
    });

    it('brings the old name back, with the server’s words, when a rename takes a name already used', async () => {
      const user = await show([WORK, PERSONAL], WORK.id);
      await renameTo(user, 'Personal', 'Work');
      expect(theStrip()).toEqual(['Work', 'Work']);

      await answerNext();

      expect(theStrip()).toEqual(['Work', 'Personal']);
      expect(await screen.findByRole('status')).toHaveTextContent(
        '“Personal” was not renamed to “Work”. a workspace called Work already exists',
      );
    });

    it('brings the tab back when a delete is refused', async () => {
      const user = await show([WORK, PERSONAL], WORK.id);
      await deleteOnTab(user, 'Personal');
      expect(theStrip()).toEqual(['Work']);

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, 'That workspace is locked.')));
      await settle();

      expect(theStrip()).toEqual(['Work', 'Personal']);
      expect(await screen.findByRole('status')).toHaveTextContent('“Personal” was not deleted. That workspace is locked.');
    });

    it('puts the tabs back in their order when a move is refused', async () => {
      await show([WORK, PERSONAL, ACME], WORK.id);
      dragTab('Work', 1);
      await waitFor(() => expect(theStrip()).toEqual(['Personal', 'Work', 'Acme']));
      // Another device made one while the order was being put.
      stored.workspaces.push(aWorkspace('Home'));

      await answerNext();

      expect(await screen.findByRole('status')).toHaveTextContent(
        'The workspaces were not put in that order. the workspaces changed while they were being put in order',
      );
      expect(theStrip().slice(0, 3)).toEqual(['Work', 'Personal', 'Acme']);
    });
  });
});
