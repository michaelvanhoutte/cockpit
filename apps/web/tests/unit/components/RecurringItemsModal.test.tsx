import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RecurringItem, WorkspaceSnapshot } from '@cockpit/shared';
import { changes } from '../../../src/api/changes';
import { fetchSnapshot, fetchWorkspaces } from '../../../src/api/client';
import { readForAnnouncement } from '../../../src/api/snapshotReads';
import RecurringModal from '../../../src/components/RecurringModal';
import { resetStanding, stand } from '../../../src/offline';
import { UndoWhatJustHappened } from '../../../src/undo';

/**
 * The Recurring items modal: what it draws from a read (F1) and what a save, a
 * refusal and an announcement do to it with the server holding the answer (F2,
 * run in this runner as `ConnectionsAtOnce.test.tsx` is). The modal, its queries
 * and the tab's queue are the app's own and only the network is replaced: a
 * server that answers when the test says, keeps the recurring items it is told
 * to, and refuses what the real one refuses. What each change draws is
 * tests/unit/recurringItemsDrawnAhead.test.ts; what the server decides is
 * apps/api/tests/integration/http/recurring-items.test.ts.
 */

const held = vi.hoisted(() => ({
  /** What the list answers with, and how many times it has been read. */
  items: [] as unknown[],
  reads: 0,
  /** Every change sent and not yet answered, oldest first. */
  waiting: [] as { name: string; payload: Record<string, any>; answer: () => void; refuse: (reason: string) => void }[],
  sent: [] as { name: string; payload: Record<string, any> }[],
}));

vi.mock('../../../src/api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/api/client')>();
  const send = (name: string, payload: Record<string, any>) =>
    new Promise<unknown>((resolve, reject) => {
      held.sent.push({ name, payload });
      held.waiting.push({
        name,
        payload,
        answer: () => {
          const items = held.items as RecurringItem[];
          if (name === 'delete_recurring_item') held.items = items.filter((one) => one.id !== payload.seriesId);
          else {
            const row: RecurringItem = {
              id: payload.seriesId,
              workspaceId: payload.workspaceId,
              title: payload.title,
              description: payload.description,
              priority: payload.priority,
              panelIds: payload.panelIds,
              ...payload.repeat,
            };
            held.items = name === 'create_recurring_item' ? [...items, row] : items.map((one) => (one.id === row.id ? row : one));
          }
          resolve({ ok: true, applied: true });
        },
        refuse: (reason) => reject(new original.CommandRefused(400, reason)),
      });
    });
  return {
    ...original,
    api: {
      v1: {
        workspaces: {
          ':workspaceId': {
            'recurring-items': {
              $get: async () => {
                held.reads += 1;
                return Response.json({ recurringItems: structuredClone(held.items) });
              },
            },
          },
        },
      },
    },
    fetchSnapshot: vi.fn(),
    fetchWorkspaces: vi.fn(),
    sendCommand: send,
  };
});

const WORK = 'ws-work';
const PANEL = '018f0000-0000-7000-8000-0000000000a1';
const SNAPSHOT = {
  workspace: { id: WORK, tenantId: 'tenant', name: 'Work' },
  items: [],
  dashboards: [{ id: 'd-chores', tenantId: 'tenant', workspaceId: WORK, name: 'Chores' }],
  panels: [{ id: PANEL, tenantId: 'tenant', dashboardId: 'd-chores', name: 'Panel 1', kind: 'items' }],
  layouts: [],
  filings: [],
  associations: [],
  series: [],
  duplicates: [],
  agentRuns: [],
} as unknown as WorkspaceSnapshot;

const aRecurringItem = (over: Partial<RecurringItem> & { id: string }): RecurringItem => ({
  workspaceId: WORK,
  title: `Recurring ${over.id}`,
  description: '',
  priority: null,
  panelIds: [],
  frequency: 'weekly',
  nextOn: '2082-11-02',
  dueAfterDays: null,
  ...over,
});
const REVIEW = aRecurringItem({ id: '018f0000-0000-7000-8000-000000000001', title: 'Weekly review', panelIds: [PANEL] });
const INVOICES = aRecurringItem({ id: '018f0000-0000-7000-8000-000000000002', title: 'Monthly invoices', frequency: 'monthly', nextOn: '2082-11-20' });
const VAT = aRecurringItem({ id: '018f0000-0000-7000-8000-000000000003', title: 'Quarterly VAT', frequency: 'quarterly', nextOn: '2082-11-10' });

let client: QueryClient;
const closed = vi.fn();

function open(returnFocusTo?: HTMLElement) {
  return render(
    <QueryClientProvider client={client}>
      <RecurringModal workspaceId={WORK} onClose={closed} returnFocusTo={returnFocusTo} />
    </QueryClientProvider>,
  );
}

