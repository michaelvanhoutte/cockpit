import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Dashboard, Filing, Item, Panel, WorkspaceSnapshot } from '@cockpit/shared';
import { CommandRefused } from '../../../src/api/client';
import { ITEM_BEING_DRAGGED } from '../../../src/dropAt';
import { ItemList } from '../../../src/components/ItemList';
import { UndoWhatJustHappened } from '../../../src/undo';

/**
 * F1: the picker and what choosing in it sends. What a move then does to a
 * panel and to the Inbox is a query, proved against a real store in
 * apps/api/tests/integration/http/panel-items.test.ts; what is asked here is
 * the wiring - that the right panels are offered, in the right order, and that
 * choosing one sends a move naming that panel and the order it lands in.
 */

const held = vi.hoisted(() => ({
  items: [] as Item[],
  filings: [] as Filing[],
  dashboards: [] as Dashboard[],
  panels: [] as Panel[],
  mutate: vi.fn(),
  send: vi.fn(() => Promise.resolve()),
  error: null as Error | null,
  variables: undefined as { payload?: { itemId?: string } } | undefined,
  /** What the next change is refused with, if anything. */
  refuses: null as Error | null,
  /** That a change is still going, which is what stops a question being closed. */
  pending: false,
}));

/**
 * A mutation, in the shape the real one has: a refusal it *holds* rather than
 * one the test hands out.
 *
 * Written with state because the alternative is choreography. `reset` only
 * matters through what it takes off the screen, and a mock that returned a
 * fixed error made that unobservable - the only thing left to assert was that
 * reset had been called, which is what the testing skill rules out.
 *
 * `held.refuses` is what a change is refused with, so a test can make the next
 * one fail the way the server would.
 */
vi.mock('../../../src/api/queries', async () => {
  const { useState } = await vi.importActual<typeof import('react')>('react');
  return {
    useCommand: () => {
      const [error, setError] = useState<Error | null>(held.error);
      return {
        mutate: (args: unknown, options?: unknown) => {
          if (held.refuses) setError(held.refuses);
          held.mutate(args, options);
        },
        reset: () => setError(null),
        isPending: held.pending,
        error,
        // What the real mutation carries: the last change asked for. A refusal
        // is attributed by it, so a mock without it would make every refusal
        // look like somebody else's.
        variables: held.variables,
      };
    },
    useSendCommand: () => held.send,
    snapshotQuery: (workspaceId: string) => ({
      queryKey: ['snapshot', workspaceId],
    queryFn: (): Promise<WorkspaceSnapshot> =>
      Promise.resolve({
        workspace: {
          id: workspaceId,
          tenantId: 'tenant',
          name: 'Work',
          color: '#6f62b5',
          bar: '#dbd7ee',
          ground: '#e3e1f2',
          header: '#d2cdea',
        },
        items: held.items,
        dashboards: held.dashboards,
        panels: held.panels,
        layouts: [],
        associations: [],
        itemTypes: [],
        filings: held.filings,
        generatedAt: '2026-08-31T09:00:00.000Z',
      } as WorkspaceSnapshot),
    }),
  };
});

function anItem(id: string, title: string): Item {
  return {
    id,
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    title,
    capturedMessage: null,
    description: null,
    sourceResolvedAt: null,
    typeId: null,
    nextAction: null,
    completedAt: null,
    priority: null,
    dueDate: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-31T08:00:00.000Z',
    updatedAt: '2026-08-31T08:00:00.000Z',
  };
}

const TODAY: Dashboard = { id: 'd-today', tenantId: 'tenant', workspaceId: 'ws-work', name: 'Today' };
const RESEARCH: Dashboard = {
  id: 'd-research',
  tenantId: 'tenant',
  workspaceId: 'ws-work',
  name: 'Research',
};

function aPanel(id: string, dashboardId: string, name: string): Panel {
  return { id, tenantId: 'tenant', dashboardId, name };
}

const BART = anItem('11111111-1111-7111-8111-000000000001', 'Reply to Bart');

/**
 * A captured item, which is what capture actually makes: no title, and the text
 * in the captured message. Every other fixture here has a title, and with one
 * the old `item.nextAction ?? item.title` and `itemLabel(item)` say the same
 * thing - so nothing else in this file can tell the two apart.
 */
