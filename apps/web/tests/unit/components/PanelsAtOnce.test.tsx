import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CommandResult, Dashboard, Filing, Item, Layout, Panel, WorkspaceSnapshot } from '@cockpit/shared';
import { A_DESK, onAScreen } from '../onAScreen';
import { changes } from '../../../src/api/changes';
import { CommandRefused, fetchSnapshot, fetchWorkspaces, sendCommand } from '../../../src/api/client';
import { useSnapshot } from '../../../src/api/useSnapshot';
import { DashboardBar } from '../../../src/components/DashboardBar';
import { PanelBoard } from '../../../src/components/PanelBoard';
import { resetStanding } from '../../../src/offline';
import { UndoWhatJustHappened } from '../../../src/undo';

/**
 * A Panel change as each control makes it, with the server holding the answer -
 * the frontend-with-its-own-backend level (F2), run in this runner as
 * `DashboardsAtOnce.test.tsx` is. The bar, the board, the queries and the tab's
 * queue are the app's own and only the network is replaced: a server that
 * answers when the test says, keeps what it is told to, and refuses what the
 * real one refuses. What each change draws is tests/unit/drawnAhead.test.ts and
 * when it stops being drawn is tests/unit/changeQueue.test.ts; what is asked here
 * is that every control is wired to them.
 */

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  fetchSnapshot: vi.fn(),
  fetchWorkspaces: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to: _to,
    search: _search,
    params: _params,
    ...rest
  }: {
    children?: React.ReactNode;
    to?: string;
    search?: unknown;
    params?: unknown;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href="#" {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => () => Promise.resolve(),
}));

const WORK = 'ws-work';
const TODAY: Dashboard = { id: 'd-today', tenantId: 'tenant', workspaceId: WORK, name: 'Today' };
const READING: Dashboard = { id: 'd-reading', tenantId: 'tenant', workspaceId: WORK, name: 'Reading' };

const FALCON = '00000000-0000-7000-8000-00000000000a';
const NOTES = '00000000-0000-7000-8000-00000000000b';
const URGENT = '00000000-0000-7000-8000-00000000000c';

function aPanel(id: string, name: string, over: Partial<Panel> = {}): Panel {
  return {
    id,
    tenantId: 'tenant',
    dashboardId: TODAY.id,
    name,
    kind: 'items',
    format: 'plain',
    body: '',
    readOnly: false,
    neverPropose: false,
    filter: null,
    sort: null,
    columns: null,
    ...over,
  } as Panel;
}

function anItem(id: string, title: string, priority: Item['priority'] = null): Item {
  return {
    id,
    tenantId: 'tenant',
    workspaceId: WORK,
    workspaceDecided: true,
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    title,
    capturedMessage: null,
    description: null,
    textsSettledAt: null,
    textsProposedAt: null,
    readings: null,
    proposedPanelId: null,
    proposedPanelReason: null,
    proposedPanelFit: null,
    claudeProposals: null,
    seriesId: null,
    waitingSince: null,
    sourceResolvedAt: null,
    nextAction: null,
    completedAt: null,
    startedAt: null,
    priority,
    prioritySetAt: null,
    dueDateChosenAt: null,
    capturedTimeZone: null,
    dueDate: null,
    dueDateSetAt: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-31T08:00:00.000Z',
    updatedAt: '2026-08-31T08:00:00.000Z',
  };
}

/** What the server holds. A Panel change alters it only when the test lets the server answer. */
let stored: { panels: Panel[]; layouts: Layout[]; filings: Filing[] };

/** Every change the server has been sent and not yet answered, oldest first. */
let waiting: { name: string; payload: Record<string, unknown>; answer: () => void; refuse: (error: Error) => void }[];

const OTHER = '00000000-0000-7000-8000-00000000000d';

