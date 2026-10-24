import 'fake-indexeddb/auto';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { itemsOnPanel } from '@cockpit/shared';
import type { CommandResult, Dashboard, Filing, Item, Panel, WorkspaceSnapshot } from '@cockpit/shared';
import { changes } from '../../../src/api/changes';
import { CommandRefused, fetchSnapshot, fetchWorkspaces, sendCommand } from '../../../src/api/client';
import { useSnapshot } from '../../../src/api/useSnapshot';
import { InboxPanel } from '../../../src/components/InboxPanel';
import { ItemForm } from '../../../src/components/ItemForm';
import { ItemList } from '../../../src/components/ItemList';
import { resetStanding } from '../../../src/offline';
import { UndoWhatJustHappened } from '../../../src/undo';

/**
 * Filing an Item as each surface does it, with the server holding the answer -
 * the frontend-with-its-own-backend level (F2), run in this runner as
 * `ChangesAtOnce.test.tsx` is. The screens are the app's own, the queries and
 * the tab's queue are real, and only the network is replaced: a server that
 * answers when the test says, keeps the Panels it is told to, and refuses an
 * order that is not the Panel's, as the real one does. What a filing draws is
 * tests/unit/drawnAhead.test.ts and the order changes are sent in is
 * tests/unit/changeQueue.test.ts; what is asked here is that every sender is
 * wired to them, and builds its order without a read first.
 */

const opened = vi.hoisted(() => ({ item: undefined as string | undefined, close: vi.fn() }));

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  fetchSnapshot: vi.fn(),
  fetchWorkspaces: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => ({
  ...(await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')),
  useNavigate: () => vi.fn(() => Promise.resolve()),
  useParams: () => ({ workspaceId: 'ws-work' }),
}));

vi.mock('../../../src/itemForm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/itemForm')>()),
  useReportDocked: () => () => {},
  useQuietOpening: () => () => false,
  useSettleQuietOpening: () => () => {},
  useItemForm: () => ({ openItemId: opened.item, close: opened.close }),
  useOpenItem: () => (itemId: string) => {
    opened.item = itemId;
  },
}));

vi.mock('../../../src/description/RichDescription', () => ({
  default: function FakeRichDescription({ initial, editable }: { initial: string; editable: boolean }) {
    const [value, setValue] = useState(initial);
    return <textarea aria-label="Description" disabled={!editable} value={value} onChange={(e) => setValue(e.target.value)} />;
  },
}));

function anItem(id: string, title: string, over: Partial<Item> = {}): Item {
  return {
    id,
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    workspaceDecided: true,
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    capturedMessage: null,
    capturedTimeZone: null,
    title,
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
    priority: null,
    prioritySetAt: null,
    dueDate: null,
    dueDateSetAt: null,
    dueDateChosenAt: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-10-19T08:00:00.000Z',
    updatedAt: '2026-10-19T08:00:00.000Z',
    ...over,
  };
}

