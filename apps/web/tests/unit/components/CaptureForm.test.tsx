import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import type { Item, ItemType } from '@cockpit/shared';
import { CaptureForm } from '../../../src/components/CaptureForm';
import { useCommand, useSendCommand } from '../../../src/api/queries';

/**
 * The types the account has *after* a change, which is what the form re-reads
 * to find out which id the type it just named ended up with.
 */
const afterwards = vi.hoisted(() => ({ types: [] as unknown[] }));

vi.mock('../../../src/api/queries', () => ({
  useCommand: vi.fn(),
  useSendCommand: vi.fn(),
  itemTypesQuery: {
    queryKey: ['itemTypes'],
    queryFn: () => Promise.resolve({ itemTypes: afterwards.types }),
  },
}));

const mockUseCommand = vi.mocked(useCommand);
const mockUseSendCommand = vi.mocked(useSendCommand);

function aType(name: string, at: number): ItemType {
  return {
    id: `11111111-1111-7111-8111-${String(at).padStart(12, '0')}`,
    tenantId: 'tenant',
    name,
    color: '#6f62b5',
    position: at,
    createdAt: '2026-08-31T08:00:00.000Z',
  };
}

const ACTION = aType('Action', 0);
const THOUGHT = aType('Thought', 1);

function anItemOf(type: ItemType | null, at: number): Item {
  return {
    id: `22222222-2222-7222-8222-${String(at).padStart(12, '0')}`,
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    title: `item ${at}`,
    preview: null,
    sourceResolvedAt: null,
    typeId: type?.id ?? null,
    nextAction: null,
    completedAt: null,
    priority: null,
    dueDate: null,
    unseen: false,
    deletedAt: null,
    createdAt: `2026-08-31T0${at}:00:00.000Z`,
    updatedAt: `2026-08-31T0${at}:00:00.000Z`,
  };
}

/**
 * The form, with the types and items the workspace holds.
 *
 * `madeAs` is the type the account is holding by the time the form re-reads
 * them - which is how the case where another tab made the same type first is
 * arranged, since the id that comes back is then not the one this form
 * generated.
 */
function aForm(
  types: ItemType[] = [ACTION, THOUGHT],
  items: Item[] = [],
  madeAs: ItemType[] = types,
) {
  const mutate = vi.fn();
  const send = vi.fn((_args: unknown) => Promise.resolve());
  afterwards.types = madeAs;
  mockUseCommand.mockReturnValue({ mutate, isPending: false } as never);
  mockUseSendCommand.mockReturnValue(send as never);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CaptureForm workspaceId="ws-work" types={types} items={items} />
    </QueryClientProvider>,
  );
  return { mutate, send, user: userEvent.setup() };
}

/** What the type box offers, in the order it offers them. */
const offered = () =>
  Array.from(document.querySelectorAll('datalist option')).map((option) =>
    option.getAttribute('value'),
  );

const asked = (mutate: ReturnType<typeof vi.fn>, name: string) =>
  mutate.mock.calls.map(([args]) => args).find((args) => args.name === name);

