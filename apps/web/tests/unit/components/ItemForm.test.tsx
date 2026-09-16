import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Filing, Item, PossibleDuplicate, WorkspaceSnapshot } from '@cockpit/shared';
import { ItemForm, whatChanged } from '../../../src/components/ItemForm';
import { UndoWhatJustHappened } from '../../../src/undo';

/**
 * F1: the form's own behaviour and its wiring. What a saved text survives is a
 * real column with a real cap, proved through the real interface in
 * apps/api/tests/integration/http/item-changes.test.ts; what is asked here is
 * what the form sends, and what it does not.
 */

const held = vi.hoisted(() => ({
  items: [] as Item[],
  filings: [] as Filing[],
  duplicates: [] as PossibleDuplicate[],
  send: vi.fn(() => Promise.resolve({ ok: true as const, applied: true })),
  close: vi.fn(),
  open: vi.fn(),
  openItemId: 'item-1' as string | undefined,
}));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ workspaceId: 'ws-work' }),
}));

vi.mock('../../../src/itemForm', () => ({
  useItemForm: () => ({ openItemId: held.openItemId, close: held.close }),
  useOpenItem: () => held.open,
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
    queryKey: ['snapshot', workspaceId, held.items, held.filings, held.duplicates],
    queryFn: (): Promise<WorkspaceSnapshot> =>
      Promise.resolve({
        items: held.items,
        filings: held.filings,
        duplicates: held.duplicates,
      } as unknown as WorkspaceSnapshot),
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
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-12T10:00:00.000Z',
    updatedAt: '2026-08-12T10:00:00.000Z',
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
  held.filings = [];
  held.duplicates = [];
  held.openItemId = 'item-1';
});

describe('Item editing', () => {
  describe('saving asks only for what changed', () => {
    // A pure decision over the item and the boxes, so the situations live here
    // rather than being driven through the form one keystroke at a time.
    it.each([
      {
        situation: 'the title edited and nothing else',
        draft: { title: 'Part 12', description: '', priority: null },
        asks: { title: 'Part 12' },
      },
      {
        situation: 'the description written and nothing else',
        draft: { title: 'Part 11', description: 'Tolerances', priority: null },
        asks: { description: 'Tolerances' },
      },
      {
        situation: 'both',
        draft: { title: 'Part 12', description: 'Tolerances', priority: null },
        asks: { title: 'Part 12', description: 'Tolerances' },
      },
      {
        situation: 'neither',
        draft: { title: 'Part 11', description: '', priority: null },
        asks: {},
      },
      // Adding a space to the end of a title is not a change to the title: the
      // space would not be stored either.
      {
        situation: 'a title with a space added to the end',
        draft: { title: 'Part 11 ', description: '', priority: null },
        asks: {},
      },
      // Emptied is cleared, and there is no third state to send.
      {
        situation: 'a description emptied',
        stored: { title: 'Part 11', description: 'Tolerances', priority: null },
        draft: { title: 'Part 11', description: '   ', priority: null },
        asks: { description: null },
      },
      {
        situation: 'a description that was never there and is still empty',
        draft: { title: 'Part 11', description: '', priority: null },
        asks: {},
      },
      {
        situation: 'the priority changed and nothing else',
        draft: { title: 'Part 11', description: '', priority: 'high' as const },
        asks: { priority: 'high' },
      },
      {
        situation: 'the priority cleared to none',
        stored: { title: 'Part 11', description: '', priority: 'low' as const },
        draft: { title: 'Part 11', description: '', priority: null },
        asks: { priority: null },
      },
      {
        situation: 'a priority left as it was',
        stored: { title: 'Part 11', description: '', priority: 'normal' as const },
        draft: { title: 'Part 11', description: '', priority: 'normal' as const },
        asks: {},
      },
    ])('$situation', ({ stored, draft, asks }) => {
      expect(
        whatChanged(stored ?? { title: 'Part 11', description: '', priority: null }, draft),
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

  describe('what was captured is there when you look for it, and not before', () => {
    it('keeps it shut until it is asked for, and never lets it be typed in', async () => {
      const user = await theForm();

      expect(screen.queryByText('Ask Novy about part 11')).not.toBeVisible();

      await user.click(screen.getByText('What was captured'));

      expect(screen.getByText('Ask Novy about part 11')).toBeVisible();
      // A record, not a control: there is no box to put a cursor in.
      expect(screen.queryByLabelText('What was captured')).toBeNull();
    });

    it('says nothing about it where nothing was captured', async () => {
      await theForm(anItem({ capturedMessage: null }));

      expect(screen.queryByText('What was captured')).toBeNull();
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
});