async function show(items: RecurringItem[]) {
  held.items = [...items];
  open();
  await screen.findByRole('button', { name: '+ New recurring item' });
  return userEvent.setup();
}

const titles = () => screen.queryAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0]!.textContent);

/** Lets what the app does between an answer and the read behind it happen. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

async function answerNext() {
  await act(async () => held.waiting.shift()!.answer());
  await settle();
}
async function refuseNext(reason: string) {
  await act(async () => held.waiting.shift()!.refuse(reason));
  await settle();
}

beforeEach(() => {
  localStorage.clear();
  resetStanding();
  held.items = [];
  held.reads = 0;
  held.waiting = [];
  held.sent = [];
  closed.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchSnapshot).mockResolvedValue(SNAPSHOT);
  vi.mocked(fetchWorkspaces).mockResolvedValue({ workspaces: [{ id: WORK, tenantId: 'tenant', name: 'Work', color: '#3a72c8' }] } as never);
});

afterEach(async () => {
  cleanup();
  resetStanding();
  for (let round = 0; round < 6 && changes.unanswered() > 0; round += 1) {
    await act(async () => held.waiting.splice(0).forEach((request) => request.answer()));
    await settle();
  }
  changes.forgetAnswered();
});

describe('Workspace management', () => {
  describe('the Recurring items modal lists, opens one and swaps in place', () => {
    it('lists the recurring items soonest first, with Title, Repeats, Next on and Files on', async () => {
      await show([INVOICES, REVIEW, VAT]);

      expect(titles()).toEqual(['Weekly review', 'Quarterly VAT', 'Monthly invoices']);
      const header = screen.getAllByRole('columnheader').map((one) => one.textContent);
      expect(header).toEqual(['Title', 'Repeats', 'Next on', 'Files on']);
      const review = screen.getAllByRole('row')[1]!;
      expect(within(review).getByText('Weekly on Monday')).toBeInTheDocument();
      expect(within(review).getByText('Chores ▸ Panel 1')).toBeInTheDocument();
      // Nothing filed on a Panel files in the Inbox.
      expect(within(screen.getAllByRole('row')[3]!).getByText('Inbox')).toBeInTheDocument();
    });

    it('says what a recurring item is where there are none, with the way to make one', async () => {
      await show([]);

      expect(screen.getByText(/Nothing recurs yet/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '+ New recurring item' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    });

    it('turns into the form of the row pressed, in the same dialog and never a second one', async () => {
      const user = await show([REVIEW, INVOICES]);

      await user.click(screen.getByRole('button', { name: 'Monthly invoices' }));

      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(screen.getByLabelText('Title')).toHaveValue('Monthly invoices');
      expect(screen.getByRole('button', { name: 'Recurring items' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Delete recurring item' })).toBeInTheDocument();
    });

    it('turns into a blank form for + New recurring item, without a Delete', async () => {
      const user = await show([REVIEW]);

      await user.click(screen.getByRole('button', { name: '+ New recurring item' }));

      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(screen.getByLabelText('Title')).toHaveValue('');
      expect(screen.getByText('New recurring item')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Delete recurring item' })).not.toBeInTheDocument();
    });

    it.each([
      { control: '← Recurring items', name: 'Recurring items' },
      { control: 'Cancel', name: /^Cancel$/ },
    ])('goes back to the list from $control with nothing written', async ({ name }) => {
      const user = await show([REVIEW]);
      await user.click(screen.getByRole('button', { name: 'Weekly review' }));
      await user.type(screen.getByLabelText('Title'), ' changed');

      await user.click(screen.getByRole('button', { name }));

      expect(screen.getByRole('button', { name: '+ New recurring item' })).toBeInTheDocument();
      expect(titles()).toEqual(['Weekly review']);
      expect(held.sent).toEqual([]);
    });

    it('closes with an unsaved edit and writes nothing', async () => {
      const user = await show([REVIEW]);
      await user.click(screen.getByRole('button', { name: 'Weekly review' }));
      await user.type(screen.getByLabelText('Title'), ' changed');

      await user.keyboard('{Escape}');

      expect(closed).toHaveBeenCalled();
      expect(held.sent).toEqual([]);
    });

    it('closes from the list with Close', async () => {
      const user = await show([REVIEW]);

      await user.click(screen.getByRole('button', { name: 'Close' }));

      expect(closed).toHaveBeenCalled();
    });

    it('clears what was typed in the Panel search with Escape before the next Escape closes it, keeping the form', async () => {
      const user = await show([REVIEW]);
      await user.click(screen.getByRole('button', { name: 'Weekly review' }));
      await user.click(screen.getByRole('textbox', { name: 'Find a Panel to file on' }));
      const search = await screen.findByRole('searchbox', { name: 'Find a Panel to file on' });
      await user.type(search, 'Pan');

      await user.keyboard('{Escape}');

      expect(closed).not.toHaveBeenCalled();
      expect(search).toHaveValue('');
      expect(screen.getByLabelText('Title')).toHaveValue('Weekly review');
      await user.keyboard('{Escape}');
      expect(closed).toHaveBeenCalled();
    });

    it('gives the focus back to the control it was opened from when it closes', async () => {
      const from = document.createElement('button');
      document.body.append(from);
      held.items = [REVIEW];
      open(from);
      const user = userEvent.setup();
      await screen.findByRole('button', { name: '+ New recurring item' });

      await user.keyboard('{Escape}');
      cleanup();

      await waitFor(() => expect(from).toHaveFocus());
      from.remove();
    });

    it('keeps a file let go outside the window from the browser, which would navigate away to open it', async () => {
      await show([REVIEW]);
      const scrim = screen.getByRole('dialog').previousElementSibling!;

      const notPrevented = fireEvent.drop(scrim, { dataTransfer: { types: ['Files'], files: [] } });

      expect(notPrevented).toBe(false);
    });

    it('says it needs a connection when opened offline, and reads nothing', async () => {
      stand({ found: true });
      open();

      expect(await screen.findByText(/needs a connection/)).toBeInTheDocument();
      expect(held.reads).toBe(0);
      expect(screen.queryByRole('button', { name: '+ New recurring item' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    });
  });

  describe('a save shows at once, and a refusal goes back with its reason', () => {
    async function fillANewOne(user: ReturnType<typeof userEvent.setup>, title: string) {
      await user.click(screen.getByRole('button', { name: '+ New recurring item' }));
      await user.type(screen.getByLabelText('Title'), title);
    }

    it('shows a new one in the list before the server has answered, and sends it once', async () => {
      const user = await show([REVIEW]);
      await fillANewOne(user, 'Check the cellar');

      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(titles()).toContain('Check the cellar');
      expect(screen.getByRole('button', { name: '+ New recurring item' })).toBeInTheDocument();
      expect(held.sent.map((one) => one.name)).toEqual(['create_recurring_item']);
      expect(held.sent[0]?.payload).toMatchObject({ workspaceId: WORK, title: 'Check the cellar', panelIds: [], repeat: { frequency: 'weekly' } });
      await answerNext();
      expect(titles()).toContain('Check the cellar');
    });

    it('shows a change to an existing one at once, sent whole', async () => {
      const user = await show([REVIEW, INVOICES]);
      await user.click(screen.getByRole('button', { name: 'Weekly review' }));
      await user.clear(screen.getByLabelText('Title'));
      await user.type(screen.getByLabelText('Title'), 'Friday review');
      await user.click(screen.getByRole('button', { name: 'Daily' }));

      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(titles()).toContain('Friday review');
      expect(within(screen.getAllByRole('row')[1]!).getByText('Daily')).toBeInTheDocument();
      expect(held.sent[0]).toMatchObject({
        name: 'write_recurring_item',
        payload: { seriesId: REVIEW.id, title: 'Friday review', panelIds: [PANEL], repeat: { frequency: 'daily', nextOn: '2082-11-02' } },
      });
      await answerNext();
    });

    it('takes a deleted one out of the list at once, after asking', async () => {
      const user = await show([REVIEW, INVOICES]);
      await user.click(screen.getByRole('button', { name: 'Weekly review' }));
      await user.click(screen.getByRole('button', { name: 'Delete recurring item' }));
      expect(held.sent).toEqual([]);
      expect(screen.getByText('Stop it? Copies already made stay.')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Delete' }));

      expect(titles()).toEqual(['Monthly invoices']);
      expect(held.sent.map((one) => one.name)).toEqual(['delete_recurring_item']);
      await answerNext();
      expect(titles()).toEqual(['Monthly invoices']);
    });

    it('goes back to the form when a Next on is refused, with what was typed and the reason beside the field', async () => {
      const user = await show([REVIEW]);
      await fillANewOne(user, 'Check the cellar');
      fireEvent.change(screen.getByLabelText('Next on'), { target: { value: '2020-01-06' } });
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(titles()).toContain('Check the cellar');

      await refuseNext('Next on cannot be before today.');

      expect(screen.getByLabelText('Title')).toHaveValue('Check the cellar');
      expect(screen.getByLabelText('Next on')).toHaveValue('2020-01-06');
      const reason = screen.getByRole('alert');
      expect(reason).toHaveTextContent('Next on cannot be before today.');
      expect(reason.parentElement).toContainElement(screen.getByLabelText('Next on'));
      // The list is as the server holds it again.
      await user.click(screen.getByRole('button', { name: 'Recurring items' }));
      expect(titles()).toEqual(['Weekly review']);
    });

    it('puts a refused change to an existing one back in the list, and its form comes back with the reason beside Files on', async () => {
      const user = await show([REVIEW]);
      await user.click(screen.getByRole('button', { name: 'Weekly review' }));
      await user.clear(screen.getByLabelText('Title'));
      await user.type(screen.getByLabelText('Title'), 'Renamed');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(titles()).toEqual(['Renamed']);

      await refuseNext('A Panel it files on is no longer in this Workspace.');

      expect(screen.getByLabelText('Title')).toHaveValue('Renamed');
      expect(screen.getByRole('alert')).toHaveTextContent('A Panel it files on is no longer in this Workspace.');
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(titles()).toEqual(['Weekly review']);
    });

    it.each([
      { change: 'a save', verb: 'saved', press: ['Save'] },
      { change: 'a delete', verb: 'deleted', press: ['Delete recurring item', 'Delete'] },
    ])('says the refusal of $change in the undo bar when the modal has been closed meanwhile', async ({ verb, press }) => {
      held.items = [REVIEW];
      const shown = (modal: boolean) => (
        <QueryClientProvider client={client}>
          <UndoWhatJustHappened>{modal && <RecurringModal workspaceId={WORK} onClose={closed} />}</UndoWhatJustHappened>
        </QueryClientProvider>
      );
      const view = render(shown(true));
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Weekly review' }));
      for (const name of press) await user.click(screen.getByRole('button', { name }));
      view.rerender(shown(false));

      await refuseNext('That recurring item is no longer there.');

      expect(await screen.findByText(`“Weekly review” was not ${verb}. That recurring item is no longer there.`)).toBeInTheDocument();
    });

    it('does not let a title past the length the server takes be saved, and says so', async () => {
      const user = await show([]);
      await user.click(screen.getByRole('button', { name: '+ New recurring item' }));

      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'x'.repeat(201) } });

      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent('A title is at most 200 characters.');
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'x'.repeat(200) } });
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('says a refusal after the person has opened another form, in the list, and leaves them where they are', async () => {
      const user = await show([REVIEW, INVOICES]);
      await user.click(screen.getByRole('button', { name: 'Weekly review' }));
      await user.type(screen.getByLabelText('Title'), ' x');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await user.click(screen.getByRole('button', { name: 'Monthly invoices' }));

      await refuseNext('That recurring item is no longer there.');

      expect(screen.getByLabelText('Title')).toHaveValue('Monthly invoices');
      await user.click(screen.getByRole('button', { name: 'Recurring items' }));
      expect(screen.getByRole('alert')).toHaveTextContent('“Weekly review x” was not saved. That recurring item is no longer there.');
    });
  });

  describe('a read that fails is said, and tried again from the modal', () => {
    it('says the Workspace could not be read, and reads it again on Try again', async () => {
      held.items = [REVIEW];
      vi.mocked(fetchSnapshot).mockRejectedValueOnce(new Error('down'));
      open();
      expect(await screen.findByText(/could not be read/)).toBeInTheDocument();
      expect(screen.queryByText('Loading…')).not.toBeInTheDocument();

      await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));

      expect(await screen.findByRole('button', { name: '+ New recurring item' })).toBeInTheDocument();
      expect(titles()).toEqual(['Weekly review']);
    });

    it('reads the list again when a change is refused, so a row gone elsewhere goes from it', async () => {
      const user = await show([REVIEW, INVOICES]);
      await user.click(screen.getByRole('button', { name: 'Weekly review' }));
      await user.type(screen.getByLabelText('Title'), ' x');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      held.items = [INVOICES];

      await refuseNext('That recurring item is no longer there.');

      await user.click(screen.getByRole('button', { name: 'Recurring items' }));
      await waitFor(() => expect(titles()).toEqual(['Monthly invoices']));
    });
  });

  describe('the list stays current while the modal is open', () => {
    it('reads again when the Workspace is announced as changed on another device', async () => {
      await show([REVIEW]);
      const reads = held.reads;
      held.items = [REVIEW, INVOICES];

      await act(async () => readForAnnouncement(client, { type: 'snapshot_invalidated', workspaceId: WORK }));
      await settle();

      await waitFor(() => expect(titles()).toEqual(['Weekly review', 'Monthly invoices']));
      expect(held.reads).toBeGreaterThan(reads);
    });

    it('reads what changed while it was closed on the next opening', async () => {
      await show([REVIEW]);
      cleanup();
      await settle();
      held.items = [REVIEW, INVOICES];

      await show([REVIEW, INVOICES]);

      expect(titles()).toEqual(['Weekly review', 'Monthly invoices']);
    });
  });
});
