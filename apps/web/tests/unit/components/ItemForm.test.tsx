import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
  send: vi.fn(() => Promise.resolve()),
  close: vi.fn(),
  openItemId: 'item-1' as string | undefined,
}));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ workspaceId: 'ws-work' }),
}));

vi.mock('../../../src/itemForm', () => ({
  useItemForm: () => ({ openItemId: held.openItemId, close: held.close }),
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
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    capturedMessage: 'Ask Novy about part 11',
    sourceResolvedAt: null,
    title: 'Part 11',
    description: null,
    status: 'to_process',
    nextAction: null,
    focusHorizon: null,
    priority: null,
    dueDate: null,
    snoozedUntil: null,
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
  return userEvent.setup();
}

const titleBox = () => screen.getByLabelText('Title');
const descriptionBox = () => screen.getByLabelText('Description');
const sent = () =>
  held.send.mock.calls.map((call) => (call as unknown as [{ name: string }])[0]);

beforeEach(() => {
  cleanup();
  held.send.mockClear();
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
      expect(whatChanged(stored ?? { title: 'Part 11', description: null }, draft)).toEqual(asks);
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

    it('sends nothing at all when nothing was touched', async () => {
      const user = await theForm();

      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(held.close).toHaveBeenCalledTimes(1));
      expect(held.send).not.toHaveBeenCalled();
    });
  });

  describe('the form says which item is open', () => {
    it.each([
      { situation: 'an item with a title', item: {}, named: 'Part 11' },
      // The case that needs it: both boxes are empty, so without this the form
      // is two blank fields over the word "Item".
      {
        situation: 'an item with only a captured message',
        item: { title: '', capturedMessage: 'Ask Novy about part 11' },
        named: 'Ask Novy about part 11',
      },
    ])('$situation', async ({ item, named }) => {
      await theForm(anItem(item));

      expect(screen.getByRole('heading')).toHaveTextContent(named);
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
});
