import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  Attachment,
  Filing,
  Item,
  ItemType,
  Panel,
  PossibleDuplicate,
  WorkspaceSnapshot,
} from '@cockpit/shared';
import { attachmentUrl, uploadAttachment } from '../../../src/api/client';
import { DUE_DATE_SETTLES_MS, ItemForm, whatChanged } from '../../../src/components/ItemForm';
import { dueComingFriday, dueSevenDaysOut, dueToday } from '../../../src/dueDateShortcuts';
import { THE_BAR_LASTS_MS, UndoWhatJustHappened } from '../../../src/undo';

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  uploadAttachment: vi.fn(() => Promise.resolve({ ok: true as const, applied: true })),
}));

/**
 * F1: the form's own behaviour and its wiring. What a saved text survives is a
 * real column with a real cap, proved through the real interface in
 * apps/api/tests/integration/http/item-changes.test.ts; what is asked here is
 * what the form sends, and what it does not.
 */

const held = vi.hoisted(() => ({
  items: [] as Item[],
  filings: [] as Filing[],
  itemTypes: [] as ItemType[],
  panels: [] as Panel[],
  dashboards: [] as { id: string; name: string }[],
  duplicates: [] as PossibleDuplicate[],
  attachments: [] as Attachment[],
  itemFormPresentation: 'centered' as 'centered' | 'docked',
  send: vi.fn(() => Promise.resolve({ ok: true as const, applied: true })),
  close: vi.fn(),
  open: vi.fn(),
  reportDocked: vi.fn(),
  quietly: false,
  /** Holds every read of the snapshot until it settles, where a test needs one still in flight. */
  gate: undefined as Promise<void> | undefined,
  settleQuiet: vi.fn(),
  openItemId: 'item-1' as string | undefined,
}));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ workspaceId: 'ws-work' }),
}));

vi.mock('../../../src/itemForm', () => ({
  useItemForm: () => ({ openItemId: held.openItemId, close: held.close }),
  useOpenItem: () => held.open,
  useReportDocked: () => held.reportDocked,
  useQuietOpening: () => () => held.quietly,
  useSettleQuietOpening: () => held.settleQuiet,
}));

/**
 * The description's editor, replaced by a box that takes text and says what is
 * in it. This file is about what the form sends and what it does not; what the
 * editor keeps is tests/unit/description/syntax.test.ts, and when it appears is
 * tests/unit/components/DescriptionBox.test.tsx. Left real, every test here
 * would mount a 115KB editor to type one word into it.
 *
 * **Uncontrolled, like the real one.** Milkdown owns its document once it is
 * made and ignores a new `initial` fed into the same instance
 * (`DescriptionBox.tsx`), so this seeds its own state once at mount and never
 * resyncs - a controlled stand-in would pass every test here whether or not
 * the form actually remounted the box for a reading it filled the boxes with
 * ("Offer the other readings when a captured note says two things", issue
 * 297).
 */
function FakeRichDescription({
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
}

vi.mock('../../../src/description/RichDescription', () => ({
  default: FakeRichDescription,
}));

vi.mock('../../../src/api/queries', () => ({
  useSendCommand: () => held.send,
  snapshotQuery: (workspaceId: string) => ({
    queryKey: [
      'snapshot',
      workspaceId,
      held.items,
      held.filings,
      held.itemTypes,
      held.panels,
      held.dashboards,
      held.duplicates,
      held.attachments,
      held.itemFormPresentation,
    ],
    queryFn: async (): Promise<WorkspaceSnapshot> => {
      await held.gate;
      return {
        items: held.items,
        filings: held.filings,
        itemTypes: held.itemTypes,
        panels: held.panels,
        dashboards: held.dashboards,
        duplicates: held.duplicates,
        attachments: held.attachments,
        itemFormPresentation: held.itemFormPresentation,
      } as unknown as WorkspaceSnapshot;
    },
  }),
}));

function anItem(over: Partial<Item> = {}): Item {
  return {
    id: 'item-1',
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    workspaceDecided: true,
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    capturedMessage: 'Ask Novy about part 11',
    textsSettledAt: null,
    textsProposedAt: null,
    readings: null,
    proposedPanelId: null,
    proposedPanelReason: null,
    sourceResolvedAt: null,
    title: 'Part 11',
    description: null,
    typeId: null,
    nextAction: null,
    completedAt: null,
    priority: null,
    dueDate: null,
    dueDateSetAt: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-12T10:00:00.000Z',
    updatedAt: '2026-08-12T10:00:00.000Z',
    ...over,
  };
}

function aType(id: string, name: string): ItemType {
  return { id, tenantId: 'tenant', name, color: '#000000', position: 0, createdAt: '2026-08-01T00:00:00.000Z' };
}

function anAttachment(over: Partial<Attachment> = {}): Attachment {
  return {
    id: 'attachment-1',
    tenantId: 'tenant',
    itemId: 'item-1',
    filename: 'receipt.png',
    size: 2048,
    contentType: 'image/png',
    createdAt: '2026-09-16T10:00:00.000Z',
    ...over,
  };
}

async function theForm(
  item: Item = anItem(),
  alsoInTheInbox: Item[] = [],
  withUndo = false,
) {
  held.items = [item, ...alsoInTheInbox];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={client}>
      <ItemForm />
    </QueryClientProvider>
  );
  render(withUndo ? <UndoWhatJustHappened>{tree}</UndoWhatJustHappened> : tree);
  await screen.findByLabelText('Title');
  await theEditorHasArrived();
  return userEvent.setup();
}

/**
 * The editor is fetched behind the form, so for a tick the description is the
 * read-only stand-in that says it is coming. Typing into that would be typing
 * into nothing.
 */
async function theEditorHasArrived() {
  await waitFor(() => expect(screen.getByLabelText('Description')).not.toHaveAttribute('readonly'));
}

const titleBox = () => screen.getByLabelText('Title');
const descriptionBox = () => screen.getByLabelText('Description');
const sent = () =>
  held.send.mock.calls.map((call) => (call as unknown as [{ name: string }])[0]);

beforeEach(() => {
  cleanup();
  localStorage.clear();
  held.send.mockClear();
  held.send.mockImplementation(() => Promise.resolve({ ok: true as const, applied: true }));
  held.close.mockClear();
  held.open.mockClear();
  held.reportDocked.mockClear();
  held.quietly = false;
  held.gate = undefined;
  held.filings = [];
  held.itemTypes = [];
  held.panels = [];
  held.dashboards = [];
  held.duplicates = [];
  held.attachments = [];
  held.itemFormPresentation = 'centered';
  held.openItemId = 'item-1';
  vi.mocked(uploadAttachment).mockClear();
  vi.mocked(uploadAttachment).mockResolvedValue({ ok: true as const, applied: true });
});

