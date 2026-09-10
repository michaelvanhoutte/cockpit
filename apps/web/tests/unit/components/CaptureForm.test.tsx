import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import type { Item, ItemType } from '@cockpit/shared';
import { CommandRefused } from '../../../src/api/client';
import { CaptureForm } from '../../../src/components/CaptureForm';
import { NO_TYPES } from '../../../src/itemTypes';
import { useCommand } from '../../../src/api/queries';

vi.mock('../../../src/api/queries', () => ({
  useCommand: vi.fn(),
}));

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
    workspaceDecided: true,
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    title: `item ${at}`,
    capturedMessage: null,
    description: null,
    textsSettledAt: null,
    readings: null,
    proposedPanelId: null,
    proposedPanelReason: null,
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
 * `refuses` is what the account says back, so the row can be watched putting a
 * note that did not land back in the box. `rerender` is how a type deleted in
 * another tab is arranged: the same row, one type fewer.
 */
function aForm(types: ItemType[] | null = [ACTION, THOUGHT], items: Item[] = [], refuses?: Error) {
  const mutate = vi.fn(
    (_args: unknown, answers?: { onSuccess?: () => void; onError?: (error: Error) => void }) => {
      if (refuses) answers?.onError?.(refuses);
      else answers?.onSuccess?.();
    },
  );
  mockUseCommand.mockReturnValue({ mutate, isPending: false } as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Null is how a copy that does not carry the types at all is arranged, which
  // the row has to tell apart from an account that has none.
  const shown = (now: ItemType[] | null) => (
    <QueryClientProvider client={client}>
      <CaptureForm workspaceId="ws-work" types={now ?? undefined} items={items} />
    </QueryClientProvider>
  );
  const { rerender } = render(shown(types));
  return {
    mutate,
    user: userEvent.setup(),
    /** The same row again, with whatever the account holds now. */
    withTypes: (now: ItemType[] | null) => rerender(shown(now)),
  };
}

const theTypeBox = () => screen.getByLabelText('What kind of thing this is');
/** The box as it may not be there at all, which is what no types looks like. */
const anyTypeBox = () => screen.queryByLabelText('What kind of thing this is');

/** What the type box offers, in the order it offers them. */
const offered = () =>
  Array.from(theTypeBox().querySelectorAll('option')).map((option) => option.textContent);

const asked = (mutate: ReturnType<typeof vi.fn>, name: string) =>
  mutate.mock.calls.map(([args]) => args).find((args) => args.name === name);

const everythingAsked = (mutate: ReturnType<typeof vi.fn>) =>
  mutate.mock.calls.map(([args]) => args.name);

describe('Capture', () => {
  describe('capturing a thought sends it and leaves the box ready for the next one', () => {
    it('asks to capture what was typed, then empties the box', async () => {
      const { mutate, user } = aForm();

      const box = screen.getByLabelText('Capture a note or to-do');
      await user.type(box, '  Buy milk  ');
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      const capture = asked(mutate, 'capture_item');
      expect(capture.payload.message).toBe('Buy milk');
      expect(capture.payload.workspaceId).toBe('ws-work');
      expect(box).toHaveValue('');
    });

    /**
     * Which of the two doors this is ("Capture something before you know which
     * workspace it belongs to", issue 165). This row is inside a workspace and
     * has therefore already said where; the Capture page has not, and says so
     * by leaving it undecided (tests/unit/pages/CapturePage.test.tsx).
     *
     * The command carries the field only when it is false, so this door sends
     * exactly what it always sent.
     */
    it('says the workspace it is in is where what it captures belongs', async () => {
      const { mutate, user } = aForm();

      await user.type(screen.getByLabelText('Capture a note or to-do'), 'Buy milk');
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      const capture = asked(mutate, 'capture_item');
      expect(capture.payload.workspaceDecided).toBeUndefined();
      expect(capture.payload.workspaceId).toBe('ws-work');
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

  /**
   * The Inbox's half of the rule ("Make a type where types are managed, not
   * while capturing", issue 203). The window that does make one owns the other
   * half, in tests/unit/components/ManageTypes.test.tsx.
   */
  describe('a type is made where types are managed, and nowhere else', () => {
    it('offers the types the account has, and nothing else', () => {
      aForm();

      expect(theTypeBox().tagName).toBe('SELECT');
      // No *No type* at the head of it: every Item is some kind of thing, so
      // the only answers are the account's own types.
      expect(offered()).toEqual(['Action', 'Thought']);
    });

    it('asks to capture, and never to make a type', async () => {
      const { mutate, user } = aForm();

      await user.type(screen.getByLabelText('Capture a note or to-do'), 'Why is this slow?');
      await user.selectOptions(theTypeBox(), THOUGHT.id);
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      expect(everythingAsked(mutate)).toEqual(['capture_item']);
    });
  });

  describe('an item is captured as the type you chose, or as the one you used last', () => {
    it('captures it as the type chosen', async () => {
      const { mutate, user } = aForm();

      await user.type(screen.getByLabelText('Capture a note or to-do'), 'Buy milk');
      await user.selectOptions(theTypeBox(), THOUGHT.id);
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      expect(asked(mutate, 'capture_item').payload.typeId).toBe(THOUGHT.id);
    });

    /**
     * The choice follows the list rather than being remembered beside it, which
     * is what stops a capture naming a type the account no longer has - the
     * server refuses one of those, and the note would go with it. It falls back
     * to the type used last rather than to none, because there is no none.
     */
    it('captures as the type used last when the one chosen is deleted in another tab', async () => {
      const { mutate, user, withTypes } = aForm();

      await user.type(screen.getByLabelText('Capture a note or to-do'), 'Buy milk');
      await user.selectOptions(theTypeBox(), THOUGHT.id);
      withTypes([ACTION]);
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      expect(theTypeBox()).toHaveValue(ACTION.id);
      expect(asked(mutate, 'capture_item').payload.typeId).toBe(ACTION.id);
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

      expect(theTypeBox()).toHaveValue(THOUGHT.id);
    });

  });

  /**
   * The one thing that stops this row capturing, and it is reachable: deleting
   * every type of the account leaves the question with no answers, and a
   * capture with no type is refused ("every Item has a Type").
   */
  describe('with no types to give it, capture says so instead of capturing', () => {
    it('shows no box of types, says where one is made, and asks for nothing', async () => {
      const { mutate, user } = aForm([]);

      await user.type(screen.getByLabelText('Capture a note or to-do'), 'Buy milk');
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      expect(anyTypeBox()).toBeNull();
      expect(screen.getByText(NO_TYPES)).toBeVisible();
      expect(screen.getByRole('button', { name: 'Capture' })).toBeDisabled();
      expect(mutate).not.toHaveBeenCalled();
    });

    /**
     * The stored copy of a workspace can be older than the field that carries
     * the account's types (components/InboxPanel.tsx), and "no types yet" is a
     * claim about the account rather than about what has reached this column.
     */
    it('says nothing at all where this copy does not carry the types yet', () => {
      aForm(null);

      expect(anyTypeBox()).toBeNull();
      expect(screen.queryByText(NO_TYPES)).toBeNull();
      expect(screen.getByRole('button', { name: 'Capture' })).toBeDisabled();
    });
  });

  describe('a thought that could not be captured stays in the box, and says why', () => {
    it.each([
      {
        situation: 'the account refused it',
        refuses: new CommandRefused(404, 'that workspace is not there any more'),
        says: 'that workspace is not there any more',
      },
      {
        situation: 'the request never arrived',
        refuses: new Error('offline'),
        says: 'That did not reach the server. Try again.',
      },
    ])('$situation', async ({ refuses, says }) => {
      const { user } = aForm([ACTION, THOUGHT], [], refuses);

      const box = screen.getByLabelText('Capture a note or to-do');
      await user.type(box, 'Why is this slow?');
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      // The note is still there to be captured again, and the reason is on
      // screen - clearing it first threw it away with nothing said.
      expect(await screen.findByText(says)).toBeVisible();
      expect(box).toHaveValue('Why is this slow?');
    });
  });
});
