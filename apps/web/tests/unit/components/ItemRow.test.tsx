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
    capturedMessage: null,
    description: null,
    textsSettledAt: null,
    textsProposedAt: null,
    readings: null,
    proposedPanelId: null,
    proposedPanelReason: null,
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
  onOpen,
  onMoveHere,
  item = anItem(),
  selecting,
  routingProposal,
  onAcceptRouting,
  mayBeADuplicate,
  onSettleNotADuplicate,
}: {
  settles?: boolean;
  onMoveTo?: (from: HTMLElement | null) => void;
  onOpen?: () => void;
  onMoveHere?: () => void;
  item?: Item;
  selecting?: {
    picked: boolean;
    revealed: boolean;
    onPick: (withShift: boolean) => void;
    onEndSelection: () => void;
  };
  routingProposal?: { panelName: string; reason: string };
  onAcceptRouting?: () => void;
  mayBeADuplicate?: boolean;
  onSettleNotADuplicate?: () => void;
} = {}) {
  const mutate = vi.fn((_args, options?: { onSuccess?: () => void }) => {
    if (settles) options?.onSuccess?.();
  });
  const send = vi.fn(() => Promise.resolve({ ok: true as const, applied: true }));
  mockUseCommand.mockReturnValue({ mutate, isPending: false } as never);
  mockUseSendCommand.mockReturnValue(send);
  const rendered = (selectingNow?: typeof selecting) => (
    <UndoWhatJustHappened>
      <ItemRow
        item={item}
        workspaceId="ws-work"
        {...(onMoveTo ? { onMoveTo } : {})}
        {...(onOpen ? { onOpen } : {})}
        {...(onMoveHere ? { onMoveHere } : {})}
        {...(selectingNow ? { selecting: selectingNow } : {})}
        {...(routingProposal ? { routingProposal } : {})}
        {...(onAcceptRouting ? { onAcceptRouting } : {})}
        {...(mayBeADuplicate === undefined ? {} : { mayBeADuplicate })}
        {...(onSettleNotADuplicate ? { onSettleNotADuplicate } : {})}
      />
    </UndoWhatJustHappened>
  );
  const { rerender } = render(rendered(selecting));
  return {
    mutate,
    send,
    /** Re-renders the same row with a different `selecting`, in place. */
    rerenderSelecting: (next: typeof selecting) => rerender(rendered(next)),
  };
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

/**
 * The same, stopped with the finger still down, which is where the row says
 * what letting go would do.
 */
function swipeAndHold({
  dx,
  dy = 0,
  pointerType = 'touch',
  pointerId = 1,
}: { dx: number; dy?: number; pointerType?: string; pointerId?: number }) {
  const row = screen.getByRole('listitem');
  fireEvent.pointerDown(row, { pointerType, pointerId, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(row, { pointerType, pointerId, clientX: dx, clientY: dy });
}

const lift = (row: HTMLElement, dx: number) =>
  fireEvent.pointerUp(row, { pointerType: 'touch', pointerId: 1, clientX: dx, clientY: 0 });

/**
 * The band a swipe uncovers, or null while nothing is being named.
 *
 * A direct child of the `li`, which is what tells it from everything else the
 * row draws: the row's own contents live inside the wrapper that slides.
 */
const namedByTheRow = () =>
  screen.getByRole('listitem').querySelector(':scope > span[aria-hidden="true"]');

/**
 * The part of the row that slides under a finger, which is not the `li` itself.
 *
 * A direct child, like the band above: the `li` holds exactly two things, and
 * asking for the first `div` anywhere beneath it would happily return some
 * wrapper nested deeper - which is how the transform assertions went vacuous
 * when the transform moved off the `li` in the first place.
 */
const theSlidingPart = () => screen.getByRole('listitem').querySelector(':scope > div');

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
  });

  describe('a row being swiped names the action, and stops naming it when the gesture ends', () => {
    // What the words are for each distance is apps/web/tests/unit/swipe.test.ts;
    // what is only true here is that the row draws them at all, and takes them
    // away again on every way a gesture can finish.
    // A word half off the edge is worse than no word, so a band too narrow to
    // hold one carries the mark alone - which is why the wide cases are what
    // say the words and the narrow ones say none.
    it.each([
      { situation: 'swiped right, barely', dx: 20, named: '' },
      { situation: 'swiped right, far enough to act but too narrow to read', dx: past, named: '' },
      { situation: 'swiped right, wide enough for the word', dx: 160, named: 'Move to…' },
      { situation: 'swiped left, barely', dx: -20, named: '' },
      { situation: 'swiped left, wide enough for the word', dx: -160, named: 'Dismiss' },
    ])('$situation', ({ dx, named }) => {
      aRow({ onMoveTo: vi.fn() });

      swipeAndHold({ dx });

      const band = namedByTheRow();
      expect(band).not.toBeNull();
      expect(band?.textContent).toBe(named);
    });

    it('says nothing to a thumb that is scrolling the list past it', () => {
      aRow({ onMoveTo: vi.fn() });

      swipeAndHold({ dx: 40, dy: 90 });

      expect(namedByTheRow()).toBeNull();
    });

    it.each([
      { situation: 'the finger lifts', finish: (row: HTMLElement) => lift(row, -past) },
      {
        // A scroll the browser decided was a scroll after all is no swipe at
        // all, and a band left behind would name an action nothing took.
        situation: 'the browser takes the gesture over',
        finish: (row: HTMLElement) =>
          fireEvent.pointerCancel(row, { pointerType: 'touch', pointerId: 1 }),
      },
    ])('says nothing once $situation', ({ finish }) => {
      aRow({ onMoveTo: vi.fn() });
      const row = screen.getByRole('listitem');

      swipeAndHold({ dx: -past });
      expect(namedByTheRow()).not.toBeNull();

      finish(row);

      expect(namedByTheRow()).toBeNull();
    });

    it('says nothing to a mouse, which never swipes', () => {
      aRow({ onMoveTo: vi.fn() });

      swipeAndHold({ dx: -past, pointerType: 'mouse' });

      expect(namedByTheRow()).toBeNull();
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
      expect(container.querySelector('li span[aria-hidden="true"]')).toBeNull();
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

/**
 * F1: the row's own wiring. What a label *is* is a pure decision proved in
 * packages/shared/tests/unit/domain/item.test.ts; what is asked here is that
 * the row asks it, and that the two ways into the form both ask for this item.
 */
describe('Item editing', () => {
  describe('a row shows the label the item has, and says whether there is more written about it', () => {
    it('says an item nobody has named is untitled, rather than borrowing what was captured', () => {
      aRow({ item: anItem({ title: '', capturedMessage: 'Ask Novy about part 11' }) });

      expect(screen.getByRole('listitem')).toHaveTextContent('Untitled');
    });

    it.each([
      { situation: 'an item with a description', description: 'Tolerances', marked: true },
      { situation: 'an item with none', description: null, marked: false },
    ])('$situation', ({ description, marked }) => {
      aRow({ item: anItem({ description }) });

      expect(screen.queryByLabelText('Has a description') !== null).toBe(marked);
    });

    /**
     * "Offer the other readings when a captured note says two things" (issue
     * 297): the row carries one quiet mark and nothing else, so the common
     * case - no readings, which is most notes - draws exactly the row it
     * always did.
     */
    const AN_ALTERNATE_READING = [
      { title: 'Call in January', description: '', meaning: "'jan' is short for January" },
    ];

    it.each([
      { situation: 'an item with another reading', readings: AN_ALTERNATE_READING, settled: null, marked: true },
      { situation: 'an item with none', readings: null, settled: null, marked: false },
      {
        situation: 'an item whose texts are already settled',
        readings: AN_ALTERNATE_READING,
        settled: '2026-08-12T10:00:00.000Z',
        marked: false,
      },
    ])('$situation', ({ readings, settled, marked }) => {
      aRow({ item: anItem({ readings, textsSettledAt: settled }) });

      expect(screen.queryByLabelText('Reads more than one way') !== null).toBe(marked);
    });

    /**
     * "Flag a captured note that says what another one already said" (issue
     * 407): the row says a note may be repeating another and nothing about
     * which one, exactly as the readings mark above says nothing about the
     * readings. Whether it is repeating anything is the list's answer and not
     * the row's - which is what this proves, by drawing both answers.
     */
    it.each([
      { situation: 'an item that may be saying what another one already said', flagged: true },
      { situation: 'an item that is saying something of its own', flagged: false },
    ])('$situation', ({ flagged }) => {
      aRow({ mayBeADuplicate: flagged });

      expect(screen.queryByLabelText('Possible duplicate') !== null).toBe(flagged);
    });

    /**
     * "Say a flagged pair is not a duplicate" (issue 408): the menu entry is
     * the list's to offer, exactly as the mark is - a row with the mark but
     * nothing handed down to settle offers no way to, rather than a way that
     * does nothing.
     */
    it.each([
      { situation: 'flagged, and given something to settle', flagged: true, given: true, shown: true },
      { situation: 'flagged, but given nothing to settle', flagged: true, given: false, shown: false },
      { situation: 'not flagged, though given something to settle', flagged: false, given: true, shown: false },
    ])('offers "Not a duplicate" only when $situation', async ({ flagged, given, shown }) => {
      const user = userEvent.setup();
      aRow({
        mayBeADuplicate: flagged,
        ...(given ? { onSettleNotADuplicate: () => {} } : {}),
      });

      await user.click(screen.getByRole('button', { name: 'Item actions' }));

      expect(screen.queryByRole('menuitem', { name: 'Not a duplicate' }) !== null).toBe(shown);
    });

    it('settles by calling what the list handed down, not by sending anything itself', async () => {
      const user = userEvent.setup();
      const settle = vi.fn();
      const { mutate, send } = aRow({ mayBeADuplicate: true, onSettleNotADuplicate: settle });

      await choose(user, 'Not a duplicate');

      expect(settle).toHaveBeenCalledTimes(1);
      expect(mutate).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });
  });

  /**
   * "Propose where a captured note belongs, without filing it there" (issue
   * 298): the chip is only ever drawn from what the list resolved and handed
   * down, never worked out by the row itself - `ItemList.test.tsx` is where
   * that resolution is proved.
   */
  describe('a row offers the panel Cockpit proposed, and takes it in one click', () => {
    it('draws nothing when nothing was handed down', () => {
      aRow();

      expect(screen.queryByText(/^→/) !== null).toBe(false);
    });

    it('names the panel, and explains why on hover', () => {
      aRow({
        routingProposal: { panelName: 'Compliance questions', reason: 'a compliance question' },
        onAcceptRouting: () => {},
      });

      const chip = screen.getByText('→ Compliance questions');
      expect(chip).toHaveAttribute('title', 'a compliance question');
    });

    it('takes the proposal with one click, and lets nothing else on the row hear it', async () => {
      const user = userEvent.setup();
      const onAcceptRouting = vi.fn();
      const onOpen = vi.fn();
      aRow({
        routingProposal: { panelName: 'Compliance questions', reason: 'a compliance question' },
        onAcceptRouting,
        onOpen,
      });

      await user.click(screen.getByText('→ Compliance questions'));

      expect(onAcceptRouting).toHaveBeenCalledOnce();
      expect(onOpen).not.toHaveBeenCalled();
    });
  });

  describe('a row spells out a label it had to cut, and stays quiet about one it drew whole', () => {
    /**
     * Hovers a label that is drawn in the width given.
     *
     * The widths are put on the element because jsdom has no layout engine and
     * reports every element as zero-sized, so what this proves is the wiring -
     * that the hover measures the label itself and hands the two widths to the
     * rule. The rule is tests/unit/cutOff.test.ts, and that a real browser
     * really does cut a long title in a narrow column is
     * tests/e2e/inbox.test.ts.
     */
    async function hoverLabel(
      user: ReturnType<typeof userEvent.setup>,
      label: HTMLElement,
      drawn: { scrollWidth: number; clientWidth: number },
    ) {
      Object.defineProperty(label, 'scrollWidth', {
        value: drawn.scrollWidth,
        configurable: true,
      });
      Object.defineProperty(label, 'clientWidth', {
        value: drawn.clientWidth,
        configurable: true,
      });
      await user.hover(label);
    }

    it.each([
      { situation: 'a title wider than the row', scrollWidth: 340, clientWidth: 120, spelled: true },
      { situation: 'a title the row drew whole', scrollWidth: 96, clientWidth: 120, spelled: false },
    ])('$situation', async ({ scrollWidth, clientWidth, spelled }) => {
      const user = userEvent.setup();
      aRow();
      const label = screen.getByText('Make appointment with Novy');

      await hoverLabel(user, label, { scrollWidth, clientWidth });

      if (spelled) expect(label).toHaveAttribute('title', 'Make appointment with Novy');
      else expect(label).not.toHaveAttribute('title');
    });

    it('measures again on every arrival, because the panel it is in can be narrowed under it', async () => {
      const user = userEvent.setup();
      aRow();
      const label = screen.getByText('Make appointment with Novy');

      await hoverLabel(user, label, { scrollWidth: 340, clientWidth: 400 });
      expect(label).not.toHaveAttribute('title');

      // The same label, in a panel that has since been dragged narrow enough to
      // cut it. This way round rather than the other, because a row that had
      // simply forgotten its answer on the way out would also stop offering the
      // tooltip - only a second measurement can start offering one.
      await user.unhover(label);
      await hoverLabel(user, label, { scrollWidth: 340, clientWidth: 120 });
      expect(label).toHaveAttribute('title', 'Make appointment with Novy');
    });

    it('forgets what it measured when the pointer leaves, so no answer outlives the hover', async () => {
      const user = userEvent.setup();
      aRow();
      const label = screen.getByText('Make appointment with Novy');

      await hoverLabel(user, label, { scrollWidth: 340, clientWidth: 120 });
      expect(label).toHaveAttribute('title');

      await user.unhover(label);

      expect(label).not.toHaveAttribute('title');
    });

    it('spells out the label the row drew, not the title underneath it', async () => {
      const user = userEvent.setup();
      aRow({ item: anItem({ title: 'Novy', nextAction: 'Ask Novy about part 11' }) });
      const label = screen.getByText('Ask Novy about part 11');

      await hoverLabel(user, label, { scrollWidth: 340, clientWidth: 120 });

      expect(label).toHaveAttribute('title', 'Ask Novy about part 11');
    });

    it('leaves the description mark out of what it spells out', async () => {
      const user = userEvent.setup();
      aRow({ item: anItem({ description: 'Tolerances' }) });
      const label = screen.getByText('Make appointment with Novy');

      await hoverLabel(user, label, { scrollWidth: 340, clientWidth: 120 });

      // The mark is a sibling of the label rather than part of it, so hovering
      // the label cannot pick it up - the tooltip is the title, not the title
      // and a pilcrow.
      expect(label).toHaveAttribute('title', 'Make appointment with Novy');
    });
  });

  describe('a row opens its own form, from a double-click and from its menu', () => {
    it('opens it on a double-click', async () => {
      const onOpen = vi.fn();
      aRow({ onOpen });

      fireEvent.doubleClick(screen.getByRole('listitem'));

      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('opens it from the menu, which is the way a keyboard has', async () => {
      const user = userEvent.setup();
      const onOpen = vi.fn();
      aRow({ onOpen });

      await choose(user, 'Open');

      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    // A double press on the menu control is easy to do by accident, and the
    // event bubbles to the row: without a check on what was hit, it opened the
    // menu and the form at once.
    it('leaves the form shut when the double-click was on a control of its own', async () => {
      const onOpen = vi.fn();
      aRow({ onOpen });

      fireEvent.doubleClick(screen.getByLabelText('Item actions'));

      expect(onOpen).not.toHaveBeenCalled();
    });

    // The menu's entries are drawn in a portal on the body, so a double press
    // on one reaches the row's handler from outside the row.
    it('leaves the form shut when the double-click was on an entry in the open menu', async () => {
      const user = userEvent.setup();
      const onOpen = vi.fn();
      aRow({ onOpen });

      await user.click(screen.getByLabelText('Item actions'));
      fireEvent.doubleClick(await screen.findByRole('menuitem', { name: 'Mark done' }));

      expect(onOpen).not.toHaveBeenCalled();
    });

    it('offers nothing to open where there is nowhere to open it', async () => {
      const user = userEvent.setup();
      aRow();

      await user.click(screen.getByLabelText('Item actions'));

      expect(screen.queryByRole('menuitem', { name: 'Open' })).toBeNull();
    });
  });
});

describe('Triage', () => {
  describe('a row shows what type it is', () => {
    /** One row, rendered on its own, with the type it was given. */
    function aRowOf(itemType: ItemType | undefined) {
      mockUseCommand.mockReturnValue({ mutate: vi.fn(), isPending: false } as never);
      mockUseSendCommand.mockReturnValue(vi.fn(() => Promise.resolve({ ok: true as const, applied: true })));
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
      // Anywhere in the row rather than a child of it: the row's contents moved
      // inside a wrapper that slides under a finger, and where the mark is
      // nested is not what this rule is about. At rest it is the only
      // undecorated mark a row has - the band a swipe uncovers is drawn only
      // while one is happening.
      const mark = container.querySelector('li span[aria-hidden="true"]');
      // The colour is the dot's, and the word is what carries it to anyone not
      // looking at colours - neither alone would be the whole mark.
      expect(mark).not.toBeNull();
      expect((mark as HTMLElement).style.backgroundColor).not.toBe('');
      unmount();
    });

    it('draws an item with no type without one, rather than hiding it', () => {
      const { container } = aRowOf(undefined);

      expect(screen.getByText('Make appointment with Novy')).toBeInTheDocument();
      expect(container.querySelector('li span[aria-hidden="true"]')).toBeNull();
    });
  });

  /**
   * "Show and edit an item's priority" (issue 433): the level is not echoed
   * in words anywhere else on the row, unlike the type name above, so the
   * mark carries its own title/aria-label rather than being decorative.
   */
  describe('a row shows its priority', () => {
    it.each([
      { situation: 'high priority', priority: 'high' as const, named: 'High priority' },
      { situation: 'normal priority', priority: 'normal' as const, named: 'Normal priority' },
      { situation: 'low priority', priority: 'low' as const, named: 'Low priority' },
    ])('draws a named mark for $situation', ({ priority, named }) => {
      aRow({ item: anItem({ priority }) });

      expect(screen.getByLabelText(named)).toBeInTheDocument();
      expect(screen.getByTitle(named)).toBeInTheDocument();
    });

    it('draws no mark for an item with no priority', () => {
      aRow({ item: anItem({ priority: null }) });

      expect(screen.queryByLabelText('High priority')).toBeNull();
      expect(screen.queryByLabelText('Normal priority')).toBeNull();
      expect(screen.queryByLabelText('Low priority')).toBeNull();
    });

    // A level this build does not recognise - reachable from a tab left open
    // across a deploy that adds one, since a value read out of the cache is
    // never re-validated the way a fresh fetch is. Skipped rather than
    // crashing the row, the same as an item type nobody can resolve.
    it('draws no mark, rather than crashing, for a priority this build does not recognise', () => {
      expect(() =>
        aRow({ item: anItem({ priority: 'urgent' as unknown as Item['priority'] }) }),
      ).not.toThrow();

      expect(screen.getByText('Make appointment with Novy')).toBeInTheDocument();
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
      aRow({ selecting: { picked: false, revealed: false, onPick, onEndSelection: vi.fn() } });

      hold();

      expect(onPick).toHaveBeenCalledWith(false);
    });

    it('puts the row back where it started, however far the finger drifted', () => {
      // A hold allows a little drift, so the row can already be drawn a few
      // pixels across when the timer fires - and nothing moves it back
      // afterwards, because a spent gesture stops drawing. It would have stayed
      // there, mid-swipe, until the finger came off.
      const onPick = vi.fn();
      aRow({ selecting: { picked: false, revealed: false, onPick, onEndSelection: vi.fn() } });

      hold({ dx: HOLD_DRIFT_PX });

      expect(onPick).toHaveBeenCalledWith(false);
      expect(theSlidingPart()).not.toHaveStyle({
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
      aRow({ selecting: { picked: false, revealed: false, onPick, onEndSelection: vi.fn() } });

      hold(how);

      expect(onPick).not.toHaveBeenCalled();
    });

    it('is finished once it has picked the row out, whatever the finger does next', () => {
      // The finger is still down when a hold fires, and what it does afterwards
      // is still measured from where it started - so without a gesture that
      // knows it is spent, resting on a row and then sliding away picked the
      // row out *and* dismissed it.
      const onPick = vi.fn();
      const { mutate } = aRow({ selecting: { picked: false, revealed: false, onPick, onEndSelection: vi.fn() } });

      const row = screen.getByRole('listitem');
      fireEvent.pointerDown(row, { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      act(() => {
        vi.advanceTimersByTime(HOLD_MS);
      });
      fireEvent.pointerMove(row, { pointerType: 'touch', pointerId: 1, clientX: -past, clientY: 0 });

      // Asserted here, with the finger still down: it does not draw the gesture
      // it will not make. The row would otherwise slide and name a dismissal
      // that has already been refused - and letting go puts it back either way,
      // so after the release the two are indistinguishable.
      //
      // Against the part that slides rather than the `li`, which stopped moving
      // when the band a swipe uncovers needed something to stay still behind.
      expect(theSlidingPart()).not.toHaveStyle({ transform: `translateX(${-past}px)` });
      expect(namedByTheRow()).toBeNull();

      fireEvent.pointerUp(row, { pointerType: 'touch', pointerId: 1, clientX: -past, clientY: 0 });

      expect(onPick).toHaveBeenCalledTimes(1);
      expect(mutate).not.toHaveBeenCalled();
    });

    it('stops waiting when the finger lifts, so a later tap is not a hold', () => {
      // The timer outlives the gesture unless something stops it: without that,
      // resting a moment on one row and letting go picked it out half a second
      // later, while the finger was somewhere else entirely.
      const onPick = vi.fn();
      aRow({ selecting: { picked: false, revealed: false, onPick, onEndSelection: vi.fn() } });

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
      // does not offer one - has nothing for a hold to pick out.
      aRow();

      expect(() => hold()).not.toThrow();
    });
  });

  /**
   * A click anywhere on the row, not only a checkbox ("Pick a row by
   * ctrl/shift-click instead of aiming for a checkbox, and suspend single-row
   * actions while a selection is held", issue 438), and never opening it
   * itself ("Require a double-click to open a row again, now that a plain
   * click opens it", issue 456) - opening is a double-click's or the menu's
   * own Open.
   *
   * Which rows a shift-click's span covers is still `afterClicking`'s, proved
   * in `selection.test.ts` - what is asked here is which call the row's click
   * handler makes, and when it ends a selection instead.
   */
  describe('a click anywhere on the row picks it, or ends a selection, but never opens it', () => {
    it('picks an unpicked row alone on a ctrl-click, nothing yet selected', () => {
      const onPick = vi.fn();
      aRow({ selecting: { picked: false, revealed: false, onPick, onEndSelection: vi.fn() } });

      fireEvent.click(screen.getByRole('listitem'), { ctrlKey: true });

      expect(onPick).toHaveBeenCalledWith(false);
    });

    it('picks the same way on a cmd-click', () => {
      const onPick = vi.fn();
      aRow({ selecting: { picked: false, revealed: false, onPick, onEndSelection: vi.fn() } });

      fireEvent.click(screen.getByRole('listitem'), { metaKey: true });

      expect(onPick).toHaveBeenCalledWith(false);
    });

    it('adds to a selection already held on a ctrl/cmd-click', () => {
      const onPick = vi.fn();
      aRow({ selecting: { picked: false, revealed: true, onPick, onEndSelection: vi.fn() } });

      fireEvent.click(screen.getByRole('listitem'), { ctrlKey: true });

      expect(onPick).toHaveBeenCalledWith(false);
    });

    it('reaches a span across rows on a shift-click', () => {
      const onPick = vi.fn();
      aRow({ selecting: { picked: false, revealed: true, onPick, onEndSelection: vi.fn() } });

      fireEvent.click(screen.getByRole('listitem'), { shiftKey: true });

      expect(onPick).toHaveBeenCalledWith(true);
    });

    it('opens nothing on a plain mouse click, nothing yet selected', () => {
      // A plain click only ends a selection; opening is a double-click's or
      // the menu's own Open ("Require a double-click to open a row again, now
      // that a plain click opens it", issue 456).
      const onOpen = vi.fn();
      const onPick = vi.fn();
      const onEndSelection = vi.fn();
      aRow({ onOpen, selecting: { picked: false, revealed: false, onPick, onEndSelection } });

      fireEvent.click(screen.getByRole('listitem'));

      expect(onOpen).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();
      expect(onEndSelection).not.toHaveBeenCalled();
    });

    it('clears the whole selection on a plain mouse click, while one is held, without opening the row', () => {
      const onOpen = vi.fn();
      const onEndSelection = vi.fn();
      aRow({
        onOpen,
        selecting: { picked: false, revealed: true, onPick: vi.fn(), onEndSelection },
      });

      fireEvent.click(screen.getByRole('listitem'));

      expect(onEndSelection).toHaveBeenCalledTimes(1);
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('opens nothing on a plain touch tap, nothing yet selected', () => {
      const onOpen = vi.fn();
      const onPick = vi.fn();
      aRow({ onOpen, selecting: { picked: false, revealed: false, onPick, onEndSelection: vi.fn() } });
      const row = screen.getByRole('listitem');

      fireEvent.pointerDown(row, { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.click(row);

      expect(onOpen).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();
    });

    it('toggles the row on a plain touch tap instead of opening it, while a selection is held', () => {
      // Touch has no ctrl key, so a tap is what it has instead, once a
      // selection is already held - the way past the first row, which still
      // needs a long press.
      const onOpen = vi.fn();
      const onPick = vi.fn();
      const onEndSelection = vi.fn();
      aRow({ onOpen, selecting: { picked: false, revealed: true, onPick, onEndSelection } });
      const row = screen.getByRole('listitem');

      fireEvent.pointerDown(row, { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.click(row);

      expect(onPick).toHaveBeenCalledWith(false);
      expect(onOpen).not.toHaveBeenCalled();
      expect(onEndSelection).not.toHaveBeenCalled();
    });

    it('does not toggle a row a second time from the click that follows the hold which just picked it', () => {
      // The finger that just picked the row out with a long press is still the
      // one the browser turns into a click - without `held`, the row it had
      // just picked out was toggled straight back off.
      vi.useFakeTimers();
      const onPick = vi.fn();
      aRow({ selecting: { picked: false, revealed: false, onPick, onEndSelection: vi.fn() } });
      const row = screen.getByRole('listitem');

      fireEvent.pointerDown(row, { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      act(() => {
        vi.advanceTimersByTime(HOLD_MS);
      });
      fireEvent.pointerUp(row, { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.click(row);

      expect(onPick).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('does not un-stick that suppression when a second finger lands on the row mid-hold', () => {
      // A second finger touching down is ignored as a swipe (`from.current`
      // already belongs to the first), but resetting `held` regardless would
      // un-stick the very suppression the first finger's hold just earned
      // (found in review, alongside the case above).
      vi.useFakeTimers();
      const onPick = vi.fn();
      aRow({ selecting: { picked: false, revealed: false, onPick, onEndSelection: vi.fn() } });
      const row = screen.getByRole('listitem');

      fireEvent.pointerDown(row, { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      act(() => {
        vi.advanceTimersByTime(HOLD_MS);
      });
      fireEvent.pointerDown(row, { pointerType: 'touch', pointerId: 2, clientX: 5, clientY: 5 });
      fireEvent.pointerUp(row, { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.click(row);

      expect(onPick).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('leaves the row alone when the click landed on its own menu trigger', () => {
      // The trigger is a button inside the row, so its click bubbles here the
      // same way a double press on it does (above): without the guard, opening
      // the menu also opened the form.
      const onOpen = vi.fn();
      const onPick = vi.fn();
      aRow({ onOpen, selecting: { picked: false, revealed: false, onPick, onEndSelection: vi.fn() } });

      fireEvent.click(screen.getByLabelText('Item actions'));

      expect(onOpen).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();
    });
  });

  /**
   * A selection suspends what a row's own menu and swipe would otherwise do,
   * so acting on one row while several are picked cannot happen through them -
   * except the routing chip, which is a carve-out.
   */
  describe('a selection suspends the row’s own menu and swipe, but not the routing chip', () => {
    it('marks the row’s own menu trigger unavailable while a selection is held, but keeps it reachable', async () => {
      // `aria-disabled` rather than native `disabled`, the same reason a
      // menu's own unavailable entries do (`RowMenu`, `MoveAStep`): it stays
      // in Tab order rather than silently dropping out of it.
      const user = userEvent.setup();
      aRow({ selecting: { picked: false, revealed: true, onPick: vi.fn(), onEndSelection: vi.fn() } });
      const trigger = screen.getByLabelText('Item actions');

      expect(trigger).toHaveAttribute('aria-disabled', 'true');
      expect(trigger).not.toBeDisabled();
      await user.click(trigger);
      expect(screen.queryByRole('menuitem', { name: 'Mark done' })).toBeNull();
    });

    it('leaves the menu trigger available and opening where nothing is selected', async () => {
      const user = userEvent.setup();
      aRow({ selecting: { picked: false, revealed: false, onPick: vi.fn(), onEndSelection: vi.fn() } });
      const trigger = screen.getByLabelText('Item actions');

      expect(trigger).not.toHaveAttribute('aria-disabled');
      await user.click(trigger);
      expect(await screen.findByRole('menuitem', { name: 'Mark done' })).toBeVisible();
    });

    it('closes a menu already open when a selection starts elsewhere', async () => {
      // Disabling the trigger only refuses a *new* open - without this, a menu
      // opened before any row was picked stayed fully actionable once a
      // selection started (found in review).
      const user = userEvent.setup();
      const { rerenderSelecting } = aRow({
        selecting: { picked: false, revealed: false, onPick: vi.fn(), onEndSelection: vi.fn() },
      });
      await user.click(screen.getByLabelText('Item actions'));
      expect(await screen.findByRole('menuitem', { name: 'Mark done' })).toBeVisible();

      rerenderSelecting({ picked: false, revealed: true, onPick: vi.fn(), onEndSelection: vi.fn() });

      expect(screen.queryByRole('menuitem', { name: 'Mark done' })).toBeNull();
    });

    it('stays closed once the selection that closed it ends, rather than reopening on its own', async () => {
      // Forcing the menu shut while a selection is held has to forget that it
      // was ever asked to open - otherwise the moment the selection ends, the
      // stale "open" from before comes back and the menu reopens itself,
      // having asked nobody the second time (found in review).
      const user = userEvent.setup();
      const { rerenderSelecting } = aRow({
        selecting: { picked: false, revealed: false, onPick: vi.fn(), onEndSelection: vi.fn() },
      });
      await user.click(screen.getByLabelText('Item actions'));
      expect(await screen.findByRole('menuitem', { name: 'Mark done' })).toBeVisible();
      rerenderSelecting({ picked: false, revealed: true, onPick: vi.fn(), onEndSelection: vi.fn() });
      expect(screen.queryByRole('menuitem', { name: 'Mark done' })).toBeNull();

      rerenderSelecting({ picked: false, revealed: false, onPick: vi.fn(), onEndSelection: vi.fn() });

      expect(screen.queryByRole('menuitem', { name: 'Mark done' })).toBeNull();
    });

    it('does not dismiss or file on a swipe while a selection is held', () => {
      const onMoveTo = vi.fn();
      const { mutate } = aRow({
        onMoveTo,
        selecting: { picked: false, revealed: true, onPick: vi.fn(), onEndSelection: vi.fn() },
      });

      swipe({ dx: -past });

      expect(mutate).not.toHaveBeenCalled();
      expect(onMoveTo).not.toHaveBeenCalled();
    });

    it('names no action while a selection is held, so the row promises nothing it will not do', () => {
      aRow({
        onMoveTo: vi.fn(),
        selecting: { picked: false, revealed: true, onPick: vi.fn(), onEndSelection: vi.fn() },
      });

      swipeAndHold({ dx: 160 });

      expect(namedByTheRow()).toBeNull();
    });

    it('keeps the routing chip clickable while a selection is held', async () => {
      const user = userEvent.setup();
      const onAcceptRouting = vi.fn();
      const onPick = vi.fn();
      const onOpen = vi.fn();
      aRow({
        routingProposal: { panelName: 'Compliance questions', reason: 'a compliance question' },
        onAcceptRouting,
        onOpen,
        selecting: { picked: false, revealed: true, onPick, onEndSelection: vi.fn() },
      });

      await user.click(screen.getByText('→ Compliance questions'));

      expect(onAcceptRouting).toHaveBeenCalledOnce();
      expect(onOpen).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();
    });
  });
});