function aPanel(id: string, name: string): Panel {
  return {
    id,
    tenantId: 'tenant',
    dashboardId: 'd-today',
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

const TODAY: Dashboard = { id: 'd-today', tenantId: 'tenant', workspaceId: 'ws-work', name: 'Today' } as Dashboard;
const BART = 'item-bart';
const LISA = 'item-lisa';
const MAGGIE = 'item-maggie';
const TITLES: Record<string, string> = { [BART]: 'Reply to Bart', [LISA]: 'Reply to Lisa', [MAGGIE]: 'Reply to Maggie' };
const REFUSED_AS_STALE = 'this panel changed while you were looking at it: try the move again';

/** What the server holds. A filing changes it only when the test lets the server answer. */
let stored: { items: Item[]; filings: Filing[]; panels: Panel[] };

/** How the Item form is presented, which decides whether a Panel chip is written at once or held for Save. */
let presentation: 'docked' | 'centered';

/** Every change the server has been sent and not yet answered, oldest first. */
let waiting: { name: string; payload: Record<string, unknown>; answer: () => void; refuse: (error: Error) => void }[];

const heldOn = (panelId: string) =>
  stored.filings
    .filter((filing) => filing.panelId === panelId)
    .sort((a, b) => a.position - b.position)
    .map((filing) => filing.itemId);

/** What the server does with a filing it accepts, and when it refuses one: an order that is not the Panel's. */
function keep(name: string, payload: Record<string, unknown>) {
  const itemId = payload.itemId as string;
  const panelId = payload.panelId as string | null;
  if (name === 'add_panel') {
    stored.panels.push({ ...aPanel(panelId!, payload.name as string) });
    return;
  }
  // As the real server refuses a filing that names a Panel it does not have.
  if (panelId !== null && !stored.panels.some((one) => one.id === panelId)) {
    throw new CommandRefused(404, 'that panel does not exist');
  }
  if (name === 'remove_item_from_panel') {
    stored.filings = stored.filings.filter((f) => !(f.itemId === itemId && f.panelId === panelId));
    return;
  }
  if (panelId !== null) {
    const order = payload.order as string[];
    const expected = new Set([...heldOn(panelId), itemId]);
    if (order.length !== expected.size || !order.every((id) => expected.has(id))) {
      throw new CommandRefused(409, REFUSED_AS_STALE);
    }
  }
  if (name === 'move_item_to_panel') stored.filings = stored.filings.filter((f) => f.itemId !== itemId);
  if (panelId !== null) {
    stored.filings = [
      ...stored.filings.filter((f) => f.panelId !== panelId),
      ...(payload.order as string[]).map((id, position) => ({ panelId, itemId: id, position })),
    ];
  }
}

function theWorkspace(): WorkspaceSnapshot {
  return {
    workspace: { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' },
    items: stored.items,
    dashboards: [TODAY],
    panels: stored.panels,
    layouts: [],
    associations: [],
    attachments: [],
    itemFormPresentation: presentation,
    followUpDays: 3,
    duplicates: [],
    filings: stored.filings,
    agentRuns: [],
    generatedAt: '2026-10-20T09:00:00.000Z',
  } as unknown as WorkspaceSnapshot;
}

let client: QueryClient;

/** A Panel's contents as the board draws them: the rows the drawn Workspace files there. */
function PanelContents({ panelId, name }: { panelId: string; name: string }) {
  const { data } = useSnapshot('ws-work');
  return (
    <section aria-label={name}>
      <ItemList
        workspaceId="ws-work"
        items={itemsOnPanel(data?.items ?? [], data?.filings ?? [], panelId)}
        openDashboardId={TODAY.id}
        panelId={panelId}
        emptyMessage="Nothing here."
      />
    </section>
  );
}

/** Every Panel of the drawn Workspace, as the board draws them. */
function Board() {
  const { data } = useSnapshot('ws-work');
  return (
    <>
      {(data?.panels ?? []).map((one) => (
        <PanelContents key={one.id} panelId={one.id} name={one.name} />
      ))}
    </>
  );
}

function aScreen() {
  return (
    <QueryClientProvider client={client}>
      <UndoWhatJustHappened>
        <InboxPanel workspaceId="ws-work" />
        <Board />
        <ItemForm />
      </UndoWhatJustHappened>
    </QueryClientProvider>
  );
}

async function show(
  items: Item[],
  filings: Filing[] = [],
  options: { openItem?: string; presentation?: 'docked' | 'centered' } = {},
) {
  presentation = options.presentation ?? 'docked';
  stored = { items, filings, panels: [aPanel('p-falcon', 'Falcon'), aPanel('p-anna', 'Anna')] };
  opened.item = options.openItem;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(aScreen());
  await waitFor(() => expect(client.getQueryData(['snapshot', 'ws-work'])).toBeDefined());
  return userEvent.setup();
}

const inboxRows = () => within(document.querySelector<HTMLElement>('[data-inbox]')!);
const panel = (name: string) => within(screen.getByRole('region', { name }));
const titlesIn = (name: string) => within(screen.getByRole('region', { name })).queryAllByRole('listitem').map((row) => row.textContent);
const filed = (...ids: string[]) => ids.map((id, position) => ({ panelId: 'p-falcon', itemId: id, position }));

/** Lets what the app does between an answer and the next request, and the read behind it, happen. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

/** The server answers the oldest change it is holding. */
async function answerNext() {
  await act(async () => waiting.shift()!.answer());
  await settle();
}

beforeEach(() => {
  localStorage.clear();
  resetStanding();
  waiting = [];
  vi.mocked(fetchSnapshot).mockReset();
  vi.mocked(fetchSnapshot).mockImplementation(async () => structuredClone(theWorkspace()));
  vi.mocked(fetchWorkspaces).mockImplementation(async () => ({ workspaces: [theWorkspace().workspace] }) as never);
  vi.mocked(sendCommand).mockReset();
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

async function openRowMenu(user: ReturnType<typeof userEvent.setup>, where: 'inbox' | string, entry: string, title?: string) {
  const scope = where === 'inbox' ? inboxRows() : panel(where);
  const row = title ? scope.getByText(title).closest('li')! : null;
  await user.click((row ? within(row) : scope).getAllByLabelText('Item actions')[0]!);
  await user.click(await screen.findByRole('menuitem', { name: entry }));
}

async function chooseInThePicker(user: ReturnType<typeof userEvent.setup>, name: string) {
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name }));
}

async function tick(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.keyboard('{Control>}');
  await user.click(screen.getByText(title));
  await user.keyboard('{/Control}');
}

const forms = () => within(document.querySelector<HTMLElement>('[data-docked-form]') ?? document.body);

/** Makes a Panel on Today from the + beside its heading in Move to…, which moves the Item onto it. */
async function makeAPanelInMoveTo(user: ReturnType<typeof userEvent.setup>, name: string) {
  const dialog = within(await screen.findByRole('dialog'));
  await user.click(dialog.getByRole('button', { name: 'Add a panel to Today' }));
  await user.type(dialog.getByRole('textbox', { name: /^Name of the new panel/ }), name);
  await user.click(dialog.getByRole('button', { name: 'Add & move' }));
}

/** Makes a Panel from the last option of the Item form's File on search, which files the Item on it. */
async function makeAPanelInTheForm(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(forms().getByRole('textbox', { name: 'Find a Panel to file on' }));
  await user.type(await forms().findByRole('searchbox', { name: 'Find a Panel to file on' }), name);
  await user.click(await forms().findByRole('button', { name: new RegExp(`^\\+ New panel “${name}”`) }));
}

/** The Panel as the board draws it, even under a modal form, which hides the board from the accessibility tree. */
const onTheBoard = (name: string) => screen.queryByRole('region', { name, hidden: true });
const sentSoFar = () => vi.mocked(sendCommand).mock.calls.map(([name]) => name);

describe('Panels', () => {
  describe('a filing shows the moment it is made, with the server still holding the answer', () => {
    it('takes the row off the Panel it was on and puts it first on the one chosen in Move to…', async () => {
      const user = await show(
        [anItem(BART, TITLES[BART]!), anItem(MAGGIE, TITLES[MAGGIE]!)],
        [...filed(BART), { panelId: 'p-anna', itemId: MAGGIE, position: 0 }],
      );

      await openRowMenu(user, 'Falcon', 'Move to…');
      await chooseInThePicker(user, 'Anna');

      expect(titlesIn('Falcon')).toEqual([]);
      expect(titlesIn('Anna')).toEqual([expect.stringContaining('Reply to Bart'), expect.stringContaining('Reply to Maggie')]);
      expect(waiting.map((request) => request.name)).toEqual(['move_item_to_panel']);
    });

    it('puts the row back in the Inbox when Remove from this panel takes it off its only Panel', async () => {
      const user = await show([anItem(BART, TITLES[BART]!)], filed(BART));
      expect(inboxRows().queryByText('Reply to Bart')).toBeNull();

      await openRowMenu(user, 'Falcon', 'Remove from this panel');

      expect(inboxRows().getByText('Reply to Bart')).toBeVisible();
      expect(titlesIn('Falcon')).toEqual([]);
      expect(waiting.map((request) => request.name)).toEqual(['remove_item_from_panel']);
    });

    it('shows the row on both Panels when Also show on… adds it to a second', async () => {
      const user = await show([anItem(BART, TITLES[BART]!)], filed(BART));

      await openRowMenu(user, 'Falcon', 'Also show on…');
      await chooseInThePicker(user, 'Anna');

      expect(titlesIn('Falcon')).toEqual([expect.stringContaining('Reply to Bart')]);
      expect(titlesIn('Anna')).toEqual([expect.stringContaining('Reply to Bart')]);
      expect(waiting.map((request) => request.name)).toEqual(['add_item_to_panel']);
    });

    it('takes the chip and the row off a Panel when the docked form’s ✕ is pressed on one of two', async () => {
      const user = await show(
        [anItem(BART, TITLES[BART]!)],
        [...filed(BART), { panelId: 'p-anna', itemId: BART, position: 0 }],
        { openItem: BART },
      );
      await waitFor(() => expect(forms().getByRole('button', { name: 'Remove from Anna' })).toBeVisible());

      await user.click(forms().getByRole('button', { name: 'Remove from Anna' }));

      expect(forms().queryByRole('button', { name: 'Remove from Anna' })).toBeNull();
      expect(forms().getByRole('button', { name: 'Remove from Falcon' })).toBeVisible();
      expect(titlesIn('Anna')).toEqual([]);
      expect(titlesIn('Falcon')).toHaveLength(1);
      expect(waiting.map((request) => request.name)).toEqual(['remove_item_from_panel']);
    });

    it('draws a new chip when Add another Panel… is chosen in the docked form', async () => {
      const user = await show([anItem(BART, TITLES[BART]!)], filed(BART), { openItem: BART });
      await waitFor(() => expect(forms().getByRole('button', { name: 'Remove from Falcon' })).toBeVisible());

      await user.click(forms().getByRole('textbox', { name: 'Find a Panel to file on' }));
      await forms().findByRole('searchbox', { name: 'Find a Panel to file on' });
      await user.click(await forms().findByRole('button', { name: /^Anna/ }));

      expect(forms().getByRole('button', { name: 'Remove from Anna' })).toBeVisible();
      expect(titlesIn('Anna')).toHaveLength(1);
      expect(waiting.map((request) => request.name)).toEqual(['add_item_to_panel']);
    });

    it('moves every row of a selection when the bar’s Move to… is chosen', async () => {
      const user = await show([anItem(BART, TITLES[BART]!), anItem(LISA, TITLES[LISA]!)]);
      await tick(user, 'Reply to Bart');
      await tick(user, 'Reply to Lisa');

      await user.click(screen.getByRole('button', { name: 'Move to…' }));
      await chooseInThePicker(user, 'Falcon');

      // Handed over together, before the server has answered the first.
      await waitFor(() => expect(titlesIn('Falcon')).toHaveLength(2));
      expect(inboxRows().queryByText('Reply to Bart')).toBeNull();
      expect(inboxRows().queryByText('Reply to Lisa')).toBeNull();
      expect(waiting.map((request) => request.name)).toEqual(['move_item_to_panel']);
      await answerNext();
      expect(waiting.map((request) => request.name)).toEqual(['move_item_to_panel']);
    });

    it('files an Inbox row where Cockpit proposed when the proposal is accepted', async () => {
      const user = await show([anItem(BART, TITLES[BART]!, { proposedPanelId: 'p-falcon', proposedPanelReason: 'a Falcon question' })]);

      await user.click(screen.getByRole('button', { name: /^Today ▸ Falcon/ }));

      expect(inboxRows().queryByText('Reply to Bart')).toBeNull();
      expect(titlesIn('Falcon')).toHaveLength(1);
    });

    it('puts a removed row back in its place when Undo is pressed, before the removal has been answered', async () => {
      const user = await show(
        [anItem(BART, TITLES[BART]!), anItem(MAGGIE, TITLES[MAGGIE]!)],
        filed(MAGGIE, BART),
      );
      await openRowMenu(user, 'Falcon', 'Remove from this panel', 'Reply to Bart');
      expect(titlesIn('Falcon')).toEqual([expect.stringContaining('Reply to Maggie')]);

      await user.click(await screen.findByRole('button', { name: 'Undo' }));

      expect(titlesIn('Falcon')).toEqual([expect.stringContaining('Reply to Maggie'), expect.stringContaining('Reply to Bart')]);
      expect(inboxRows().queryByText('Reply to Bart')).toBeNull();
      // Waiting its turn behind the removal it reverses.
      expect(waiting.map((request) => request.name)).toEqual(['remove_item_from_panel']);
      await answerNext();
      await waitFor(() => expect(waiting.map((request) => request.name)).toEqual(['add_item_to_panel']));
    });
  });
  describe('a Panel made to file on shows with the Item on it the moment it is made, with the server still holding the answer', () => {
    it('draws the new Panel with the row on it, and closes the question, when Move to… makes one', async () => {
      const user = await show([anItem(BART, TITLES[BART]!)]);

      await openRowMenu(user, 'inbox', 'Move to…');
      await makeAPanelInMoveTo(user, 'Waiting on');

      expect(titlesIn('Waiting on')).toEqual([expect.stringContaining('Reply to Bart')]);
      expect(inboxRows().queryByText('Reply to Bart')).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
      // The filing waits its turn behind the Panel.
      expect(waiting.map((request) => request.name)).toEqual(['add_panel']);
      await answerNext();
      await waitFor(() => expect(waiting.map((request) => request.name)).toEqual(['move_item_to_panel']));
      await answerNext();
      expect(heldOn(stored.panels.find((one) => one.name === 'Waiting on')!.id)).toEqual([BART]);
    });

    it('draws the new Panel with every picked row on it when the bar’s Move to… makes one', async () => {
      const user = await show([anItem(BART, TITLES[BART]!), anItem(LISA, TITLES[LISA]!)]);
      await tick(user, 'Reply to Bart');
      await tick(user, 'Reply to Lisa');

      await user.click(screen.getByRole('button', { name: 'Move to…' }));
      await makeAPanelInMoveTo(user, 'Waiting on');

      await waitFor(() => expect(titlesIn('Waiting on')).toHaveLength(2));
      expect(inboxRows().queryByText('Reply to Bart')).toBeNull();
      expect(inboxRows().queryByText('Reply to Lisa')).toBeNull();
      expect(waiting.map((request) => request.name)).toEqual(['add_panel']);
    });

    it('draws the chip and the new Panel with the row on it when the docked form’s File on makes one', async () => {
      const user = await show([anItem(BART, TITLES[BART]!)], [], { openItem: BART });
      await waitFor(() => expect(forms().getByRole('textbox', { name: 'Find a Panel to file on' })).toBeVisible());

      await makeAPanelInTheForm(user, 'Waiting on');

      expect(forms().getByRole('button', { name: 'Remove from Waiting on' })).toBeVisible();
      expect(titlesIn('Waiting on')).toEqual([expect.stringContaining('Reply to Bart')]);
      expect(waiting.map((request) => request.name)).toEqual(['add_panel']);
      await answerNext();
      await waitFor(() => expect(waiting.map((request) => request.name)).toEqual(['add_item_to_panel']));
    });

    it('draws the new Panel and the chip, but holds the filing for Save, when the form is not docked', async () => {
      const user = await show([anItem(BART, TITLES[BART]!)], [], { openItem: BART, presentation: 'centered' });
      await waitFor(() => expect(forms().getByRole('textbox', { name: 'Find a Panel to file on' })).toBeVisible());

      await makeAPanelInTheForm(user, 'Waiting on');

      expect(forms().getByRole('button', { name: 'Remove from Waiting on' })).toBeVisible();
      expect(onTheBoard('Waiting on')).not.toBeNull();
      expect(waiting.map((request) => request.name)).toEqual(['add_panel']);
    });
  });

  describe('a filing is sent without reading the Workspace first, unless the copy is marked out of date', () => {
    it('sends a docked ✕ with no read in between while announcements keep the copy current', async () => {
      const user = await show([anItem(BART, TITLES[BART]!)], filed(BART), { openItem: BART });
      await waitFor(() => expect(forms().getByRole('button', { name: 'Remove from Falcon' })).toBeVisible());
      await settle();
      const reads = vi.mocked(fetchSnapshot).mock.calls.length;

      await user.click(forms().getByRole('button', { name: 'Remove from Falcon' }));

      expect(waiting.map((request) => request.name)).toEqual(['remove_item_from_panel']);
      expect(vi.mocked(fetchSnapshot).mock.calls.length).toBe(reads);
    });

    it('reads once, and then sends, when the copy was marked out of date by a change elsewhere', async () => {
      const user = await show([anItem(BART, TITLES[BART]!)], filed(BART), { openItem: BART });
      await waitFor(() => expect(forms().getByRole('button', { name: 'Remove from Falcon' })).toBeVisible());
      await settle();
      const reads = vi.mocked(fetchSnapshot).mock.calls.length;
      // What an announcement of another device's change, or a reconnect, leaves behind.
      await act(async () => void (await client.invalidateQueries({ queryKey: ['snapshot', 'ws-work'], refetchType: 'none' })));

      await user.click(forms().getByRole('button', { name: 'Remove from Falcon' }));
      await waitFor(() => expect(waiting).toHaveLength(1));

      expect(vi.mocked(fetchSnapshot).mock.calls.length).toBe(reads + 1);
      expect(waiting.map((request) => request.name)).toEqual(['remove_item_from_panel']);
    });
  });

  describe('a filing built on one still unanswered includes it', () => {
    it('lands both of two quick moves onto the same Panel, the second’s order naming the first', async () => {
      const user = await show([anItem(BART, TITLES[BART]!), anItem(LISA, TITLES[LISA]!)]);

      await openRowMenu(user, 'inbox', 'Move to…');
      await chooseInThePicker(user, 'Falcon');
      await openRowMenu(user, 'inbox', 'Move to…');
      await chooseInThePicker(user, 'Falcon');

      expect(titlesIn('Falcon')).toHaveLength(2);
      await answerNext();
      expect(waiting.map((request) => request.payload.order)).toEqual([expect.arrayContaining([BART, LISA])]);
      await answerNext();

      expect(heldOn('p-falcon').sort()).toEqual([BART, LISA].sort());
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('takes both chips away at once and lands both removals when ✕ is pressed twice in a row', async () => {
      const user = await show(
        [anItem(BART, TITLES[BART]!)],
        [...filed(BART), { panelId: 'p-anna', itemId: BART, position: 0 }],
        { openItem: BART },
      );
      await waitFor(() => expect(forms().getByRole('button', { name: 'Remove from Falcon' })).toBeVisible());

      await user.click(forms().getByRole('button', { name: 'Remove from Falcon' }));
      await user.click(forms().getByRole('button', { name: 'Remove from Anna' }));

      expect(forms().queryByRole('button', { name: 'Remove from Falcon' })).toBeNull();
      expect(forms().queryByRole('button', { name: 'Remove from Anna' })).toBeNull();
      await waitFor(() => expect(waiting).toHaveLength(1));
      await answerNext();
      await waitFor(() => expect(waiting).toHaveLength(1));
      await answerNext();

      expect(stored.filings).toEqual([]);
    });
  });

  describe('a Panel made to file on that is refused takes the filing back with it, and the undo bar says why once', () => {
    const LOCKED = 'That dashboard is locked.';
    const saidOnce = async () => {
      expect(await screen.findByRole('status', { hidden: true })).toHaveTextContent(`The panel “Waiting on” was not added. ${LOCKED}`);
      expect(screen.queryByRole('alert', { hidden: true })).toBeNull();
      // The filing was never sent to be refused as well.
      expect(sentSoFar()).toEqual(['add_panel']);
    };

    it('leaves the row in the Inbox, with no Panel, when Move to… made it', async () => {
      const user = await show([anItem(BART, TITLES[BART]!)]);
      await openRowMenu(user, 'inbox', 'Move to…');
      await makeAPanelInMoveTo(user, 'Waiting on');
      expect(titlesIn('Waiting on')).toHaveLength(1);

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, LOCKED)));
      await settle();

      expect(onTheBoard('Waiting on')).toBeNull();
      expect(inboxRows().getByText('Reply to Bart')).toBeVisible();
      await saidOnce();
    });

    it('leaves every picked row in the Inbox, and picked, when the bar’s Move to… made it', async () => {
      const user = await show([anItem(BART, TITLES[BART]!), anItem(LISA, TITLES[LISA]!)]);
      await tick(user, 'Reply to Bart');
      await tick(user, 'Reply to Lisa');
      await user.click(screen.getByRole('button', { name: 'Move to…' }));
      await makeAPanelInMoveTo(user, 'Waiting on');
      await waitFor(() => expect(titlesIn('Waiting on')).toHaveLength(2));

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, LOCKED)));
      await settle();

      expect(onTheBoard('Waiting on')).toBeNull();
      expect(inboxRows().getByText('Reply to Bart')).toBeVisible();
      expect(inboxRows().getByText('Reply to Lisa')).toBeVisible();
      await saidOnce();
    });

    it('takes the chip and the Panel away, with the row still in the Inbox, when the docked form’s File on made it', async () => {
      const user = await show([anItem(BART, TITLES[BART]!)], [], { openItem: BART });
      await waitFor(() => expect(forms().getByRole('textbox', { name: 'Find a Panel to file on' })).toBeVisible());
      await makeAPanelInTheForm(user, 'Waiting on');
      expect(forms().getByRole('button', { name: 'Remove from Waiting on' })).toBeVisible();

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, LOCKED)));
      await settle();

      expect(forms().queryByRole('button', { name: 'Remove from Waiting on' })).toBeNull();
      expect(onTheBoard('Waiting on')).toBeNull();
      expect(inboxRows().getByText('Reply to Bart')).toBeVisible();
      await saidOnce();
    });

    it('takes the held chip away, and the Panel, when the form that is not docked made it', async () => {
      const user = await show([anItem(BART, TITLES[BART]!)], [], { openItem: BART, presentation: 'centered' });
      await waitFor(() => expect(forms().getByRole('textbox', { name: 'Find a Panel to file on' })).toBeVisible());
      await makeAPanelInTheForm(user, 'Waiting on');
      expect(forms().getByRole('button', { name: 'Remove from Waiting on' })).toBeVisible();

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, LOCKED)));
      await settle();

      expect(forms().queryByRole('button', { name: 'Remove from Waiting on' })).toBeNull();
      expect(onTheBoard('Waiting on')).toBeNull();
      await saidOnce();
    });
  });

  describe('a refused filing goes back and says why', () => {
    it('puts the row back in the Inbox with the server’s words when the Panel changed on another device', async () => {
      const user = await show([anItem(BART, TITLES[BART]!), anItem(MAGGIE, TITLES[MAGGIE]!)]);
      await openRowMenu(user, 'inbox', 'Move to…');
      await chooseInThePicker(user, 'Falcon');
      expect(inboxRows().queryByText('Reply to Bart')).toBeNull();
      // Another device files Maggie there before this one's answer arrives.
      stored.filings = filed(MAGGIE);

      await answerNext();

      expect(await screen.findByRole('alert')).toHaveTextContent(REFUSED_AS_STALE);
      expect(inboxRows().getByText('Reply to Bart')).toBeVisible();
      expect(titlesIn('Falcon')).toEqual([]);
    });

    it('puts the chip back and says why under the field when a docked ✕ is refused', async () => {
      const user = await show([anItem(BART, TITLES[BART]!)], filed(BART), { openItem: BART });
      await waitFor(() => expect(forms().getByRole('button', { name: 'Remove from Falcon' })).toBeVisible());
      await user.click(forms().getByRole('button', { name: 'Remove from Falcon' }));
      expect(forms().queryByRole('button', { name: 'Remove from Falcon' })).toBeNull();

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, 'That item is locked.')));
      await settle();

      expect(forms().getByRole('button', { name: 'Remove from Falcon' })).toBeVisible();
      expect(forms().getByRole('alert')).toHaveTextContent('It was not taken off “Falcon”. That item is locked.');
    });
  });
});