const JUST_CAPTURED: Item = {
  ...anItem('11111111-1111-7111-8111-000000000009', ''),
  capturedMessage: 'Ask Novy about the part 11 tolerances',
};

/**
 * The box a drop is handled on: the rows and the empty message both sit inside
 * it, so it is one parent up from whichever of them is drawn.
 */
function theListBox(): HTMLElement {
  const rows = screen.queryByRole('list');
  return (rows ?? screen.getByText('Nothing to deal with.')).parentElement!;
}

/**
 * A row let go over the list.
 *
 * The snapshot has to have settled first: what a list can file is read from it,
 * and a drop against a list that has not read one yet finds no item and does
 * nothing at all - which reads exactly like the drop being refused.
 *
 * **The place cannot be aimed at here.** jsdom reports every rectangle as zero
 * and does not carry a pointer position through a drop event, so which gap a
 * position picks out is tests/unit/dropAt.test.ts's rule and the browser walk's.
 */
async function dropOnto(itemId: string, clientY = 1) {
  await act(async () => {});
  await act(async () => {});
  const dataTransfer = {
    types: [ITEM_BEING_DRAGGED],
    getData: (type: string) => (type === ITEM_BEING_DRAGGED ? itemId : ''),
    setData: vi.fn(),
    dropEffect: '',
  };
  fireEvent.dragOver(theListBox(), { dataTransfer, clientY });
  fireEvent.drop(theListBox(), { dataTransfer, clientY });
}

async function showList({
  items = [BART],
  openDashboardId = null as string | null,
  panelId = null as string | null,
}: { items?: Item[]; openDashboardId?: string | null; panelId?: string | null } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UndoWhatJustHappened>
        <ItemList
          workspaceId="ws-work"
          items={items}
          openDashboardId={openDashboardId}
          panelId={panelId}
          emptyMessage="Nothing to deal with."
        />
      </UndoWhatJustHappened>
    </QueryClientProvider>,
  );
  // **Waited for, not flushed.** What a list can file is read from the
  // snapshot, and a drop against a list that has not read one yet does nothing
  // at all - which reads exactly like the drop being refused. Asked of the
  // cache rather than of the screen, because an empty list draws nothing that
  // says the read has happened.
  await waitFor(() => expect(client.getQueryData(['snapshot', 'ws-work'])).toBeDefined());
  return userEvent.setup();
}

