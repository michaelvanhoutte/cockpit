import 'fake-indexeddb/auto';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dayOf, daysOnFrom, type CommandResult, type Item, type PossibleDuplicate, type WorkspaceSnapshot } from '@cockpit/shared';
import { changes } from '../../../src/api/changes';
import { CommandRefused, fetchSnapshot, fetchWorkspaces, sendCommand } from '../../../src/api/client';
import { InboxPanel } from '../../../src/components/InboxPanel';
import { ItemForm } from '../../../src/components/ItemForm';
import { resetStanding, stand } from '../../../src/offline';
import { UndoWhatJustHappened } from '../../../src/undo';

/**
 * A change to an Item as each surface makes it, with the server holding the
 * answer - the frontend-with-its-own-backend level (F2), run in this runner as
 * `queries.test.tsx` is, since no `tests/service` runner exists. The screens are
 * the app's own, the queries and the tab's queue are real, and only the network
 * is replaced (`sendCommand` and the reads), by a server that answers when the
 * test says and keeps what it was told, so a read after an answer finds the
 * change in it. What each change draws is
 * tests/unit/drawnAhead.test.ts and the order they are sent in is
 * tests/unit/changeQueue.test.ts; what is asked here is that every sender is
 * wired to them.
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
  useDockedItem: () => ({
    openId: null,
    show: (itemId: string) => {
      opened.item = itemId;
    },
  }),
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
const LISA = 'item-lisa';
const MAGGIE = 'item-maggie';

/** What the server holds, which a change changes only when the test lets the server answer it. */
let stored: Item[];

/** The pairs the server offers as possible duplicates. */
let pairs: PossibleDuplicate[];

/** Every change the server has been sent and not yet answered, oldest first. */
let waiting: { name: string; payload: Record<string, unknown>; answer: () => void; refuse: (error: Error) => void }[];