/** What the server does with a Panel change it accepts, and the refusals the real one gives. */
function keep(name: string, payload: Record<string, unknown>) {
  const id = payload.panelId as string;
  const taken = (text: string, dashboardId: string, except?: string) =>
    stored.panels.find((one) => one.dashboardId === dashboardId && one.id !== except && one.name.toLowerCase() === text.toLowerCase());
  if (name === 'add_panel') {
    const clash = taken(payload.name as string, payload.dashboardId as string);
    if (clash) throw new CommandRefused(409, `a panel called ${clash.name} is already on this dashboard`);
    stored.panels.push(aPanel(id, payload.name as string, { kind: payload.kind as Panel['kind'] }));
  } else if (name === 'save_layout') {
    const rows = payload.rows as Layout['rows'];
    const own = stored.layouts.find((layout) => layout.dashboardId === payload.dashboardId);
    if (own) own.rows = rows;
    else stored.layouts.push({ id: payload.layoutId as string, tenantId: 'tenant', dashboardId: payload.dashboardId as string, rows });
  } else if (name === 'set_panel_settings') {
    const clash = typeof payload.name === 'string' ? taken(payload.name, TODAY.id, id) : undefined;
    if (clash) throw new CommandRefused(409, `a panel called ${clash.name} is already on this dashboard`);
    stored.panels = stored.panels.map((one) => (one.id === id ? ({ ...one, ...settingsOf(payload) } as Panel) : one));
  } else if (name === 'set_panel_filter') {
    stored.panels = stored.panels.map((one) =>
      one.id === id ? { ...one, filter: { rows: payload.rows, groupBy: payload.groupBy } as Panel['filter'] } : one,
    );
  } else if (name === 'set_panel_sort') {
    stored.panels = stored.panels.map((one) => (one.id === id ? { ...one, sort: payload.sort as Panel['sort'] } : one));
  } else if (name === 'delete_panel') {
    stored.panels = stored.panels.filter((one) => one.id !== id);
    stored.filings = stored.filings.filter((filing) => filing.panelId !== id);
  } else if (name === 'move_panel_to_dashboard') {
    // The real server renames a Panel that lands beside one of its name.
    const target = payload.dashboardId as string;
    const clash = taken(stored.panels.find((one) => one.id === id)!.name, target);
    stored.panels = stored.panels.map((one) =>
      one.id === id ? { ...one, dashboardId: target, name: clash ? `${one.name} (2)` : one.name } : one,
    );
  }
}

function settingsOf(payload: Record<string, unknown>) {
  const { name, neverPropose, readOnly, format, columns } = payload;
  return Object.fromEntries(Object.entries({ name, neverPropose, readOnly, format, columns }).filter(([, value]) => value !== undefined));
}

function theWorkspace(): WorkspaceSnapshot {
  return {
    workspace: { id: WORK, tenantId: 'tenant', name: 'Work', color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' },
    items: [anItem('i-alpha', 'Alpha', 'low'), anItem('i-bravo', 'Bravo', 'high'), anItem('i-charlie', 'Charlie', 'high')],
    dashboards: [TODAY, READING],
    panels: stored.panels,
    layouts: stored.layouts,
    associations: [],
    attachments: [],
    itemFormPresentation: 'centered',
    followUpDays: 3,
    duplicates: [],
    filings: stored.filings,
    agentRuns: [],
    generatedAt: '2026-10-21T09:00:00.000Z',
  } as unknown as WorkspaceSnapshot;
}

let client: QueryClient;

/** The page of the open Dashboard, as `DashboardPage` draws it: its board from the drawn copy. */
function Board() {
  const { data } = useSnapshot(WORK);
  if (!data) return null;
  return (
    <PanelBoard
      key={TODAY.id}
      workspaceId={WORK}
      dashboard={TODAY}
      dashboards={data.dashboards}
      panels={data.panels.filter((panel) => panel.dashboardId === TODAY.id)}
      panelsInWorkspace={data.panels}
      layouts={data.layouts}
      items={data.items}
      filings={data.filings}
      attachments={data.attachments}
      agentRuns={data.agentRuns}
    />
  );
}

async function show(panels: Panel[], layouts: Layout[] = [], filings: Filing[] = []) {
  stored = { panels: [...panels], layouts: structuredClone(layouts), filings: [...filings] };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UndoWhatJustHappened>
        <DashboardBar workspaceId={WORK} tint="#6f62b5" ground="#e3e1f2" openDashboardId={TODAY.id} />
        <Board />
      </UndoWhatJustHappened>
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: '+ Panel' });
  await screen.findByRole('region', { name: panels[0]!.name });
  return userEvent.setup();
}