describe('Item editing', () => {
  describe('a dialog names an item the way its row does', () => {
    // The bug this holds: every dialog and undo offer read `title`, which
    // capture no longer writes, so each named a captured item as an empty pair
    // of quotation marks. Found in the browser, which is the only tier that
    // reads these dialogs - and this is the level that can hold it.
    it('names a captured item by what was captured, in the picker', async () => {
      const user = await showList({ items: [JUST_CAPTURED], openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);

      expect(dialog).toHaveTextContent('Ask Novy about the part 11 tolerances');
    });

    it('names it the same way in the offer to undo what just happened', async () => {
      // The offer waits for the change to land, which this file's mutation
      // never does by itself.
      held.mutate.mockImplementation((_args, options?: { onSuccess?: () => void }) =>
        options?.onSuccess?.(),
      );
      const user = await showList({ items: [JUST_CAPTURED], openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);
      await user.click(within(dialog).getByRole('button', { name: 'Falcon' }));

      expect(await screen.findByRole('status')).toHaveTextContent(
        'Ask Novy about the part 11 tolerances',
      );
    });
  });
});

/** Move to… lives in the row's own menu, so reaching the picker is two gestures. */
async function openThePicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Item actions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
  return screen.findByRole('dialog');
}

/** What the picker offers, top to bottom. */
function offered(dialog: HTMLElement): string[] {
  return within(dialog)
    .getAllByRole('button')
    .map((button) => button.textContent ?? '')
    .filter((label) => label !== 'Cancel');
}

beforeEach(() => {
  held.items = [BART];
  held.filings = [];
  held.dashboards = [TODAY, RESEARCH];
  held.panels = [
    aPanel('p-falcon', TODAY.id, 'Falcon'),
    aPanel('p-anna', TODAY.id, 'Anna'),
    aPanel('p-reading', RESEARCH.id, 'To read'),
  ];
  held.error = null;
  held.variables = { payload: { itemId: BART.id } };
  held.refuses = null;
  held.pending = false;
  held.mutate = vi.fn();
  held.send = vi.fn(() => Promise.resolve());
  localStorage.clear();
});

describe('Panels', () => {
  describe('moving an item offers every panel of the workspace, the dashboard you are on first', () => {
    it('puts the open dashboard’s panels above the other dashboards’', async () => {
      const user = await showList({ openDashboardId: RESEARCH.id });

      const dialog = await openThePicker(user);

      expect(offered(dialog)).toEqual(['Inboxstill to deal with', 'To read', 'Falcon', 'Anna']);
    });

    it('offers the Inbox as somewhere to put it back', async () => {
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);

      expect(within(dialog).getByRole('button', { name: /^Inbox/ })).toBeVisible();
    });

    it('offers the panels most recently filed into above the dashboards', async () => {
      localStorage.setItem('cockpit.recent-panels.ws-work', JSON.stringify(['p-reading', 'p-anna']));
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);

      // The recent two first, each saying which dashboard it is on, then every
      // dashboard in turn.
      expect(offered(dialog).slice(0, 3)).toEqual([
        'Inboxstill to deal with',
        'To readResearch',
        'AnnaToday',
      ]);
    });

    it('still opens for a workspace whose only dashboard has no panels', async () => {
      held.dashboards = [TODAY];
      held.panels = [];
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);

      expect(within(dialog).getByText('No panels yet.')).toBeVisible();
      expect(within(dialog).getByRole('button', { name: /^Inbox/ })).toBeVisible();
    });
  });

  describe('choosing where an item goes files it there, at the top of that panel', () => {
    it('sends the panel and the order it lands in', async () => {
      held.items = [BART, anItem('11111111-1111-7111-8111-000000000002', 'Renew the domain')];
      held.filings = [{ panelId: 'p-falcon', itemId: held.items[1]!.id, position: 0 }];
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);
      await user.click(within(dialog).getByRole('button', { name: 'Falcon' }));

      expect(held.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'move_item_to_panel',
          payload: expect.objectContaining({
            itemId: BART.id,
            panelId: 'p-falcon',
            order: [BART.id, held.items[1]!.id],
          }),
        }),
        expect.anything(),
      );
    });

    it('names the items the panel holds but does not draw, so the move is not refused', async () => {
      // The regression: the order was built from what the panel *draws*, which
      // leaves out an item that has been finished while its filing stays. The
      // server compares against every filing, so a panel that had ever held a
      // completed item refused everything filed onto it afterwards, for good.
      const finished = anItem('11111111-1111-7111-8111-000000000003', 'Already handled');
      finished.completedAt = '2026-08-31T09:00:00.000Z';
      held.items = [BART, finished];
      held.filings = [{ panelId: 'p-falcon', itemId: finished.id, position: 0 }];
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);
      await user.click(within(dialog).getByRole('button', { name: 'Falcon' }));

      // Both of them named. Which comes first is not the claim: a row the panel
      // does not draw has no place on the screen for anything to be moved above
      // or below, so where it sits among the held order says nothing a person
      // could see.
      expect(held.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            order: expect.arrayContaining([BART.id, finished.id]),
          }),
        }),
        expect.anything(),
      );
      expect(held.mutate.mock.calls[0]![0].payload.order).toHaveLength(2);
    });

    it('sends no order when it is being put back in the Inbox, which has none', async () => {
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);
      await user.click(within(dialog).getByRole('button', { name: /^Inbox/ }));

      expect(held.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ panelId: null, order: [] }),
        }),
        expect.anything(),
      );
    });

    it('remembers the panel once the move has happened, and not before', async () => {
      held.mutate = vi.fn((_args, options?: { onSuccess?: () => void }) => options?.onSuccess?.());
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);
      await user.click(within(dialog).getByRole('button', { name: 'Falcon' }));

      expect(JSON.parse(localStorage.getItem('cockpit.recent-panels.ws-work') ?? '[]')).toEqual([
        'p-falcon',
      ]);
    });

    it('takes the refusal away with the question it was shown on', async () => {
      // A refusal outlives the dialog it was shown in, and the list says one of
      // its own now — so cancelling used to leave the message stuck above the
      // rows with nothing to explain it.
      held.refuses = new CommandRefused(409, 'this panel changed while you were looking at it');
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);
      await user.click(within(dialog).getByRole('button', { name: 'Falcon' }));
      expect(await within(dialog).findByRole('alert')).toBeVisible();

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      // What the person ends up seeing: no message anywhere, rather than one
      // stuck above the rows with the dialog that explained it gone.
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('cannot be cancelled while a choice is still going', async () => {
      // Cancelling resets the change that is still running, so a move that goes
      // on to happen loses what follows it - the panel is not remembered as a
      // recent one, and no way back is offered.
      held.pending = true;
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);
      await user.click(within(dialog).getByRole('button', { name: 'Falcon' }));
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      expect(screen.getByRole('dialog')).toBeVisible();
    });

    it('sends nothing when the question is cancelled', async () => {
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      expect(held.mutate).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  describe('what just happened can be put back, until the offer runs out', () => {
    /** A move that really landed, which is what the offer of an undo waits for. */
    function movesFor(item: string) {
      held.mutate = vi.fn((_args, options?: { onSuccess?: () => void }) => options?.onSuccess?.());
      return item;
    }

    it.each([
      {
        situation: 'filed out of the Inbox',
        filings: [] as { panelId: string; itemId: string; position: number }[],
        putBack: { panelId: null, order: [] as string[] },
      },
      {
        situation: 'moved from another panel',
        filings: [{ panelId: 'p-anna', itemId: BART.id, position: 1 }],
        putBack: { panelId: 'p-anna', order: [BART.id] },
      },
    ])('offers it back to where it was, $situation', async ({ filings, putBack }) => {
      held.filings = filings;
      movesFor(BART.id);
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);
      await user.click(within(dialog).getByRole('button', { name: 'Falcon' }));
      expect(screen.getByRole('status')).toHaveTextContent('“Reply to Bart” moved to Falcon');
      await user.click(screen.getByRole('button', { name: 'Undo' }));

      expect(held.send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'move_item_to_panel',
          payload: expect.objectContaining({ itemId: BART.id, ...putBack }),
        }),
      );
    });

    it('puts it back on every panel it was on, not just the first', async () => {
      // A move takes the item off all of them, so an undo that named one would
      // lose the rest - which became possible the day an item could be on two
      // panels at once ("Ask whether to move an item to a panel or add it to
      // one", issue 142).
      const other = anItem('11111111-1111-7111-8111-000000000008', 'Renew the domain');
      held.items = [BART, other];
      held.filings = [
        { panelId: 'p-anna', itemId: BART.id, position: 0 },
        { panelId: 'p-reading', itemId: other.id, position: 0 },
        { panelId: 'p-reading', itemId: BART.id, position: 1 },
      ];
      movesFor(BART.id);
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);
      await user.click(within(dialog).getByRole('button', { name: 'Falcon' }));
      await user.click(screen.getByRole('button', { name: 'Undo' }));

      // The first as a move, which takes it off Falcon; the second as an add,
      // which leaves the first alone.
      expect(held.send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'move_item_to_panel',
          payload: expect.objectContaining({ panelId: 'p-anna', order: [BART.id] }),
        }),
      );
      expect(held.send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'add_item_to_panel',
          payload: expect.objectContaining({ panelId: 'p-reading', order: [other.id, BART.id] }),
        }),
      );
    });

    it('puts it back in the order the panel it left was in, not at the top of it', async () => {
      const other = anItem('11111111-1111-7111-8111-000000000004', 'Renew the domain');
      held.items = [BART, other];
      held.filings = [
        { panelId: 'p-anna', itemId: other.id, position: 0 },
        { panelId: 'p-anna', itemId: BART.id, position: 1 },
      ];
      movesFor(BART.id);
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);
      await user.click(within(dialog).getByRole('button', { name: 'Falcon' }));
      await user.click(screen.getByRole('button', { name: 'Undo' }));

      expect(held.send).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ panelId: 'p-anna', order: [other.id, BART.id] }),
        }),
      );
    });

    it('says the Inbox by name when that is where it went', async () => {
      movesFor(BART.id);
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);
      await user.click(within(dialog).getByRole('button', { name: /^Inbox/ }));

      expect(screen.getByRole('status')).toHaveTextContent('“Reply to Bart” moved to the Inbox');
    });
  });

  describe('a move that fails says why and leaves the item where it was', () => {
    it('keeps the question open with the server’s own words on it', async () => {
      held.refuses = new CommandRefused(
        409,
        'The order sent is not the order of that panel any more',
      );
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);
      await user.click(within(dialog).getByRole('button', { name: 'Falcon' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'The order sent is not the order of that panel any more',
      );
      expect(screen.getByText('Reply to Bart')).toBeVisible();
    });
  });

  describe('a list with nothing in it says so', () => {
    it('says what it is empty of rather than showing an empty box', async () => {
      await showList({ items: [] });

      expect(await screen.findByText('Nothing to deal with.')).toBeVisible();
    });
  });
});