describe('Item editing', () => {
  describe('saving asks only for what changed', () => {
    // A pure decision over the item and the boxes, so the situations live here
    // rather than being driven through the form one keystroke at a time.
    it.each([
      {
        situation: 'the title edited and nothing else',
        draft: { title: 'Part 12', description: '', priority: null, dueDate: null, typeId: null, done: false },
        asks: { title: 'Part 12' },
      },
      {
        situation: 'the description written and nothing else',
        draft: { title: 'Part 11', description: 'Tolerances', priority: null, dueDate: null, typeId: null, done: false },
        asks: { description: 'Tolerances' },
      },
      {
        situation: 'both',
        draft: { title: 'Part 12', description: 'Tolerances', priority: null, dueDate: null, typeId: null, done: false },
        asks: { title: 'Part 12', description: 'Tolerances' },
      },
      {
        situation: 'neither',
        draft: { title: 'Part 11', description: '', priority: null, dueDate: null, typeId: null, done: false },
        asks: {},
      },
      // Adding a space to the end of a title is not a change to the title: the
      // space would not be stored either.
      {
        situation: 'a title with a space added to the end',
        draft: { title: 'Part 11 ', description: '', priority: null, dueDate: null, typeId: null, done: false },
        asks: {},
      },
      // Emptied is cleared, and there is no third state to send.
      {
        situation: 'a description emptied',
        stored: { title: 'Part 11', description: 'Tolerances', priority: null, dueDate: null, typeId: null, done: false },
        draft: { title: 'Part 11', description: '   ', priority: null, dueDate: null, typeId: null, done: false },
        asks: { description: null },
      },
      {
        situation: 'a description that was never there and is still empty',
        draft: { title: 'Part 11', description: '', priority: null, dueDate: null, typeId: null, done: false },
        asks: {},
      },
      {
        situation: 'the priority changed and nothing else',
        draft: { title: 'Part 11', description: '', priority: 'high' as const, dueDate: null, typeId: null, done: false },
        asks: { priority: 'high' },
      },
      {
        situation: 'the priority cleared to none',
        stored: { title: 'Part 11', description: '', priority: 'low' as const, dueDate: null, typeId: null, done: false },
        draft: { title: 'Part 11', description: '', priority: null, dueDate: null, typeId: null, done: false },
        asks: { priority: null },
      },
      {
        situation: 'a priority left as it was',
        stored: { title: 'Part 11', description: '', priority: 'normal' as const, dueDate: null, typeId: null, done: false },
        draft: { title: 'Part 11', description: '', priority: 'normal' as const, dueDate: null, typeId: null, done: false },
        asks: {},
      },
      {
        situation: 'a due date set on an item that had none',
        draft: { title: 'Part 11', description: '', priority: null, dueDate: '2026-09-30', typeId: null, done: false },
        asks: { dueDate: '2026-09-30' },
      },
      {
        situation: 'a due date changed to another date',
        stored: { title: 'Part 11', description: '', priority: null, dueDate: '2026-09-30', typeId: null, done: false },
        draft: { title: 'Part 11', description: '', priority: null, dueDate: '2026-10-15', typeId: null, done: false },
        asks: { dueDate: '2026-10-15' },
      },
      {
        situation: 'a due date cleared',
        stored: { title: 'Part 11', description: '', priority: null, dueDate: '2026-09-30', typeId: null, done: false },
        draft: { title: 'Part 11', description: '', priority: null, dueDate: null, typeId: null, done: false },
        asks: { dueDate: null },
      },
      {
        situation: 'the type changed and nothing else',
        stored: { title: 'Part 11', description: '', priority: null, dueDate: null, typeId: 'task', done: false },
        draft: { title: 'Part 11', description: '', priority: null, dueDate: null, typeId: 'idea', done: false },
        asks: { typeId: 'idea' },
      },
      {
        situation: 'a type left as it was',
        stored: { title: 'Part 11', description: '', priority: null, dueDate: null, typeId: 'task', done: false },
        draft: { title: 'Part 11', description: '', priority: null, dueDate: null, typeId: 'task', done: false },
        asks: {},
      },
      {
        situation: 'the status set to done',
        draft: { title: 'Part 11', description: '', priority: null, dueDate: null, typeId: null, done: true },
        asks: { done: true },
      },
      {
        situation: 'a due date left as it was',
        stored: { title: 'Part 11', description: '', priority: null, dueDate: '2026-09-30', typeId: null, done: false },
        draft: { title: 'Part 11', description: '', priority: null, dueDate: '2026-09-30', typeId: null, done: false },
        asks: {},
      },
    ])('$situation', ({ stored, draft, asks }) => {
      expect(
        whatChanged(
          stored ?? { title: 'Part 11', description: '', priority: null, dueDate: null, typeId: null, done: false },
          draft,
        ),
      ).toEqual(asks);
    });

    it('sends a change for each box that moved, and closes', async () => {
      const user = await theForm();

      await user.clear(titleBox());
      await user.type(titleBox(), 'Part 12');
      await user.type(descriptionBox(), 'Tolerances');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
      expect(sent().map((change) => change.name)).toEqual(['set_title', 'set_description']);
    });

    // Against the live item this inverted: an edit arriving while the form was
    // open moved the item and not the untouched box, so Save read the box as
    // edited and wrote the value it was opened with back over the newer one.
    it('leaves a box alone that only the world changed, not the person', async () => {
      held.items = [anItem()];
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      // A fresh element each time: passing the identical one back lets React
      // bail out of the re-render, and the query never sees its new key.
      const shell = () => (
        <QueryClientProvider client={client}>
          <ItemForm />
        </QueryClientProvider>
      );
      const { rerender } = render(shell());
      await screen.findByLabelText('Title');
      await theEditorHasArrived();
      const user = userEvent.setup();
      await user.type(descriptionBox(), 'Tolerances');

      // The title moves underneath, as a change from another device does when
      // it arrives over the live updates stream. The box is not refilled - that
      // is deliberate, so nothing typed is lost - so the title in it is now the
      // one the form opened with rather than the one the item carries.
      held.items = [anItem({ title: 'Renamed elsewhere' })];
      rerender(shell());
      await waitFor(() => expect(screen.getByRole('heading')).toHaveTextContent('Renamed elsewhere'));
      expect(titleBox()).toHaveValue('Part 11');

      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
      // The description only. A title change here would put 'Part 11' back over
      // the rename nobody in this form asked to undo.
      expect(sent().map((change) => change.name)).toEqual(['set_description']);
    });

    it('sends nothing at all when nothing was touched', async () => {
      const user = await theForm();

      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
      expect(held.send).not.toHaveBeenCalled();
    });
  });

  /**
   * "Show and edit an item's priority" (issue 433): a third field beside
   * title and description, sent only on Save and only when it moved - the
   * same rule the boxes above already follow.
   */
  describe('priority is edited from the form', () => {
    const priorityBox = () => screen.getByLabelText('Priority');

    it('opens with the item’s own priority selected', async () => {
      await theForm(anItem({ priority: 'high' }));

      expect(priorityBox()).toHaveValue('high');
    });

    it('opens with none selected for an item with no priority', async () => {
      await theForm(anItem({ priority: null }));

      expect(priorityBox()).toHaveValue('');
    });

    it('sends only a priority change when only the priority changed', async () => {
      const user = await theForm(anItem({ priority: null }));

      await user.selectOptions(priorityBox(), 'high');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
      expect(sent().map((change) => change.name)).toEqual(['set_priority']);
      expect(sent()[0]).toMatchObject({ payload: { priority: 'high' } });
    });

    it('sends a priority change alongside whichever other fields changed', async () => {
      const user = await theForm(anItem({ priority: null }));

      await user.clear(titleBox());
      await user.type(titleBox(), 'Part 12');
      await user.selectOptions(priorityBox(), 'low');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
      expect(sent().map((change) => change.name)).toEqual(['set_title', 'set_priority']);
    });

    it('sends a priority change of null for “None” on an item that has one', async () => {
      const user = await theForm(anItem({ priority: 'normal' }));

      await user.selectOptions(priorityBox(), 'None');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
      expect(sent().map((change) => change.name)).toEqual(['set_priority']);
      expect(sent()[0]).toMatchObject({ payload: { priority: null } });
    });
  });

  /**
   * "Show and set an item's due date" (issue 462): a fourth field beside
   * title, description and priority, sent only on Save and only when it
   * moved - the same rule the boxes above already follow.
   */
  describe('due date is edited from the form', () => {
    const dueDateBox = () => screen.getByLabelText('Due date');

    it('opens with the item’s own due date filled in', async () => {
      await theForm(anItem({ dueDate: '2026-09-30' }));

      expect(dueDateBox()).toHaveValue('2026-09-30');
    });

    it('opens empty for an item with no due date', async () => {
      await theForm(anItem({ dueDate: null }));

      expect(dueDateBox()).toHaveValue('');
    });

    it('sends only a due date change when only the due date changed', async () => {
      const user = await theForm(anItem({ dueDate: null }));

      fireEvent.change(dueDateBox(), { target: { value: '2026-09-30' } });
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
      expect(sent().map((change) => change.name)).toEqual(['set_due_date']);
      expect(sent()[0]).toMatchObject({ payload: { dueDate: '2026-09-30' } });
    });

    it('sends a due date change alongside whichever other fields changed', async () => {
      const user = await theForm(anItem({ dueDate: null }));

      await user.clear(titleBox());
      await user.type(titleBox(), 'Part 12');
      fireEvent.change(dueDateBox(), { target: { value: '2026-09-30' } });
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
      expect(sent().map((change) => change.name)).toEqual(['set_title', 'set_due_date']);
    });

    it('sends a due date change of null when cleared on an item that has one', async () => {
      const user = await theForm(anItem({ dueDate: '2026-09-30' }));

      fireEvent.change(dueDateBox(), { target: { value: '' } });
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
      expect(sent().map((change) => change.name)).toEqual(['set_due_date']);
      expect(sent()[0]).toMatchObject({ payload: { dueDate: null } });
    });
  });

  /**
   * "Give the item's form more room, and put clutter out of the way" (issue
   * 480): one-click alongside typing one directly. What each shortcut
   * actually computes - the coming Friday never a past one, seven days out -
   * is tests/unit/dueDateShortcuts.test.ts's own claim; what is asked here is
   * that pressing one fills the field with it, overriding whatever was
   * already there, and that typing afterwards still wins.
   */
  describe('setting a due date has one-click shortcuts alongside typing one directly', () => {
    const dueDateBox = () => screen.getByLabelText('Due date');

    it.each([
      { situation: 'Today', button: 'Today', shortcut: dueToday },
      { situation: 'Fri', button: 'Fri', shortcut: dueComingFriday },
      { situation: '+7d', button: '+7d', shortcut: dueSevenDaysOut },
    ])('$situation fills the field, overriding a due date already there', async ({ button, shortcut }) => {
      await theForm(anItem({ dueDate: '2020-01-01' }));

      // The clock pinned, the same reason `ItemRow.test.tsx`'s own waited-time
      // cases pin it: the field and this assertion both read "now" (the
      // component at click time, this expectation right after), and two live
      // `new Date()` calls landing either side of a real day boundary is
      // exactly the flake the testing skill's "inject time" rule exists for.
      // `fireEvent`, not `user.click`, since userEvent's own small delays
      // between event stages block on the real timers fake ones replace.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-18T09:00:00.000Z'));
      try {
        fireEvent.click(screen.getByRole('button', { name: button }));

        expect(dueDateBox()).toHaveValue(shortcut(new Date()));
      } finally {
        vi.useRealTimers();
      }
    });

    it('typing over a shortcut still wins', async () => {
      const user = await theForm(anItem({ dueDate: null }));

      await user.click(screen.getByRole('button', { name: '+7d' }));
      fireEvent.change(dueDateBox(), { target: { value: '2026-01-01' } });

      expect(dueDateBox()).toHaveValue('2026-01-01');
    });
  });

  /**
   * Said rather than shown: the row that opened this form was labelled by the
   * title, and the title box sits directly under the heading, so drawing it
   * would put the same words on the form twice. It is still announced, which is
   * what a dialog has to do.
   */
  describe('the form says which item is open', () => {
    it.each([
      { situation: 'an item with a title', item: {}, named: 'Part 11' },
      // Reachable by clearing a title somebody had written: the captured
      // message does not come back as a name, here or on the row.
      {
        situation: 'an item nobody has named',
        item: { title: '', capturedMessage: 'Ask Novy about part 11' },
        named: 'Untitled',
      },
    ])('$situation', async ({ item, named }) => {
      await theForm(anItem(item));

      expect(screen.getByRole('heading')).toHaveTextContent(named);
    });

    // Said and not drawn, which is the whole point: the title box under it
    // holds the same words, and a heading showing them too is the duplicate
    // this removed. Asserted on the class because a 1px-clipped element is
    // still visible to jsdom, so nothing else here can tell the two apart -
    // that it reads correctly on screen is the walk in
    // tests/e2e/item-editing.test.ts.
    it('does not draw the name it announces', async () => {
      await theForm();

      expect(screen.getByRole('heading')).toHaveClass('sr-only');
    });
  });

  describe('the boxes are closed while a save is in flight', () => {
    // What is sent is worked out before the round trip, so a keystroke landing
    // during it would go into a draft nobody reads and be lost when the form
    // closes - the opposite of the promise the refusal path makes.
    it('takes nothing more while it is saving', async () => {
      const user = await theForm();
      let letItLand: (() => void) | undefined;
      held.send.mockImplementation(
        () =>
          new Promise((settle) => {
            letItLand = () => settle({ ok: true as const, applied: true });
          }),
      );

      await user.type(descriptionBox(), 'Tolerances');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(descriptionBox()).toBeDisabled());
      expect(titleBox()).toBeDisabled();
      letItLand?.();
      await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
    });
  });

  describe('a save that did not land keeps the form open', () => {
    // A change made against an older version of an item is answered with a 200
    // and `applied: false` rather than refused, so a form that read only "it
    // did not throw" would close on it and take what was typed with it.
    it('says the item changed elsewhere, and keeps what was typed', async () => {
      const user = await theForm();
      held.send.mockImplementation(() => Promise.resolve({ ok: true as const, applied: false }));

      await user.type(descriptionBox(), 'Tolerances');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/changed somewhere else/));
      expect(held.close).not.toHaveBeenCalled();
      expect(descriptionBox()).toHaveValue('Tolerances');
    });

    // The two texts are sent one after the other, so the first can land and the
    // second not. A second Save must then send only what is still missing:
    // re-sending a title that is already stored bumps its time and would drop a
    // genuinely newer edit from somewhere else as stale.
    it('asks only for what is still missing when a second save follows a half one', async () => {
      const user = await theForm();
      await user.clear(titleBox());
      await user.type(titleBox(), 'Part 12');
      await user.type(descriptionBox(), 'Tolerances');

      let sends = 0;
      held.send.mockImplementation(() => {
        sends += 1;
        return Promise.resolve({ ok: true as const, applied: sends === 1 });
      });
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

      held.send.mockClear();
      held.send.mockImplementation(() => Promise.resolve({ ok: true as const, applied: true }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
      expect(sent().map((change) => change.name)).toEqual(['set_description']);
    });
  });

  describe('the form shows the item’s type and status, and changes them the way it changes priority', () => {
    const typeBox = () => screen.getByLabelText('Type');
    const statusBox = () => screen.getByLabelText('Status');
    const optionsOf = (box: HTMLElement) =>
      Array.from(box.querySelectorAll('option')).map((option) => option.textContent);
    const TASK = aType('task', 'Task');
    const IDEA = aType('idea', 'Idea');
    const NOTE = aType('note', 'Note');

    describe('the type', () => {
      it('offers every type the account has and selects the one the item is', async () => {
        held.itemTypes = [TASK, IDEA, NOTE];
        await theForm(anItem({ typeId: 'idea' }));

        expect(typeBox()).toHaveValue('idea');
        expect(optionsOf(typeBox()).sort()).toEqual(['Idea', 'Note', 'Task']);
      });

      it.each([
        { situation: 'its type was deleted', typeId: 'gone' },
        { situation: 'it never had one', typeId: null },
      ])('shows “No type”, selected, where $situation', async ({ typeId }) => {
        held.itemTypes = [TASK, IDEA];
        await theForm(anItem({ typeId }));

        expect(typeBox()).toHaveValue('');
        expect(optionsOf(typeBox())).toContain('No type');
      });

      it('stops offering “No type” once a type is picked', async () => {
        held.itemTypes = [TASK, IDEA];
        const user = await theForm(anItem({ typeId: null }));

        await user.selectOptions(typeBox(), 'Idea');

        expect(optionsOf(typeBox())).not.toContain('No type');
      });

      it('offers the types used last first, the rest in their own order', async () => {
        held.itemTypes = [TASK, IDEA, NOTE];
        await theForm(
          anItem({ id: 'item-1', typeId: 'task' }),
          [anItem({ id: 'item-2', typeId: 'note' })],
        );

        expect(optionsOf(typeBox())).toEqual(['Note', 'Task', 'Idea']);
      });

      it('sends only a type change when only the type changed, with the other changed fields', async () => {
        held.itemTypes = [TASK, IDEA];
        const user = await theForm(anItem({ typeId: 'task' }));

        await user.selectOptions(typeBox(), 'Idea');
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
        expect(sent().map((change) => change.name)).toEqual(['set_item_type']);
        expect(sent()[0]).toMatchObject({ payload: { typeId: 'idea' } });
      });

      it('sends nothing for a type left alone', async () => {
        held.itemTypes = [TASK, IDEA];
        const user = await theForm(anItem({ typeId: 'task' }));

        await user.type(descriptionBox(), 'Notes');
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
        expect(sent().map((change) => change.name)).toEqual(['set_description']);
      });

      it('refuses, saying the item changed elsewhere, and keeps the form open', async () => {
        held.itemTypes = [TASK, IDEA];
        const user = await theForm(anItem({ typeId: 'task' }));
        held.send.mockResolvedValueOnce({ ok: true as const, applied: false });

        await user.selectOptions(typeBox(), 'Idea');
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() =>
          expect(screen.getByRole('alert')).toHaveTextContent(/changed somewhere else/),
        );
        expect(held.close).not.toHaveBeenCalled();
      });
    });

    describe('the status', () => {
      it.each([
        { situation: 'an open item', completedAt: null, shown: 'open' },
        { situation: 'a finished item', completedAt: '2026-09-01T08:00:00.000Z', shown: 'done' },
      ])('selects the one $situation is', async ({ completedAt, shown }) => {
        await theForm(anItem({ completedAt }));

        expect(statusBox()).toHaveValue(shown);
      });

      it('offers to deal with and done, and never dismissed', async () => {
        await theForm();

        expect(optionsOf(statusBox())).toEqual(['To deal with', 'Done']);
      });

      it('sends a finish, alone, on Save', async () => {
        const user = await theForm();

        await user.selectOptions(statusBox(), 'Done');
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
        expect(sent().map((change) => change.name)).toEqual(['set_done']);
        expect(sent()[0]).toMatchObject({ payload: { done: true } });
      });

      it('sends the way back for a finished item set to be dealt with', async () => {
        const user = await theForm(anItem({ completedAt: '2026-09-01T08:00:00.000Z' }));

        await user.selectOptions(statusBox(), 'To deal with');
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
        expect(sent()[0]).toMatchObject({ name: 'set_done', payload: { done: false } });
      });
    });

    describe('a refusal of one of them', () => {
      it('leaves the form open, names the refusal, and moves the baseline for the one that landed', async () => {
        held.itemTypes = [TASK, IDEA];
        const user = await theForm(anItem({ typeId: 'task' }));
        held.send
          .mockResolvedValueOnce({ ok: true as const, applied: true })
          .mockRejectedValueOnce(new Error('Too many requests'));

        await user.selectOptions(typeBox(), 'Idea');
        await user.selectOptions(statusBox(), 'Done');
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Too many requests/));
        expect(held.close).not.toHaveBeenCalled();

        held.send.mockClear();
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
        expect(sent().map((change) => change.name)).toEqual(['set_done']);
      });
    });
  });

  describe('the form lists where the item is shown, read-only, at the bottom of Details', () => {
    const detailsTab = async (user: ReturnType<typeof userEvent.setup>) =>
      user.click(screen.getByRole('tab', { name: 'Details' }));

    it('names the dashboard and panel it is filed on, and puts the list last', async () => {
      held.dashboards = [{ id: 'd1', name: 'Work' }];
      held.panels = [{ id: 'p1', tenantId: 't', dashboardId: 'd1', name: 'Falcon', kind: 'items', format: 'plain', body: '', readOnly: false, filter: null }];
      held.filings = [{ panelId: 'p1', itemId: 'item-1', position: 0 }];
      const user = await theForm();

      await detailsTab(user);

      const heading = screen.getByText('Shown on');
      expect(heading.closest('dl')?.lastElementChild).toBe(heading.parentElement);
      expect(screen.getByText('Work › Falcon')).toBeVisible();
      expect(heading.parentElement?.querySelector('button, input, select')).toBeNull();
    });

    it('says the inbox where it is filed nowhere', async () => {
      const user = await theForm();

      await detailsTab(user);

      expect(screen.getByText('Inbox')).toBeVisible();
    });

    it('says a finished item is not shown on any panel', async () => {
      const user = await theForm(anItem({ completedAt: '2026-09-01T08:00:00.000Z' }));

      await detailsTab(user);

      expect(screen.getByText(/not shown on any panel while it is done/i)).toBeVisible();
    });
  });

  describe('the form is the item the address names, and no other', () => {
    // Going from one item's form straight to another's - a pasted link, a step
    // through history - kept the first item's boxes, and Save then wrote its
    // text onto the second.
    it('starts again from the item now named', async () => {
      held.items = [anItem(), anItem({ id: 'item-2', title: 'Part 12', description: 'Its own' })];
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { rerender } = render(
        <QueryClientProvider client={client}>
          <ItemForm />
        </QueryClientProvider>,
      );
      await screen.findByLabelText('Title');
      await theEditorHasArrived();
      expect(titleBox()).toHaveValue('Part 11');

      held.openItemId = 'item-2';
      rerender(
        <QueryClientProvider client={client}>
          <ItemForm />
        </QueryClientProvider>,
      );

      await waitFor(() => expect(titleBox()).toHaveValue('Part 12'));
      await theEditorHasArrived();
      expect(descriptionBox()).toHaveValue('Its own');
    });

    // The same swap, but for the size rather than the boxes: nothing here
    // ever calls Cancel or Save on the first item, which is exactly the path
    // a fix hung off either of those would miss a drag on.
    it('remembers a size dragged on the item it is swapped away from, not only on Cancel or Save', async () => {
      held.items = [anItem(), anItem({ id: 'item-2', title: 'Part 12', description: 'Its own' })];
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      // Stands in for the browser's own layout - a full `DOMRect` shape, since
      // the component reads `right`/`bottom` off it to recognise a press in
      // the handle's own corner.
      let rect = { width: 900, height: 700, top: 0, left: 0, right: 900, bottom: 700, x: 0, y: 0 };
      const measuring = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(() => rect as DOMRect);

      // Restored even if an assertion below throws - left in place, the stub
      // would go on returning a fake rect for every element in every test
      // that runs after this one in the file.
      try {
        const { rerender } = render(
          <QueryClientProvider client={client}>
            <ItemForm />
          </QueryClientProvider>,
        );
        await screen.findByLabelText('Title');
        await theEditorHasArrived();

        // A press inside the handle's own corner, and the release that ends
        // it - the two checkpoints the component settles a drag between.
        fireEvent.mouseDown(screen.getByRole('dialog'), { clientX: 895, clientY: 695 });
        rect = { width: 500, height: 400, top: 0, left: 0, right: 500, bottom: 400, x: 0, y: 0 };
        fireEvent.mouseUp(window);

        held.openItemId = 'item-2';
        rerender(
          <QueryClientProvider client={client}>
            <ItemForm />
          </QueryClientProvider>,
        );

        await waitFor(() => expect(localStorage.getItem('cockpit.item-form-size')).not.toBeNull());
        expect(JSON.parse(localStorage.getItem('cockpit.item-form-size')!)).toEqual({
          width: 500,
          height: 400,
        });
        // Read back by the very form it was swapped into, not only written -
        // the write and this read are on either side of the same swap, so a
        // read landing before the write on a real commit would open item-2
        // at the old size and only catch up from its *next* open.
        await waitFor(() =>
          expect(screen.getByRole('dialog')).toHaveStyle({ width: '500px', height: '400px' }),
        );
      } finally {
        measuring.mockRestore();
      }
    });
  });

  describe('closing the form without saving changes nothing', () => {
    it.each([
      { situation: 'Cancel', close: async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Cancel' })) },
      { situation: 'Escape', close: async (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}') },
    ])('$situation asks for nothing and leaves', async ({ close }) => {
      const user = await theForm();
      await user.type(descriptionBox(), 'Something typed and then abandoned');

      await close(user);

      expect(held.send).not.toHaveBeenCalled();
      expect(held.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('a text too long to store is refused before it is sent', () => {
    it.each([
      { situation: 'a title over the cap', box: 'Title', typed: 'x'.repeat(201) },
      { situation: 'a description over the cap', box: 'Description', typed: 'x'.repeat(60_001) },
    ])('$situation', async ({ box, typed }) => {
      const user = await theForm();
      const field = screen.getByLabelText(box);
      await user.clear(field);
      // `paste` rather than `type`: sixty thousand keystrokes is not a test.
      await user.click(field);
      await user.paste(typed);

      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(held.send).not.toHaveBeenCalled();
    });

    // The read model lets a title from before the cap existed through on
    // purpose, so such an item opens this form with an over-cap title in the
    // box. Measured over the whole draft, that disabled Save outright and
    // refused an edit to the description for a title nothing was going to send.
    it('lets a description be written on an item whose stored title is over the cap', async () => {
      const user = await theForm(anItem({ title: 'x'.repeat(500) }));

      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
      await user.type(descriptionBox(), 'Tolerances');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
      expect(sent().map((change) => change.name)).toEqual(['set_description']);
    });
  });

  /**
   * "Offer the other readings when a captured note says two things" (issue
   * 297): choosing a reading only fills the two boxes, exactly as typing it in
   * by hand would - it is Save that sends anything.
   */
  describe('the other readings offer to fill the two boxes, and nothing else', () => {
    // Each reading's own description differs from the item's stored one and
    // from the other reading's - so a test that reads back the empty string
    // both before and after a pick cannot pass by accident, the way one that
    // reused '' for everything did.
    const READINGS = [
      { title: 'Call Jan', description: 'Ring Jan about the invoice.', meaning: "'jan' is a person's name" },
      {
        title: 'Call in January',
        description: 'Ring in January about the invoice.',
        meaning: "'jan' is short for January",
      },
    ];

    it('shows nothing where the note had only the one reading', async () => {
      await theForm(anItem({ readings: null }));

      expect(screen.queryByText('Reads more than one way')).toBeNull();
    });

    it('offers each reading, and filling the boxes from one sends nothing on its own', async () => {
      const user = await theForm(
        anItem({ title: 'Call Jan', description: 'Mine already', readings: READINGS }),
      );

      await user.click(screen.getByRole('button', { name: /Call in January/ }));

      expect(titleBox()).toHaveValue('Call in January');
      // The box itself, not only the draft it is bound to - the editor is
      // uncontrolled and ignores a prop change once it has mounted
      // (`DescriptionBox.tsx`, "Milkdown owns its document"), so replacing
      // what it shows needs the form to remount it rather than merely
      // re-render it with a new value.
      expect(descriptionBox()).toHaveValue('Ring in January about the invoice.');
      expect(held.send).not.toHaveBeenCalled();
    });

    it('sends what a chosen reading filled the boxes with, once Save is pressed', async () => {
      const user = await theForm(
        anItem({ title: 'Call Jan', description: 'Mine already', readings: READINGS }),
      );

      await user.click(screen.getByRole('button', { name: /Call in January/ }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
      expect(sent()).toContainEqual(
        expect.objectContaining({ name: 'set_title', payload: expect.objectContaining({ title: 'Call in January' }) }),
      );
      expect(sent()).toContainEqual(
        expect.objectContaining({
          name: 'set_description',
          payload: expect.objectContaining({ description: 'Ring in January about the invoice.' }),
        }),
      );
    });

    it('says nothing about the other readings once the texts are already yours', async () => {
      await theForm(anItem({ readings: READINGS, textsSettledAt: '2026-08-12T10:00:00.000Z' }));

      expect(screen.queryByText('Reads more than one way')).toBeNull();
    });
  });

  /**
   * "Flag a captured note that says what another one already said" (issue 407):
   * the row says only that there may be one, and the form is where the other
   * note is named and can be opened. Which notes are paired at all is the
   * server's answer (apps/api/tests/integration/http/duplicate-notes.test.ts)
   * and whether a pair is drawn is tests/unit/duplicates.test.ts; what is asked
   * here is that the form draws what it is given and opens what it draws.
   */
  describe('the form says which note this one may be repeating, and opens it', () => {
    const ANOTHER_NOTE = anItem({ id: 'item-2', title: 'Part 11 audit trail, for Novy' });
    const A_THIRD_NOTE = anItem({ id: 'item-3', title: 'Novy and the audit trail' });

    it('lists each one, and opens the one that is chosen', async () => {
      held.duplicates = [
        { itemId: 'item-1', otherItemId: ANOTHER_NOTE.id },
        { itemId: A_THIRD_NOTE.id, otherItemId: 'item-1' },
      ];
      const user = await theForm(anItem(), [ANOTHER_NOTE, A_THIRD_NOTE]);

      expect(screen.getByText('Possible duplicate of')).toBeVisible();
      // Both of them, including the pair written the other way round - one pair
      // is one pair whichever of the two you are looking at.
      await user.click(screen.getByRole('button', { name: 'Part 11 audit trail, for Novy' }));

      expect(held.open).toHaveBeenCalledWith(ANOTHER_NOTE.id);
      expect(screen.getByRole('button', { name: 'Novy and the audit trail' })).toBeVisible();
    });

    it('says nothing where this note repeats none', async () => {
      await theForm(anItem(), [ANOTHER_NOTE]);

      expect(screen.queryByText('Possible duplicate of')).toBeNull();
    });

    /**
     * Every other test in this describe block leaves both halves in the
     * Inbox, which is the one case that predates issue 410 and tells
     * nothing about the asymmetric rule it added - a filed item's own form
     * showing what it repeats is a capability this test file has otherwise
     * never exercised.
     */
    it('shows a note this one repeats even once both are filed', async () => {
      held.filings = [
        { panelId: 'pn-1', itemId: 'item-1', position: 0 },
        { panelId: 'pn-1', itemId: ANOTHER_NOTE.id, position: 1 },
      ];
      held.duplicates = [{ itemId: 'item-1', otherItemId: ANOTHER_NOTE.id }];
      await theForm(anItem(), [ANOTHER_NOTE]);

      expect(screen.getByText('Possible duplicate of')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Part 11 audit trail, for Novy' })).toBeVisible();
    });
  });

  /**
   * "Say a flagged pair is not a duplicate" (issue 408): each linked note gets
   * its own way to settle the pair it names, distinct from opening it - and
   * settling offers the way back the same bar every other change does.
   */
  describe('settling a pair as not a duplicate', () => {
    const ANOTHER_NOTE = anItem({ id: 'item-2', title: 'Part 11 audit trail, for Novy' });

    it('settles the pair this link names, not the one this form is', async () => {
      held.duplicates = [{ itemId: 'item-1', otherItemId: ANOTHER_NOTE.id }];
      const user = await theForm(anItem(), [ANOTHER_NOTE]);

      await user.click(screen.getByRole('button', { name: 'Not a duplicate' }));

      expect(sent()).toContainEqual(
        expect.objectContaining({
          name: 'set_duplicate_settled',
          payload: expect.objectContaining({
            itemId: 'item-1',
            otherItemId: ANOTHER_NOTE.id,
            settled: true,
          }),
        }),
      );
      // The link to the other note is untouched - settling is not opening it.
      expect(held.open).not.toHaveBeenCalled();
    });

    it('says so, and offers no undo, where settling is refused', async () => {
      held.duplicates = [{ itemId: 'item-1', otherItemId: ANOTHER_NOTE.id }];
      held.send.mockRejectedValueOnce(new Error('That did not reach the server. Try again.'));
      const user = await theForm(anItem(), [ANOTHER_NOTE]);

      await user.click(screen.getByRole('button', { name: 'Not a duplicate' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('That did not reach the server');
      expect(screen.queryByRole('status')).toBeNull();
    });

    /**
     * The bar itself is `UndoWhatJustHappened`'s own (`tests/unit/undo.test.tsx`);
     * what is asked here is that settling from the form offers *this* change's
     * inverse.
     *
     * **Found by text and clicked by `fireEvent`, not by role and `user.click`.**
     * The form is a Radix `Dialog`, which marks every sibling outside itself
     * `aria-hidden` while it is open - this bar included, since it is mounted
     * above the router rather than inside the dialog. A real browser still
     * lets a mouse reach it (`pointer-events-auto`, undo.tsx, proved by hand
     * in the browser pass this issue's own definition of done requires), but
     * `user.click` deliberately refuses to interact with anything under an
     * `aria-hidden` ancestor - correctly, since a screen reader could not
     * reach it either, which is the one part of this still open as a
     * follow-up. `fireEvent` proves the wiring - that settling from the form
     * offers this change's own inverse - without asserting reachability this
     * tier cannot honestly claim either way.
     */
    it('offers the way back, which settles it false again', async () => {
      held.duplicates = [{ itemId: 'item-1', otherItemId: ANOTHER_NOTE.id }];
      const user = await theForm(anItem(), [ANOTHER_NOTE], true);

      await user.click(screen.getByRole('button', { name: 'Not a duplicate' }));

      const undo = await screen.findByText('Undo');
      held.send.mockClear();
      fireEvent.click(undo);

      expect(sent()).toContainEqual(
        expect.objectContaining({
          name: 'set_duplicate_settled',
          payload: expect.objectContaining({
            itemId: 'item-1',
            otherItemId: ANOTHER_NOTE.id,
            settled: false,
          }),
        }),
      );
    });
  });

  /**
   * "Attach a file to an item" (issue 441). What actually lands in R2 and
   * comes back on a real download is proved through the real interface in
   * apps/api/tests/integration/http/attachments.test.ts; what is asked here
   * is what the form draws from the snapshot it is handed, and what
   * removing sends.
   */
  describe('the files attached to an item', () => {
    it('shows only this item’s own, each opening its own address', async () => {
      held.attachments = [
        anAttachment(),
        anAttachment({ id: 'attachment-2', itemId: 'item-2', filename: 'other.pdf' }),
      ];
      await theForm(anItem({ id: 'item-1' }), [anItem({ id: 'item-2' })]);

      expect(screen.getByText('receipt.png')).toBeVisible();
      expect(screen.queryByText('other.pdf')).toBeNull();
      expect(screen.getByRole('link', { name: /receipt\.png/ })).toHaveAttribute(
        'href',
        attachmentUrl('attachment-1'),
      );
    });

    it('says nothing is there where nothing is attached', async () => {
      await theForm(anItem());

      expect(screen.getByText('Drag a file here, or')).toBeVisible();
    });

    it('the remove control sends a remove for this attachment, this item', async () => {
      held.attachments = [anAttachment()];
      const user = await theForm(anItem({ id: 'item-1' }));

      await user.click(screen.getByRole('button', { name: 'Remove receipt.png' }));

      expect(sent()).toContainEqual(
        expect.objectContaining({
          name: 'remove_attachment',
          payload: expect.objectContaining({ itemId: 'item-1', attachmentId: 'attachment-1' }),
        }),
      );
    });

    /**
     * A bug caught in review: an earlier version cleared the refusal the
     * moment the *next* file in the same drop succeeded, which a case
     * rejecting only one file at a time could never catch.
     */
    it('keeps the refusal visible when another file in the same drop succeeds', async () => {
      const user = await theForm(anItem({ id: 'item-1' }));
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      const rejected = new File(['just words'], 'notes.txt', { type: 'text/plain' });
      const accepted = new File(['bytes'], 'receipt.png', { type: 'image/png' });

      await user.upload(input, [rejected, accepted]);

      await waitFor(() =>
        expect(uploadAttachment).toHaveBeenCalledWith(expect.objectContaining({ file: accepted })),
      );
      expect(screen.getByRole('alert')).toHaveTextContent(
        '"notes.txt" is not a kind of file Cockpit accepts.',
      );
      expect(uploadAttachment).toHaveBeenCalledTimes(1);
    });
  });

  /** "Open an Item at its source", issue 487. */
  describe('the form says where an item came from and offers the way back to it', () => {
    const link = 'https://teams.example/l/message/1';

    it('names the source and sender, and opens the original in a new tab', async () => {
      await theForm(anItem({ source: 'teams', sender: 'Anna', sourceLink: link }));

      expect(screen.getByText(/From Microsoft Teams - Anna/)).toBeInTheDocument();
      const opener = screen.getByRole('link', { name: 'Open in Microsoft Teams' });
      expect(opener).toHaveAttribute('href', link);
      expect(opener).toHaveAttribute('target', '_blank');
    });

    it('says nothing for an item of your own', async () => {
      await theForm(anItem({ sender: 'Anna', sourceLink: link }));

      expect(screen.queryByText(/^From /)).toBeNull();
      expect(screen.queryByRole('link')).toBeNull();
    });

    it.each([
      { situation: 'a source that never gave a link', sourceLink: null },
      { situation: 'a link that is not a web address', sourceLink: 'javascript:alert(1)' },
    ])('names the source but offers no link for $situation', async ({ sourceLink }) => {
      await theForm(anItem({ source: 'teams' as const, sender: 'Anna', sourceLink }));

      expect(screen.getByText(/From Microsoft Teams - Anna/)).toBeInTheDocument();
      expect(screen.queryByRole('link')).toBeNull();
    });
  });

  describe('the technical record is on a tab of its own, and not on the form', () => {
    it('shows the form first, and the captured message only once Details is asked for', async () => {
      const user = await theForm();

      expect(screen.getByRole('tab', { name: 'Item', selected: true })).toBeInTheDocument();
      expect(screen.queryByText('Ask Novy about part 11')).toBeNull();

      await user.click(screen.getByRole('tab', { name: 'Details' }));

      expect(screen.getByText('Ask Novy about part 11')).toBeVisible();
      // A record, not a control: there is no box to put a cursor in.
      expect(screen.queryByLabelText('Captured message')).toBeNull();
    });

    it('says nothing about a captured message where nothing was captured', async () => {
      const user = await theForm(anItem({ capturedMessage: null }));

      await user.click(screen.getByRole('tab', { name: 'Details' }));

      expect(screen.queryByText('Captured message')).toBeNull();
    });

    it('keeps what was typed on the form while Details is showing', async () => {
      const user = await theForm();

      await user.type(screen.getByLabelText('Title'), ' extra');
      await user.click(screen.getByRole('tab', { name: 'Details' }));
      await user.click(screen.getByRole('tab', { name: 'Item' }));

      expect(screen.getByLabelText('Title')).toHaveValue(`${anItem().title} extra`);
    });

    it('moves between the tabs with the arrow keys', async () => {
      const user = await theForm();

      screen.getByRole('tab', { name: 'Item' }).focus();
      await user.keyboard('{ArrowRight}');

      expect(screen.getByRole('tab', { name: 'Details', selected: true })).toHaveFocus();
    });
  });

  /**
   * "See the history of what Cockpit proposed for the Inbox's items" (issue
   * 444): an item's id is what a rewrite-history row identifies it by, since
   * its title is the very thing a rewrite changes - so the form shows it in
   * full, with a way to copy it.
   */
  describe("an item's own id is shown in full, with a way to copy it", () => {
    it('stays off the form until Details is asked for, then shows the id whole and copies exactly it', async () => {
      const user = await theForm();

      const writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

      expect(screen.queryByText('item-1')).toBeNull();

      await user.click(screen.getByRole('tab', { name: 'Details' }));

      expect(screen.getByText('item-1')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Copy' }));

      expect(writeText).toHaveBeenCalledWith('item-1');
    });
  });

  describe('an item that is not there is said to be gone rather than drawn empty', () => {
    it('says so, and offers nothing to save', async () => {
      held.items = [];
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <ItemForm />
        </QueryClientProvider>,
      );

      expect(await screen.findByText('That item is not here any more.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });

    // The dock is moved to a note the instant it is captured, before the re-read
    // that carries it lands: that beat is "not here yet", not "gone" (found in
    // review).
    it('says it is opening, not gone, for a note just captured while the read that brings it is in flight', async () => {
      held.items = [anItem()];
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const shell = () => (
        <QueryClientProvider client={client}>
          <ItemForm />
        </QueryClientProvider>
      );
      const { rerender } = render(shell());
      await screen.findByLabelText('Title');

      let arrive: () => void = () => {};
      held.gate = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      held.openItemId = 'item-2';
      held.quietly = true;
      // Not awaited: the refetch is what waits on the gate.
      act(() => {
        void client.invalidateQueries();
      });
      rerender(shell());

      expect(screen.queryByText('That item is not here any more.')).toBeNull();
      expect(screen.getByText('Opening…')).toBeInTheDocument();

      held.items = [anItem(), anItem({ id: 'item-2', title: 'Just captured' })];
      await act(async () => arrive());

      await waitFor(() => expect(titleBox()).toHaveValue('Just captured'));
    });

    // A note that really is gone stays gone: an unrelated refetch of the
    // snapshot - any command, any collaborator's change - must not flicker it
    // back to "Opening…" (found in review).
    it('does not go back to opening on a later re-read, for a note that is really gone', async () => {
      held.items = [anItem()];
      held.openItemId = 'item-2';
      held.quietly = true;
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const shell = () => (
        <QueryClientProvider client={client}>
          <ItemForm />
        </QueryClientProvider>
      );
      render(shell());
      expect(await screen.findByText('That item is not here any more.')).toBeInTheDocument();

      held.gate = new Promise<void>(() => {});
      act(() => {
        void client.invalidateQueries();
      });

      expect(screen.getByText('That item is not here any more.')).toBeInTheDocument();
      expect(screen.queryByText('Opening…')).toBeNull();
    });
  });

  /**
   * The dialog used to size itself to what was inside it, which is what made
   * the editor's arrival visibly shrink the box the instant its fixed
   * twelve-row placeholder was replaced ("Fix the item form's resize jank, and
   * let it be resized", issue 295). What is asked here is that nothing about
   * the frame - its class or its inline size - moves as what is inside it
   * does; that a person can actually drag it to a size and get it back is a
   * real pointer and a real layout, so it is proved in
   * tests/e2e/item-editing.test.ts instead.
   */
  describe('the dialog frame does not react to what is typed or loaded inside it', () => {
    /** The two things that decide how big the dialog is drawn. */
    const frameSize = (dialog: HTMLElement) => ({
      className: dialog.className,
      style: dialog.getAttribute('style'),
    });

    it('is unmoved by the editor arriving, and by a long description typed after', async () => {
      held.items = [anItem()];
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <ItemForm />
        </QueryClientProvider>,
      );
      await screen.findByLabelText('Title');
      const dialog = screen.getByRole('dialog');
      const whileArriving = frameSize(dialog);

      await theEditorHasArrived();
      expect(frameSize(dialog)).toEqual(whileArriving);

      const user = userEvent.setup();
      await user.type(
        descriptionBox(),
        'A description that runs on for a while - well past what the twelve-row placeholder showed before the editor swapped in for it.',
      );
      expect(frameSize(dialog)).toEqual(whileArriving);
    });

    it('opens at the same size for an empty description as for one already written', async () => {
      const sizeOf = async (item: Item) => {
        held.items = [item];
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        render(
          <QueryClientProvider client={client}>
            <ItemForm />
          </QueryClientProvider>,
        );
        await screen.findByLabelText('Title');
        const size = frameSize(screen.getByRole('dialog'));
        cleanup();
        return size;
      };

      expect(await sizeOf(anItem({ description: null }))).toEqual(
        await sizeOf(anItem({ description: 'Tolerances, and the sign-off date' })),
      );
    });
  });

  /**
   * "Let the item's form dock to the side of the screen instead of opening
   * as a dialog" (issue 481). The docked presentation's own non-modality and
   * its resizing are a real pointer and a real layout, so they are proved in
   * tests/e2e/item-editing.test.ts instead; what is asked here is which
   * presentation the form opens at, what pressing the control sends and
   * switches, and that a choice made elsewhere leaves an open form alone.
   */
  describe('the form is centered or docked to the side, an account-wide choice', () => {
    const dockButton = () => screen.getByRole('button', { name: 'Dock' });
    const centerButton = () => screen.getByRole('button', { name: 'Center' });

    it('opens centered where the account has never chosen, offering to dock it', async () => {
      await theForm();

      expect(dockButton()).toBeVisible();
      expect(screen.getByRole('dialog')).toHaveClass('left-1/2');
    });

    // "Let the item's form dock to the side of the screen instead of opening as a dialog" (issue 481): the rows
    // only follow a form that is really docked, so it says so - and says so no
    // longer once it is not, whether centered, too narrow to dock, or gone.
    it('tells the rows it is docked, and that it no longer is once it is gone', async () => {
      held.itemFormPresentation = 'docked';
      await theForm();

      expect(held.reportDocked).toHaveBeenLastCalledWith(true);

      cleanup();

      expect(held.reportDocked).toHaveBeenLastCalledWith(false);
    });

    // A switch that is not a click on a row - a capture moving the dock - must
    // leave the keyboard in the box the person is typing in.
    it('takes the keyboard for the title, unless a docked form was opened keeping it where it is', async () => {
      held.itemFormPresentation = 'docked';
      await theForm();
      expect(titleBox()).toHaveFocus();

      cleanup();
      held.quietly = true;
      await theForm();
      expect(titleBox()).not.toHaveFocus();
    });

    // Centering it is a switch to a modal dialog, which mounts its content
    // afresh: the keyboard has to go into it the ordinary way then, or it is
    // left outside a dialog that has hidden the page (found in review).
    it('takes the keyboard for the title once a quietly opened form is centered', async () => {
      held.itemFormPresentation = 'docked';
      held.quietly = true;
      const user = await theForm();
      expect(titleBox()).not.toHaveFocus();

      await user.click(centerButton());

      await waitFor(() => expect(titleBox()).toHaveFocus());
    });

    it('tells the rows nothing is docked while the form is centered', async () => {
      await theForm();

      expect(held.reportDocked).not.toHaveBeenCalledWith(true);
    });

    it('opens docked where the account has chosen it, offering to center it', async () => {
      held.itemFormPresentation = 'docked';
      const user = await theForm();

      expect(centerButton()).toBeVisible();
      expect(screen.getByRole('dialog')).toHaveClass('right-0');
      // Still the same form otherwise - the fields are #480's own component,
      // reused rather than reproven.
      await user.type(descriptionBox(), 'Tolerances');
      expect(descriptionBox()).toHaveValue('Tolerances');
    });

    // Phone is its own, separate discussion, by the issue's own text - but
    // "out of scope" has to mean "falls back to centered" rather than
    // "renders the docked layout anyway" (found in review: a fixed-width
    // panel with no scrim, on a screen too narrow to spare the room).
    it('renders centered on a screen too narrow to dock, though the account is still docked', async () => {
      const original = window.innerWidth;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
      try {
        held.itemFormPresentation = 'docked';
        await theForm();

        expect(screen.getByRole('dialog')).toHaveClass('left-1/2');
        // The control still names the account's real choice, not what a
        // narrow screen happens to be falling back to - pressing it has to
        // go on undocking the account rather than "docking" what already is.
        expect(centerButton()).toBeVisible();
      } finally {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
      }
    });

    it('docking sends the choice account-wide, and switches this open form at once', async () => {
      const user = await theForm();

      await user.click(dockButton());

      expect(sent()).toContainEqual(
        expect.objectContaining({
          name: 'set_item_form_presentation',
          payload: expect.objectContaining({ workspaceId: 'account', presentation: 'docked' }),
        }),
      );
      expect(centerButton()).toBeVisible();
      expect(screen.getByRole('dialog')).toHaveClass('right-0');
    });

    it('centering switches an open docked form back, the same way', async () => {
      held.itemFormPresentation = 'docked';
      const user = await theForm();

      await user.click(centerButton());

      expect(sent()).toContainEqual(
        expect.objectContaining({
          name: 'set_item_form_presentation',
          payload: expect.objectContaining({ presentation: 'centered' }),
        }),
      );
      expect(dockButton()).toBeVisible();
      expect(screen.getByRole('dialog')).toHaveClass('left-1/2');
    });

    // Against the live account this inverts: a choice made from another
    // device or tab while this form is open must not move it - only a press
    // on this form's own control does that (the case above).
    // Following a docked form to another row remounts it: the presentation
    // this open form was locked to must survive that, where the snapshot the
    // new one would re-read may not yet carry a choice just made - which drew
    // the next item's form centered and modal (found in CI, "Let the item's form dock to the side of
    // the screen instead of opening as a dialog", issue 481).
    it('stays docked when it is swapped to another item, whatever the snapshot says by then', async () => {
      held.items = [anItem(), anItem({ id: 'item-2', title: 'Part 12' })];
      held.itemFormPresentation = 'docked';
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const shell = () => (
        <QueryClientProvider client={client}>
          <ItemForm />
        </QueryClientProvider>
      );
      const { rerender } = render(shell());
      await screen.findByLabelText('Title');
      expect(centerButton()).toBeVisible();

      held.itemFormPresentation = 'centered';
      held.openItemId = 'item-2';
      rerender(shell());

      await waitFor(() => expect(titleBox()).toHaveValue('Part 12'));
      expect(centerButton()).toBeVisible();
      expect(screen.getByRole('dialog')).toHaveClass('right-0');
    });

    it('is not locked to a choice reverting itself after the form has closed', async () => {
      held.items = [anItem()];
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const shell = () => (
        <QueryClientProvider client={client}>
          <ItemForm />
        </QueryClientProvider>
      );
      let refuse: (reason: Error) => void = () => {};
      held.send.mockImplementation(((change: { name: string }) =>
        change.name === 'set_item_form_presentation'
          ? new Promise((_, reject) => {
              refuse = reject;
            })
          : Promise.resolve({ ok: true as const, applied: true })) as unknown as () => Promise<{
        ok: true;
        applied: boolean;
      }>);
      const user = userEvent.setup();
      const { rerender } = render(shell());
      await screen.findByLabelText('Title');

      await user.click(dockButton());
      held.openItemId = undefined;
      rerender(shell());
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await act(async () => refuse(new Error('Too many requests')));

      // The account moved on elsewhere in the meantime.
      held.itemFormPresentation = 'docked';
      held.openItemId = 'item-1';
      rerender(shell());

      await screen.findByLabelText('Title');
      expect(centerButton()).toBeVisible();
    });

    it('reads the account afresh for the next form, once none is open', async () => {
      held.items = [anItem()];
      held.itemFormPresentation = 'docked';
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const shell = () => (
        <QueryClientProvider client={client}>
          <ItemForm />
        </QueryClientProvider>
      );
      const { rerender } = render(shell());
      await screen.findByLabelText('Title');
      expect(centerButton()).toBeVisible();

      held.openItemId = undefined;
      rerender(shell());
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      held.itemFormPresentation = 'centered';
      held.openItemId = 'item-1';
      rerender(shell());

      await screen.findByLabelText('Title');
      expect(dockButton()).toBeVisible();
    });

    it('a choice made elsewhere does not move a form already open', async () => {
      held.items = [anItem()];
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const shell = () => (
        <QueryClientProvider client={client}>
          <ItemForm />
        </QueryClientProvider>
      );
      const { rerender } = render(shell());
      await screen.findByLabelText('Title');
      expect(dockButton()).toBeVisible();

      // The account's choice moves underneath, alongside a change to the item
      // itself - proof that the new snapshot was actually read, not only that
      // nothing happened to be re-rendered.
      held.items = [anItem({ title: 'Renamed elsewhere' })];
      held.itemFormPresentation = 'docked';
      rerender(shell());

      await waitFor(() => expect(screen.getByRole('heading')).toHaveTextContent('Renamed elsewhere'));
      expect(dockButton()).toBeVisible();
    });
  });

  /**
   * "Save a docked item's fields as you finish them, not behind one Save
   * button" (issue 483). A commit landing against an item changed elsewhere
   * reuses the batched Save's own refusal (`a save that did not land keeps the
   * form open`), so only its being reached from here is asked.
   */
  describe('a docked form writes each field as it is finished, not behind one Save', () => {
    const priorityBox = () => screen.getByLabelText('Priority');
    const dueDateBox = () => screen.getByLabelText('Due date');
    const dockedForm = async (item: Item = anItem(), withUndo = false) => {
      held.itemFormPresentation = 'docked';
      return theForm(item, [], withUndo);
    };

    it.each([
      {
        situation: 'the title, on leaving it',
        item: anItem(),
        finish: async (user: ReturnType<typeof userEvent.setup>) => {
          await user.type(titleBox(), ' now');
          expect(held.send).not.toHaveBeenCalled();
          await user.tab();
        },
        expected: 'set_title',
      },
      {
        situation: 'the description, on leaving it',
        item: anItem(),
        finish: async (user: ReturnType<typeof userEvent.setup>) => {
          await user.type(descriptionBox(), 'Notes');
          expect(held.send).not.toHaveBeenCalled();
          await user.tab();
        },
        expected: 'set_description',
      },
      {
        situation: 'the priority, the moment one is picked',
        item: anItem(),
        finish: async (user: ReturnType<typeof userEvent.setup>) =>
          user.selectOptions(priorityBox(), 'high'),
        expected: 'set_priority',
      },
      {
        situation: 'the due date, the moment a shortcut is pressed',
        item: anItem(),
        finish: async (user: ReturnType<typeof userEvent.setup>) =>
          user.click(screen.getByRole('button', { name: 'Today' })),
        expected: 'set_due_date',
      },
      {
        situation: 'the due date, cleared and then left',
        item: anItem({ dueDate: '2026-09-30' }),
        finish: async (user: ReturnType<typeof userEvent.setup>) => {
          // Focused first: the title has autofocus, so without this the click
          // below lands on the box that already holds the cursor and blurs
          // nothing.
          await user.click(dueDateBox());
          fireEvent.change(dueDateBox(), { target: { value: '' } });
          await user.click(titleBox());
        },
        expected: 'set_due_date',
      },
    ])('writes $situation, and only that field', async ({ item, finish, expected }) => {
      const user = await dockedForm(item);

      await finish(user);

      // Inside the due date's own settle time, so a write that only arrives
      // because a timer ran out is not taken for one made on leaving.
      await waitFor(() => expect(sent().map((change) => change.name)).toEqual([expected]), {
        timeout: DUE_DATE_SETTLES_MS - 150,
      });
      expect(held.close).not.toHaveBeenCalled();
    });

    it('waits for a typed due date to sit still, but writes it at once on leaving the field', async () => {
      const user = await dockedForm();

      // A date input announces every date the keystrokes so far spell -
      // typing a year passes through 0002, 0020, 0202 - so a write per change
      // would send dates nobody meant.
      await user.click(dueDateBox());
      fireEvent.change(dueDateBox(), { target: { value: '2026-10-01' } });
      expect(held.send).not.toHaveBeenCalled();

      await user.click(titleBox());

      await waitFor(() => expect(sent().map((change) => change.name)).toEqual(['set_due_date']), {
        timeout: DUE_DATE_SETTLES_MS - 150,
      });
      expect(sent()[0]).toMatchObject({ payload: { dueDate: '2026-10-01' } });
    });

    // A date input reports '' while one segment of a complete date is being
    // retyped, which is a step towards a date and not a clear.
    it('does not write a clear for a segment being retyped, only the date it ends as', async () => {
      await dockedForm(anItem({ dueDate: '2026-09-30' }));

      fireEvent.change(dueDateBox(), { target: { value: '' } });
      fireEvent.change(dueDateBox(), { target: { value: '2026-10-30' } });

      await waitFor(() => expect(sent().map((change) => change.name)).toEqual(['set_due_date']), {
        timeout: 3000,
      });
      expect(sent()[0]).toMatchObject({ payload: { dueDate: '2026-10-30' } });
    });

    it('writes a typed due date once it has sat still, without leaving the field', async () => {
      await dockedForm();

      fireEvent.change(dueDateBox(), { target: { value: '2026-10-01' } });
      expect(held.send).not.toHaveBeenCalled();

      await waitFor(() => expect(sent().map((change) => change.name)).toEqual(['set_due_date']), {
        timeout: 3000,
      });
    });

    it('sends nothing for a field left as it was, and never resends one already written', async () => {
      const user = await dockedForm();

      await user.type(titleBox(), ' now');
      await user.tab();
      await waitFor(() => expect(held.send).toHaveBeenCalledTimes(1));

      // Into the description and out again untouched, then the title again.
      await user.click(descriptionBox());
      await user.tab();
      await user.click(titleBox());
      await user.tab();
      expect(held.send).toHaveBeenCalledTimes(1);

      await user.type(descriptionBox(), 'Notes');
      await user.tab();

      await waitFor(() => expect(held.send).toHaveBeenCalledTimes(2));
      expect(sent().map((change) => change.name)).toEqual(['set_title', 'set_description']);
    });

    it('has a Close and no Save or Cancel, and closing keeps what is still in a box', async () => {
      await dockedForm();
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Close' })).toBeVisible();

      // The cursor is still in the box when the form goes - the back button,
      // or another item opening in its place, blurs nothing.
      fireEvent.change(titleBox(), { target: { value: 'Typed, cursor still there' } });
      cleanup();

      await waitFor(() => expect(sent().map((change) => change.name)).toEqual(['set_title']));
      expect(sent()[0]).toMatchObject({ payload: { title: 'Typed, cursor still there' } });
    });

    it('writes what was already typed the moment the form is docked', async () => {
      const user = await theForm();
      await user.type(titleBox(), ' now');
      expect(held.send).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Dock' }));

      await waitFor(() =>
        expect(sent().map((change) => change.name).sort()).toEqual([
          'set_item_form_presentation',
          'set_title',
        ]),
      );
    });

    it('keeps the bar offering an undo clear of the form, for as long as the form is docked', async () => {
      await dockedForm();
      const cleared = () => document.documentElement.style.getPropertyValue('--docked-form-w');

      expect(cleared()).toMatch(/^\d+px$/);

      cleanup();
      expect(cleared()).toBe('');
    });

    // Docking is refused a screen too narrow for it (the form stays centered,
    // with Save and Cancel), so there is no Save left over that writes twice.
    it('writes nothing on Dock where the screen is too narrow for it to dock, and keeps Save', async () => {
      const original = window.innerWidth;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
      try {
        const user = await theForm();
        await user.type(titleBox(), ' now');

        await user.click(screen.getByRole('button', { name: 'Dock' }));

        await waitFor(() =>
          expect(sent().map((change) => change.name)).toEqual(['set_item_form_presentation']),
        );
        expect(screen.getByRole('button', { name: 'Save' })).toBeVisible();
      } finally {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
      }
    });

    it('writes nothing on Dock when the choice itself is refused, and keeps saying so', async () => {
      const user = await theForm();
      await user.type(titleBox(), ' now');
      held.send.mockImplementation(((change: { name: string }) =>
        change.name === 'set_item_form_presentation'
          ? Promise.reject(new Error('Too many requests'))
          : Promise.resolve({ ok: true as const, applied: true })) as unknown as () => Promise<{
        ok: true;
        applied: boolean;
      }>);

      await user.click(screen.getByRole('button', { name: 'Dock' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sent().map((change) => change.name)).toEqual(['set_item_form_presentation']);
      expect(screen.getByRole('alert')).toHaveTextContent('Too many requests');
      expect(screen.getByRole('button', { name: 'Save' })).toBeVisible();
    });

    it.each([
      {
        situation: 'the Close button',
        close: async (user: ReturnType<typeof userEvent.setup>) =>
          user.click(screen.getByRole('button', { name: 'Close' })),
      },
      {
        situation: 'Escape',
        close: async (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}'),
      },
    ])('$situation stays open while what was typed cannot be written, and leaves on the second press', async ({ close }) => {
      const user = await dockedForm();
      await user.type(titleBox(), ' now');
      held.send.mockRejectedValue(new Error('offline'));

      await close(user);

      expect(await screen.findByRole('alert')).toHaveTextContent(/offline.*Close again/);
      expect(held.close).not.toHaveBeenCalled();
      expect(titleBox()).toHaveValue('Part 11 now');

      await close(user);

      await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
    });

    it('does not take a second press, made while the first is still waiting on its write, for the one that leaves', async () => {
      const user = await dockedForm();
      await user.type(titleBox(), ' now');
      const waiting: ((error: Error) => void)[] = [];
      held.send.mockImplementation((() =>
        new Promise((_, reject) => {
          waiting.push(reject);
        })) as unknown as () => Promise<{ ok: true; applied: boolean }>);

      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(waiting).toHaveLength(1));
      waiting.forEach((fail) => fail(new Error('offline')));

      expect(await screen.findByRole('alert')).toHaveTextContent(/offline.*Close again/);
      expect(held.close).not.toHaveBeenCalled();
      expect(held.send).toHaveBeenCalledTimes(1);
    });

    it('warns again for a later refusal, once an earlier one has cleared', async () => {
      const user = await dockedForm();
      await user.type(titleBox(), ' now');
      held.send.mockRejectedValue(new Error('offline'));
      await user.click(screen.getByRole('button', { name: 'Close' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/Close again/);

      held.send.mockResolvedValue({ ok: true as const, applied: true });
      await user.type(titleBox(), '!');
      await user.tab();
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());

      held.send.mockRejectedValue(new Error('offline'));
      await user.selectOptions(priorityBox(), 'high');
      expect(await screen.findByRole('alert')).toHaveTextContent('offline');
      await user.click(screen.getByRole('button', { name: 'Close' }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Close again/));
      expect(held.close).not.toHaveBeenCalled();
    });

    it('keeps saying a write did not land while that field is still unwritten, whatever else is written', async () => {
      const user = await dockedForm();
      held.send.mockResolvedValueOnce({ ok: true as const, applied: false });
      await user.selectOptions(priorityBox(), 'high');
      expect(await screen.findByRole('alert')).toHaveTextContent(/changed somewhere else/);

      await user.type(titleBox(), ' now');
      await user.tab();

      await waitFor(() =>
        expect(sent().map((change) => change.name)).toEqual(['set_priority', 'set_title']),
      );
      expect(screen.getByRole('alert')).toHaveTextContent(/changed somewhere else/);
    });

    it('waits for a write still in flight before undoing an earlier one, and offers nothing stale after', async () => {
      const user = await dockedForm(anItem({ title: 'A' }), true);
      await user.type(titleBox(), ' B');
      await user.tab();
      const undo = await screen.findByText('Undo');
      held.send.mockClear();
      let land!: () => void;
      held.send.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            land = () => resolve({ ok: true as const, applied: true });
          }),
      );
      await user.type(titleBox(), ' C');
      await user.tab();
      await waitFor(() => expect(held.send).toHaveBeenCalledTimes(1));

      fireEvent.click(undo);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(held.send).toHaveBeenCalledTimes(1);

      land();

      await waitFor(() => expect(held.send).toHaveBeenCalledTimes(2));
      expect(sent().map((change) => change.name)).toEqual(['set_title', 'set_title']);
      expect(sent()[1]).toMatchObject({ payload: { title: 'A' } });
      await waitFor(() => expect(screen.queryByText('Undo')).toBeNull());
      expect(titleBox()).toHaveValue('A');
    });

    it('takes a chosen reading as one write of both texts, and one thing to undo', async () => {
      const READINGS = [
        { title: 'Call Jan', description: 'Ring Jan.', meaning: "'jan' is a person's name" },
        { title: 'Call in January', description: 'Ring in January.', meaning: "'jan' is a month" },
      ];
      const user = await dockedForm(
        anItem({ title: 'Call Jan', description: 'Mine already', readings: READINGS }),
        true,
      );

      await user.click(screen.getByRole('button', { name: /Call in January/ }));

      await waitFor(() =>
        expect(sent().map((change) => change.name)).toEqual(['set_title', 'set_description']),
      );
      expect(await screen.findByText('Changed the title and the description')).toBeVisible();
    });

    describe('the type and the status are written as they are picked', () => {
      it('writes a picked type at once, and undoes it to the type the item was', async () => {
        held.itemTypes = [aType('task', 'Task'), aType('idea', 'Idea')];
        const user = await dockedForm(anItem({ typeId: 'task' }), true);

        await user.selectOptions(screen.getByLabelText('Type'), 'Idea');

        await waitFor(() => expect(sent().map((change) => change.name)).toEqual(['set_item_type']));
        const undo = await screen.findByText('Undo');
        held.send.mockClear();
        fireEvent.click(undo);

        await waitFor(() => expect(sent().map((change) => change.name)).toEqual(['set_item_type']));
        expect(sent()[0]).toMatchObject({ payload: { typeId: 'task' } });
        await waitFor(() => expect(screen.getByLabelText('Type')).toHaveValue('task'));
      });

      it('offers no way back for an item that had no type, which nothing can restore', async () => {
        held.itemTypes = [aType('task', 'Task')];
        const user = await dockedForm(anItem({ typeId: null }), true);

        await user.selectOptions(screen.getByLabelText('Type'), 'Task');

        await waitFor(() => expect(held.send).toHaveBeenCalledTimes(1));
        expect(screen.queryByText('Undo')).toBeNull();
      });

      it('writes a status at once, and undoes it', async () => {
        const user = await dockedForm(anItem(), true);

        await user.selectOptions(screen.getByLabelText('Status'), 'Done');

        await waitFor(() => expect(sent().map((change) => change.name)).toEqual(['set_done']));
        const undo = await screen.findByText('Undo');
        held.send.mockClear();
        fireEvent.click(undo);

        await waitFor(() => expect(sent()[0]).toMatchObject({ name: 'set_done', payload: { done: false } }));
        await waitFor(() => expect(screen.getByLabelText('Status')).toHaveValue('open'));
      });
    });

    describe('and every write can be undone right after, and only right after', () => {
      it('puts the previous value back, in the item and in the box', async () => {
        const user = await dockedForm(anItem({ title: 'Part 11' }), true);
        await user.clear(titleBox());
        await user.type(titleBox(), 'Part 12');
        await user.tab();
        const undo = await screen.findByText('Undo');
        held.send.mockClear();

        fireEvent.click(undo);

        await waitFor(() => expect(sent().map((change) => change.name)).toEqual(['set_title']));
        expect(sent()[0]).toMatchObject({ payload: { title: 'Part 11' } });
        await waitFor(() => expect(titleBox()).toHaveValue('Part 11'));
      });

      it('puts a priority back to none, not to whatever it was last shown as', async () => {
        const user = await dockedForm(anItem({ priority: null }), true);
        await user.selectOptions(priorityBox(), 'high');
        const undo = await screen.findByText('Undo');
        held.send.mockClear();

        fireEvent.click(undo);

        await waitFor(() => expect(sent().map((change) => change.name)).toEqual(['set_priority']));
        expect(sent()[0]).toMatchObject({ payload: { priority: null } });
        await waitFor(() => expect(priorityBox()).toHaveValue(''));
      });

      it('says so, and leaves the box alone, where the item changed elsewhere in the meantime', async () => {
        const user = await dockedForm(anItem({ title: 'Part 11' }), true);
        await user.type(titleBox(), ' now');
        await user.tab();
        const undo = await screen.findByText('Undo');
        held.send.mockResolvedValueOnce({ ok: true as const, applied: false });

        fireEvent.click(undo);

        expect(await screen.findByText(/changed somewhere else/)).toBeVisible();
        expect(titleBox()).toHaveValue('Part 11 now');
      });

      it('stops being offered once the bar has gone', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
          const user = await dockedForm(anItem(), true);
          await user.selectOptions(priorityBox(), 'low');
          expect(await screen.findByText('Undo')).toBeVisible();

          await act(async () => {
            vi.advanceTimersByTime(THE_BAR_LASTS_MS);
          });

          expect(screen.queryByText('Undo')).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe('and a write that did not land says so, and offers nothing to undo', () => {
      it.each([
        {
          situation: 'the item changed elsewhere',
          answer: () => held.send.mockResolvedValueOnce({ ok: true as const, applied: false }),
          said: /changed somewhere else/,
        },
        {
          situation: 'the server refused it',
          answer: () => held.send.mockRejectedValueOnce(new Error('Too many requests')),
          said: /Too many requests/,
        },
      ])('$situation', async ({ answer, said }) => {
        const user = await dockedForm(anItem(), true);
        answer();

        await user.selectOptions(priorityBox(), 'high');

        expect(await screen.findByRole('alert')).toHaveTextContent(said);
        expect(screen.queryByText('Undo')).toBeNull();
      });
    });
  });
});
