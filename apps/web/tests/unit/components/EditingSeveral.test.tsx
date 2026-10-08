import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Dashboard, Filing, Item, ItemType, Panel, WorkspaceSnapshot } from '@cockpit/shared';
import { PanelBoard } from '../../../src/components/PanelBoard';
import { ItemList } from '../../../src/components/ItemList';
import { UndoWhatJustHappened } from '../../../src/undo';
import { useCommand, useSendCommand, type CommandArgs } from '../../../src/api/queries';

/**
 * F1: the Edit menu on the selection bar as the person sees it - what each
 * field reads, what a run looks like while it goes, and that the selection is
 * still held afterwards. Which commands a choice sends, and what Undo sends, is
 * decided in tests/unit/bulkEdit.test.ts; that the menus open and choose under
 * a real pointer is the walk in tests/e2e/selecting.test.ts.
 */

vi.mock('@tanstack/react-router', async () => ({
  ...(await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')),
  useNavigate: () => vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../src/api/queries', async () => {
  const actual = await vi.importActual<typeof import('../../../src/api/queries')>('../../../src/api/queries');
  return { ...actual, useCommand: vi.fn(), useSendCommand: vi.fn() };
});

const DASHBOARD: Dashboard = { id: 'today', tenantId: 'tenant', workspaceId: 'ws-work', name: 'Today' };

function aPanel(id: string, name: string): Panel {
  return {
    id,
    tenantId: 'tenant',
    dashboardId: DASHBOARD.id,
    name,
    kind: 'items',
    format: 'plain',
    body: '',
    readOnly: false,
    neverPropose: false,
    filter: null,
    sort: null,
  } as Panel;
}

function anItem(id: string, title: string, over: Partial<Item> = {}): Item {
  return {
    id,
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    workspaceDecided: true,
    source: 'internal',
    title,
    typeId: null,
    completedAt: null,
    startedAt: null,
    priority: null,
    dueDate: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-31T08:00:00.000Z',
    updatedAt: '2026-08-31T08:00:00.000Z',
    ...over,
  } as Item;
}

const filedOn = (panelId: string, itemId: string, position = 0): Filing =>
  ({ id: `${panelId}-${itemId}`, tenantId: 'tenant', panelId, itemId, position }) as Filing;

const BART = anItem('11111111-1111-7111-8111-000000000001', 'Reply to Bart', { priority: 'high' });
const RENEW = anItem('11111111-1111-7111-8111-000000000002', 'Renew the licence', { priority: 'high' });
const CHASE = anItem('11111111-1111-7111-8111-000000000003', 'Chase the invoice');
const INBOXED = anItem('11111111-1111-7111-8111-000000000004', 'File the receipts');
const ANOTHER = anItem('11111111-1111-7111-8111-000000000005', 'Call the bank');

const FALCON = aPanel('falcon', 'Project Falcon');
const READING = aPanel('reading', 'To read');
const TYPES = [{ id: 'task', name: 'Task' }] as unknown as ItemType[];

interface World {
  items: Item[];
  filings: Filing[];
  inbox?: Item[];
}

let client: QueryClient;
let world: World;
let view: ReturnType<typeof render>;
/** Every change sent, and a way to hold each one until the test lets it land. */
let sent: CommandArgs[];
let landing: (() => void)[];
let holding: boolean;

function snapshotOf(now: World): WorkspaceSnapshot {
  return {
    workspace: { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' },
    items: [...now.items, ...(now.inbox ?? [])],
    dashboards: [DASHBOARD],
    panels: [FALCON, READING],
    layouts: [],
    associations: [],
    attachments: [],
    itemTypes: TYPES,
    itemFormPresentation: 'centered',
    duplicates: [],
    filings: now.filings,
    agents: [],
    hiddenAgents: [],
    hasClaudeCodeConnection: false,
    agentRuns: [],
    claudeCodeFailing: null,
    generatedAt: '2026-08-31T09:00:00.000Z',
  } as unknown as WorkspaceSnapshot;
}

function screenFor(now: World) {
  return (
    <QueryClientProvider client={client}>
      <UndoWhatJustHappened>
        <PanelBoard
          workspaceId="ws-work"
          dashboard={DASHBOARD}
          dashboards={[DASHBOARD]}
          panels={[FALCON, READING]}
          panelsInWorkspace={[FALCON, READING]}
          layouts={[]}
          items={now.items}
          attachments={[]}
          agentRuns={[]}
          filings={now.filings}
          itemTypes={TYPES}
        />
        {now.inbox && (
          <ItemList workspaceId="ws-work" items={now.inbox} openDashboardId={DASHBOARD.id} emptyMessage="Nothing to deal with." />
        )}
      </UndoWhatJustHappened>
    </QueryClientProvider>
  );
}

function show(now: World, options: { hold?: boolean } = {}) {
  world = now;
  sent = [];
  landing = [];
  holding = options.hold ?? false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['snapshot', 'ws-work'], snapshotOf(now));
  vi.mocked(useCommand).mockReturnValue({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null, variables: undefined } as never);
  vi.mocked(useSendCommand).mockReturnValue((args: CommandArgs) => {
    sent.push(args);
    if (!holding) return Promise.resolve({ applied: true } as never);
    return new Promise((resolve) => landing.push(() => resolve({ applied: true } as never)));
  });
  view = render(screenFor(now));
  return userEvent.setup();
}

function nextSnapshot(changes: Partial<World>) {
  world = { ...world, ...changes };
  act(() => client.setQueryData(['snapshot', 'ws-work'], snapshotOf(world)));
  view.rerender(screenFor(world));
}

async function tick(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.keyboard('{Control>}');
  await user.click(screen.getByText(title));
  await user.keyboard('{/Control}');
}

/**
 * Opens Edit ▾ and then one field's submenu, by keyboard: a pointer moving onto
 * a submenu is not reproducible in jsdom, which has no layout for Radix's
 * pointer-grace area to measure, so the pointer is the browser walk's
 * (tests/e2e/selecting.test.ts).
 */
async function openField(user: ReturnType<typeof userEvent.setup>, field: string) {
  await user.click(screen.getByRole('button', { name: 'Edit ▾' }));
  (await screen.findByRole('menuitem', { name: new RegExp(`^${field}`) })).focus();
  await user.keyboard('{ArrowRight}');
  await screen.findAllByRole('menuitemradio');
}

/** Opens a field's submenu and chooses one of its options. */
async function choose(user: ReturnType<typeof userEvent.setup>, field: string, option: string) {
  await openField(user, field);
  const options = screen.getAllByRole('menuitemradio').map((o) => o.textContent?.replace('✓', ''));
  for (let step = 0; step < options.indexOf(option); step += 1) await user.keyboard('{ArrowDown}');
  await user.keyboard('{Enter}');
}

const TWO_PANELS: World = {
  items: [BART, RENEW, CHASE],
  filings: [filedOn('falcon', BART.id), filedOn('reading', RENEW.id), filedOn('reading', CHASE.id, 1)],
};

beforeEach(() => {
  localStorage.clear();
});

describe('Selection', () => {
  describe('Edit names the value every picked Item shares, or Mixed, and ticks the shared one', () => {
    it('reads High and ticks it when the picked Items are all High', async () => {
      const user = show(TWO_PANELS);
      await tick(user, BART.title);
      await tick(user, RENEW.title);

      await openField(user, 'Priority');

      expect(screen.getByRole('menuitem', { name: /^Priority/ })).toHaveTextContent('High');
      expect(await screen.findByRole('menuitemradio', { name: 'High' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('menuitemradio', { name: 'Low' })).toHaveAttribute('aria-checked', 'false');
    });

    it('reads Mixed and ticks nothing when they differ', async () => {
      const user = show(TWO_PANELS);
      await tick(user, BART.title);
      await tick(user, CHASE.title);

      await openField(user, 'Priority');

      expect(screen.getByRole('menuitem', { name: /^Priority/ })).toHaveTextContent('Mixed');
      for (const option of await screen.findAllByRole('menuitemradio')) {
        expect(option).toHaveAttribute('aria-checked', 'false');
      }
    });
  });

  describe('while a run is going the bar counts it and holds back new work; afterwards the selection is still held', () => {
    it('reads Saving 2 of 3… with Move to… and Edit unavailable, then leaves the same Items picked', async () => {
      const user = show({ ...TWO_PANELS, items: [CHASE, anItem('a', 'A'), anItem('b', 'B')], filings: [filedOn('falcon', CHASE.id), filedOn('falcon', 'a', 1), filedOn('reading', 'b')] }, { hold: true });
      await tick(user, CHASE.title);
      await tick(user, 'A');
      await tick(user, 'B');
      await choose(user, 'Priority', 'High');

      expect(await screen.findByText('Saving 1 of 3…')).toBeVisible();
      await act(async () => landing.shift()!());
      expect(await screen.findByText('Saving 2 of 3…')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Move to…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Edit ▾' })).toBeDisabled();

      await act(async () => landing.shift()!());
      await act(async () => landing.shift()!());

      expect(await screen.findByText('3 selected')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Edit ▾' })).toBeEnabled();
      expect(sent.map((c) => c.name)).toEqual(['set_priority', 'set_priority', 'set_priority']);
    });

    it('lets a second field be set straight after the first', async () => {
      const user = show(TWO_PANELS);
      await tick(user, CHASE.title);
      await choose(user, 'Priority', 'High');
      expect(await screen.findByText('1 selected')).toBeVisible();

      await choose(user, 'Status', 'In progress');

      expect(sent.map((c) => c.name)).toEqual(['set_priority', 'set_started']);
    });

    it('stands the undo offer aside while Edit is open, and brings it back when it closes', async () => {
      const user = show(TWO_PANELS);
      await tick(user, CHASE.title);
      await choose(user, 'Priority', 'High');
      const offer = await screen.findByRole('status');
      expect(offer).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Edit ▾' }));
      expect(document.documentElement).toHaveAttribute('data-editing-several');

      await user.keyboard('{Escape}');
      expect(document.documentElement).not.toHaveAttribute('data-editing-several');
    });

    it('offers one Undo for the run, and says which Items were not changed', async () => {
      const user = show(TWO_PANELS);
      await tick(user, BART.title);
      await tick(user, CHASE.title);

      await choose(user, 'Priority', 'High');

      // BART already holds High, so only CHASE changes.
      expect(await screen.findByText('Priority set to High on “Chase the invoice”')).toBeVisible();
      expect(sent).toHaveLength(1);
    });

    it('takes an Item set to Done out of the selection and leaves the rest picked', async () => {
      const user = show(TWO_PANELS);
      await tick(user, BART.title);
      await tick(user, CHASE.title);
      await choose(user, 'Status', 'Done');
      expect(sent.map((c) => c.name)).toEqual(['set_done', 'set_done']);

      // What the server then holds: BART finished, so no Panel shows it.
      nextSnapshot({
        items: [{ ...BART, completedAt: '2026-08-31T09:00:00.000Z' }, RENEW, CHASE],
      });

      expect(await screen.findByText('1 selected')).toBeVisible();
    });
  });

  describe('the Inbox’s bar offers the same Edit', () => {
    it('sets High on each Item picked in the Inbox', async () => {
      const user = show({ ...TWO_PANELS, inbox: [INBOXED, ANOTHER] });
      await tick(user, INBOXED.title);
      await tick(user, ANOTHER.title);

      await choose(user, 'Priority', 'High');

      expect(sent.map((c) => [c.name, (c.payload as { itemId: string }).itemId])).toEqual([
        ['set_priority', INBOXED.id],
        ['set_priority', ANOTHER.id],
      ]);
      expect(within(document.body).getByText('2 selected')).toBeVisible();
    });
  });
});