/** What the server does with a change it accepts. */
function keep(name: string, payload: Record<string, unknown>) {
  const itemId = payload.itemId as string;
  const change = (fields: Partial<Item>) => {
    stored = stored.map((item) => (item.id === itemId ? { ...item, ...fields } : item));
  };
  if (name === 'set_done') change({ completedAt: payload.done ? (payload.issuedAt as string) : null });
  if (name === 'set_started') change({ startedAt: payload.started ? (payload.issuedAt as string) : null, waitingSince: null });
  if (name === 'wait_for_reply') {
    const held = stored.find((item) => item.id === itemId);
    change({
      waitingSince: held?.waitingSince ?? (payload.issuedAt as string),
      dueDate: daysOnFrom(dayOf(new Date(payload.issuedAt as string)), payload.days as number),
    });
  }
  if (name === 'set_priority') change({ priority: payload.priority as Item['priority'] });
  if (name === 'set_due_date') change({ dueDate: payload.dueDate as string | null });
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
  options: { form?: 'centered' | 'docked'; openItem?: string; pairs?: PossibleDuplicate[] } = {},
) {
  stored = items;
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

async function tick(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.keyboard('{Control>}');
  await user.click(screen.getByText(title));
  await user.keyboard('{/Control}');
}

/** Opens Edit ▾, one field's submenu and chooses a value, by keyboard (a pointer onto a submenu is the browser walk's). */
async function chooseForAll(user: ReturnType<typeof userEvent.setup>, field: string, option: string) {
  await user.click(screen.getByRole('button', { name: 'Edit ▾' }));
  (await screen.findByRole('menuitem', { name: new RegExp(`^${field}`) })).focus();
  await user.keyboard('{ArrowRight}');
  const options = (await screen.findAllByRole('menuitemradio')).map((o) => o.textContent?.replace('✓', ''));
  for (let step = 0; step < options.indexOf(option); step += 1) await user.keyboard('{ArrowDown}');
  await user.keyboard('{Enter}');
}

/** Opens a row's menu and picks one of Status's states by keyboard. */
async function chooseStatus(user: ReturnType<typeof userEvent.setup>, title: string, state: string) {
  await user.click(within(rowOf(title)).getByLabelText('Item actions'));
  (await screen.findByRole('menuitem', { name: /^Status/ })).focus();
  await user.keyboard('{ArrowRight}');
  await screen.findAllByRole('menuitemradio');
  for (let step = 0; step < ['To do', 'In progress', 'Waiting for reply', 'Done'].indexOf(state); step += 1) await user.keyboard('{ArrowDown}');
  await user.keyboard('{Enter}');
}

const titleBox = () => screen.getByLabelText('Title');
const descriptionBox = () => screen.getByLabelText('Description');

describe('Item editing', () => {
  describe('a change shows on the row the moment it is made, with the server still holding the answer', () => {
    it('takes a row from the Inbox when Done is chosen from its Status ▸', async () => {
      const user = await show([anItem(BART, 'Reply to Bart'), anItem(LISA, 'Reply to Lisa')]);

      await chooseStatus(user, 'Reply to Bart', 'Done');

      expect(screen.queryByText('Reply to Bart')).toBeNull();
      expect(screen.getByText('Reply to Lisa')).toBeVisible();
      expect(waiting.map((request) => request.name)).toEqual(['set_done']);
    });

    it('marks a row In progress from its Status ▸', async () => {
      const user = await show([anItem(BART, 'Reply to Bart')]);
      expect(rowOf('Reply to Bart')).not.toHaveTextContent('In progress');

      await chooseStatus(user, 'Reply to Bart', 'In progress');

      expect(rowOf('Reply to Bart')).toHaveTextContent('In progress');
      expect(waiting.map((request) => request.name)).toEqual(['set_started']);
    });

    it('takes a row from the Inbox when it is dismissed from its menu', async () => {
      const user = await show([anItem(BART, 'Reply to Bart'), anItem(LISA, 'Reply to Lisa')]);

      await user.click(within(rowOf('Reply to Bart')).getByLabelText('Item actions'));
      await user.click(await screen.findByText('Dismiss'));

      expect(screen.queryByText('Reply to Bart')).toBeNull();
      expect(screen.getByRole('status')).toHaveTextContent('“Reply to Bart” dismissed');
    });

    it('flags every row of a selection with the priority chosen for them', async () => {
      const user = await show([anItem(BART, 'Reply to Bart'), anItem(LISA, 'Reply to Lisa'), anItem(MAGGIE, 'Reply to Maggie')]);
      await tick(user, 'Reply to Bart');
      await tick(user, 'Reply to Lisa');

      await chooseForAll(user, 'Priority', 'High');

      expect(within(rowOf('Reply to Bart')).getByLabelText('High priority')).toBeVisible();
      expect(within(rowOf('Reply to Lisa')).getByLabelText('High priority')).toBeVisible();
      expect(within(rowOf('Reply to Maggie')).queryByLabelText('High priority')).toBeNull();
    });

    it('opens a row again at once when its Done is undone, and sends the Undo after the Done', async () => {
      const user = await show([anItem(BART, 'Reply to Bart')]);
      await chooseStatus(user, 'Reply to Bart', 'Done');
      expect(screen.queryByText('Reply to Bart')).toBeNull();

      await user.click(await screen.findByRole('button', { name: 'Undo' }));

      expect(screen.getByText('Reply to Bart')).toBeVisible();
      // Waiting its turn behind the Done it reverses.
      expect(waiting.map((request) => request.name)).toEqual(['set_done']);
      await answerNext();
      expect(waiting.map((request) => [request.name, request.payload.done])).toEqual([['set_done', false]]);
    });

    it('keeps showing the change under a read that lands before the server has answered it', async () => {
      const user = await show([anItem(BART, 'Reply to Bart'), anItem(LISA, 'Reply to Lisa')]);
      await chooseStatus(user, 'Reply to Bart', 'Done');

      // Another change elsewhere makes the tab read the Workspace again, and the server has not answered ours.
      await act(async () => void (await client.invalidateQueries({ queryKey: ['snapshot', 'ws-work'] })));

      expect(vi.mocked(fetchSnapshot).mock.calls.length).toBeGreaterThan(1);
      expect(screen.queryByText('Reply to Bart')).toBeNull();
    });

    it('shows what another device wrote after this one’s answer once a later read has landed', async () => {
      const user = await show([anItem(BART, 'Reply to Bart')]);
      await chooseStatus(user, 'Reply to Bart', 'In progress');
      await answerNext();
      // Another device then takes it back to To do, and the next read says so.
      stored = stored.map((item) => ({ ...item, startedAt: null }));

      await act(async () => void (await client.invalidateQueries({ queryKey: ['snapshot', 'ws-work'] })));

      await waitFor(() => expect(rowOf('Reply to Bart')).not.toHaveTextContent('In progress'));
    });
  });

  describe('a docked form’s fields show on the row at once, and a reopened form shows what was written', () => {
    it('shows a title committed on leaving the box as the row’s label', async () => {
      const user = await show([anItem(BART, 'Reply to Bart')], { form: 'docked', openItem: BART });
      await waitFor(() => expect(titleBox()).toBeVisible());

      await user.clear(titleBox());
      await user.type(titleBox(), 'Reply to Bart today');
      await user.tab();

      expect(within(rowOf('Reply to Bart today')).getByText('Reply to Bart today')).toBeVisible();
      expect(waiting.map((request) => request.name)).toEqual(['set_title']);
    });

    it('shows a due date picked with Tmrw on the row', async () => {
      const user = await show([anItem(BART, 'Reply to Bart')], { form: 'docked', openItem: BART });
      await waitFor(() => expect(titleBox()).toBeVisible());
      expect(rowOf('Reply to Bart')).not.toHaveTextContent('Due tomorrow');

      await user.click(screen.getByRole('button', { name: 'Tmrw' }));

      expect(rowOf('Reply to Bart')).toHaveTextContent('Due tomorrow');
    });

    it('does not make a second field wait for the first to be answered', async () => {
      const user = await show([anItem(BART, 'Reply to Bart')], { form: 'docked', openItem: BART });
      await waitFor(() => expect(titleBox()).toBeVisible());

      await user.clear(titleBox());
      await user.type(titleBox(), 'Reply to Bart today');
      await user.tab();
      await user.click(screen.getByRole('button', { name: 'High priority' }));

      // The title is still unanswered, and the priority is on the row already.
      expect(within(rowOf('Reply to Bart today')).getByLabelText('High priority')).toBeVisible();
      expect(waiting.map((request) => request.name)).toEqual(['set_title']);
    });

    it('opens again on the description just committed, with the read behind it not yet back', async () => {
      const user = await show([anItem(BART, 'Reply to Bart')], { form: 'docked', openItem: BART });
      await waitFor(() => expect(descriptionBox()).toBeEnabled());

      await user.type(descriptionBox(), 'Ask about the tolerances');
      await user.tab();
      cleanup();
      render(aScreen());

      await waitFor(() => expect(descriptionBox()).toHaveValue('Ask about the tolerances'));
    });
  });

  describe('Save in the centered form closes on the server’s acceptance', () => {
    it('keeps the form open until the server has accepted the change, and closes without waiting for the read', async () => {
      const user = await show([anItem(BART, 'Reply to Bart')], { openItem: BART });
      await waitFor(() => expect(descriptionBox()).toBeEnabled());
      // Every read from here on never comes back, so closing cannot be waiting on one.
      vi.mocked(fetchSnapshot).mockImplementation(() => new Promise(() => {}));

      await user.type(descriptionBox(), 'Ask about the tolerances');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(opened.close).not.toHaveBeenCalled();

      await answerNext();

      expect(opened.close).toHaveBeenCalled();
    });

    it('stays open with what was typed and says why when the server refuses it', async () => {
      const user = await show([anItem(BART, 'Reply to Bart')], { openItem: BART });
      await waitFor(() => expect(descriptionBox()).toBeEnabled());
      opened.close.mockClear();

      await user.type(descriptionBox(), 'Ask about the tolerances');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, 'That item is locked.')));
      await settle();

      expect(await screen.findByRole('alert')).toHaveTextContent('That item is locked.');
      expect(descriptionBox()).toHaveValue('Ask about the tolerances');
      expect(opened.close).not.toHaveBeenCalled();
    });
  });

  describe('a wait for a reply shows on the row the moment it is chosen, and goes back with its reason if refused', () => {
    /** Opens a row's menu and its *Wait for reply…*, and accepts the days it starts on with Enter. */
    async function waitThreeDays(user: ReturnType<typeof userEvent.setup>, title: string) {
      await user.click(within(rowOf(title)).getByLabelText('Item actions'));
      await user.click(await screen.findByRole('menuitem', { name: 'Wait for reply…' }));
      expect(await screen.findByLabelText('Days to wait')).toHaveValue(3);
      await user.keyboard('{Enter}');
    }

    it('wears Waiting since and a due date three days out before the server answers', async () => {
      const user = await show([anItem(BART, 'Reply to Bart', { dueDate: '2099-01-01' })]);

      await waitThreeDays(user, 'Reply to Bart');

      expect(within(rowOf('Reply to Bart')).getByText(/^Waiting since/)).toBeVisible();
      expect(within(rowOf('Reply to Bart')).getByText('Due in 3d')).toBeVisible();
      expect(waiting.map((request) => request.name)).toEqual(['wait_for_reply']);
      expect(waiting[0]?.payload).toMatchObject({ itemId: BART, days: 3 });
    });

    it('takes the pill and the due date back when the server refuses, and the bar says why', async () => {
      const user = await show([anItem(BART, 'Reply to Bart', { dueDate: '2099-01-01' })]);
      await waitThreeDays(user, 'Reply to Bart');

      await act(async () => waiting.shift()!.refuse(new CommandRefused(400, 'Cockpit does not know the time zone this device is in.')));
      await settle();

      expect(within(rowOf('Reply to Bart')).queryByText(/^Waiting since/)).toBeNull();
      expect(within(rowOf('Reply to Bart')).queryByText('Due in 3d')).toBeNull();
      expect(await screen.findByText(/is not waiting for a reply\. Cockpit does not know the time zone/)).toBeVisible();
    });
  });

  describe('a refused change goes back and says why where it says so today', () => {
    it('puts a row back in the Inbox when its Done is refused, and takes the offer to undo it away', async () => {
      const user = await show([anItem(BART, 'Reply to Bart')]);
      await chooseStatus(user, 'Reply to Bart', 'Done');
      expect(screen.queryByText('Reply to Bart')).toBeNull();

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, 'That item is locked.')));
      await settle();

      expect(screen.getByText('Reply to Bart')).toBeVisible();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('puts back the rows of a selection the server refused, and says how many and why in the bar', async () => {
      const user = await show([anItem(BART, 'Reply to Bart'), anItem(LISA, 'Reply to Lisa')]);
      await tick(user, 'Reply to Bart');
      await tick(user, 'Reply to Lisa');
      await chooseForAll(user, 'Priority', 'High');
      expect(within(rowOf('Reply to Bart')).getByLabelText('High priority')).toBeVisible();

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, 'That item is locked.')));
      await settle();
      await answerNext();

      expect(within(rowOf('Reply to Bart')).queryByLabelText('High priority')).toBeNull();
      expect(within(rowOf('Reply to Lisa')).getByLabelText('High priority')).toBeVisible();
      expect(await screen.findByText(/1 not changed\. That item is locked\./)).toBeVisible();
    });

    it('goes on with the changes behind a refused one', async () => {
      const user = await show([anItem(BART, 'Reply to Bart'), anItem(LISA, 'Reply to Lisa')]);
      await chooseStatus(user, 'Reply to Bart', 'Done');
      await chooseStatus(user, 'Reply to Lisa', 'Done');

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, 'That item is locked.')));
      await settle();

      expect(screen.getByText('Reply to Bart')).toBeVisible();
      expect(screen.queryByText('Reply to Lisa')).toBeNull();
      expect(waiting.map((request) => request.payload.itemId)).toEqual([LISA]);
    });

    it('puts the row’s label back and keeps what was typed when a docked title is refused', async () => {
      const user = await show([anItem(BART, 'Reply to Bart')], { form: 'docked', openItem: BART });
      await waitFor(() => expect(titleBox()).toBeVisible());
      await user.clear(titleBox());
      await user.type(titleBox(), 'Reply to Bart today');
      await user.tab();
      expect(within(rowOf('Reply to Bart today')).getByText('Reply to Bart today')).toBeVisible();

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, 'That title is taken.')));
      await settle();

      expect(await screen.findByRole('alert')).toHaveTextContent('That title is taken.');
      expect(titleBox()).toHaveValue('Reply to Bart today');
      expect(within(rowOf('Reply to Bart')).getByText('Reply to Bart')).toBeVisible();
    });

    it('sends every change still queued back with the offline refusal once offline is found', async () => {
      const user = await show([anItem(BART, 'Reply to Bart'), anItem(LISA, 'Reply to Lisa'), anItem(MAGGIE, 'Reply to Maggie')]);
      await tick(user, 'Reply to Bart');
      await tick(user, 'Reply to Lisa');
      await tick(user, 'Reply to Maggie');
      await chooseForAll(user, 'Priority', 'High');
      // The first is out and the other two are queued behind it when the connection is found gone.
      expect(waiting).toHaveLength(1);
      stand({ found: true });

      await answerNext();

      expect(await screen.findByText(/2 not changed. You're working offline/)).toBeVisible();
      expect(within(rowOf('Reply to Bart')).getByLabelText('High priority')).toBeVisible();
      expect(within(rowOf('Reply to Lisa')).queryByLabelText('High priority')).toBeNull();
      expect(within(rowOf('Reply to Maggie')).queryByLabelText('High priority')).toBeNull();
    });
  });
});


