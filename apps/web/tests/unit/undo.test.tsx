import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  THE_BAR_LASTS_MS,
  UndoWhatJustHappened,
  forgetWhatJustHappened,
  useUndo,
} from '../../src/undo';

/**
 * F1: the bar's own behaviour - what it offers, what pressing it runs, and when
 * it stops offering it. What an undo actually puts back is the change it was
 * given, and that belongs to the list or the row that made it
 * (tests/unit/components/ItemList.test.tsx,
 * tests/unit/components/ItemRow.test.tsx).
 *
 * The clock is the runner's rather than the component's: the bar going on its
 * own is a real rule and there is no way to state it without one, so the timer
 * is the boundary being replaced, at the edge.
 */

/** A screen with a control that makes one undoable change. */
function AChange({
  label,
  what,
  undo,
}: {
  label: string;
  what: string;
  undo: () => Promise<unknown>;
}) {
  const offerToUndo = useUndo();
  return (
    <button type="button" onClick={() => offerToUndo({ what, undo })}>
      {label}
    </button>
  );
}

function show(changes: { label: string; what: string; undo: () => Promise<unknown> }[]) {
  render(
    <UndoWhatJustHappened>
      {changes.map((change) => (
        <AChange key={change.label} {...change} />
      ))}
    </UndoWhatJustHappened>,
  );
}

/**
 * A press, and everything it set going.
 *
 * `fireEvent` rather than `userEvent` because the clock here is the runner's:
 * `userEvent` waits on real timers between its own steps and deadlocks against
 * fake ones. The gestures under test are single presses, which is the one case
 * where the difference does not matter - and `act` is what lets the promise an
 * undo returns settle before anything is asserted.
 */
async function press(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

const bar = () => screen.queryByRole('status');

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Triage', () => {
  describe('what just happened can be put back, until the offer runs out', () => {
    it('says what happened and runs the way back when it is taken', async () => {
      const undo = vi.fn(() => Promise.resolve());
      show([{ label: 'Dismiss', what: '“Reply to Bart” dismissed', undo }]);

      await press('Dismiss');
      expect(bar()).toHaveTextContent('“Reply to Bart” dismissed');

      await press('Undo');

      expect(undo).toHaveBeenCalledOnce();
      expect(bar()).toBeNull();
    });

    it('offers nothing until something has happened', () => {
      show([{ label: 'Dismiss', what: 'x', undo: () => Promise.resolve() }]);

      expect(bar()).toBeNull();
    });

    it.each([
      { situation: 'after it has been taken', take: true },
      { situation: 'after a second change replaces it', take: false },
    ])('cannot be taken twice, $situation', async ({ take }) => {
      const first = vi.fn(() => Promise.resolve());
      const second = vi.fn(() => Promise.resolve());
      show([
        { label: 'Dismiss', what: 'first', undo: first },
        { label: 'Move', what: 'second', undo: second },
      ]);

      await press('Dismiss');
      if (take) {
        await press('Undo');
        expect(bar()).toBeNull();
      } else {
        await press('Move');
        expect(bar()).toHaveTextContent('second');
        await press('Undo');
        // The one on offer, not the one before it.
        expect(second).toHaveBeenCalledOnce();
      }
      expect(first).toHaveBeenCalledTimes(take ? 1 : 0);
    });

    it('goes on its own, and the change stays made', async () => {
      const undo = vi.fn(() => Promise.resolve());
      show([{ label: 'Dismiss', what: 'first', undo }]);
      await press('Dismiss');

      act(() => vi.advanceTimersByTime(THE_BAR_LASTS_MS));

      expect(bar()).toBeNull();
      expect(undo).not.toHaveBeenCalled();
    });

    it('gives a second change its own full time rather than what the first had left', async () => {
      show([
        { label: 'Dismiss', what: 'first', undo: () => Promise.resolve() },
        { label: 'Move', what: 'second', undo: () => Promise.resolve() },
      ]);

      await press('Dismiss');
      act(() => vi.advanceTimersByTime(THE_BAR_LASTS_MS - 1000));
      await press('Move');

      act(() => vi.advanceTimersByTime(THE_BAR_LASTS_MS - 1000));
      expect(bar()).toHaveTextContent('second');
      act(() => vi.advanceTimersByTime(1000));
      expect(bar()).toBeNull();
    });
  });

  describe('an undo that fails says so and leaves the item where the server has it', () => {
    it('waits for the answer rather than going while one is still coming', async () => {
      // The bar would otherwise reach its ten seconds mid-request and unmount,
      // and the failure arriving a moment later would be written to something
      // nothing is drawing - a slow undo that did not work looking exactly like
      // one that did.
      let refuse: (why: Error) => void = () => {};
      show([
        {
          label: 'Dismiss',
          what: 'first',
          undo: () => new Promise((_resolve, reject) => (refuse = reject)),
        },
      ]);
      await press('Dismiss');

      await press('Undo');
      act(() => vi.advanceTimersByTime(THE_BAR_LASTS_MS * 2));
      expect(bar()).toHaveTextContent('first');

      await act(async () => refuse(new Error('that item is no longer there')));

      expect(bar()).toHaveTextContent('that item is no longer there');
      // And what went wrong gets its own full time to be read.
      act(() => vi.advanceTimersByTime(THE_BAR_LASTS_MS - 1));
      expect(bar()).not.toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(bar()).toBeNull();
    });

    it('replaces what it was offering with what went wrong', async () => {
      show([
        {
          label: 'Dismiss',
          what: '“Reply to Bart” dismissed',
          undo: () => Promise.reject(new Error('that item is no longer there')),
        },
      ]);
      await press('Dismiss');

      await press('Undo');

      expect(bar()).toHaveTextContent('that item is no longer there');
    });
  });
});

describe('Sign-in', () => {
  describe('signing out leaves nothing of the person on screen', () => {
    it('takes the offer of an undo with it, title and all', async () => {
      // The bar is mounted above the router, so it outlives the navigation to
      // the logon page - and what it is holding is one of the previous
      // person's item titles, on the screen the next person signs in from.
      show([
        { label: 'Dismiss', what: '“Reply to Bart” dismissed', undo: () => Promise.resolve() },
      ]);
      await press('Dismiss');
      expect(bar()).toHaveTextContent('“Reply to Bart” dismissed');

      act(() => forgetWhatJustHappened());

      expect(bar()).toBeNull();
    });
  });
});