/** The Panels as drawn, in order. */
const panelsOnScreen = () =>
  screen
    .getAllByRole('region', { hidden: true })
    .map((region) => region.getAttribute('aria-label') ?? '')
    .filter(Boolean);
const panel = (name: string) => screen.getByRole('region', { name });
const reads = () => vi.mocked(fetchSnapshot).mock.calls.length;
const waitingFor = () => waiting.map((request) => request.name);
/** The drawn copy, as the router and every other reader of the Workspace would see it. */
const drawn = () => changes.drawnOver(client.getQueryData<WorkspaceSnapshot>(['snapshot', WORK])!);

/** Lets what the app does between an answer and the next request, and the read behind it, happen. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

/** The server answers the oldest change it is holding. */
async function answerNext() {
  await act(async () => waiting.shift()!.answer());
  await settle();
}

async function choose(user: ReturnType<typeof userEvent.setup>, name: string, entry: string) {
  const header = panel(name).querySelector('header')!;
  header.focus();
  fireEvent.contextMenu(header);
  await user.click(await screen.findByRole('menuitem', { name: entry }));
}

async function addAPanel(user: ReturnType<typeof userEvent.setup>, name: string, kind?: string) {
  await user.click(screen.getByRole('button', { name: '+ Panel' }));
  if (kind) await user.click(screen.getByRole('radio', { name: new RegExp(kind) }));
  await user.type(screen.getByRole('textbox', { name: /^(Name of the new panel|Title of the new section)$/ }), name);
  await user.click(screen.getByRole('button', { name: 'Add' }));
}

const thePanels = () => [aPanel(FALCON, 'Falcon'), aPanel(NOTES, 'Notes', { kind: 'text' })];
const inRows = (...ids: string[]): Layout => ({
  id: '00000000-0000-7000-8000-0000000000aa',
  tenantId: 'tenant',
  dashboardId: TODAY.id,
  rows: ids.map((panelId) => ({ height: null, cells: [{ panelId, span: 12 }] })),
});

beforeEach(() => {
  onAScreen(A_DESK);
  Object.defineProperty(globalThis, 'innerWidth', { value: 1280, configurable: true, writable: true });
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
  vi.unstubAllGlobals();
});