describe('Panels', () => {
  describe('a dropped row is sent to the panel it was dropped on, in the place it was dropped', () => {
    /**
     * A row let go over the list, at a gap.
     *
     * **The place cannot be aimed at here.** jsdom reports every rectangle as
     * zero, so every row's middle is the same, and it does not carry a pointer
     * position through a drop event either. Which gap a position picks out is
     * tests/unit/dropAt.test.ts's rule and the browser walk's; what this asks
     * is that a drop reaches the right command with the right panel and the
     * right items in it, which is the wiring.
     */
    const dropOnTheList = dropOnto;

    it('files an item dropped onto a panel, naming that panel and the order', async () => {
      const other = anItem('11111111-1111-7111-8111-000000000005', 'Renew the domain');
      held.items = [BART, other];
      held.filings = [{ panelId: 'p-falcon', itemId: other.id, position: 0 }];
      await showList({ items: [other], openDashboardId: TODAY.id, panelId: 'p-falcon' });

      await dropOnTheList(BART.id);

      expect(held.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'move_item_to_panel',
          payload: expect.objectContaining({
            itemId: BART.id,
            panelId: 'p-falcon',
            // Both of them, in one order. *Which* order is not asked here:
            // jsdom has no layout engine and does not carry a pointer position
            // through a drop event either, so the place a drop picks out
            // belongs to tests/unit/dropAt.test.ts and to the browser walk.
            order: expect.arrayContaining([BART.id, other.id]),
          }),
        }),
        expect.anything(),
      );
      expect(held.mutate.mock.calls[0]![0].payload.order).toHaveLength(2);
    });

    it('takes an item off every panel when it is dropped on the Inbox', async () => {
      held.filings = [{ panelId: 'p-falcon', itemId: BART.id, position: 0 }];
      await showList({ items: [], openDashboardId: null, panelId: null });

      await dropOnTheList(BART.id);

      expect(held.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ panelId: null, order: [] }),
        }),
        expect.anything(),
      );
    });

    it('sends nothing for a drop that is not one of our rows', async () => {
      await showList({ openDashboardId: TODAY.id, panelId: 'p-falcon' });
      await act(async () => {});

      // A panel being dragged by its header across the list on its way
      // somewhere else.
      fireEvent.drop(theListBox(), {
        dataTransfer: { types: ['text/plain'], getData: () => 'a panel', setData: vi.fn() },
        clientY: 1,
      });

      expect(held.mutate).not.toHaveBeenCalled();
    });

    it('sends nothing when a row is dragged about inside the Inbox', async () => {
      // The Inbox is by age and has no order, so there is nowhere in it for a
      // row to land: moving one to the Inbox it is already in changes nothing,
      // and it would still offer to be undone.
      held.filings = [];
      await showList({ items: [BART], openDashboardId: null, panelId: null });

      await dropOnTheList(BART.id);

      expect(held.mutate).not.toHaveBeenCalled();
    });

    it('says why a drop was refused, where nothing else would say it', async () => {
      held.error = new CommandRefused(409, 'this panel changed while you were looking at it');
      await showList({ items: [BART], openDashboardId: TODAY.id, panelId: 'p-falcon' });

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'this panel changed while you were looking at it',
      );
    });

    it('leaves somebody else’s refusal alone', async () => {
      // One `useCommand` is not one mutation: a panel's rename is refused by
      // the board's, and a list drawn inside that panel must not say so too.
      held.error = new CommandRefused(409, 'a panel called To read is already on this dashboard');
      held.variables = { payload: {} };
      await showList({ items: [BART], openDashboardId: TODAY.id, panelId: 'p-falcon' });

      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('sends nothing when a row is dropped exactly where it started', async () => {
      held.filings = [{ panelId: 'p-falcon', itemId: BART.id, position: 0 }];
      await showList({ items: [BART], openDashboardId: TODAY.id, panelId: 'p-falcon' });

      await dropOnTheList(BART.id);

      expect(held.mutate).not.toHaveBeenCalled();
    });
  });

  describe('moving a row a step sends the same order a drag would', () => {
    it.each([
      { situation: 'down from the first', row: 'Reply to Bart', entry: 'Move down' },
      { situation: 'up from the last', row: 'Renew the domain', entry: 'Move up' },
    ])('$situation', async ({ row, entry }) => {
      const other = anItem('11111111-1111-7111-8111-000000000005', 'Renew the domain');
      held.items = [BART, other];
      held.filings = [
        { panelId: 'p-falcon', itemId: BART.id, position: 0 },
        { panelId: 'p-falcon', itemId: other.id, position: 1 },
      ];
      const user = await showList({
        items: [BART, other],
        openDashboardId: TODAY.id,
        panelId: 'p-falcon',
      });

      const theRow = screen.getAllByRole('listitem').find((li) => li.textContent?.includes(row))!;
      await user.click(within(theRow).getByRole('button', { name: 'Item actions' }));
      await user.click(await screen.findByRole('menuitem', { name: entry }));

      // Either way round, the two swap - and it is an *add*, not a move: a
      // move takes the item off every other panel showing it, which reordering
      // a row inside this one must not do.
      expect(held.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'add_item_to_panel',
          payload: expect.objectContaining({ panelId: 'p-falcon', order: [other.id, BART.id] }),
        }),
        expect.anything(),
      );
    });

    it.each([
      { situation: 'the first row cannot go up', row: 'Reply to Bart', entry: 'Move up' },
      { situation: 'the last row cannot go down', row: 'Renew the domain', entry: 'Move down' },
    ])('$situation', async ({ row, entry }) => {
      const other = anItem('11111111-1111-7111-8111-000000000005', 'Renew the domain');
      held.items = [BART, other];
      const user = await showList({
        items: [BART, other],
        openDashboardId: TODAY.id,
        panelId: 'p-falcon',
      });

      const theRow = screen.getAllByRole('listitem').find((li) => li.textContent?.includes(row))!;
      await user.click(within(theRow).getByRole('button', { name: 'Item actions' }));
      // Said out loud rather than gone, and choosing it does nothing.
      const said = await screen.findByRole('menuitem', { name: new RegExp(`^${entry}: `) });
      await user.click(said);

      expect(held.mutate).not.toHaveBeenCalled();
    });

    it('counts the rows the panel draws, not the ones it only holds', async () => {
      // A filing outlives its item being finished, so a panel can hold a row it
      // does not draw. Counting a move among the held order instead of the
      // drawn one made Move down on the first visible row rewrite the stored
      // order and change nothing on the screen.
      const finished = anItem('11111111-1111-7111-8111-000000000007', 'Already handled');
      finished.completedAt = '2026-08-31T09:00:00.000Z';
      const other = anItem('11111111-1111-7111-8111-000000000005', 'Renew the domain');
      held.items = [finished, BART, other];
      held.filings = [
        { panelId: 'p-falcon', itemId: finished.id, position: 0 },
        { panelId: 'p-falcon', itemId: BART.id, position: 1 },
        { panelId: 'p-falcon', itemId: other.id, position: 2 },
      ];
      const user = await showList({
        items: [BART, other],
        openDashboardId: TODAY.id,
        panelId: 'p-falcon',
      });

      const theRow = screen
        .getAllByRole('listitem')
        .find((li) => li.textContent?.includes('Reply to Bart'))!;
      await user.click(within(theRow).getByRole('button', { name: 'Item actions' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Move down' }));

      // Past the row below it on the screen, and the row nobody can see stays
      // where it was.
      expect(held.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ order: [finished.id, other.id, BART.id] }),
        }),
        expect.anything(),
      );
    });

    it('does not offer the moves in the Inbox, which is by age', async () => {
      const user = await showList({ openDashboardId: null, panelId: null });

      await user.click(screen.getByRole('button', { name: 'Item actions' }));

      expect(screen.queryByRole('menuitem', { name: /^Move up/ })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: /^Move down/ })).toBeNull();
    });
  });
});