describe('Capture', () => {
  describe('capturing a thought sends it and leaves the box ready for the next one', () => {
    it('asks to capture what was typed, then empties the box', async () => {
      const { mutate, user } = aForm();

      const box = screen.getByLabelText('Capture a note or to-do');
      await user.type(box, '  Buy milk  ');
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      const capture = asked(mutate, 'capture_item');
      expect(capture.payload.title).toBe('Buy milk');
      expect(capture.payload.workspaceId).toBe('ws-work');
      expect(box).toHaveValue('');
    });
  });

  describe('an empty thought is never captured', () => {
    it('asks for nothing when the box holds only spaces', async () => {
      const { mutate, user } = aForm();

      await user.type(screen.getByLabelText('Capture a note or to-do'), '   ');
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      expect(mutate).not.toHaveBeenCalled();
    });
  });

  describe('an item is captured as the type you named, or as the one you used last', () => {
    it('captures it as the type named', async () => {
      const { mutate, user } = aForm();

      await user.type(screen.getByLabelText('Capture a note or to-do'), 'Buy milk');
      await user.clear(screen.getByLabelText('What kind of thing this is'));
      await user.type(screen.getByLabelText('What kind of thing this is'), 'Thought');
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      expect(asked(mutate, 'capture_item').payload.typeId).toBe(THOUGHT.id);
      expect(asked(mutate, 'create_item_type')).toBeUndefined();
    });

    it.each([
      { situation: 'the same name', typed: 'Thought' },
      { situation: 'a different capitalisation', typed: 'THOUGHT' },
      { situation: 'the name with blanks round it', typed: '  thought  ' },
    ])('reuses the type when given $situation', async ({ typed }) => {
      const { mutate, user } = aForm();

      await user.type(screen.getByLabelText('Capture a note or to-do'), 'Buy milk');
      await user.clear(screen.getByLabelText('What kind of thing this is'));
      await user.type(screen.getByLabelText('What kind of thing this is'), typed);
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      expect(asked(mutate, 'create_item_type')).toBeUndefined();
      expect(asked(mutate, 'capture_item').payload.typeId).toBe(THOUGHT.id);
    });

    it.each([
      {
        situation: 'this request is what made it',
        made: aType('Question', 2),
      },
      {
        // The same name, a different id: another tab got there first and the
        // store kept its row. Capturing against the id this form generated
        // would name something nobody stored, and the note would be gone.
        situation: 'another tab made it first',
        made: { ...aType('Question', 9), id: 'made-by-somebody-else' },
      },
    ])('makes a new type and captures as the one now going by that name, when $situation', async ({ made }) => {
      const { mutate, send, user } = aForm([ACTION, THOUGHT], [], [ACTION, THOUGHT, made]);

      await user.type(screen.getByLabelText('Capture a note or to-do'), 'Why is this slow?');
      await user.clear(screen.getByLabelText('What kind of thing this is'));
      await user.type(screen.getByLabelText('What kind of thing this is'), 'Question');
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'create_item_type',
          payload: expect.objectContaining({ name: 'Question' }),
        }),
      );
      await waitFor(() => expect(asked(mutate, 'capture_item')).toBeDefined());
      expect(asked(mutate, 'capture_item').payload.typeId).toBe(made.id);
    });

    it('captures with no type when the box was emptied', async () => {
      const { mutate, user } = aForm();

      await user.type(screen.getByLabelText('Capture a note or to-do'), 'Buy milk');
      await user.clear(screen.getByLabelText('What kind of thing this is'));
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      expect(asked(mutate, 'capture_item').payload.typeId).toBeUndefined();
      expect(asked(mutate, 'create_item_type')).toBeUndefined();
    });
  });

  describe('capture offers the types you already have, the ones you used last first', () => {
    it.each([
      { situation: 'none used yet', used: [] as (ItemType | null)[], order: ['Action', 'Thought'] },
      { situation: 'one used', used: [THOUGHT], order: ['Thought', 'Action'] },
      {
        situation: 'the older one used more recently',
        used: [THOUGHT, ACTION],
        order: ['Action', 'Thought'],
      },
      {
        situation: 'the same one used twice',
        used: [THOUGHT, THOUGHT],
        order: ['Thought', 'Action'],
      },
    ])('$situation', ({ used, order }) => {
      aForm(
        [ACTION, THOUGHT],
        used.map((type, at) => anItemOf(type, at)),
      );

      expect(offered()).toEqual(order);
    });

    it('opens on the type used last', () => {
      aForm([ACTION, THOUGHT], [anItemOf(THOUGHT, 0)]);

      expect(screen.getByLabelText('What kind of thing this is')).toHaveValue('Thought');
    });

    it('offers nothing and asks for nothing when the account has no types yet', () => {
      aForm([]);

      expect(offered()).toEqual([]);
      expect(screen.getByLabelText('What kind of thing this is')).toHaveValue('');
    });
  });
});
