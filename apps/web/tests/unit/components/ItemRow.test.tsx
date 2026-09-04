import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Item, ItemType } from '@cockpit/shared';
import { ItemRow } from '../../../src/components/ItemRow';
import { HOLD_DRIFT_PX, HOLD_MS } from '../../../src/hold';
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
  onMoveHere,
  item = anItem(),
  selecting,
}: {
  settles?: boolean;
  onMoveTo?: (from: HTMLElement | null) => void;
  onMoveHere?: () => void;
  item?: Item;
  selecting?: { picked: boolean; revealed: boolean; onPick: (withShift: boolean) => void };
} = {}) {
  const mutate = vi.fn((_args, options?: { onSuccess?: () => void }) => {
    if (settles) options?.onSuccess?.();
  });
  const send = vi.fn(() => Promise.resolve());
  mockUseCommand.mockReturnValue({ mutate, isPending: false } as never);
  mockUseSendCommand.mockReturnValue(send);
  render(
    <UndoWhatJustHappened>
      <ItemRow
        item={item}
        workspaceId="ws-work"
        {...(onMoveTo ? { onMoveTo } : {})}
        {...(onMoveHere ? { onMoveHere } : {})}
        {...(selecting ? { selecting } : {})}
      />
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

describe('Capture', () => {
  /**
   * F1: which entries a menu carries, and what the row says about itself, are
   * the component's. That the entry's move actually settles the workspace, and
   * that the item then leaves every other Inbox, is a query and is proved
   * against a real store in
   * apps/api/tests/integration/http/panel-items.test.ts.
   */
  describe('a row says when it belongs to no workspace yet', () => {
    it.each([
      { situation: 'belonging to no workspace yet', decided: false, marked: true },
      { situation: 'belonging to this one', decided: true, marked: false },
    ])('$situation', ({ decided, marked }) => {
      aRow({ item: anItem({ workspaceDecided: decided }) });

      expect(screen.queryByText('Any workspace') !== null).toBe(marked);
    });

    /**
     * A snapshot stored before the field existed is rehydrated without being
     * parsed again, so the field can simply be missing - and missing has to
     * read as *belongs here*. The other way round would put every item an old
     * copy holds into every workspace's Inbox at once.
     */
    it('takes an item from before the field as belonging where it is', () => {
      const { workspaceDecided: _, ...older } = anItem();
      aRow({ item: older as Item });

      expect(screen.queryByText('Any workspace')).toBeNull();
    });
  });

  describe('the workspace you are looking at is one press away, and only where there is a question', () => {
    it.each([
      { situation: 'belonging to no workspace yet', decided: false, offered: true },
      { situation: 'belonging to this one already', decided: true, offered: false },
    ])('$situation', async ({ decided, offered }) => {
      const user = userEvent.setup();
      aRow({ item: anItem({ workspaceDecided: decided }), onMoveHere: vi.fn() });

      await user.click(screen.getByLabelText('Item actions'));

      expect(screen.queryByText('Move to this workspace') !== null).toBe(offered);
    });

    it('asks for it when it is chosen', async () => {
      const user = userEvent.setup();
      const onMoveHere = vi.fn();
      aRow({ item: anItem({ workspaceDecided: false }), onMoveHere });

      await choose(user, 'Move to this workspace');

      expect(onMoveHere).toHaveBeenCalled();
    });
  });
});

/**
 * Holding a row still to pick it out ("Start a selection with a long press, so
 * a phone can do it too", issue 170).
 *
 * Synthetic events on a fake clock, so what this proves is that the handlers
 * are attached, hand their numbers to the right decision, and stop waiting when
 * the gesture stops being a hold. How far is too far is tests/unit/hold.test.ts,
 * and that a thumb can do it at all is tests/e2e/selecting.test.ts.
 */

/** A finger down on the row, held for `ms`, having moved `dx`/`dy` first. */
function hold({
  ms = HOLD_MS,
  dx = 0,
  dy = 0,
  pointerType = 'touch',
  onto = 'listitem' as 'listitem' | 'menu',
  cancelled = false,
}: {
  ms?: number;
  dx?: number;
  dy?: number;
  pointerType?: string;
  onto?: 'listitem' | 'menu';
  cancelled?: boolean;
} = {}) {
  const row = screen.getByRole('listitem');
  const target = onto === 'menu' ? screen.getByLabelText('Item actions') : row;
  fireEvent.pointerDown(target, { pointerType, pointerId: 1, clientX: 0, clientY: 0 });
  if (dx !== 0 || dy !== 0) {
    fireEvent.pointerMove(row, { pointerType, pointerId: 1, clientX: dx, clientY: dy });
  }
  if (cancelled) fireEvent.pointerCancel(row, { pointerType, pointerId: 1 });
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('Selection', () => {
  describe('a row held still is picked out, and anything else is not', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('picks the row out once the finger has rested long enough', () => {
      const onPick = vi.fn();
      aRow({ selecting: { picked: false, revealed: false, onPick } });

      hold();

      expect(onPick).toHaveBeenCalledWith(false);
    });

    it('puts the row back where it started, however far the finger drifted', () => {
      // A hold allows a little drift, so the row can already be drawn a few
      // pixels across when the timer fires - and nothing moves it back
      // afterwards, because a spent gesture stops drawing. It would have stayed
      // there, mid-swipe, until the finger came off.
      const onPick = vi.fn();
      aRow({ selecting: { picked: false, revealed: false, onPick } });

      hold({ dx: HOLD_DRIFT_PX });

      expect(onPick).toHaveBeenCalledWith(false);
      expect(screen.getByRole('listitem')).not.toHaveStyle({
        transform: `translateX(${HOLD_DRIFT_PX}px)`,
      });
    });

    it.each([
      { situation: 'it has not rested long enough yet', ms: HOLD_MS - 50 },
      { situation: 'it set off across the row instead', dx: SWIPE_THRESHOLD_PX + 10 },
      { situation: 'it set off down the list instead', dy: 40 },
      { situation: 'the browser took the gesture for a scroll', cancelled: true },
      // A held mouse button is the beginning of a drag onto a panel, and a
      // desktop row shows its tick on hover.
      { situation: 'it was a mouse button being held down', pointerType: 'mouse' },
      // A touch that starts on a control belongs to that control, which is the
      // rule the swipe already keeps.
      { situation: 'it started on the row’s own menu', onto: 'menu' as const },
    ])('picks nothing out when $situation', (how) => {
      const onPick = vi.fn();
      aRow({ selecting: { picked: false, revealed: false, onPick } });

      hold(how);

      expect(onPick).not.toHaveBeenCalled();
    });

    it('is finished once it has picked the row out, whatever the finger does next', () => {
      // The finger is still down when a hold fires, and what it does afterwards
      // is still measured from where it started - so without a gesture that
      // knows it is spent, resting on a row and then sliding away picked the
      // row out *and* dismissed it.
      const onPick = vi.fn();
      const { mutate } = aRow({ selecting: { picked: false, revealed: false, onPick } });

      const row = screen.getByRole('listitem');
      fireEvent.pointerDown(row, { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      act(() => {
        vi.advanceTimersByTime(HOLD_MS);
      });
      fireEvent.pointerMove(row, { pointerType: 'touch', pointerId: 1, clientX: -past, clientY: 0 });

      // Asserted here, with the finger still down: it does not draw the gesture
      // it will not make. The row would otherwise slide and colour itself to
      // promise a dismissal that has already been refused - and letting go puts
      // it back either way, so after the release the two are indistinguishable.
      expect(row).not.toHaveStyle({ transform: `translateX(${-past}px)` });

      fireEvent.pointerUp(row, { pointerType: 'touch', pointerId: 1, clientX: -past, clientY: 0 });

      expect(onPick).toHaveBeenCalledTimes(1);
      expect(mutate).not.toHaveBeenCalled();
    });

    it('stops waiting when the finger lifts, so a later tap is not a hold', () => {
      // The timer outlives the gesture unless something stops it: without that,
      // resting a moment on one row and letting go picked it out half a second
      // later, while the finger was somewhere else entirely.
      const onPick = vi.fn();
      aRow({ selecting: { picked: false, revealed: false, onPick } });

      const row = screen.getByRole('listitem');
      fireEvent.pointerDown(row, { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerUp(row, { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      act(() => {
        vi.advanceTimersByTime(HOLD_MS * 2);
      });

      expect(onPick).not.toHaveBeenCalled();
    });

    it('leaves a row that cannot be picked out alone', () => {
      // A list drawn without a selection - a test harness, or a screen that
      // does not offer one - has no tick, so a hold has nothing to do.
      aRow();

      expect(() => hold()).not.toThrow();
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    });
  });
});
