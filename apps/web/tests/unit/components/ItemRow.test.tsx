import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Item, ItemType } from '@cockpit/shared';
import { ItemRow } from '../../../src/components/ItemRow';
import { SWIPE_THRESHOLD_PX } from '../../../src/swipe';
import { UndoWhatJustHappened } from '../../../src/undo';
import { useCommand, useSendCommand } from '../../../src/api/queries';

vi.mock('../../../src/api/queries', () => ({ useCommand: vi.fn(), useSendCommand: vi.fn() }));

const mockUseCommand = vi.mocked(useCommand);
const mockUseSendCommand = vi.mocked(useSendCommand);

function anItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'item-1',
    tenantId: 'tenant-default',
    workspaceId: 'ws-work',
    workspaceDecided: true,
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    title: 'Make appointment with Novy',
    preview: null,
    sourceResolvedAt: null,
    typeId: null,
    nextAction: null,
    completedAt: null,
    priority: null,
    dueDate: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-12T10:00:00.000Z',
    updatedAt: '2026-08-12T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * Renders one row and hands back the changes it asks for.
 *
 * `settles` runs the caller's `onSuccess`, which is what a change that really
 * landed does - and what the offer of an undo waits for.
 */
function aRow({
  settles = false,
  onMoveTo,
  item = anItem(),
}: {
  settles?: boolean;
  onMoveTo?: (from: HTMLElement | null) => void;
  item?: Item;
} = {}) {
  const mutate = vi.fn((_args, options?: { onSuccess?: () => void }) => {
    if (settles) options?.onSuccess?.();
  });
  const send = vi.fn(() => Promise.resolve());
  mockUseCommand.mockReturnValue({ mutate, isPending: false } as never);
  mockUseSendCommand.mockReturnValue(send);
  render(
    <UndoWhatJustHappened>
      <ItemRow item={item} workspaceId="ws-work" {...(onMoveTo ? { onMoveTo } : {})} />
    </UndoWhatJustHappened>,
  );
  return { mutate, send };
}

/**
 * A finger down, across and off the row.
 *
 * Synthetic events, so what this proves is that the handlers are attached and
 * hand their numbers to the right decision - not that a thumb can do it, which
 * jsdom cannot say anything about at all. The rules themselves are
 * tests/unit/swipe.test.ts and the gesture is tests/e2e/triage.test.ts.
 */