describe('Panels', () => {
  describe('a Panel change shows the moment it is made, with the server still holding the answer', () => {
    it('puts a new Panel at the foot of the board, and closes the question', async () => {
      const user = await show(thePanels(), [inRows(FALCON, NOTES)]);

      await addAPanel(user, 'Waiting on');

      expect(panelsOnScreen()).toEqual(['Falcon', 'Notes', 'Waiting on']);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(waitingFor()).toEqual(['add_panel']);
    });

    it('puts a new Section at the foot of the board, and closes the question', async () => {
      const user = await show(thePanels(), [inRows(FALCON, NOTES)]);

      await addAPanel(user, 'This week', 'Section');

      const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
      expect(headings.at(-1)).toBe('This week');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(waitingFor()).toEqual(['save_layout']);
    });

    it('builds a second Section on the first, in the one Layout, before the first is answered', async () => {
      const user = await show(thePanels());

      await addAPanel(user, 'One', 'Section');
      await addAPanel(user, 'Two', 'Section');
      await answerNext();
      await waitFor(() => expect(waitingFor()).toEqual(['save_layout']));

      const second = waiting[0]!.payload;
      expect((second.rows as { title?: string }[]).filter((row) => row.title).map((row) => row.title)).toEqual(['One', 'Two']);
      expect(stored.layouts).toHaveLength(1);
      expect(second.layoutId).toBe(stored.layouts[0]!.id);
    });

    it.each([
      { situation: 'a Panel of items', name: 'Falcon', changed: 'Falcon 2', tick: 'Suggest Falcon 2 for new items in the Inbox', reopened: false },
      { situation: 'a Panel of text', name: 'Notes', changed: 'Notes 2', tick: 'Read-only', reopened: true },
    ])('shows the new name and settings of $situation, and closes the form', async ({ name, changed, tick, reopened }) => {
      const user = await show(thePanels(), [inRows(FALCON, NOTES)]);

      await choose(user, name, 'Settings…');
      const box = await screen.findByRole('textbox', { name: 'Name' });
      await user.clear(box);
      await user.type(box, changed);
      await user.click(screen.getByRole('checkbox', { name: tick }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(panel(changed)).toBeVisible();
      expect(waitingFor()).toEqual(['set_panel_settings']);
      // The form opens on what was saved, not on what the server last sent.
      await choose(user, changed, 'Settings…');
      const ticked = await screen.findByRole('checkbox', { name: tick });
      if (reopened) expect(ticked).toBeChecked();
      else expect(ticked).not.toBeChecked();
    });

    it('shows a Filter the Items its new conditions match', async () => {
      const filing = (panelId: string, itemId: string, position: number): Filing => ({ panelId, itemId, position });
      const user = await show(
        [aPanel(FALCON, 'Falcon'), aPanel(URGENT, 'Urgent', { kind: 'filter', filter: { rows: [], groupBy: 'none' } })],
        [inRows(FALCON, URGENT)],
        [filing(FALCON, 'i-alpha', 0), filing(FALCON, 'i-bravo', 1), filing(FALCON, 'i-charlie', 2)],
      );

      await choose(user, 'Urgent', 'Filter…');
      await user.click(await screen.findByRole('button', { name: '+ And…' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Priority' }));
      await user.click(await screen.findByRole('button', { name: '+ Priority' }));
      await user.click(await screen.findByRole('checkbox', { name: 'High' }));
      await user.keyboard('{Escape}');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(within(panel('Urgent')).getAllByText(/^(Alpha|Bravo|Charlie)$/).map((row) => row.textContent)).toEqual(['Bravo', 'Charlie']);
      expect(waitingFor()).toEqual(['set_panel_filter']);
    });

    it('reorders a Panel’s Items by the sort it was given', async () => {
      const filing = (itemId: string, position: number): Filing => ({ panelId: FALCON, itemId, position });
      const user = await show(thePanels(), [inRows(FALCON, NOTES)], [filing('i-charlie', 0), filing('i-alpha', 1), filing('i-bravo', 2)]);
      const titles = () => within(panel('Falcon')).getAllByText(/^(Alpha|Bravo|Charlie)$/).map((row) => row.textContent);
      expect(titles()).toEqual(['Charlie', 'Alpha', 'Bravo']);

      await choose(user, 'Falcon', 'Sort…');
      await user.click(await screen.findByRole('radio', { name: 'Sorted' }));
      await user.click(await screen.findByRole('button', { name: /^\+ Sort by…$/ }));
      await user.click(await screen.findByRole('menuitem', { name: 'Title' }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(titles()).toEqual(['Alpha', 'Bravo', 'Charlie']);
      expect(waitingFor()).toEqual(['set_panel_sort']);
    });

    it('takes a deleted Panel off the board, and closes the question', async () => {
      const user = await show(thePanels(), [inRows(FALCON, NOTES)]);

      await choose(user, 'Falcon', 'Delete');
      await user.click(await screen.findByRole('button', { name: 'Yes, delete Falcon' }));

      expect(panelsOnScreen()).toEqual(['Notes']);
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(waitingFor()).toEqual(['delete_panel']);
    });

    it('takes a Panel moved to another Dashboard off this board and puts it on the other', async () => {
      const user = await show(thePanels(), [inRows(FALCON, NOTES)]);

      await choose(user, 'Falcon', 'Move to another dashboard');
      await user.click(await screen.findByRole('button', { name: 'Reading' }));

      expect(panelsOnScreen()).toEqual(['Notes']);
      expect(drawn().panels.find((one) => one.id === FALCON)?.dashboardId).toBe(READING.id);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(waitingFor()).toEqual(['move_panel_to_dashboard']);
    });
  });

  describe('a refused Panel change goes back and says why in the undo bar', () => {
    it('brings the old name back, with the server’s words, when the settings are refused', async () => {
      const user = await show(thePanels(), [inRows(FALCON, NOTES)]);
      await choose(user, 'Falcon', 'Settings…');
      const box = await screen.findByRole('textbox', { name: 'Name' });
      await user.clear(box);
      await user.type(box, 'Notes');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(panelsOnScreen()).toEqual(['Notes', 'Notes']);

      await answerNext();

      expect(panelsOnScreen()).toEqual(['Falcon', 'Notes']);
      expect(await screen.findByRole('status')).toHaveTextContent(
        'The settings of “Falcon” were not saved. a panel called Notes is already on this dashboard',
      );
    });

    it('brings a deleted Panel back where it was when the delete is refused', async () => {
      const user = await show(thePanels(), [inRows(FALCON, NOTES)]);
      await choose(user, 'Falcon', 'Delete');
      await user.click(await screen.findByRole('button', { name: 'Yes, delete Falcon' }));
      expect(panelsOnScreen()).toEqual(['Notes']);

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, 'That panel is locked.')));
      await settle();

      expect(panelsOnScreen()).toEqual(['Falcon', 'Notes']);
      expect(await screen.findByRole('status')).toHaveTextContent('“Falcon” was not deleted. That panel is locked.');
    });

    it('takes a new Panel away when the add is refused', async () => {
      const user = await show(thePanels(), [inRows(FALCON, NOTES)]);
      await addAPanel(user, 'Waiting on');
      // Another device took the name first.
      stored.panels.push(aPanel(OTHER, 'Waiting on'));

      await answerNext();

      expect(panelsOnScreen()).toEqual(['Falcon', 'Notes']);
      expect(await screen.findByRole('status')).toHaveTextContent('“Waiting on” was not added.');
    });
  });

  describe('arranging Panels reads the Workspace once', () => {
    it('draws the new arrangement at once, and reads once after the answer and none of its own', async () => {
      await show(thePanels(), [inRows(FALCON, NOTES)]);
      await settle();
      const before = reads();

      const handle = panel('Notes').querySelector('header')!;
      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, pointerType: 'mouse' });
      document.querySelectorAll('[data-panel-row]').forEach((row, index) => {
        row.getBoundingClientRect = () => ({ top: index * 122, bottom: index * 122 + 100, left: 0, right: 600 }) as DOMRect;
        row.querySelectorAll('[data-panel-cell]').forEach((cell) => {
          cell.getBoundingClientRect = () => ({ left: 0, right: 600 }) as DOMRect;
        });
      });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 1, clientY: 50 });
      // On the board itself, which holds the pointer: the Panel is drawn under another row once it is moved.
      fireEvent.pointerUp(document.querySelector('[data-panel-row]')!.parentElement!, { pointerId: 1, clientX: 1, clientY: 50 });

      await waitFor(() => expect(waitingFor()).toEqual(['save_layout']));
      expect(panelsOnScreen()).toEqual(['Notes', 'Falcon']);
      expect(reads()).toBe(before);

      await answerNext();

      expect(reads()).toBe(before + 1);
      expect(panelsOnScreen()).toEqual(['Notes', 'Falcon']);
    });
  });
});