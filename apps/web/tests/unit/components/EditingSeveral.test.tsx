import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentRun, Dashboard, Filing, Item, Panel, WorkspaceSnapshot } from '@cockpit/shared';
import { PanelBoard } from '../../../src/components/PanelBoard';
import { ItemList } from '../../../src/components/ItemList';
import { UndoWhatJustHappened } from '../../../src/undo';
import { CommandRefused } from '../../../src/api/client';
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

interface World {
  items: Item[];
  filings: Filing[];
  inbox?: Item[];
  runs?: AgentRun[];
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
    itemFormPresentation: 'centered',
    followUpDays: 3,
    duplicates: [],
    filings: now.filings,
    agentRuns: now.runs ?? [],
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
        />
        {now.inbox && (
          <ItemList workspaceId="ws-work" items={now.inbox} openDashboardId={DASHBOARD.id} emptyMessage="Nothing to deal with." />
        )}
      </UndoWhatJustHappened>
    </QueryClientProvider>
  );
}

function show(now: World, options: { hold?: boolean; refusing?: string } = {}) {
  world = now;
  sent = [];
  landing = [];
  holding = options.hold ?? false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['snapshot', 'ws-work'], snapshotOf(now));
  vi.mocked(useCommand).mockReturnValue({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null, variables: undefined } as never);
  vi.mocked(useSendCommand).mockReturnValue((args: CommandArgs) => {
    sent.push(args);
    if (options.refusing && (args.payload as { itemId: string }).itemId === options.refusing) {
      return Promise.reject(new CommandRefused(409, 'That item is locked.'));
    }
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
    it('offers Priority, Due and Status, then End Claude run and Add as child of…, and no Type, though the workspace has one', async () => {
      const user = show(TWO_PANELS);
      await tick(user, BART.title);
      await tick(user, RENEW.title);

      await user.click(screen.getByRole('button', { name: 'Edit ▾' }));

      const fields = (await screen.findAllByRole('menuitem')).map((item) => item.textContent?.split(' ')[0]);
      expect(fields).toEqual(['Priority', 'Due', 'Status', 'End', 'Add']);
    });

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

    it('reads Waiting for reply when the picked Items all wait, though it offers no such choice', async () => {
      const waiting = { waitingSince: '2026-08-31T08:00:00.000Z' };
      const user = show({ ...TWO_PANELS, items: [{ ...BART, ...waiting }, { ...RENEW, ...waiting }, CHASE] });
      await tick(user, BART.title);
      await tick(user, RENEW.title);

      await openField(user, 'Status');

      expect(screen.getByRole('menuitem', { name: /^Status/ })).toHaveTextContent('Waiting for reply');
    });
  });

  describe('End Claude run ends the run of each picked Item that has one', () => {
    const run = (itemId: string, id: string) => ({ id, itemId, stage: 'ready', destination: 'code' }) as unknown as AgentRun;

    it('sends one end for each picked Item with a run, and none for the rest', async () => {
      const user = show({ ...TWO_PANELS, runs: [run(BART.id, 'run-bart'), run(CHASE.id, 'run-chase')] });
      await tick(user, BART.title);
      await tick(user, RENEW.title);
      await tick(user, CHASE.title);

      await user.click(screen.getByRole('button', { name: 'Edit ▾' }));
      await user.click(await screen.findByRole('menuitem', { name: 'End Claude run' }));

      await waitFor(() => expect(sent).toHaveLength(2));
      expect(sent.map((one) => [one.name, (one.payload as { runId: string }).runId])).toEqual([
        ['end_claude_run', 'run-bart'],
        ['end_claude_run', 'run-chase'],
      ]);
    });

    it('stays on the menu but unavailable, saying none has a Claude run, where no picked Item has one', async () => {
      const user = show({ ...TWO_PANELS, runs: [run(CHASE.id, 'run-chase')] });
      await tick(user, BART.title);
      await tick(user, RENEW.title);

      await user.click(screen.getByRole('button', { name: 'Edit ▾' }));

      const entry = await screen.findByRole('menuitem', { name: /End Claude run/ });
      expect(entry).toHaveAttribute('aria-disabled', 'true');
      expect(entry).toHaveTextContent('None of them has a Claude run');
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
      await tick(user, RENEW.title);
      await choose(user, 'Priority', 'High');
      expect(await screen.findByText('2 selected')).toBeVisible();

      await choose(user, 'Status', 'In progress');

      expect(sent.map((c) => c.name)).toEqual(['set_priority', 'set_started', 'set_started']);
    });

    it('stands the undo offer aside while Edit is open, and brings it back when it closes', async () => {
      const user = show(TWO_PANELS);
      await tick(user, CHASE.title);
      await tick(user, RENEW.title);
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

      await waitFor(() => expect(screen.queryByText('2 selected')).toBeNull());
      expect(screen.getByText(CHASE.title).closest('li')).toHaveClass('row-picked');
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
  describe('Dismiss, last on the bar, asks first and sends nothing until Dismiss is pressed', () => {
    const THREE: World = {
      items: [BART, RENEW, CHASE],
      filings: [filedOn('falcon', BART.id), filedOn('falcon', RENEW.id, 1), filedOn('reading', CHASE.id)],
    };

    async function pickAllThree(user: ReturnType<typeof userEvent.setup>) {
      await tick(user, BART.title);
      await tick(user, RENEW.title);
      await tick(user, CHASE.title);
    }

    it('sits after Move to…, Edit ▾ and Clear', async () => {
      const user = show(THREE);
      await pickAllThree(user);

      const bar = screen.getByRole('button', { name: 'Move to…' }).parentElement!;

      expect([...bar.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
        'Move to…',
        'Edit ▾',
        'Clear',
        'Dismiss',
      ]);
    });

    it('asks Dismiss 3 items? with Cancel then Dismiss, and sends nothing', async () => {
      const user = show(THREE);
      await pickAllThree(user);

      await user.click(screen.getByRole('button', { name: 'Dismiss' }));

      const question = await screen.findByRole('alertdialog');
      expect(within(question).getByText('Dismiss 3 items?')).toBeVisible();
      expect(within(question).getAllByRole('button').map((button) => button.textContent)).toEqual(['Cancel', 'Dismiss']);
      expect(within(question).getByRole('button', { name: 'Dismiss 3 items' })).toBeVisible();
      expect(sent).toHaveLength(0);
    });

    it.each([
      { how: 'Cancel', close: (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Cancel' })) },
      { how: 'Escape', close: (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}') },
    ])('closes on $how with nothing sent and the three still picked', async ({ close }) => {
      const user = show(THREE);
      await pickAllThree(user);
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      await screen.findByRole('alertdialog');

      await close(user);

      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(sent).toHaveLength(0);
      expect(screen.getByText('3 selected')).toBeVisible();
    });

    it('starts the run on Dismiss: one set_dismissed each in list order, the bar counting it with Move to…, Edit and Dismiss unavailable', async () => {
      const user = show(THREE, { hold: true });
      await pickAllThree(user);
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Dismiss 3 items' }));

      expect(sent.map((c) => [c.name, (c.payload as { itemId: string }).itemId])).toEqual([
        ['set_dismissed', BART.id],
        ['set_dismissed', RENEW.id],
        ['set_dismissed', CHASE.id],
      ]);
      expect(await screen.findByText('Dismissing 1 of 3…')).toBeVisible();
      await act(async () => landing.shift()!());
      expect(await screen.findByText('Dismissing 2 of 3…')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Move to…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Edit ▾' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled();

      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(sent).toHaveLength(3);

      await act(async () => landing.shift()!());
      await act(async () => landing.shift()!());
    });

    it('says how many were dismissed in the undo bar, whose one Undo undismisses them', async () => {
      const user = show(THREE);
      await pickAllThree(user);
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Dismiss 3 items' }));

      expect(await screen.findByText('3 items dismissed')).toBeVisible();
      sent.length = 0;
      await user.click(screen.getByRole('button', { name: 'Undo' }));

      await waitFor(() => expect(sent).toHaveLength(3));
      expect(sent.map((c) => [c.name, (c.payload as { dismissed: boolean }).dismissed])).toEqual([
        ['set_dismissed', false],
        ['set_dismissed', false],
        ['set_dismissed', false],
      ]);
    });

    it('sends in the order the Panels show the rows, not the order they were picked in', async () => {
      const user = show(THREE);
      await tick(user, CHASE.title);
      await tick(user, BART.title);
      await tick(user, RENEW.title);
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Dismiss 3 items' }));

      expect(sent.map((c) => (c.payload as { itemId: string }).itemId)).toEqual([BART.id, RENEW.id, CHASE.id]);
    });

    it('puts the focus on the Dashboard’s board once the question closes, the Dismiss button being unavailable for the run', async () => {
      const user = show(THREE, { hold: true });
      await pickAllThree(user);
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Dismiss 3 items' }));

      await waitFor(() => expect(document.activeElement).toHaveAttribute('data-selection-home'));
      await act(async () => landing.splice(0).forEach((land) => land()));
    });

    it('carries on past a refused Item, says how many were not dismissed and why, and keeps the other two undoable', async () => {
      const user = show(THREE, { refusing: RENEW.id });
      await pickAllThree(user);
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Dismiss 3 items' }));

      expect(await screen.findByText('1 not dismissed. That item is locked.')).toBeVisible();
      expect(sent).toHaveLength(3);
      // Corrected to what was dismissed once the answers are in, and the refused Item is the one still picked.
      expect(await screen.findByText('2 items dismissed')).toBeVisible();
      expect(screen.getByText('1 selected')).toBeVisible();
      expect(screen.getByText(RENEW.title).closest('li')).toHaveClass('row-picked');
    });

    it('says nothing of a refusal once the selection has been cleared, when one of its Items is picked on its own again', async () => {
      const user = show(THREE, { refusing: RENEW.id });
      await pickAllThree(user);
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Dismiss 3 items' }));
      expect(await screen.findByText('1 not dismissed. That item is locked.')).toBeVisible();

      await user.click(screen.getByRole('button', { name: 'Clear' }));
      await user.click(screen.getByText(RENEW.title));

      expect(screen.queryByText(/not dismissed/)).toBeNull();
      expect(screen.queryByText(/ selected$/)).toBeNull();
    });

    it('offers no Undo when every Item was refused', async () => {
      const user = show({ ...THREE, items: [BART, RENEW], filings: THREE.filings.slice(0, 2) });
      await tick(user, RENEW.title);
      await tick(user, BART.title);
      vi.mocked(useSendCommand).mockReturnValue((args: CommandArgs) => {
        sent.push(args);
        return Promise.reject(new CommandRefused(409, 'That item is locked.'));
      });
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Dismiss 2 items' }));

      expect(await screen.findByText('2 not dismissed. That item is locked.')).toBeVisible();
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull());
    });

    it('offers the same Dismiss on the Inbox’s bar', async () => {
      const user = show({ ...THREE, inbox: [INBOXED, ANOTHER] });
      await tick(user, INBOXED.title);
      await tick(user, ANOTHER.title);

      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(within(await screen.findByRole('alertdialog')).getByText('Dismiss 2 items?')).toBeVisible();
      await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Dismiss 2 items' }));

      await waitFor(() => expect(sent.map((c) => [c.name, (c.payload as { itemId: string }).itemId])).toEqual([
        ['set_dismissed', INBOXED.id],
        ['set_dismissed', ANOTHER.id],
      ]));
    });
  });

});