function swipe({
  dx,
  dy = 0,
  pointerType = 'touch',
  pointerId = 1,
}: { dx: number; dy?: number; pointerType?: string; pointerId?: number }) {
  const row = screen.getByRole('listitem');
  fireEvent.pointerDown(row, { pointerType, pointerId, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(row, { pointerType, pointerId, clientX: dx, clientY: dy });
  fireEvent.pointerUp(row, { pointerType, pointerId, clientX: dx, clientY: dy });
}

const past = SWIPE_THRESHOLD_PX + 10;

async function choose(user: ReturnType<typeof userEvent.setup>, option: string) {
  await user.click(screen.getByLabelText('Item actions'));
  await user.click(await screen.findByText(option));
}

describe('Triage', () => {
  describe("an item's menu offers only what the app does, for that row's own item", () => {
    it.each([
      { option: 'Mark done', name: 'set_done', field: 'done' },
      { option: 'Dismiss', name: 'set_dismissed', field: 'dismissed' },
    ])('$option', async ({ option, name, field }) => {
      const user = userEvent.setup();
      const { mutate } = aRow();

      await choose(user, option);

      expect(mutate).toHaveBeenCalledTimes(1);
      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe(name);
      expect(asked.payload[field]).toBe(true);
      expect(asked.payload.itemId).toBe('item-1');
    });

    // The four the app stopped having ("An item is either yours to deal with or
    // finished with", issue 154). Named rather than counted, so the rule says
    // which entries went rather than how many.
    it.each(['Make it a task', 'Waiting on someone', 'Snooze a week', 'Goal for today'])(
      'no longer offers %s',
      async (option) => {
        const user = userEvent.setup();
        aRow();

        await user.click(screen.getByRole('button', { name: 'Item actions' }));

        // The menu is open - without this, an entry that is absent because
        // nothing opened would read the same as one that is gone on purpose.
        expect(screen.getByRole('menuitem', { name: 'Mark done' })).toBeVisible();
        expect(screen.queryByRole('menuitem', { name: option })).toBeNull();
      },
    );
  });

  describe('a swipe that acts sends its change; one that stops short puts the row back', () => {
    it('dismisses on a swipe left that went far enough', () => {
      const { mutate } = aRow();

      swipe({ dx: -past });

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate.mock.calls[0]![0].payload.dismissed).toBe(true);
    });

    it('opens the same picker Move to… opens, on a swipe right', () => {
      const asked = vi.fn();
      aRow({ onMoveTo: asked });

      swipe({ dx: past });

      expect(asked).toHaveBeenCalledTimes(1);
    });

    it('sends nothing when the gesture meant nothing', () => {
      // One case, not one per way of meaning nothing: they are the same branch
      // here, and which distances mean nothing is
      // apps/web/tests/unit/swipe.test.ts's rule rather than this one's.
      const asked = vi.fn();
      const { mutate } = aRow({ onMoveTo: asked });

      swipe({ dx: SWIPE_THRESHOLD_PX - 10 });

      expect(mutate).not.toHaveBeenCalled();
      expect(asked).not.toHaveBeenCalled();
    });

    describe('the swipe belongs to the finger that started it', () => {
      // A finger resting on the row mid-swipe used to overwrite where the
      // gesture began, and the release was then measured from the wrong place.
      // Two halves hold it: the second finger is not taken for the first, and
      // only the finger that started can end it.
      const down = (row: HTMLElement, pointerId: number, clientX: number) =>
        fireEvent.pointerDown(row, { pointerType: 'touch', pointerId, clientX, clientY: 0 });
      const move = (row: HTMLElement, pointerId: number, clientX: number) =>
        fireEvent.pointerMove(row, { pointerType: 'touch', pointerId, clientX, clientY: 0 });
      const up = (row: HTMLElement, pointerId: number, clientX: number) =>
        fireEvent.pointerUp(row, { pointerType: 'touch', pointerId, clientX, clientY: 0 });

      it('carries on when a second finger lands on the row', () => {
        const { mutate } = aRow();
        const row = screen.getByRole('listitem');

        down(row, 1, 0);
        move(row, 1, -past);
        down(row, 2, 300);
        up(row, 1, -past);

        expect(mutate).toHaveBeenCalledTimes(1);
        expect(mutate.mock.calls[0]![0].payload.dismissed).toBe(true);
      });

      it('is not started by a touch that landed on a control', () => {
        // The menu opens on pointerdown and the same event bubbles up to the
        // row, so tapping the three dots both opened the menu and began a
        // swipe - and the release then landed on a menu entry in a portal
        // outside this row, so nothing ever ended it.
        const asked = vi.fn();
        const { mutate } = aRow({ onMoveTo: asked });
        const menu = screen.getByLabelText('Item actions');
        // Held before the press: opening the menu takes the row out of the
        // accessibility tree, which is Radix doing its job rather than
        // anything this case is about.
        const row = screen.getByRole('listitem');

        fireEvent.pointerDown(menu, { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
        fireEvent.pointerUp(row, {
          pointerType: 'touch',
          pointerId: 1,
          clientX: -past,
          clientY: 0,
        });

        expect(mutate).not.toHaveBeenCalled();
        expect(asked).not.toHaveBeenCalled();
      });

      it('is not ended by a finger that was not making it', () => {
        const asked = vi.fn();
        const { mutate } = aRow({ onMoveTo: asked });
        const row = screen.getByRole('listitem');

        down(row, 1, 0);
        down(row, 2, 300);
        // The second finger lifts far from where the first went down, which is
        // the whole distance a swipe rightward would need - so without the
        // check this opens the picker for a gesture nobody made.
        up(row, 2, 300);

        expect(asked).not.toHaveBeenCalled();
        expect(mutate).not.toHaveBeenCalled();
      });
    });

    it('leaves a mouse alone, because a desktop row is dragged rather than swiped', () => {
      const asked = vi.fn();
      const { mutate } = aRow({ onMoveTo: asked });

      swipe({ dx: -past, pointerType: 'mouse' });

      expect(mutate).not.toHaveBeenCalled();
      expect(asked).not.toHaveBeenCalled();
    });
  });

  describe('what just happened can be put back, until the offer runs out', () => {
    it('offers a dismissal back, as the same change turned round', async () => {
      const user = userEvent.setup();
      const { send } = aRow({ settles: true });

      await choose(user, 'Dismiss');
      expect(screen.getByRole('status')).toHaveTextContent(
        '“Make appointment with Novy” dismissed',
      );
      await user.click(screen.getByRole('button', { name: 'Undo' }));

      // Nothing about the row is read to build the way back, which is what
      // stops a dismissal putting back the wrong thing.
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'set_dismissed',
          payload: expect.objectContaining({ itemId: 'item-1', dismissed: false }),
        }),
      );
    });

    it('offers a finish back, as the same change turned round', async () => {
      const user = userEvent.setup();
      const { send } = aRow({ settles: true });

      await choose(user, 'Mark done');
      expect(screen.getByRole('status')).toHaveTextContent(
        '“Make appointment with Novy” marked done',
      );
      await user.click(screen.getByRole('button', { name: 'Undo' }));

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'set_done',
          payload: expect.objectContaining({ itemId: 'item-1', done: false }),
        }),
      );
    });

    it('offers nothing back while the dismissal is still in flight', async () => {
      const user = userEvent.setup();
      aRow({ settles: false });

      await choose(user, 'Dismiss');

      expect(screen.queryByRole('status')).toBeNull();
    });
  });

});