describe('Panels', () => {
  describe('a drop from one panel onto another asks which it is, and sends what was chosen', () => {
    /** An item already filed on another panel, dropped onto this one. */
    async function dropFromAnotherPanel() {
      held.filings = [{ panelId: 'p-anna', itemId: BART.id, position: 0 }];
      const user = await showList({ items: [], openDashboardId: TODAY.id, panelId: 'p-falcon' });
      await dropOnto(BART.id);
      return user;
    }

    it('asks, naming the item and the panel it was dropped on', async () => {
      await dropFromAnotherPanel();

      const question = await screen.findByRole('alertdialog');
      expect(question).toHaveTextContent('Move “Reply to Bart” to Falcon, or add it there as well?');
      expect(held.mutate).not.toHaveBeenCalled();
    });

    it.each([
      { answer: 'Move it here', sends: 'move_item_to_panel' },
      { answer: 'Add it here as well', sends: 'add_item_to_panel' },
    ])('sends $sends when the answer is “$answer”', async ({ answer, sends }) => {
      const user = await dropFromAnotherPanel();

      await user.click(await screen.findByRole('button', { name: answer }));

      expect(held.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: sends,
          payload: expect.objectContaining({ itemId: BART.id, panelId: 'p-falcon' }),
        }),
        expect.anything(),
      );
    });

    it.each([
      { situation: 'the question', open: 'ask' as const, cancel: 'Cancel' },
      { situation: 'the picker for adding', open: 'add' as const, cancel: 'Cancel' },
    ])('takes the refusal away with $situation', async ({ open }) => {
      // The same rule the move picker follows: a refusal outlives the dialog it
      // was shown in, and the list says one of its own — so cancelling has to
      // clear it or the message is stuck above the rows with nothing to
      // explain it.
      held.refuses = new CommandRefused(409, 'this panel changed while you were looking at it');
      held.filings = [{ panelId: 'p-anna', itemId: BART.id, position: 0 }];

      if (open === 'ask') {
        await showList({ items: [], openDashboardId: TODAY.id, panelId: 'p-falcon' });
        await dropOnto(BART.id);
        const question = await screen.findByRole('alertdialog');
        await userEvent.click(within(question).getByRole('button', { name: 'Move it here' }));
        expect(await within(question).findByRole('alert')).toBeVisible();
        await userEvent.click(within(question).getByRole('button', { name: 'Cancel' }));
      } else {
        held.filings = [{ panelId: 'p-falcon', itemId: BART.id, position: 0 }];
        const user = await showList({
          items: [BART],
          openDashboardId: TODAY.id,
          panelId: 'p-falcon',
        });
        await user.click(screen.getByRole('button', { name: 'Item actions' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Add to…' }));
        const picker = await screen.findByRole('dialog');
        await user.click(within(picker).getByRole('button', { name: 'Anna' }));
        expect(await within(picker).findByRole('alert')).toBeVisible();
        await user.click(within(picker).getByRole('button', { name: 'Cancel' }));
      }

      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('sends nothing when the question is cancelled, and leaves the item where it was', async () => {
      const user = await dropFromAnotherPanel();

      await user.click(await screen.findByRole('button', { name: 'Cancel' }));

      expect(held.mutate).not.toHaveBeenCalled();
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it.each([
      {
        situation: 'a row arriving from the Inbox, which is what is filed nowhere',
        filings: [] as { panelId: string; itemId: string; position: number }[],
        drawn: [] as Item[],
      },
      {
        situation: 'a row already on this panel, which is being reordered',
        filings: [{ panelId: 'p-falcon', itemId: BART.id, position: 0 }],
        drawn: [BART],
      },
    ])('does not ask about $situation', async ({ filings, drawn }) => {
      held.filings = filings;
      await showList({ items: drawn, openDashboardId: TODAY.id, panelId: 'p-falcon' });
      await dropOnto(BART.id);

      expect(screen.queryByRole('alertdialog')).toBeNull();
      // A reorder that lands where it started sends nothing; a row from the
      // Inbox is filed. Either way, no question.
      if (drawn.length === 0) {
        expect(held.mutate).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'move_item_to_panel' }),
          expect.anything(),
        );
      }
    });
  });

  describe('a row on a panel can be shown on another as well, or taken off this one', () => {
    async function aRowOnAPanel() {
      held.filings = [{ panelId: 'p-falcon', itemId: BART.id, position: 0 }];
      return showList({ items: [BART], openDashboardId: TODAY.id, panelId: 'p-falcon' });
    }

    it('offers both on a panel, and neither in the Inbox', async () => {
      const user = await aRowOnAPanel();
      await user.click(screen.getByRole('button', { name: 'Item actions' }));
      expect(await screen.findByRole('menuitem', { name: 'Add to…' })).toBeVisible();
      expect(screen.getByRole('menuitem', { name: 'Remove from this panel' })).toBeVisible();

      cleanup();
      held.filings = [];
      const inbox = await showList({ openDashboardId: null, panelId: null });
      await inbox.click(screen.getByRole('button', { name: 'Item actions' }));

      expect(screen.queryByRole('menuitem', { name: 'Add to…' })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'Remove from this panel' })).toBeNull();
    });

    it('opens the picker for adding, without the Inbox in it', async () => {
      const user = await aRowOnAPanel();

      await user.click(screen.getByRole('button', { name: 'Item actions' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Add to…' }));

      const picker = await screen.findByRole('dialog');
      expect(picker).toHaveTextContent('Also show “Reply to Bart” on');
      // Nothing can be added to the Inbox: it is what is filed nowhere.
      expect(within(picker).queryByRole('button', { name: /^Inbox/ })).toBeNull();

      await user.click(within(picker).getByRole('button', { name: 'Anna' }));
      expect(held.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'add_item_to_panel',
          payload: expect.objectContaining({ itemId: BART.id, panelId: 'p-anna' }),
        }),
        expect.anything(),
      );
    });

    it('sends nothing when it is added to a panel it is already on', async () => {
      // The add would change nothing, and its undo would take the item off a
      // panel it was legitimately on.
      const user = await aRowOnAPanel();

      await user.click(screen.getByRole('button', { name: 'Item actions' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Add to…' }));
      const picker = await screen.findByRole('dialog');
      await user.click(within(picker).getByRole('button', { name: 'Falcon' }));

      expect(held.mutate).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('takes it off this panel, naming this panel and no other', async () => {
      const user = await aRowOnAPanel();

      await user.click(screen.getByRole('button', { name: 'Item actions' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Remove from this panel' }));

      expect(held.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'remove_item_from_panel',
          payload: expect.objectContaining({ itemId: BART.id, panelId: 'p-falcon' }),
        }),
        expect.anything(),
      );
    });
  });

  describe('what just happened can be put back, until the offer runs out', () => {
    it.each([
      { situation: 'adding it to a panel', entry: 'Add to…', undoes: 'remove_item_from_panel' },
      {
        situation: 'taking it off a panel',
        entry: 'Remove from this panel',
        undoes: 'add_item_to_panel',
      },
    ])('offers the way back after $situation', async ({ entry, undoes }) => {
      held.mutate = vi.fn((_args, options?: { onSuccess?: () => void }) => options?.onSuccess?.());
      held.filings = [{ panelId: 'p-falcon', itemId: BART.id, position: 0 }];
      const user = await showList({
        items: [BART],
        openDashboardId: TODAY.id,
        panelId: 'p-falcon',
      });

      await user.click(screen.getByRole('button', { name: 'Item actions' }));
      await user.click(await screen.findByRole('menuitem', { name: entry }));
      if (entry === 'Add to…') {
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Anna' }));
      }
      await user.click(screen.getByRole('button', { name: 'Undo' }));

      expect(held.send).toHaveBeenCalledWith(expect.objectContaining({ name: undoes }));
    });
  });
});
