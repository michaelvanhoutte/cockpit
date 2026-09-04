import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Item, ItemType } from '@cockpit/shared';
import { CaptureForm } from '../../../src/components/CaptureForm';
import { useCommand } from '../../../src/api/queries';

vi.mock('../../../src/api/queries', () => ({ useCommand: vi.fn() }));

const mockUseCommand = vi.mocked(useCommand);

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

/** The form, with the types and items the workspace holds. */
function aForm(types: ItemType[] = [ACTION, THOUGHT], items: Item[] = []) {
  const mutate = vi.fn();
  mockUseCommand.mockReturnValue({ mutate, isPending: false } as never);
  render(<CaptureForm workspaceId="ws-work" types={types} items={items} />);
  return { mutate, user: userEvent.setup() };
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

    it('makes a new type when the name matches none, and captures it as that', async () => {
      const { mutate, user } = aForm();

      await user.type(screen.getByLabelText('Capture a note or to-do'), 'Why is this slow?');
      await user.clear(screen.getByLabelText('What kind of thing this is'));
      await user.type(screen.getByLabelText('What kind of thing this is'), 'Question');
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      const made = asked(mutate, 'create_item_type');
      expect(made.payload.name).toBe('Question');
      // The same id both times, so the item lands as the type just made rather
      // than as nothing.
      expect(asked(mutate, 'capture_item').payload.typeId).toBe(made.payload.typeId);
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