describe('Triage', () => {
  describe('an Inbox row says where it came from and how long it has waited', () => {
    it('carries neither the mark nor the word the status had', () => {
      mockUseCommand.mockReturnValue({ mutate: vi.fn(), isPending: false } as never);
      const { container } = render(<ItemRow item={anItem({})} workspaceId="ws-work" />);

      // The dot at the head of the row and the word under the title were the
      // status's two places, and both went to the type ("An item is either
      // yours to deal with or finished with", issue 154).
      expect(container.querySelector('li > span[aria-hidden="true"]')).toBeNull();
      expect(screen.queryByText('To process')).toBeNull();
      expect(screen.getByText(/Own/)).toBeInTheDocument();
    });

    it.each([
      { situation: 'has been sitting for days', createdAt: '2026-08-12T10:00:00.000Z', shows: '14d' },
      { situation: 'was captured this morning', createdAt: '2026-08-26T08:00:00.000Z', shows: null },
    ])('an item that $situation', ({ createdAt, shows }) => {
      // The row reads the clock, so the clock is what the test replaces - the
      // arithmetic itself is proved without one in tests/unit/waited.test.ts.
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse('2026-08-26T10:00:00.000Z'));
      try {
        mockUseCommand.mockReturnValue({ mutate: vi.fn(), isPending: false } as never);
        render(<ItemRow item={anItem({ createdAt })} workspaceId="ws-work" />);

        if (shows) expect(screen.getByText(shows)).toBeInTheDocument();
        else expect(screen.queryByTitle(/^Waiting /)).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('Triage', () => {
  describe('a row shows what type it is', () => {
    /** One row, rendered on its own, with the type it was given. */
    function aRowOf(itemType: ItemType | undefined) {
      mockUseCommand.mockReturnValue({ mutate: vi.fn(), isPending: false } as never);
      mockUseSendCommand.mockReturnValue(vi.fn(() => Promise.resolve()));
      return render(
        <ItemRow item={anItem({})} itemType={itemType} workspaceId="ws-work" />,
      );
    }

    const aType = (name: string, color: string): ItemType => ({
      id: '11111111-1111-7111-8111-111111111111',
      tenantId: 'tenant',
      name,
      color,
      position: 0,
      createdAt: '2026-08-31T08:00:00.000Z',
    });

    it.each([
      { situation: 'an action', itemType: aType('Action', '#6f62b5') },
      { situation: 'a thought', itemType: aType('Thought', '#3a72c8') },
      { situation: 'one made by using it', itemType: aType('Question', '#c06a45') },
    ])('says the type in words and in its own colour for $situation', ({ itemType }) => {
      const { container, unmount } = aRowOf(itemType);

      expect(screen.getByText(itemType.name)).toBeInTheDocument();
      const mark = container.querySelector('li > span[aria-hidden="true"]');
      // The colour is the dot's, and the word is what carries it to anyone not
      // looking at colours - neither alone would be the whole mark.
      expect(mark).not.toBeNull();
      expect((mark as HTMLElement).style.backgroundColor).not.toBe('');
      unmount();
    });

    it('draws an item with no type without one, rather than hiding it', () => {
      const { container } = aRowOf(undefined);

      expect(screen.getByText('Make appointment with Novy')).toBeInTheDocument();
      expect(container.querySelector('li > span[aria-hidden="true"]')).toBeNull();
    });
  });
});