const theMark = (title: string) => within(rowOf(title)).queryByText('Duplicate?');

/** Opens a row's menu and chooses Not a duplicate. */
async function saidNotADuplicate(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(within(rowOf(title)).getByLabelText('Item actions'));
  await user.click(await screen.findByRole('menuitem', { name: 'Not a duplicate' }));
}

const BART_AND_LISA = [{ itemId: BART, otherItemId: LISA }];

describe('Triage', () => {
  describe('saying a pair is not a duplicate clears its mark at once, with the server still holding the answer', () => {
    it('takes the mark off both rows when it is chosen from the row’s menu', async () => {
      const user = await show([anItem(BART, 'Reply to Bart'), anItem(LISA, 'Reply to Lisa')], { pairs: BART_AND_LISA });
      expect(theMark('Reply to Bart')).toBeVisible();
      expect(theMark('Reply to Lisa')).toBeVisible();

      await saidNotADuplicate(user, 'Reply to Bart');

      expect(theMark('Reply to Bart')).toBeNull();
      expect(theMark('Reply to Lisa')).toBeNull();
      expect(screen.getByRole('status')).toHaveTextContent('is not a duplicate');
      expect(waiting.map((request) => request.name)).toEqual(['set_duplicate_settled']);
    });

    it('takes the warning from the form, and the marks from the rows, when it is chosen there', async () => {
      const user = await show([anItem(BART, 'Reply to Bart'), anItem(LISA, 'Reply to Lisa')], { pairs: BART_AND_LISA, openItem: BART });
      await user.click(await screen.findByRole('button', { name: 'Keep both: not a duplicate' }));

      expect(screen.queryByText('Possible duplicate · keep which one?')).toBeNull();
      expect(theMark('Reply to Bart')).toBeNull();
      expect(theMark('Reply to Lisa')).toBeNull();
      expect(waiting.map((request) => request.name)).toEqual(['set_duplicate_settled']);
    });

    it('clears every pair of a row flagged against two others when it is chosen from the row’s menu', async () => {
      const user = await show([anItem(BART, 'Reply to Bart'), anItem(LISA, 'Reply to Lisa'), anItem(MAGGIE, 'Reply to Maggie')], {
        pairs: [
          { itemId: BART, otherItemId: LISA },
          { itemId: BART, otherItemId: MAGGIE },
        ],
      });

      await saidNotADuplicate(user, 'Reply to Bart');

      for (const title of ['Reply to Bart', 'Reply to Lisa', 'Reply to Maggie']) expect(theMark(title)).toBeNull();
    });

    it('keeps the mark on a row whose other pair was not the one settled in the form', async () => {
      const user = await show([anItem(BART, 'Reply to Bart'), anItem(LISA, 'Reply to Lisa'), anItem(MAGGIE, 'Reply to Maggie')], {
        pairs: [
          { itemId: BART, otherItemId: LISA },
          { itemId: BART, otherItemId: MAGGIE },
        ],
        openItem: BART,
      });
      await screen.findByText('Possible duplicate · keep which one?');

      await user.click(screen.getAllByRole('button', { name: 'Keep both: not a duplicate' })[0]!);

      // One of the two pairs is settled: Bart, and the note it was settled against, stay flagged by the other.
      expect(theMark('Reply to Bart')).toBeVisible();
      expect(['Reply to Lisa', 'Reply to Maggie'].filter((title) => theMark(title) !== null)).toHaveLength(1);
    });
  });

  describe('Undo brings the mark back at once, with the server still holding the answer', () => {
    it('puts the mark back on both rows when the pair settled from a row’s menu is taken back', async () => {
      const user = await show([anItem(BART, 'Reply to Bart'), anItem(LISA, 'Reply to Lisa')], { pairs: BART_AND_LISA });
      await saidNotADuplicate(user, 'Reply to Bart');
      await answerNext();
      // The read behind the answer has landed, and the pair is not in it.
      expect(theMark('Reply to Bart')).toBeNull();

      await user.click(await screen.findByRole('button', { name: 'Undo' }));

      expect(theMark('Reply to Bart')).toBeVisible();
      expect(theMark('Reply to Lisa')).toBeVisible();
      expect(waiting.map((request) => [request.name, request.payload.settled])).toEqual([['set_duplicate_settled', false]]);
    });

    it('puts the warning back in the form when the pair settled there is taken back', async () => {
      const user = await show([anItem(BART, 'Reply to Bart'), anItem(LISA, 'Reply to Lisa')], { pairs: BART_AND_LISA, openItem: BART });
      await screen.findByText('Possible duplicate · keep which one?');
      await user.click(screen.getByRole('button', { name: 'Keep both: not a duplicate' }));
      await answerNext();
      expect(screen.queryByText('Possible duplicate · keep which one?')).toBeNull();

      // The open form is a dialog, which hides what is behind it from the accessibility tree and from a pointer
      // here (the bar takes presses itself, styles.css); so it is pressed directly.
      fireEvent.click(await screen.findByRole('button', { name: 'Undo', hidden: true }));

      expect(screen.getByText('Possible duplicate · keep which one?')).toBeVisible();
    });
  });

  describe('a refused “Not a duplicate” brings the mark back and says why where it says so today', () => {
    it('puts the marks back and says why in the bar when the row’s menu choice is refused', async () => {
      const user = await show([anItem(BART, 'Reply to Bart'), anItem(LISA, 'Reply to Lisa')], { pairs: BART_AND_LISA });
      await saidNotADuplicate(user, 'Reply to Bart');
      expect(theMark('Reply to Bart')).toBeNull();

      await act(async () => waiting.shift()!.refuse(new CommandRefused(404, 'That note was dismissed.')));
      await settle();

      expect(theMark('Reply to Bart')).toBeVisible();
      expect(theMark('Reply to Lisa')).toBeVisible();
      expect(screen.getByRole('status')).toHaveTextContent('is still marked as a possible duplicate. That note was dismissed.');
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    });

    it('puts the warning back and says why in the form when the choice there is refused', async () => {
      const user = await show([anItem(BART, 'Reply to Bart'), anItem(LISA, 'Reply to Lisa')], { pairs: BART_AND_LISA, openItem: BART });
      await screen.findByText('Possible duplicate · keep which one?');
      await user.click(screen.getByRole('button', { name: 'Keep both: not a duplicate' }));
      expect(screen.queryByText('Possible duplicate · keep which one?')).toBeNull();

      await act(async () => waiting.shift()!.refuse(new CommandRefused(404, 'That note was dismissed.')));
      await settle();

      expect(screen.getByText('Possible duplicate · keep which one?')).toBeVisible();
      expect(await screen.findByRole('alert')).toHaveTextContent('That note was dismissed.');
      expect(screen.queryByRole('button', { name: 'Undo', hidden: true })).toBeNull();
    });
  });

  describe('keeping one of two possible duplicates from the warning takes the other from the Inbox at once, with the server still holding the answer', () => {
    const thePair = () => show([anItem(BART, 'Reply to Bart'), anItem(LISA, 'Reply to Lisa')], { pairs: BART_AND_LISA, openItem: BART });
    const keepOn = (heading: string) =>
      within(screen.getByRole('group', { name: heading })).getByRole('button', { name: 'Keep this one' });

    it('takes the other note from the Inbox and the warning from the form, which stays on this note', async () => {
      const user = await thePair();
      await screen.findByText('Possible duplicate · keep which one?');

      await user.click(keepOn('This note (open)'));

      expect(screen.queryByText('Reply to Lisa')).toBeNull();
      expect(screen.queryByText('Possible duplicate · keep which one?')).toBeNull();
      expect(screen.getByLabelText('Title')).toHaveValue('Reply to Bart');
      expect(theMark('Reply to Bart')).toBeNull();
      expect(waiting.map((request) => [request.name, request.payload.itemId, request.payload.dismissed])).toEqual([['set_dismissed', LISA, true]]);
    });

    it('takes this note from the Inbox and opens the other one', async () => {
      const user = await thePair();
      await screen.findByText('Possible duplicate · keep which one?');

      await user.click(keepOn('The other note'));

      expect(screen.queryByText('Reply to Bart')).toBeNull();
      expect(screen.getByText('Reply to Lisa')).toBeVisible();
      expect(opened.item).toBe(LISA);
      expect(waiting.map((request) => [request.name, request.payload.itemId, request.payload.dismissed])).toEqual([['set_dismissed', BART, true]]);
    });

    it('puts the other note back and says why in the bar when keeping this one is refused', async () => {
      const user = await thePair();
      await screen.findByText('Possible duplicate · keep which one?');
      await user.click(keepOn('This note (open)'));

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, 'That note is locked.')));
      await settle();

      expect(within(theInbox()).getByText('Reply to Lisa')).toBeVisible();
      expect(screen.getByText('Possible duplicate · keep which one?')).toBeVisible();
      expect(screen.getByRole('status', { hidden: true })).toHaveTextContent('“Reply to Lisa” was not dismissed. That note is locked.');
      expect(screen.queryByRole('button', { name: 'Undo', hidden: true })).toBeNull();
    });

    it('puts this note back in the Inbox and says why in the bar when keeping the other one is refused', async () => {
      const user = await thePair();
      await screen.findByText('Possible duplicate · keep which one?');
      await user.click(keepOn('The other note'));
      expect(within(theInbox()).queryByText('Reply to Bart')).toBeNull();

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, 'That note is locked.')));
      await settle();

      expect(within(theInbox()).getByText('Reply to Bart')).toBeVisible();
      expect(screen.getByRole('status', { hidden: true })).toHaveTextContent('“Reply to Bart” was not dismissed. That note is locked.');
      expect(screen.queryByRole('button', { name: 'Undo', hidden: true })).toBeNull();
    });
  });
});
