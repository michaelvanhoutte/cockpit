import 'fake-indexeddb/auto';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dayOf, firstNextOn, ruleLabel, type CommandResult, type Item, type PossibleDuplicate, type Series, type WorkspaceSnapshot } from '@cockpit/shared';
import { changes } from '../../../src/api/changes';
import { CommandRefused, fetchSnapshot, fetchWorkspaces, sendCommand } from '../../../src/api/client';
import { InboxPanel } from '../../../src/components/InboxPanel';
import { ItemForm } from '../../../src/components/ItemForm';
import { resetStanding, stand } from '../../../src/offline';
import { UndoWhatJustHappened } from '../../../src/undo';

/**
 * An Item's Repeats as the form sets it ("Set an Item to repeat from its form,
 * and see the rule on its row", issue 1406), with the server holding the answer -
 * the frontend-with-its-own-backend level (F2), built as `ChangesAtOnce.test.tsx`
 * is: the screens, the queries and the tab's queue are the app's own and only the
 * network is replaced, by a server that answers when the test says and keeps what
 * it was told. What a change draws is tests/unit/drawnAhead.test.ts.
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

/** The description's editor, as a box that takes text and says what is in it. */
vi.mock('../../../src/description/RichDescription', () => ({
  default: function FakeRichDescription({
    initial,
    onChange,
    editable,
  }: {
    initial: string;
    onChange: (markdown: string) => void;
    editable: boolean;
  }) {
    const [value, setValue] = useState(initial);
    return (
      <textarea
        aria-label="Description"
        disabled={!editable}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          onChange(event.target.value);
        }}
      />
    );
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

const BART = 'item-bart';

/** What the server holds, which a change changes only when the test lets the server answer it. */
let stored: Item[];

/** The pairs the server offers as possible duplicates. */
let pairs: PossibleDuplicate[];

/** The series the server holds. */
let held: Series[];

/** Every change the server has been sent and not yet answered, oldest first. */
let waiting: { name: string; payload: Record<string, unknown>; answer: () => void; refuse: (error: Error) => void }[];

/** What the server does with a change it accepts. */
function keep(name: string, payload: Record<string, unknown>) {
  const itemId = payload.itemId as string;
  const change = (fields: Partial<Item>) => {
    stored = stored.map((item) => (item.id === itemId ? { ...item, ...fields } : item));
  };
  if (name === 'set_done') change({ completedAt: payload.done ? (payload.issuedAt as string) : null });
  if (name === 'set_started') change({ startedAt: payload.started ? (payload.issuedAt as string) : null });
  if (name === 'set_priority') change({ priority: payload.priority as Item['priority'] });
  if (name === 'set_due_date') change({ dueDate: payload.dueDate as string | null });
  if (name === 'set_repeat') {
    const repeat = payload.repeat as Omit<Series, 'id' | 'tenantId' | 'stoppedAt'> | null;
    const own = stored.find((item) => item.id === itemId)?.seriesId ?? (payload.seriesId as string);
    if (repeat === null) held = held.map((one) => (one.id === own ? { ...one, stoppedAt: payload.issuedAt as string } : one));
    else held = [...held.filter((one) => one.id !== own), { id: own, tenantId: 'tenant', ...repeat, stoppedAt: null }];
    change({ seriesId: own });
  }
  if (name === 'set_title') change({ title: payload.title as string });
  if (name === 'set_description') change({ description: payload.description as string | null });
  if (name === 'set_dismissed' && payload.dismissed) stored = stored.filter((item) => item.id !== itemId);
  if (name === 'set_duplicate_settled') {
    const pair = { itemId, otherItemId: payload.otherItemId as string };
    pairs = pairs.filter((held) => !(held.itemId === pair.itemId && held.otherItemId === pair.otherItemId));
    if (!payload.settled) pairs = [...pairs, pair];
  }
}

function theWorkspace(presentation: 'centered' | 'docked' = 'centered'): WorkspaceSnapshot {
  return {
    workspace: { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' },
    items: stored,
    dashboards: [],
    panels: [],
    layouts: [],
    associations: [],
    attachments: [],
    series: held,
    itemFormPresentation: presentation,
    duplicates: pairs,
    filings: [],
    agentRuns: [],
    generatedAt: '2026-10-20T09:00:00.000Z',
  } as unknown as WorkspaceSnapshot;
}

let presentation: 'centered' | 'docked';
let client: QueryClient;

function aScreen() {
  return (
    <QueryClientProvider client={client}>
      <UndoWhatJustHappened>
        <InboxPanel workspaceId="ws-work" />
        <ItemForm />
      </UndoWhatJustHappened>
    </QueryClientProvider>
  );
}

/** Opens the Workspace with these Items in its Inbox, and the server answering nothing until told to. */
async function show(
  items: Item[],
  options: { form?: 'centered' | 'docked'; openItem?: string; pairs?: PossibleDuplicate[]; series?: Series[] } = {},
) {
  stored = items;
  held = options.series ?? [];
  pairs = options.pairs ?? [];
  presentation = options.form ?? 'centered';
  opened.item = options.openItem;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(aScreen());
  for (const item of items) await waitFor(() => rowOf(item.title));
  return userEvent.setup();
}

/** The Inbox row with this label; the form open beside it may say the same words. */
const rowOf = (title: string): HTMLElement => {
  const row = screen.getAllByText(title).map((words) => words.closest('li[data-item-row]')).find(Boolean);
  if (!row) throw new Error(`no row says ${title}`);
  return row as HTMLElement;
};
const theInbox = () => document.querySelector<HTMLElement>('[data-inbox]')!;

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
  vi.mocked(fetchSnapshot).mockImplementation(async () => theWorkspace(presentation));
  vi.mocked(fetchWorkspaces).mockResolvedValue({ workspaces: [] } as never);
  vi.mocked(sendCommand).mockImplementation(
    (name, payload) =>
      new Promise<CommandResult>((resolve, reject) => {
        waiting.push({
          name,
          payload: payload as Record<string, unknown>,
          answer: () => {
            keep(name, payload as Record<string, unknown>);
            resolve({ ok: true, applied: true });
          },
          refuse: (error) => reject(error),
        });
      }),
  );
});

afterEach(async () => {
  // Closed first: a docked form writes what it holds on its way out.
  cleanup();
  resetStanding();
  // Whatever a test left waiting would otherwise hold the next test's changes behind it.
  for (let round = 0; round < 6 && changes.unanswered() > 0; round += 1) {
    await act(async () => waiting.splice(0).forEach((request) => request.answer()));
    await settle();
  }
  changes.forgetAnswered();
});

const titleBox = () => screen.getByLabelText('Title');
/** Fetched behind the line, so it arrives a beat after the form. */
const theChip = () => screen.findByTitle('Repeats');
const popover = () => screen.getByRole('group', { name: 'Repeats' }).parentElement as HTMLElement;
const weekly = () => ({ frequency: 'weekly' as const, nextOn: firstNextOn(dayOf(new Date()), 'weekly') });
const saying = () => ruleLabel(weekly());
const hover = () => `Repeats ${saying().replace(/^./, (first) => first.toLowerCase())}`;

describe('Item editing', () => {
  describe('a repeat is drawn the moment it is set, and goes back if refused', () => {
    it('shows the chip, the read-back and the row mark before the server has answered', async () => {
      const user = await show([anItem(BART, 'Reply to Bart')], { form: 'docked', openItem: BART });
      await waitFor(() => expect(titleBox()).toBeVisible());
      expect(within(rowOf('Reply to Bart')).queryByRole('img', { name: /^Repeats/ })).toBeNull();

      await user.click(await theChip());
      await user.click(within(popover()).getByRole('button', { name: 'Weekly' }));

      expect(await theChip()).toHaveTextContent(saying());
      expect(popover()).toHaveTextContent(`${saying()} · next`);
      expect(within(rowOf('Reply to Bart')).getByRole('img', { name: hover() })).toBeVisible();
      expect(waiting.map((request) => request.name)).toEqual(['set_repeat']);
    });

    it('takes the chip, the read-back and the row mark back when refused, and says why beside the field', async () => {
      const user = await show([anItem(BART, 'Reply to Bart')], { form: 'docked', openItem: BART });
      await waitFor(() => expect(titleBox()).toBeVisible());
      await user.click(await theChip());
      await user.click(within(popover()).getByRole('button', { name: 'Weekly' }));

      await act(async () => waiting.shift()!.refuse(new CommandRefused(400, 'Next on cannot be before today.')));
      await settle();

      expect(within(popover()).getByRole('alert')).toHaveTextContent('Next on cannot be before today.');
      expect(await theChip()).not.toHaveTextContent(saying());
      expect(popover()).not.toHaveTextContent('next');
      expect(within(rowOf('Reply to Bart')).queryByRole('img', { name: /^Repeats/ })).toBeNull();
    });

    it('keeps a rule chosen after a refused one, and says what it now holds', async () => {
      const user = await show([anItem(BART, 'Reply to Bart')], { form: 'docked', openItem: BART });
      await waitFor(() => expect(titleBox()).toBeVisible());
      await user.click(await theChip());
      await user.click(within(popover()).getByRole('button', { name: 'Weekly' }));
      await user.type(within(popover()).getByRole('spinbutton'), '5');
      await user.tab();

      await act(async () => waiting.shift()!.refuse(new CommandRefused(400, 'Next on cannot be before today.')));
      await settle();

      expect(popover()).toHaveTextContent(`${saying()} · next`);
      expect(within(popover()).getByRole('spinbutton')).toHaveValue(5);
    });

    it('stops showing the mark on the row at once when Never is chosen', async () => {
      const series: Series = { id: 'series-1', tenantId: 'tenant', ...weekly(), dueAfterDays: null, timeZone: 'UTC', stoppedAt: null };
      const user = await show([anItem(BART, 'Reply to Bart', { seriesId: 'series-1' })], {
        form: 'docked',
        openItem: BART,
        series: [series],
      });
      await waitFor(() => expect(within(rowOf('Reply to Bart')).getByRole('img', { name: hover() })).toBeVisible());

      await user.click(await theChip());
      await user.click(within(popover()).getByRole('button', { name: 'Never' }));

      expect(within(rowOf('Reply to Bart')).queryByRole('img', { name: /^Repeats/ })).toBeNull();
      expect(waiting.map((request) => [request.name, request.payload.repeat])).toEqual([['set_repeat', null]]);
    });
  });

  describe('the form writes a repeat by its usual rule', () => {
    it('writes a frequency at once when docked, and the due gap when its box is left', async () => {
      const user = await show([anItem(BART, 'Reply to Bart')], { form: 'docked', openItem: BART });
      await waitFor(() => expect(titleBox()).toBeVisible());

      await user.click(await theChip());
      await user.click(within(popover()).getByRole('button', { name: 'Weekly' }));
      expect(waiting.map((request) => request.name)).toEqual(['set_repeat']);

      await user.type(within(popover()).getByRole('spinbutton'), '5');
      await answerNext();
      // Typing sent nothing: the first change was answered and the queue is empty.
      expect(waiting).toEqual([]);
      await user.tab();

      expect(waiting.map((request) => (request.payload.repeat as { dueAfterDays: number | null }).dueAfterDays)).toEqual([5]);
    });

    it('holds a repeat in the centered form until Save', async () => {
      const user = await show([anItem(BART, 'Reply to Bart')], { openItem: BART });
      await waitFor(() => expect(titleBox()).toBeVisible());

      await user.click(await theChip());
      await user.click(within(popover()).getByRole('button', { name: 'Weekly' }));
      await user.keyboard('{Escape}');

      expect(await theChip()).toHaveTextContent(saying());
      expect(waiting).toEqual([]);
      expect(within(rowOf('Reply to Bart')).queryByRole('img', { name: /^Repeats/ })).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(waiting.map((request) => request.name)).toEqual(['set_repeat']);
      expect(waiting[0]!.payload).toMatchObject({ itemId: BART, repeat: { frequency: 'weekly' } });
    });

    it('discards a repeat held in the centered form when it is cancelled', async () => {
      const user = await show([anItem(BART, 'Reply to Bart')], { openItem: BART });
      await waitFor(() => expect(titleBox()).toBeVisible());
      await user.click(await theChip());
      await user.click(within(popover()).getByRole('button', { name: 'Weekly' }));
      await user.keyboard('{Escape}');

      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      await settle();

      expect(waiting).toEqual([]);
      expect(opened.close).toHaveBeenCalled();
    });
  });
});
