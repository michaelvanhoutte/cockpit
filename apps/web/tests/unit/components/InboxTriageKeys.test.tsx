import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, type QueryClient as Client } from '@tanstack/react-query';
import type { Dashboard, Filing, Item, Panel, WorkspaceSnapshot } from '@cockpit/shared';
import { InboxPanel } from '../../../src/components/InboxPanel';
import { OpensItemForms } from '../../../src/itemForm';
import { CommandRefused } from '../../../src/api/client';
import { UndoWhatJustHappened } from '../../../src/undo';

/**
 * F1: the keys that act on the focused Inbox row ("Act on the focused Inbox row
 * with one key, and move on", issue 1111) and the command each one sends. What
 * the commands do to the Item is the filing, Done and dismissal suites'; here
 * a change that lands is played into the snapshot, so a row leaves the Inbox the
 * way it does once the server has answered.
 */
type Sent = { name: string; payload: Record<string, unknown> };
const held = vi.hoisted(() => ({
  items: [] as Item[],
  filings: [] as Filing[],
  dashboards: [] as Dashboard[],
  panels: [] as Panel[],
  sent: [] as unknown[],
  client: null as Client | null,
  apply: (_command: unknown): void => {},
  navigate: vi.fn((_args?: unknown) => Promise.resolve()),
}));

vi.mock('@tanstack/react-router', async () => ({
  ...(await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')),
  useNavigate: () => held.navigate,
  useSearch: () => ({}),
}));

vi.mock('../../../src/api/queries', () => ({
  useCommand: () => ({
    mutate: (command: unknown, options?: { onSuccess?: () => void }) => {
      held.sent.push(command);
      held.apply(command);
      options?.onSuccess?.();
    },
    reset: () => {},
    isPending: false,
    error: null,
  }),
  useSendCommand: () => (command: unknown) => {
    held.sent.push(command);
    held.apply(command);
    return Promise.resolve();
  },
  useStartAgent: () => ({ mutateAsync: () => Promise.resolve() }),
  workspacesQuery: { queryKey: ['workspaces'], queryFn: () => Promise.resolve({ workspaces: [] }) },
  useLatestSnapshot: () => () => Promise.resolve({ filings: [] }),
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: (): Promise<WorkspaceSnapshot> => Promise.resolve(snapshot()),
  }),
}));

