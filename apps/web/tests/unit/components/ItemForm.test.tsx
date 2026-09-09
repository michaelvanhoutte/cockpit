import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Item, WorkspaceSnapshot } from '@cockpit/shared';
import { ItemForm, whatChanged } from '../../../src/components/ItemForm';

/**
 * F1: the form's own behaviour and its wiring. What a saved text survives is a
 * real column with a real cap, proved through the real interface in
 * apps/api/tests/integration/http/item-changes.test.ts; what is asked here is
 * what the form sends, and what it does not.
 */

const held = vi.hoisted(() => ({
  items: [] as Item[],
  send: vi.fn(() => Promise.resolve({ ok: true as const, applied: true })),
  close: vi.fn(),
  openItemId: 'item-1' as string | undefined,
}));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ workspaceId: 'ws-work' }),
}));

vi.mock('../../../src/itemForm', () => ({
  useItemForm: () => ({ openItemId: held.openItemId, close: held.close }),
}));

/**
 * The description's editor, replaced by a box that takes text and says what is
 * in it. This file is about what the form sends and what it does not; what the
 * editor keeps is tests/unit/description/syntax.test.ts, and when it appears is
 * tests/unit/components/DescriptionBox.test.tsx. Left real, every test here
 * would mount a 115KB editor to type one word into it.
 */
vi.mock('../../../src/description/RichDescription', () => ({
  default: ({
    initial,
    onChange,
    editable,
  }: {
    initial: string;
    onChange: (markdown: string) => void;
    editable: boolean;
  }) => (
    <textarea
      aria-label="Description"
      disabled={!editable}
      value={initial}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock('../../../src/api/queries', () => ({
  useSendCommand: () => held.send,
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId, held.items],
    queryFn: (): Promise<WorkspaceSnapshot> =>
      Promise.resolve({ items: held.items } as WorkspaceSnapshot),
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

async function theForm(item: Item = anItem()) {
  held.items = [item];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ItemForm />
    </QueryClientProvider>,
  );
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
  held.send.mockClear();
  held.send.mockImplementation(() => Promise.resolve({ ok: true as const, applied: true }));
  held.close.mockClear();
  held.openItemId = 'item-1';
});

describe('Item editing', () => {
  describe('saving asks only for what changed', () => {
    // A pure decision over the item and the boxes, so the situations live here
    // rather than being driven through the form one keystroke at a time.
    it.each([
      {
        situation: 'the title edited and nothing else',
        draft: { title: 'Part 12', description: '' },
        asks: { title: 'Part 12' },
      },
      {
        situation: 'the description written and nothing else',
        draft: { title: 'Part 11', description: 'Tolerances' },
        asks: { description: 'Tolerances' },
      },
      {
        situation: 'both',
        draft: { title: 'Part 12', description: 'Tolerances' },
        asks: { title: 'Part 12', description: 'Tolerances' },
      },
      { situation: 'neither', draft: { title: 'Part 11', description: '' }, asks: {} },
      // Adding a space to the end of a title is not a change to the title: the
      // space would not be stored either.
      {
        situation: 'a title with a space added to the end',
        draft: { title: 'Part 11 ', description: '' },
        asks: {},
      },
      // Emptied is cleared, and there is no third state to send.
      {
        situation: 'a description emptied',
        stored: { title: 'Part 11', description: 'Tolerances' },
        draft: { title: 'Part 11', description: '   ' },
        asks: { description: null },
      },
      {
        situation: 'a description that was never there and is still empty',
        draft: { title: 'Part 11', description: '' },
        asks: {},
      },
    ])('$situation', ({ stored, draft, asks }) => {
      expect(whatChanged(stored ?? { title: 'Part 11', description: '' }, draft)).toEqual(asks);
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
      localStorage.removeItem('cockpit.item-form-size');
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

        // A press inside the handle's own corner - what the component takes
        // as "a drag has started", the gate on remembering anything at all.
        fireEvent.mouseDown(screen.getByRole('dialog'), { clientX: 895, clientY: 695 });

        rect = { width: 500, height: 400, top: 0, left: 0, right: 500, bottom: 400, x: 0, y: 0 };
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
