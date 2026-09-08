/**
 * What a swipe across a row meant ("Swipe an inbox row right to file it, left to
 * dismiss it", issue 145).
 *
 * **The deciding is here, and pure, on purpose.** jsdom produces no gesture at
 * all, so a test driving synthetic pointer events proves a handler is wired and
 * nothing else - it cannot fail for any reason a thumb would. Keeping the
 * decision out of the handler is what makes the rules below provable at the
 * lowest level, and leaves the browser walk to prove only that a finger can
 * reach them.
 *
 * **A swipe is a touch gesture, not a pointer gesture.** The handlers that use
 * this ignore a mouse: a row on a desktop is dragged into a panel instead
 * ("Drag an item into a panel, and drop it where you want it", issue 141), and
 * a mouse drag that both selected text and dismissed an item would be two
 * gestures wearing one movement.
 */

/**
 * How far a row has to travel before the swipe means anything, in CSS pixels.
 *
 * A distance rather than a fraction of the row: the Inbox is a column a fifth
 * of a desktop screen wide and the whole width of a phone, and the gesture
 * should not need twice the travel on the device it was designed for. Far
 * enough that a thumb sliding while scrolling does not reach it.
 */
export const SWIPE_THRESHOLD_PX = 72;

/** What a finished swipe asks for, or nothing. */
export type SwipeMeaning = 'file' | 'dismiss' | null;

/**
 * What a swipe still in progress is saying, or nothing at all.
 *
 * `wouldAct` is the difference between naming the direction's meaning and
 * promising it: below the threshold the row is saying *this way dismisses*,
 * past it *letting go now dismisses*.
 */
export type SwipePromise = { action: Exclude<SwipeMeaning, null>; wouldAct: boolean } | null;

/**
 * What the row should say it would do, while the finger is still down ("Show
 * what a swipe will do before the finger lifts").
 *
 * **From the first pixel across, rather than from the threshold**, because the
 * thing a person cannot see is which direction means what - and by the time
 * the threshold is reached the decision to swipe that way has been made. The
 * row names the direction's action immediately and only promises it once
 * letting go would take it.
 *
 * It is decided from `howFarItHasGone` rather than from `dx`, so a thumb
 * scrolling the list past a row promises nothing: the same rule that stops the
 * row shuffling sideways stops it making an offer.
 */
export function whatTheSwipeIsPromising(dx: number, dy: number): SwipePromise {
  const across = howFarItHasGone(dx, dy);
  if (across === 0) return null;
  return {
    action: across > 0 ? 'file' : 'dismiss',
    wouldAct: Math.abs(across) >= SWIPE_THRESHOLD_PX,
  };
}

/**
 * What the swipe meant, from how far it went in each direction.
 *
 * **A gesture that is mostly vertical means nothing, however far sideways it
 * wandered.** That is the whole difficulty of the feature: the list scrolls
 * under the same finger, and a thumb travelling down a phone screen drifts
 * tens of pixels across on the way. The list scrolling wins ties, because a
 * scroll that files something is far worse than a swipe that has to be made
 * again.
 *
 * **Read off the promise rather than decided again**, so the row cannot name
 * one action and the release take another. Two copies of "past the threshold,
 * to the right" would be two places to change the rule and one place to forget
 * it, and the failure that leaves - a row saying **Dismiss** under the thumb
 * and filing on release - is the one this gesture can least afford.
 */
export function whatTheSwipeMeant(dx: number, dy: number): SwipeMeaning {
  const promised = whatTheSwipeIsPromising(dx, dy);
  return promised?.wouldAct ? promised.action : null;
}

/**
 * How far the row should be drawn from where it started, while the finger is
 * still down.
 *
 * Nothing at all once the gesture is mostly vertical, so a row does not
 * shuffle sideways under a thumb that is scrolling - the same rule the meaning
 * is decided by, applied while it is still happening rather than only at the
 * end.
 */
export function howFarItHasGone(dx: number, dy: number): number {
  return Math.abs(dy) >= Math.abs(dx) ? 0 : dx;
}