function snapshot(): WorkspaceSnapshot {
  return {
    workspace: { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' },
    items: held.items,
    dashboards: held.dashboards,
    panels: held.panels,
    layouts: [],
    associations: [],
    attachments: [],
    itemFormPresentation: 'centered',
    duplicates: [],
    filings: held.filings,
    agents: [],
    hiddenAgents: [],
    hasClaudeCodeConnection: false,
    agentRuns: [],
    claudeCodeFailing: null,
    generatedAt: '2026-08-31T09:00:00.000Z',
  } as WorkspaceSnapshot;
}

/** What the server's answer does to the snapshot, played in as the re-read would find it. */
const gone = new Map<string, Item>();
function play(command: unknown) {
  const { name, payload } = command as Sent;
  const id = payload.itemId as string;
  if ((name === 'set_done' && payload.done) || (name === 'set_dismissed' && payload.dismissed)) {
    gone.set(id, held.items.find((item) => item.id === id)!);
    held.items = held.items.filter((item) => item.id !== id);
  } else if (name === 'set_done' || name === 'set_dismissed') {
    held.items = [...held.items, gone.get(id)!];
  } else if (name === 'move_item_to_panel') {
    held.filings = held.filings.filter((filing) => filing.itemId !== id);
    if (payload.panelId) held.filings = [...held.filings, { panelId: payload.panelId as string, itemId: id, position: 0 }];
  }
  held.client?.setQueryData(['snapshot', 'ws-work'], snapshot());
}

let nextItem = 0;
function anItem(title: string, proposedPanelId: string | null = null): Item {
  return {
    id: `11111111-1111-7111-8111-${String(nextItem++).padStart(12, '0')}`,
    tenantId: 'tenant',
    workspaceId: 'ws-work',
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
    proposedPanelId,
    proposedPanelReason: proposedPanelId ? 'It reads like Falcon work' : null,
    proposedPanelFit: null,
    sourceResolvedAt: null,
    nextAction: null,
    completedAt: null,
    startedAt: null,
    priority: null,
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

const TODAY: Dashboard = { id: 'd-today', tenantId: 'tenant', workspaceId: 'ws-work', name: 'Today' };
const FALCON: Panel = { id: 'p-falcon', tenantId: 'tenant', dashboardId: TODAY.id, name: 'Falcon', kind: 'items', format: 'plain', body: '', readOnly: false, neverPropose: false, filter: null, sort: null };

const HARBOR: Panel = { ...FALCON, id: 'p-harbor', name: 'Harbor' };

const rowOfTitle = (title: string) => screen.getByText(title).closest<HTMLElement>('[data-item-row]')!;
const idOf = (title: string) => rowOfTitle(title).getAttribute('data-item-id')!;
const sent = () => held.sent as Sent[];

async function showInbox(items: Item[]) {
  held.items = items;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  held.client = client;
  render(
    <QueryClientProvider client={client}>
      <OpensItemForms>
        <UndoWhatJustHappened>
          <InboxPanel workspaceId="ws-work" />
        </UndoWhatJustHappened>
      </OpensItemForms>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  return userEvent.setup();
}

// Fetched on the first key in the app; here beforehand, so a key is read within the press rather than whenever the load finishes.
beforeAll(() => import('../../../src/inboxTriage'));

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  held.filings = [];
  held.dashboards = [TODAY];
  held.panels = [FALCON, HARBOR];
  held.sent = [];
  held.apply = play;
  gone.clear();
  held.navigate = vi.fn((_args?: unknown) => Promise.resolve());
});
afterEach(() => vi.unstubAllGlobals());

describe('Triage', () => {
  describe('one key acts on the focused Inbox row, and the focus moves on to the next', () => {
    it.each([
      { situation: 'Enter on a row with a proposal files it there', key: '{Enter}', name: 'move_item_to_panel', panel: FALCON.id },
      { situation: 'D marks it Done', key: 'd', name: 'set_done' },
      { situation: 'X dismisses it', key: 'x', name: 'set_dismissed' },
    ])('$situation, and the next row is focused', async ({ key, name, panel }) => {
      const user = await showInbox([anItem('First'), anItem('Second', FALCON.id), anItem('Third')]);
      act(() => rowOfTitle('Second').focus());
      const second = idOf('Second');

      await user.keyboard(key);

      await waitFor(() => expect(sent()).toHaveLength(1));
      expect(sent()[0]).toMatchObject({ name, payload: { itemId: second, ...(panel ? { panelId: panel } : {}) } });
      await waitFor(() => expect(screen.queryByText('Second')).toBeNull());
      await waitFor(() => expect(rowOfTitle('Third')).toHaveFocus());
    });

    it('focuses the new last row when the last one was acted on', async () => {
      const user = await showInbox([anItem('First'), anItem('Second')]);
      act(() => rowOfTitle('Second').focus());

      await user.keyboard('d');

      await waitFor(() => expect(rowOfTitle('First')).toHaveFocus());
    });

    it('has the docked form follow to the row it moves on to', async () => {
      const user = await showInbox([anItem('First'), anItem('Second')]);
      act(() => rowOfTitle('First').focus());

      await user.keyboard('d');

      await waitFor(() => expect(rowOfTitle('Second')).toHaveFocus());
      const { search, replace } = held.navigate.mock.calls.at(-1)![0] as { search: (was: object) => object; replace: boolean };
      expect(replace).toBe(true);
      expect(search({})).toEqual({ item: idOf('Second') });
    });
    it('says there is no proposal, files nothing, and keeps the focus where Enter on a row with none is pressed', async () => {
      const user = await showInbox([anItem('First'), anItem('Second')]);
      act(() => rowOfTitle('First').focus());

      await user.keyboard('{Enter}');

      expect(await screen.findByRole('alert')).toHaveTextContent('No Panel was proposed');
      expect(sent()).toHaveLength(0);
      expect(rowOfTitle('First')).toHaveFocus();
    });

    it('files on the Panel chosen after M, then focuses the next row', async () => {
      const user = await showInbox([anItem('First'), anItem('Second')]);
      act(() => rowOfTitle('First').focus());

      const first = idOf('First');
      await user.keyboard('m');
      const picker = await screen.findByRole('dialog');
      expect(sent()).toHaveLength(0);
      await user.click(within(picker).getByRole('button', { name: 'Falcon' }));

      expect(sent()[0]).toMatchObject({ name: 'move_item_to_panel', payload: { itemId: first, panelId: FALCON.id } });
      await waitFor(() => expect(rowOfTitle('Second')).toHaveFocus());
    });

    it('files nothing and keeps the focus on the row when the picker opened by M is closed with Escape', async () => {
      const user = await showInbox([anItem('First'), anItem('Second')]);
      act(() => rowOfTitle('First').focus());

      await user.keyboard('m');
      await screen.findByRole('dialog');
      await user.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(sent()).toHaveLength(0);
      expect(rowOfTitle('First')).toHaveFocus();
    });

    it('adds no keys on a phone, where Enter still opens the Item', async () => {
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
      const user = await showInbox([anItem('First', FALCON.id)]);
      act(() => rowOfTitle('First').focus());

      await user.keyboard('d');
      await user.keyboard('{Enter}');

      expect(sent()).toHaveLength(0);
      expect(held.navigate).toHaveBeenCalled();
    });
  });

  describe('Z puts the last change back from the keyboard', () => {
    it('brings the Item back into the Inbox and focuses it', async () => {
      const user = await showInbox([anItem('First'), anItem('Second', FALCON.id), anItem('Third')]);
      act(() => rowOfTitle('Second').focus());
      await user.keyboard('{Enter}');
      await waitFor(() => expect(rowOfTitle('Third')).toHaveFocus());

      await user.keyboard('z');

      await waitFor(() => expect(rowOfTitle('Second')).toHaveFocus());
      expect(sent()[1]).toMatchObject({ name: 'move_item_to_panel', payload: { itemId: idOf('Second'), panelId: null } });
    });

    it('does nothing with nothing to undo', async () => {
      const user = await showInbox([anItem('First')]);
      act(() => rowOfTitle('First').focus());

      await user.keyboard('z');

      expect(sent()).toHaveLength(0);
      expect(rowOfTitle('First')).toHaveFocus();
    });
  });

  describe('O opens the Item in the Inbox, and Enter no longer does', () => {
    it('O opens the form of the focused row', async () => {
      const user = await showInbox([anItem('First'), anItem('Second')]);
      act(() => rowOfTitle('Second').focus());

      await user.keyboard('o');

      expect(held.navigate).toHaveBeenCalledOnce();
      const { search } = held.navigate.mock.calls[0]![0] as { search: (was: object) => object };
      expect(search({})).toEqual({ item: idOf('Second') });
    });
  });

  describe('Ctrl+Enter is not a triage key', () => {
    it('still opens the focused Inbox row and files nothing', async () => {
      const user = await showInbox([anItem('First'), anItem('Second')]);
      act(() => rowOfTitle('Second').focus());

      await user.keyboard('{Control>}{Enter}{/Control}');

      await waitFor(() => expect(held.navigate).toHaveBeenCalledOnce());
      expect(held.sent).toEqual([]);
    });
  });

  describe('the keys are shown where their actions live', () => {
    it('names M, D, X and O in the row menu', async () => {
      const user = await showInbox([anItem('First')]);

      await user.click(screen.getByRole('button', { name: 'Item actions' }));

      const menu = await screen.findByRole('menu');
      for (const [entry, key] of [['Open', 'O'], ['Move to…', 'M'], ['Dismiss', 'X']] as const) {
        expect(within(menu).getByRole('menuitem', { name: entry })).toHaveAttribute('data-key', key);
      }
      await user.click(within(menu).getByRole('menuitem', { name: /Status/ }));
      expect(await screen.findByRole('menuitemradio', { name: 'Done' })).toHaveAttribute('data-key', 'D');
    });

    it("names Enter in the proposal chip's hover", async () => {
      await showInbox([anItem('First', FALCON.id)]);

      expect(screen.getByRole('button', { name: /Falcon/ })).toHaveAttribute('title', expect.stringContaining('Enter'));
    });
  });
});

describe('Selection', () => {
  const selectedCount = () => screen.queryByText(/^\d+ selected$/)?.textContent ?? null;

  describe('Shift with J and K extends the selection from the focused row', () => {
    it('grows by a row with each Shift+J, shrinks with Shift+K, and ends with a plain J', async () => {
      const user = await showInbox([anItem('A'), anItem('B'), anItem('C'), anItem('D')]);
      act(() => rowOfTitle('A').focus());

      await user.keyboard('{Shift>}J{/Shift}');
      await user.keyboard('{Shift>}J{/Shift}');
      expect(selectedCount()).toBe('3 selected');
      expect(rowOfTitle('C')).toHaveFocus();

      await user.keyboard('{Shift>}K{/Shift}');
      expect(selectedCount()).toBe('2 selected');
      expect(rowOfTitle('B')).toHaveFocus();

      await user.keyboard('j');
      expect(selectedCount()).toBeNull();
      expect(rowOfTitle('C')).toHaveFocus();
    });

    it('extends with Shift+ArrowDown the same way', async () => {
      const user = await showInbox([anItem('A'), anItem('B')]);
      act(() => rowOfTitle('A').focus());

      await user.keyboard('{Shift>}{ArrowDown}{/Shift}');

      expect(selectedCount()).toBe('2 selected');
    });
  });

  describe('Enter files each selected Item on its own proposed Panel', () => {
    const select = async (user: Awaited<ReturnType<typeof showInbox>>, from: string, rows: number) => {
      act(() => rowOfTitle(from).focus());
      for (let at = 1; at < rows; at++) await user.keyboard('{Shift>}J{/Shift}');
    };
    const moves = () => sent().filter((command) => command.name === 'move_item_to_panel');

    it('files the selection, not the focused row alone, when Enter comes before the selection has been extended', async () => {
      await showInbox([anItem('A', FALCON.id), anItem('B', HARBOR.id), anItem('C')]);
      act(() => rowOfTitle('A').focus());

      // All within one task: none of the extensions has been applied when Enter is pressed.
      act(() => {
        for (const key of ['J', 'J']) fireEvent.keyDown(document.activeElement!, { key, shiftKey: true });
        fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
      });

      await waitFor(() => expect(moves()).toHaveLength(2));
      expect(screen.queryByText('No Panel was proposed. M moves it.')).toBeNull();
      expect(await screen.findByRole('status')).toHaveTextContent('2 items moved to their proposed Panels, 1 had no proposal');
    });

    it('sends one filing per Item, each to its own proposal', async () => {
      const user = await showInbox([anItem('A', FALCON.id), anItem('B', HARBOR.id), anItem('C', FALCON.id)]);
      await select(user, 'A', 3);
      const [a, b, c] = ['A', 'B', 'C'].map(idOf);

      await user.keyboard('{Enter}');

      await waitFor(() => expect(moves()).toHaveLength(3));
      expect(moves().map((m) => [m.payload.itemId, m.payload.panelId])).toEqual([
        [a, FALCON.id],
        [b, HARBOR.id],
        [c, FALCON.id],
      ]);
      expect(await screen.findByRole('status')).toHaveTextContent('3 items moved');
    });

    it('leaves an Item with no proposal where it is, and the bar says how many had none', async () => {
      const user = await showInbox([anItem('A', FALCON.id), anItem('B'), anItem('C', HARBOR.id)]);
      await select(user, 'A', 3);

      await user.keyboard('{Enter}');

      await waitFor(() => expect(moves()).toHaveLength(2));
      expect(screen.getByText('B')).toBeInTheDocument();
      expect(await screen.findByRole('status')).toHaveTextContent('2 items moved to their proposed Panels, 1 had no proposal');
      expect(selectedCount()).toBe('1 selected');
    });

    it('keeps the title of the one moved Item, and says how many had none after it', async () => {
      const user = await showInbox([anItem('A', FALCON.id), anItem('B'), anItem('C')]);
      await select(user, 'A', 3);

      await user.keyboard('{Enter}');

      expect(await screen.findByRole('status')).toHaveTextContent('“A” moved to Falcon, 2 had no proposal');
    });

    it('moves nothing and names the refusal when the only filing is refused', async () => {
      const user = await showInbox([anItem('A', FALCON.id), anItem('B')]);
      await select(user, 'A', 2);
      held.apply = () => {
        throw new CommandRefused(404, 'That Panel no longer exists.');
      };

      await user.keyboard('{Enter}');

      const bar = await screen.findByRole('status');
      expect(bar).toHaveTextContent('1 had no proposal, “A” was refused: That Panel no longer exists.');
      expect(within(bar).queryByRole('button', { name: 'Undo' })).toBeNull();
    });

    it('moves nothing when none has a proposal, and says so', async () => {
      const user = await showInbox([anItem('A'), anItem('B')]);
      await select(user, 'A', 2);

      await user.keyboard('{Enter}');

      expect(await screen.findByRole('status')).toHaveTextContent('Neither of the 2 selected had a proposed Panel');
      expect(sent()).toHaveLength(0);
      expect(selectedCount()).toBe('2 selected');
    });

    it('is taken back whole by Undo on the bar', async () => {
      const user = await showInbox([anItem('A', FALCON.id), anItem('B', HARBOR.id)]);
      await select(user, 'A', 2);
      await user.keyboard('{Enter}');
      await waitFor(() => expect(moves()).toHaveLength(2));

      await user.click(await screen.findByRole('button', { name: 'Undo' }));

      await waitFor(() => expect(moves()).toHaveLength(4));
      expect(moves().slice(2).map((m) => [m.payload.itemId, m.payload.panelId])).toEqual([
        [idOf('A'), null],
        [idOf('B'), null],
      ]);
    });

    it('keeps the others filed and names the one refused when a filing is refused partway', async () => {
      const user = await showInbox([anItem('A', FALCON.id), anItem('B', HARBOR.id), anItem('C', FALCON.id)]);
      await select(user, 'A', 3);
      const refused = idOf('B');
      const was = held.apply;
      held.apply = (command) => {
        if ((command as Sent).payload.itemId === refused) throw new CommandRefused(404, 'That Panel no longer exists.');
        was(command);
      };

      await user.keyboard('{Enter}');

      await waitFor(() => expect(moves()).toHaveLength(3));
      expect(await screen.findByRole('status')).toHaveTextContent('2 items moved to Falcon');
      expect(screen.getByRole('status')).toHaveTextContent('“B” was refused: That Panel no longer exists.');
      expect(screen.getByText('B')).toBeInTheDocument();
    });

    it('leaves Enter on a single row with no selection filing just that row', async () => {
      const user = await showInbox([anItem('A', FALCON.id), anItem('B', FALCON.id)]);
      act(() => rowOfTitle('A').focus());

      await user.keyboard('{Enter}');

      await waitFor(() => expect(moves()).toHaveLength(1));
    });
  });
});
